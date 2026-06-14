use anyhow::Result;
use russh::client;
use russh::*;
use std::sync::Arc;
use std::time::Duration;
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
    /// Keep the SSH session handle alive.
    _handle: Arc<client::Handle<ClientHandler>>,
    /// Keep the jump-host session alive (if multi-hop).
    _jump_handle: Option<Arc<client::Handle<ClientHandler>>>,
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

/// Authenticate `session` using the credentials in `config`.
async fn do_auth(
    session: &mut client::Handle<ClientHandler>,
    config: &ServerConfig,
) -> Result<()> {
    match &config.auth_method {
        AuthMethod::Password { password } => {
            let ok = session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password auth failed: {}", e))?;
            if !ok {
                anyhow::bail!("Password authentication rejected by server");
            }
        }
        AuthMethod::Key { key_path, passphrase } => {
            let key_pair = russh_keys::load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| anyhow::anyhow!("Failed to load SSH key: {}", e))?;
            let ok = session
                .authenticate_publickey(&config.username, Arc::new(key_pair))
                .await
                .map_err(|e| anyhow::anyhow!("Key auth failed: {}", e))?;
            if !ok {
                anyhow::bail!("Public key authentication rejected by server");
            }
        }
        AuthMethod::Agent => {
            auth_agent(session, &config.username).await?;
        }
    }
    Ok(())
}

impl SshSession {
    /// Connect to a server, authenticate, open a PTY, and start streaming output.
    /// If `jump_config` is provided the connection is tunneled through that host first.
    pub async fn connect(
        config: &ServerConfig,
        jump_config: Option<&ServerConfig>,
        session_id: &str,
        app: AppHandle,
        initial_cols: u32,
        initial_rows: u32,
    ) -> Result<Self> {
        let mut target_ssh_config = client::Config { ..Default::default() };
        if let Some(secs) = config.keepalive_interval_secs {
            if secs > 0 {
                target_ssh_config.keepalive_interval =
                    Some(std::time::Duration::from_secs(secs));
                target_ssh_config.keepalive_max = 3;
            }
        }

        // Establish the target session, optionally via a jump host.
        let (session, jump_handle) = if let Some(jc) = jump_config {
            // ── Step 1: connect & auth on jump host ──────────────────────────────
            let jump_addr = format!("{}:{}", jc.host, jc.port);
            let jump_handler = ClientHandler { host: jc.host.clone(), port: jc.port };
            let mut jump_session =
                client::connect(Arc::new(client::Config::default()), &jump_addr[..], jump_handler)
                    .await
                    .map_err(|e| anyhow::anyhow!("Jump host connect failed: {}", e))?;
            do_auth(&mut jump_session, jc).await?;

            // ── Step 2: open TCP tunnel to target ────────────────────────────────
            let tunnel = jump_session
                .channel_open_direct_tcpip(
                    &config.host,
                    config.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| anyhow::anyhow!("Jump tunnel failed: {}", e))?;
            let stream = tunnel.into_stream();

            // ── Step 3: connect target SSH over the tunnel stream ─────────────
            let target_handler = ClientHandler {
                host: config.host.clone(),
                port: config.port,
            };
            let mut target_session =
                client::connect_stream(Arc::new(target_ssh_config), stream, target_handler)
                    .await
                    .map_err(|e| anyhow::anyhow!("SSH via jump failed: {}", e))?;
            do_auth(&mut target_session, config).await?;

            let jump_arc = Arc::new(jump_session);
            (Arc::new(target_session), Some(jump_arc))
        } else {
            let addr = format!("{}:{}", config.host, config.port);
            let handler = ClientHandler {
                host: config.host.clone(),
                port: config.port,
            };
            let mut session =
                client::connect(Arc::new(target_ssh_config), &addr[..], handler)
                    .await
                    .map_err(|e| anyhow::anyhow!("SSH connect failed: {}", e))?;
            do_auth(&mut session, config).await?;
            (Arc::new(session), None)
        };

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
        // Output is batched into 16ms windows to reduce IPC event volume under
        // high-throughput commands (cat bigfile, builds, etc.).
        let read_task = tokio::spawn(async move {
            let mut channel = channel;
            let mut output_buf: Vec<u8> = Vec::new();
            #[allow(unused_assignments)]
            let mut flush_deadline: Option<tokio::time::Instant> = None;

            loop {
                // Flush helper — only emits if there is buffered data.
                macro_rules! flush_output {
                    () => {
                        if !output_buf.is_empty() {
                            let text = String::from_utf8_lossy(&output_buf).into_owned();
                            let _ = app.emit(&format!("ssh-data-{}", session_id_owned), text);
                            output_buf.clear();
                            flush_deadline = None;
                        }
                    };
                }

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
                                    flush_output!();
                                    let event_name = format!("ssh-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }
                                if let Some((cols, rows)) = pending_resize {
                                    let _ = channel.window_change(cols, rows, 0, 0).await;
                                }
                                if should_disconnect {
                                    flush_output!();
                                    let _ = channel.close().await;
                                    let event_name = format!("ssh-closed-{}", session_id_owned);
                                    let _ = app.emit(&event_name, ());
                                    break;
                                }
                            }
                            None => {
                                flush_output!();
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
                                output_buf.extend_from_slice(&data[..]);
                                if flush_deadline.is_none() {
                                    flush_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(16));
                                }
                                // Flush immediately if buffer exceeds 64 KB.
                                if output_buf.len() >= 65536 {
                                    flush_output!();
                                }
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                output_buf.extend_from_slice(&data[..]);
                                if flush_deadline.is_none() {
                                    flush_deadline = Some(tokio::time::Instant::now() + Duration::from_millis(16));
                                }
                                if output_buf.len() >= 65536 {
                                    flush_output!();
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                flush_output!();
                                let event_name = format!("ssh-exit-{}", session_id_owned);
                                let _ = app.emit(&event_name, exit_status);
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                flush_output!();
                                let event_name = format!("ssh-eof-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                            None => {
                                flush_output!();
                                let event_name = format!("ssh-closed-{}", session_id_owned);
                                let _ = app.emit(&event_name, ());
                                break;
                            }
                            _ => {}
                        }
                    }
                    // Flush buffered output when the 16ms deadline fires.
                    _ = async {
                        match flush_deadline {
                            Some(dl) => tokio::time::sleep_until(dl).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        flush_output!();
                    }
                }
            }
            let _ = shutdown_tx_clone.send(());
        });

        Ok(SshSession {
            command_tx,
            _read_task: read_task,
            _handle: session,
            _jump_handle: jump_handle,
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
