// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod credential_escrow;
mod local_shell;
mod lookup;
mod metrics_store;
mod ssh;
mod ssh_config_parser;
mod telnet;
mod vnc;

use config::store::ConfigStore;
use credential_escrow::CredentialEscrow;
use metrics_store::{MetricsStore, MetricsSample};
use config::{AuthMethod, ConnectionProtocol, FolderConfig, ServerConfig};
use local_shell::LocalShellManager;
#[cfg(target_os = "windows")]
use local_shell::known_windows_shell_paths;
use lookup::resolve_host_ip;
use serde::{Deserialize, Serialize};
use ssh::host_key::{clear_known_host as clear_known_host_impl, get_known_host_fingerprint as get_known_host_fingerprint_impl};
use ssh::manager::SshSessionManager;
use ssh::probe::{collect_metrics, ServerMetricsSnapshot};
use ssh::sftp::{
    create_dir as sftp_create_dir_impl, delete_entry as sftp_delete_entry_impl,
    download_file as sftp_download_file_impl, list_dir as sftp_list_dir_impl,
    read_file as sftp_read_file_impl, rename_entry as sftp_rename_entry_impl,
    set_permissions as sftp_set_permissions_impl,
    upload_dir as sftp_upload_dir_impl, download_dir as sftp_download_dir_impl,
    create_symlink as sftp_create_symlink_impl,
    upload_file as sftp_upload_file_impl, write_file as sftp_write_file_impl, SftpListResponse,
    SftpReadFileResponse, SftpWriteFileResponse,
};
use telnet::manager::TelnetSessionManager;
use vnc::manager::VncSessionManager;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use sysinfo::System;
use tauri::{Manager, State};
use tokio::net::TcpStream;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Config Commands ──

#[tauri::command]
async fn get_servers(config: State<'_, ConfigStore>) -> Result<Vec<ServerConfig>, String> {
    Ok(config.get_servers().await)
}

#[tauri::command]
async fn get_folders(config: State<'_, ConfigStore>) -> Result<Vec<FolderConfig>, String> {
    Ok(config.get_folders().await)
}

