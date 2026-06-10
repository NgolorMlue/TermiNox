use std::cmp::Ordering;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use russh::client;
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::config::ServerConfig;
use super::common::{ClientHandler, connect_authenticated};

#[derive(Debug, Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_unix: Option<u64>,
    pub modified_unix: Option<u64>,
    pub chmod: String,
}

#[derive(Debug, Serialize)]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Serialize)]
pub struct SftpReadFileResponse {
    pub path: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
    pub chmod: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct SftpWriteFileResponse {
    pub path: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
    pub chmod: String,
}

const MAX_EDITABLE_FILE_BYTES: usize = 10 * 1024 * 1024;

fn join_remote(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn normalize_path(value: Option<String>) -> String {
    match value {
        Some(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                ".".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => ".".to_string(),
    }
}

fn metadata_modified_unix(metadata: &russh_sftp::client::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs())
}



struct SftpConnection {
    session: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

async fn connect_sftp(config: &ServerConfig) -> Result<SftpConnection> {
    let session = connect_authenticated(config).await?;
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to open SFTP channel: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow::anyhow!("Failed to start SFTP subsystem: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP session: {}", e))?;

    Ok(SftpConnection { session, sftp })
}

async fn close_sftp(session: &client::Handle<ClientHandler>, sftp: &SftpSession, reason: &str) {
    let _ = sftp.close().await;
    let _ = session
        .disconnect(Disconnect::ByApplication, reason, "en-US")
        .await;
}



pub async fn list_dir(config: &ServerConfig, path: Option<String>) -> Result<SftpListResponse> {
    let SftpConnection { session, sftp } = connect_sftp(config).await?;

    let requested = normalize_path(path);
    let canonical = sftp
        .canonicalize(requested.clone())
        .await
        .unwrap_or(requested);

    let mut entries = Vec::<SftpEntry>::new();
    let read_dir = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list directory '{}': {}", canonical, e))?;

    for entry in read_dir {
        let name = entry.file_name();
        let file_type = entry.file_type();
        let metadata = entry.metadata();
        let modified_unix = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|dur| dur.as_secs());

        entries.push(SftpEntry {
            path: join_remote(&canonical, &name),
            name,
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            created_unix: metadata
                .accessed()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|dur| dur.as_secs()),
            modified_unix,
            chmod: metadata.permissions().to_string(),
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    close_sftp(&session, &sftp, "sftp list complete").await;

    Ok(SftpListResponse {
        path: canonical,
        entries,
    })
}

pub async fn upload_file(
    config: &ServerConfig,
    local_path: String,
    remote_path: String,
) -> Result<()> {
    let local = local_path.trim();
    if local.is_empty() {
        anyhow::bail!("Local file path is required");
    }

    let remote = remote_path.trim();
    if remote.is_empty() {
        anyhow::bail!("Remote file path is required");
    }

    let local_name = Path::new(local)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(local);
    let data = tokio::fs::read(local)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read local file '{}': {}", local_name, e))?;

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let mut remote_file = sftp
        .create(remote.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create remote file '{}': {}", remote, e))?;
    remote_file
        .write_all(&data)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to upload file '{}': {}", remote, e))?;
    let _ = remote_file.shutdown().await;

    close_sftp(&session, &sftp, "sftp upload complete").await;
    Ok(())
}

pub async fn download_file(
    config: &ServerConfig,
    remote_path: String,
    local_path: String,
) -> Result<()> {
    let remote = remote_path.trim();
    if remote.is_empty() {
        anyhow::bail!("Remote file path is required");
    }

    let local = local_path.trim();
    if local.is_empty() {
        anyhow::bail!("Local file path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let bytes = sftp
        .read(remote.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read remote file '{}': {}", remote, e))?;

    tokio::fs::write(local, &bytes)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to write local file '{}': {}", local, e))?;

    close_sftp(&session, &sftp, "sftp download complete").await;
    Ok(())
}

pub async fn read_file(config: &ServerConfig, path: String) -> Result<SftpReadFileResponse> {
    let requested = path.trim();
    if requested.is_empty() {
        anyhow::bail!("File path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let canonical = sftp
        .canonicalize(requested.to_string())
        .await
        .unwrap_or_else(|_| requested.to_string());

    let bytes = sftp
        .read(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read file '{}': {}", canonical, e))?;

    if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        close_sftp(&session, &sftp, "sftp read file complete").await;
        anyhow::bail!(
            "File is too large to edit ({} bytes). Max supported size is {} bytes.",
            bytes.len(),
            MAX_EDITABLE_FILE_BYTES
        );
    }

    let content = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("File appears to be binary or non-UTF-8"))?;
    let metadata = sftp
        .metadata(canonical.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to stat file '{}': {}", canonical, e))?;

    close_sftp(&session, &sftp, "sftp read file complete").await;
    Ok(SftpReadFileResponse {
        path: canonical,
        size: metadata.len(),
        modified_unix: metadata_modified_unix(&metadata),
        chmod: metadata.permissions().to_string(),
        content,
    })
}

pub async fn write_file(
    config: &ServerConfig,
    path: String,
    content: String,
) -> Result<SftpWriteFileResponse> {
    let target = path.trim();
    if target.is_empty() {
        anyhow::bail!("File path is required");
    }

    let bytes = content.into_bytes();
    if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        anyhow::bail!(
            "Content is too large ({} bytes). Max supported size is {} bytes.",
            bytes.len(),
            MAX_EDITABLE_FILE_BYTES
        );
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let mut remote_file = sftp
        .create(target.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to open file '{}': {}", target, e))?;
    remote_file
        .write_all(&bytes)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to write file '{}': {}", target, e))?;
    let _ = remote_file.shutdown().await;

    let metadata = sftp
        .metadata(target.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to stat file '{}': {}", target, e))?;

    close_sftp(&session, &sftp, "sftp write file complete").await;
    Ok(SftpWriteFileResponse {
        path: target.to_string(),
        size: metadata.len(),
        modified_unix: metadata_modified_unix(&metadata),
        chmod: metadata.permissions().to_string(),
    })
}

pub async fn rename_entry(config: &ServerConfig, old_path: String, new_path: String) -> Result<()> {
    let old_path = old_path.trim();
    let new_path = new_path.trim();
    if old_path.is_empty() || new_path.is_empty() {
        anyhow::bail!("Both old and new paths are required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    sftp.rename(old_path.to_string(), new_path.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to rename '{}': {}", old_path, e))?;
    close_sftp(&session, &sftp, "sftp rename complete").await;
    Ok(())
}

pub async fn delete_entry(config: &ServerConfig, path: String, is_dir: bool) -> Result<()> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("Path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    if is_dir {
        sftp.remove_dir(path.to_string())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete folder '{}': {}", path, e))?;
    } else {
        sftp.remove_file(path.to_string())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete file '{}': {}", path, e))?;
    }
    close_sftp(&session, &sftp, "sftp delete complete").await;
    Ok(())
}

pub async fn create_dir(config: &ServerConfig, path: String) -> Result<()> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("Folder path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    sftp.create_dir(path.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create folder '{}': {}", path, e))?;
    close_sftp(&session, &sftp, "sftp mkdir complete").await;
    Ok(())
}

pub async fn set_permissions(config: &ServerConfig, path: String, chmod_octal: u32) -> Result<()> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("Path is required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let mut meta = sftp.metadata(path.to_string()).await?;
    meta.permissions = Some(chmod_octal);
    sftp.set_metadata(path.to_string(), meta)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to set permissions for '{}': {}", path, e))?;
    close_sftp(&session, &sftp, "sftp chmod complete").await;
    Ok(())
}

pub async fn upload_dir(
    config: &ServerConfig,
    local_dir: String,
    remote_dir: String,
) -> Result<()> {
    let local_base = Path::new(&local_dir);
    if !local_base.is_dir() {
        anyhow::bail!("Local path is not a directory");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let _ = sftp.create_dir(remote_dir.clone()).await;

    let mut stack = vec![local_base.to_path_buf()];

    while let Some(current_local_dir) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&current_local_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let rel = path.strip_prefix(local_base)?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let remote_path = join_remote(&remote_dir, &rel_str);

            if path.is_dir() {
                let _ = sftp.create_dir(remote_path).await;
                stack.push(path);
            } else if path.is_file() {
                let data = tokio::fs::read(&path).await?;
                let mut remote_file = sftp.create(remote_path).await?;
                remote_file.write_all(&data).await?;
                let _ = remote_file.shutdown().await;
            }
        }
    }

    close_sftp(&session, &sftp, "sftp upload dir complete").await;
    Ok(())
}

pub async fn download_dir(
    config: &ServerConfig,
    remote_dir: String,
    local_dir: String,
) -> Result<()> {
    let local_base = Path::new(&local_dir);
    tokio::fs::create_dir_all(local_base).await?;

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    let canonical_remote_base = sftp
        .canonicalize(remote_dir.clone())
        .await
        .unwrap_or(remote_dir);

    let mut stack = vec![(canonical_remote_base.clone(), "".to_string())];

    while let Some((current_remote_dir, rel_path)) = stack.pop() {
        let read_dir = sftp.read_dir(current_remote_dir).await?;
        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let file_type = entry.file_type();
            let entry_rel = if rel_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_path, name)
            };
            let remote_path = join_remote(&canonical_remote_base, &entry_rel);
            let local_path = local_base.join(entry_rel.replace('/', &std::path::MAIN_SEPARATOR.to_string()));

            if file_type.is_dir() {
                tokio::fs::create_dir_all(&local_path).await?;
                stack.push((remote_path, entry_rel));
            } else {
                if let Some(parent) = local_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                let bytes = sftp.read(remote_path).await?;
                tokio::fs::write(local_path, &bytes).await?;
            }
        }
    }

    close_sftp(&session, &sftp, "sftp download dir complete").await;
    Ok(())
}

pub async fn create_symlink(
    config: &ServerConfig,
    target: String,
    path: String,
) -> Result<()> {
    let target = target.trim();
    let path = path.trim();
    if target.is_empty() || path.is_empty() {
        anyhow::bail!("Both symlink path and target path are required");
    }

    let SftpConnection { session, sftp } = connect_sftp(config).await?;
    sftp.symlink(target.to_string(), path.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create symlink: {}", e))?;

    close_sftp(&session, &sftp, "sftp symlink complete").await;
    Ok(())
}
