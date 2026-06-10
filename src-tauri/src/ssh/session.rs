use anyhow::Result;
use russh::client;
use russh::*;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;

use crate::config::{AuthMethod, ServerConfig};
use super::common::{ClientHandler, auth_agent};

/// Represents an active SSH session with a PTY channel.
pub struct SshSession {
    /// Command queue for write/resize/disconnect requests.
    command_tx: mpsc::UnboundedSender<SessionCommand>,
    /// Keep the task alive for the session lifetime.
    _read_task: tokio::task::JoinHandle<()>,
    /// Keep the session handle alive
    _handle: Arc<client::Handle<ClientHandler>>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

fn fold_session_command(
    cmd: SessionCommand,
    write_buf: &mut Vec<u8>,
    pending_resize: &mut Option<(u32, u32)>,
    should_disconnect: &mut bool,
) {
    match cmd {
        SessionCommand::Write(bytes) => {
            write_buf.extend_from_slice(&bytes);
        }
        SessionCommand::Resize { cols, rows } => {
            *pending_resize = Some((cols, rows));
        }
        SessionCommand::Disconnect => {
            *should_disconnect = true;
        }
    }
}

impl SshSession {
    /// Connect to a server, authenticate, open a PTY, and start streaming output.
    pub async fn connect(
        config: &ServerConfig,
        session_id: &str,
        app: AppHandle,
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<Self> {
        let mut ssh_config = client::Config {
            ..Default::default()
        };
        if let Some(secs) = config.keepalive_interval_secs {
            if secs > 0 {
                ssh_config.keepalive_interval = Some(std::time::Duration::from_secs(secs));
                ssh_config.keepalive_max = 3;
            }
        }

        let addr = format!("{}:{}", config.host, config.port);
        let handler = ClientHandler {
            host: config.host.clone(),
            port: config.port,
        };
        let mut session = client::connect(Arc::new(ssh_config), &addr[..], handler)
            .await
            .map_err(|e| anyhow::anyhow!("SSH connect failed: {}", e))?;

        // Authenticate
        match &config.auth_method {
            AuthMethod::Password { password } => {
                let auth_result = session
                    .authenticate_password(&config.username, password)
                    .await
                    .map_err(|e| anyhow::anyhow!("Password auth failed: {}", e))?;
                if !auth_result {
                    anyhow::bail!("Password authentication rejected by server");
                }
            }
            AuthMethod::Key {
                key_path,
                passphrase,
            } => {
                let key_pair = russh_keys::load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| anyhow::anyhow!("Failed to load SSH key: {}", e))?;

                let auth_result = session
                    .authenticate_publickey(&config.username, Arc::new(key_pair))
                    .await
                    .map_err(|e| anyhow::anyhow!("Key auth failed: {}", e))?;
                if !auth_result {
                    anyhow::bail!("Public key authentication rejected by server");
                }
            }
            AuthMethod::Agent => {
                auth_agent(&mut session, &config.username).await?;
            }
        }

        let session = Arc::new(session);

        // Open a session channel
        let channel = session
            .channel_open_session()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to open channel: {}", e))?;

        // Request PTY
        channel
            .request_pty(
                false,
                "xterm-256color",
                initial_cols,
                initial_rows,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| anyhow::anyhow!("Failed to request PTY: {}", e))?;

        // Request shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to request shell: {}", e))?;

        let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
        let shutdown_tx_clone = shutdown_tx.clone();

        if let Some(forwards) = &config.local_forwards {
            for forward in forwards {
                let local_port = forward.local_port;
                let remote_host = forward.remote_host.clone();
                let remote_port = forward.remote_port;
                let client_handle = session.clone();
                let mut shutdown_rx = shutdown_tx.subscribe();

                tokio::spawn(async move {
                    let addr = format!("127.0.0.1:{}", local_port);
                    let listener = match tokio::net::TcpListener::bind(&addr).await {
                        Ok(l) => l,
                        Err(e) => {
                            log::error!("Failed to bind local port forward to {}: {}", addr, e);
                            return;
                        }
                    };

                    loop {
                        tokio::select! {
                            _ = shutdown_rx.recv() => {
                                break;
                            }
                            conn = listener.accept() => {
                                let (mut local_stream, _) = match conn {
                                    Ok(c) => c,
                                    Err(_) => break,
                                };
                                let client_handle = client_handle.clone();
                                let remote_host = remote_host.clone();
                                let mut shutdown_rx_conn = shutdown_rx.resubscribe();

                                tokio::spawn(async move {
                                    let channel: russh::Channel<_> = match client_handle.channel_open_direct_tcpip(
                                        &remote_host,
                                        remote_port as u32,
                                        "127.0.0.1",
                                        local_port as u32,
                                    ).await {
                                        Ok(ch) => ch,
                                        Err(e) => {
                                            log::error!("Failed to open direct-tcpip channel: {}", e);
                                            return;
                                        }
                                    };

                                    let mut channel_stream = channel.into_stream();

                                    tokio::select! {
                                        _ = shutdown_rx_conn.recv() => {}
                                        _ = tokio::io::copy_bidirectional(&mut channel_stream, &mut local_stream) => {}
                                    }
                                });
                            }
                        }
                    }
                });
            }
        }

        // Queue control/input commands from Tauri handlers into the SSH task.
        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<SessionCommand>();
        let session_id_owned = session_id.to_string();

        // Background loop: process local commands and remote channel events.
        let read_task = tokio::spawn(async move {
            let mut channel = channel;
            loop {
                tokio::select! {
                    biased;
                    maybe_cmd = command_rx.recv() => {
                        match maybe_cmd {
                            Some(first_cmd) => {
                                let mut write_buf: Vec<u8> = Vec::new();
                                let mut pending_resize: Option<(u32, u32)> = None;
                                let mut should_disconnect = false;

                                fold_session_command(
                                    first_cmd,
                                    &mut write_buf,
                                    &mut pending_resize,
                                    &mut should_disconnect,
                                );
                                while !should_disconnect {
                                    match command_rx.try_recv() {
                                        Ok(cmd) => {
                                            fold_session_command(
                                                cmd,
                                                &mut write_buf,
                                                &mut pending_resize,
                                                &mut should_disconnect,
                                            );
                                            if write_buf.len() >= 8192 {
                                                break;
                                            }
                                        }
                                        Err(TryRecvError::Empty) => break,
                                        Err(TryRecvError::Disconnected) => {
                                            should_disconnect = true;
                                            break;
                                        }
                                    }
                                }

                                if !write_buf.is_empty() && channel.data(&write_buf[..]).await.is_err() {
                                    let event_name = format!("ssh-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }
                                if let Some((cols, rows)) = pending_resize {
                                    let _ = channel.window_change(cols, rows, 0, 0).await;
                                }
                                if should_disconnect {
                                    let _ = channel.close().await;
                                    let event_name = format!("ssh-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }
                            }
                            None => {
                                let _ = channel.close().await;
                                let event_name = format!("ssh-closed-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                let text = String::from_utf8_lossy(&data[..]).into_owned();
                                let event_name = format!("ssh-data-{}", session_id_owned);
                                let _ = app.emit(&event_name, text);
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                let text = String::from_utf8_lossy(&data[..]).into_owned();
                                let event_name = format!("ssh-data-{}", session_id_owned);
                                let _ = app.emit(&event_name, text);
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                let event_name = format!("ssh-exit-{}", session_id_owned);
                                let _ = app.emit(&event_name, exit_status);
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                let event_name = format!("ssh-eof-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                            None => {
                                let event_name = format!("ssh-closed-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
            let _ = shutdown_tx_clone.send(());
        });

        Ok(SshSession {
            command_tx,
            _read_task: read_task,
            _handle: session,
        })
    }



    /// Write data (user keystrokes) to the SSH channel
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Write(data.to_vec()))
            .map_err(|_| anyhow::anyhow!("Write failed: session already closed"))?;
        Ok(())
    }

    /// Resize the remote PTY
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|_| anyhow::anyhow!("Resize failed: session already closed"))?;
        Ok(())
    }

    /// Disconnect the remote PTY/channel.
    pub async fn disconnect(&self) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Disconnect)
            .map_err(|_| anyhow::anyhow!("Disconnect failed: session already closed"))?;
        Ok(())
    }
}