#[tauri::command]
async fn save_server(server: ServerConfig, config: State<'_, ConfigStore>) -> Result<(), String> {
    config.save_server(server).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_folder(folder: FolderConfig, config: State<'_, ConfigStore>) -> Result<(), String> {
    config.save_folder(folder).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_server(server_id: String, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .delete_server(&server_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_folder(folder_id: String, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .delete_folder(&folder_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reorder_servers(server_ids: Vec<String>, config: State<'_, ConfigStore>) -> Result<(), String> {
    config
        .reorder_servers(server_ids)
        .await
        .map_err(|e| e.to_string())
}

// ── SSH Commands ──

fn apply_auth_overrides(
    server: &mut ServerConfig,
    username_override: Option<String>,
    password_override: Option<String>,
) {
    if let Some(name) = username_override {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            server.username = trimmed.to_string();
        }
    }

    if let Some(password) = password_override {
        if let AuthMethod::Password {
            password: configured,
        } = &mut server.auth_method
        {
            *configured = password;
        }
    }
}

fn ensure_ssh_protocol(server: &ServerConfig) -> Result<(), String> {
    if server.protocol != ConnectionProtocol::Ssh {
        return Err("This action is only available for SSH server profiles.".to_string());
    }
    Ok(())
}


// ── SSH / Telnet / VNC / Local Shell Commands ──

/// Store a password in the credential escrow and return a single-use token.
/// The token expires in 30 seconds and is consumed on first use.
#[tauri::command]
async fn store_credential_token(
    password: String,
    escrow: State<'_, CredentialEscrow>,
) -> Result<String, String> {
    Ok(escrow.store(password))
}

#[tauri::command]
async fn ssh_connect(
    server_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
    username_override: Option<String>,
    password_override: Option<String>,
    credential_token: Option<String>,
    ssh_mgr: State<'_, SshSessionManager>,
    config: State<'_, ConfigStore>,
    escrow: State<'_, CredentialEscrow>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;

    // Resolve password: credential token takes priority over direct password_override
    let resolved_password = if let Some(token) = credential_token {
        Some(escrow.claim(&token).ok_or("Credential token expired or invalid")?)
    } else {
        password_override
    };

    apply_auth_overrides(&mut server, username_override, resolved_password);

    let jump_server = if let Some(ref jid) = server.jump_host_id.clone() {
        config.get_server(jid).await
    } else {
        None
    };

    let c = cols.unwrap_or(80);
    let r = rows.unwrap_or(24);

    ssh_mgr
        .connect(&server, jump_server.as_ref(), app, c, r)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_connect(
    server_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
    telnet_mgr: State<'_, TelnetSessionManager>,
    config: State<'_, ConfigStore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    if server.protocol != ConnectionProtocol::Telnet {
        return Err("Selected server is not configured for Telnet.".to_string());
    }

    let c = cols.unwrap_or(80);
    let r = rows.unwrap_or(24);

    telnet_mgr
        .connect(&server, None, app, c, r)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_clear_known_host(
    server_id: String,
    config: State<'_, ConfigStore>,
) -> Result<u32, String> {
    let server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    clear_known_host_impl(&server.host, server.port).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_get_known_host_fingerprint(
    server_id: String,
    config: State<'_, ConfigStore>,
) -> Result<Option<String>, String> {
    let server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;

    get_known_host_fingerprint_impl(&server.host, server.port).map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_write(
    session_id: String,
    data: Vec<u8>,
    telnet_mgr: State<'_, TelnetSessionManager>,
) -> Result<(), String> {
    telnet_mgr
        .write(&session_id, &data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_write_text(
    session_id: String,
    data: String,
    telnet_mgr: State<'_, TelnetSessionManager>,
) -> Result<(), String> {
    telnet_mgr
        .write(&session_id, data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    telnet_mgr: State<'_, TelnetSessionManager>,
) -> Result<(), String> {
    telnet_mgr
        .resize(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_disconnect(
    session_id: String,
    telnet_mgr: State<'_, TelnetSessionManager>,
) -> Result<(), String> {
    telnet_mgr
        .disconnect(&session_id)
        .await
        .map_err(|e| e.to_string())
}

// ── VNC Commands ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncConnectResult {
    pub session_id: String,
    pub ws_url: String,
}

#[tauri::command]
async fn vnc_connect(
    host: String,
    port: u16,
    vnc_mgr: State<'_, VncSessionManager>,
    app: tauri::AppHandle,
) -> Result<VncConnectResult, String> {
    let (session_id, ws_url) = vnc_mgr
        .connect(&host, port, app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(VncConnectResult { session_id, ws_url })
}

#[tauri::command]
async fn vnc_disconnect(
    session_id: String,
    vnc_mgr: State<'_, VncSessionManager>,
) -> Result<(), String> {
    vnc_mgr
        .disconnect(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_write(
    session_id: String,
    data: Vec<u8>,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .write(&session_id, &data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_write_text(
    session_id: String,
    data: String,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .write(&session_id, data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .resize(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_disconnect(
    session_id: String,
    ssh_mgr: State<'_, SshSessionManager>,
) -> Result<(), String> {
    ssh_mgr
        .disconnect(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_shell_connect(
    shell_type: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
    local_shell_mgr: State<'_, LocalShellManager>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let c = cols.unwrap_or(80);
    let r = rows.unwrap_or(24);
    let workspace = app_terminal_workspace_dir();
    std::fs::create_dir_all(&workspace).map_err(|e| {
        format!(
            "Failed to create terminal workspace '{}': {e}",
            workspace.display()
        )
    })?;
    local_shell_mgr.connect(app, shell_type, c, r, workspace)
}

#[tauri::command]
async fn local_shell_write(
    session_id: String,
    data: Vec<u8>,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.write(&session_id, &data)
}

#[tauri::command]
async fn local_shell_write_text(
    session_id: String,
    data: String,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.write(&session_id, data.as_bytes())
}

#[tauri::command]
async fn local_shell_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.resize(&session_id, cols, rows)
}

#[tauri::command]
async fn local_shell_disconnect(
    session_id: String,
    local_shell_mgr: State<'_, LocalShellManager>,
) -> Result<(), String> {
    local_shell_mgr.disconnect(&session_id)
}

#[tauri::command]
async fn start_local_terminal(terminal_type: Option<String>) -> Result<(), String> {
    let workspace = app_terminal_workspace_dir();
    std::fs::create_dir_all(&workspace).map_err(|e| {
        format!(
            "Failed to create terminal workspace '{}': {e}",
            workspace.display()
        )
    })?;

    let kind = terminal_type
        .unwrap_or_else(|| "powershell".to_string())
        .to_lowercase();

    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<(std::process::Command, bool)> = Vec::new();
        let zsh_via_bash_cmd = "if command -v zsh >/dev/null 2>&1; then exec zsh -l; else echo '[nodegrid] zsh not found, falling back to bash'; exec bash -l; fi";
        if kind == "cmd" {
            candidates.push((std::process::Command::new("cmd.exe"), true));
        } else if kind == "wsl" {
            let mut wsl = std::process::Command::new("wsl.exe");
            wsl.args(["--cd", "~"]);
            candidates.push((wsl, false));
            for path in known_windows_shell_paths("bash") {
                let mut bash = std::process::Command::new(path);
                bash.arg("-l");
                candidates.push((bash, true));
            }
            let mut bash = std::process::Command::new("bash.exe");
            bash.arg("-l");
            candidates.push((bash, true));
        } else if kind == "bash" {
            for path in known_windows_shell_paths("bash") {
                let mut bash = std::process::Command::new(path);
                bash.arg("-l");
                candidates.push((bash, true));
            }
            let mut bash = std::process::Command::new("bash.exe");
            bash.arg("-l");
            candidates.push((bash, true));
        } else if kind == "zsh" {
            for path in known_windows_shell_paths("zsh") {
                let mut zsh = std::process::Command::new(path);
                zsh.arg("-l");
                candidates.push((zsh, true));
            }
            for path in known_windows_shell_paths("bash") {
                let mut bash = std::process::Command::new(path);
                bash.args(["-lc", zsh_via_bash_cmd]);
                candidates.push((bash, true));
            }
            let mut zsh = std::process::Command::new("zsh.exe");
            zsh.arg("-l");
            candidates.push((zsh, true));
            let mut bash = std::process::Command::new("bash.exe");
            bash.args(["-lc", zsh_via_bash_cmd]);
            candidates.push((bash, true));
        } else {
            candidates.push((std::process::Command::new("powershell.exe"), true));
            candidates.push((std::process::Command::new("pwsh.exe"), true));
        }

        let mut last_err = String::new();
        for (mut cmd, set_cwd) in candidates {
            cmd.creation_flags(CREATE_NO_WINDOW);
            if set_cwd {
                cmd.current_dir(&workspace);
            }
            match cmd.spawn() {
                Ok(_) => return Ok(()),
                Err(err) => {
                    last_err = err.to_string();
                }
            }
        }
        return Err(format!("Failed to start local terminal: {}", last_err));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .spawn()
            .map_err(|e| format!("Failed to start local terminal: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("x-terminal-emulator", Vec::<&str>::new()),
            ("gnome-terminal", Vec::<&str>::new()),
            ("konsole", Vec::<&str>::new()),
            ("xterm", Vec::<&str>::new()),
        ];
        for (bin, args) in candidates {
            if std::process::Command::new(bin).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(
            "No terminal binary found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)"
                .to_string(),
        );
    }

    #[allow(unreachable_code)]
    Err("Local terminal launch is not supported on this platform".to_string())
}

#[derive(Debug, Serialize)]
struct HostDeviceInfo {
    hostname: String,
    os_name: String,
    os_version: String,
    arch: String,
    cpu_cores: u32,
    total_memory_mb: u64,
    terminal_workspace: String,
}

fn app_terminal_workspace_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.terminey.nodegrid")
        .join("terminal-workspace")
}

fn is_supported_external_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return false;
    }
    let lowered = trimmed.to_ascii_lowercase();
    lowered.starts_with("http://") || lowered.starts_with("https://")
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !is_supported_external_url(&trimmed) {
        return Err("Only http/https URLs are allowed".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", trimmed.as_str()]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening external URLs is not supported on this platform".to_string())
}

#[tauri::command]
async fn get_host_device_info() -> Result<HostDeviceInfo, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let hostname = System::host_name().unwrap_or_else(|| "Unknown".to_string());
    let os_name = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = System::os_version().unwrap_or_default();
    let arch = std::env::consts::ARCH.to_string();
    let cpu_cores = u32::try_from(system.cpus().len()).unwrap_or(0);

    let raw_memory = system.total_memory();
    let total_memory_mb = if raw_memory > 1_073_741_824 {
        raw_memory / (1024 * 1024)
    } else {
        raw_memory / 1024
    };

    let terminal_workspace = app_terminal_workspace_dir().to_string_lossy().to_string();

    Ok(HostDeviceInfo {
        hostname,
        os_name,
        os_version,
        arch,
        cpu_cores,
        total_memory_mb,
        terminal_workspace,
    })
}

#[tauri::command]
async fn ssh_probe_metrics(
    server_id: String,
    config: State<'_, ConfigStore>,
    metrics: State<'_, MetricsStore>,
) -> Result<ServerMetricsSnapshot, String> {
    let server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;

    let snapshot = collect_metrics(&server).await.map_err(|e| e.to_string())?;

    metrics.push(&server_id, MetricsSample {
        timestamp_ms: snapshot.fetched_unix_ms,
        cpu_percent: snapshot.cpu_used_percent,
        ram_percent: snapshot.memory_used_percent,
        disk_percent: snapshot.disk_used_percent,
    });

    Ok(snapshot)
}

#[tauri::command]
async fn get_metrics_history(
    server_id: String,
    metrics: State<'_, MetricsStore>,
) -> Result<Vec<MetricsSample>, String> {
    Ok(metrics.history(&server_id))
}

#[tauri::command]
async fn sftp_list_dir(
    server_id: String,
    path: Option<String>,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpListResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_list_dir_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_upload_file(
    server_id: String,
    local_path: String,
    remote_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_upload_file_impl(&server, local_path, remote_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_download_file(
    server_id: String,
    remote_path: String,
    local_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_download_file_impl(&server, remote_path, local_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_rename_entry(
    server_id: String,
    old_path: String,
    new_path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_rename_entry_impl(&server, old_path, new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_delete_entry(
    server_id: String,
    path: String,
    is_dir: bool,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_delete_entry_impl(&server, path, is_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_create_dir(
    server_id: String,
    path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_create_dir_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_read_file(
    server_id: String,
    path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpReadFileResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_read_file_impl(&server, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_write_file(
    server_id: String,
    path: String,
    content: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<SftpWriteFileResponse, String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_write_file_impl(&server, path, content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_set_permissions(
    server_id: String,
    path: String,
    chmod_octal: u32,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_set_permissions_impl(&server, path, chmod_octal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_upload_dir(
    server_id: String,
    local_dir: String,
    remote_dir: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_upload_dir_impl(&server, local_dir, remote_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_download_dir(
    server_id: String,
    remote_dir: String,
    local_dir: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_download_dir_impl(&server, remote_dir, local_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_create_symlink(
    server_id: String,
    target: String,
    path: String,
    username_override: Option<String>,
    password_override: Option<String>,
    config: State<'_, ConfigStore>,
) -> Result<(), String> {
    let mut server = config
        .get_server(&server_id)
        .await
        .ok_or_else(|| format!("Server not found: {}", server_id))?;
    ensure_ssh_protocol(&server)?;
    apply_auth_overrides(&mut server, username_override, password_override);

    sftp_create_symlink_impl(&server, target, path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn append_to_file(path: String, text: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write to log file: {e}"))?;
    Ok(())
}

#[tauri::command]
fn parse_ssh_config_command() -> Vec<ssh_config_parser::SshConfigEntry> {
    ssh_config_parser::parse_ssh_config()
}

#[derive(Debug, Serialize)]
struct ServerStatusResponse {
    status: String,
    latency_ms: Option<u32>,
    reason: Option<String>,
    ip: Option<String>,
}

#[tauri::command]
async fn check_server_status(
    host: String,
    port: u16,
    timeout_ms: Option<u64>,
) -> Result<ServerStatusResponse, String> {
    let ip = match resolve_host_ip(&host).await {
        Ok(ip) => ip,
        Err(err) => {
            return Ok(ServerStatusResponse {
                status: "unknown".to_string(),
                latency_ms: None,
                reason: Some(err),
                ip: None,
            });
        }
    };

    let timeout_ms = timeout_ms.unwrap_or(2500).clamp(250, 15_000);
    let addr = SocketAddr::new(ip, port);
    let start = Instant::now();

    match tokio::time::timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => {
            let elapsed = start.elapsed().as_millis();
            Ok(ServerStatusResponse {
                status: "online".to_string(),
                latency_ms: Some(u32::try_from(elapsed).unwrap_or(u32::MAX)),
                reason: None,
                ip: Some(ip.to_string()),
            })
        }
        Ok(Err(err)) => Ok(ServerStatusResponse {
            status: "offline".to_string(),
            latency_ms: None,
            reason: Some(err.to_string()),
            ip: Some(ip.to_string()),
        }),
        Err(_) => Ok(ServerStatusResponse {
            status: "offline".to_string(),
            latency_ms: None,
            reason: Some(format!("Connection timed out after {}ms", timeout_ms)),
            ip: Some(ip.to_string()),
        }),
    }
}


// ── IP Lookup Commands (delegating to lookup module) ──

#[tauri::command]
async fn lookup_ip_location(host: String) -> Result<lookup::LookupLocationResponse, String> {
    lookup::lookup_ip_location(host).await
}

#[tauri::command]
async fn geocode_location(query: String) -> Result<lookup::GeocodeLocationResponse, String> {
    lookup::geocode_location(query).await
}

#[tauri::command]
async fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

// ── Main ──


fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ConfigStore::new())
        .manage(MetricsStore::new())
        .manage(CredentialEscrow::new())
        .manage(SshSessionManager::new())
        .manage(TelnetSessionManager::new())
        .manage(LocalShellManager::new())
        .manage(VncSessionManager::new())
        .invoke_handler(tauri::generate_handler![
            get_servers,
            get_folders,
            save_server,
            save_folder,
            delete_server,
            delete_folder,
            reorder_servers,
            store_credential_token,
            ssh_connect,
            telnet_connect,
            ssh_clear_known_host,
            ssh_get_known_host_fingerprint,
            ssh_write,
            ssh_write_text,
            ssh_resize,
            ssh_disconnect,
            telnet_write,
            telnet_write_text,
            telnet_resize,
            telnet_disconnect,
            vnc_connect,
            vnc_disconnect,
            local_shell_connect,
            local_shell_write,
            local_shell_write_text,
            local_shell_resize,
            local_shell_disconnect,
            get_host_device_info,
            open_external_url,
            start_local_terminal,
            ssh_probe_metrics,
            get_metrics_history,
            sftp_list_dir,
            sftp_upload_file,
            sftp_download_file,
            sftp_upload_dir,
            sftp_download_dir,
            sftp_rename_entry,
            sftp_delete_entry,
            sftp_create_dir,
            sftp_read_file,
            sftp_write_file,
            sftp_set_permissions,
            sftp_create_symlink,
            write_text_file,
            read_text_file,
            check_server_status,
            lookup_ip_location,
            geocode_location,
            open_devtools,
            append_to_file,
            parse_ssh_config_command,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
