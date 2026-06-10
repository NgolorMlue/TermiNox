use anyhow::Result;
use keyring::Entry;
use log::warn;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::sync::Mutex;

use super::{AuthMethod, ConfigData, ConnectionProtocol, FolderConfig, ServerConfig, LocalForwardConfig};

const KEYRING_SERVICE: &str = "com.terminey.nodegrid";

fn password_secret_id(server_id: &str) -> String {
    format!("server:{server_id}:password")
}

fn key_passphrase_secret_id(server_id: &str) -> String {
    format!("server:{server_id}:key-passphrase")
}

fn write_secret(secret_id: &str, secret: &str) -> Result<()> {
    let entry = Entry::new(KEYRING_SERVICE, secret_id)
        .map_err(|e| anyhow::anyhow!("Failed to access keyring entry for {secret_id}: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| anyhow::anyhow!("Failed to store secret in keyring for {secret_id}: {e}"))
}

fn read_secret(secret_id: &str) -> Result<Option<String>> {
    let entry = Entry::new(KEYRING_SERVICE, secret_id)
        .map_err(|e| anyhow::anyhow!("Failed to access keyring entry for {secret_id}: {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::anyhow!(
            "Failed to read secret from keyring for {secret_id}: {err}"
        )),
    }
}

fn delete_secret(secret_id: &str) -> Result<()> {
    let entry = Entry::new(KEYRING_SERVICE, secret_id)
        .map_err(|e| anyhow::anyhow!("Failed to access keyring entry for {secret_id}: {e}"))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::anyhow!(
            "Failed to delete secret from keyring for {secret_id}: {err}"
        )),
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedServerConfig {
    id: String,
    name: String,
    #[serde(default = "default_server_icon")]
    icon: String,
    host: String,
    port: u16,
    username: String,
    #[serde(default = "default_connection_protocol")]
    protocol: ConnectionProtocol,
    auth_method: PersistedAuthMethod,
    location: String,
    lat: f64,
    lng: f64,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    keepalive_interval_secs: Option<u64>,
    #[serde(default)]
    scrollback_limit: Option<u32>,
    #[serde(default)]
    local_forwards: Option<Vec<LocalForwardConfig>>,
}

fn default_server_icon() -> String {
    "server".to_string()
}

fn default_connection_protocol() -> ConnectionProtocol {
    ConnectionProtocol::Ssh
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum PersistedAuthMethod {
    Password {
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        secret_ref: Option<String>,
    },
    Key {
        key_path: String,
        #[serde(default)]
        passphrase: Option<String>,
        #[serde(default)]
        passphrase_secret_ref: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedConfigData {
    version: u32,
    #[serde(default)]
    folders: Vec<FolderConfig>,
    #[serde(default)]
    servers: Vec<PersistedServerConfig>,
}

impl Default for PersistedConfigData {
    fn default() -> Self {
        Self {
            version: 2,
            folders: Vec::new(),
            servers: Vec::new(),
        }
    }
}

fn to_runtime_auth_method(server_id: &str, auth_method: PersistedAuthMethod) -> AuthMethod {
    match auth_method {
        PersistedAuthMethod::Password {
            password,
            secret_ref,
        } => {
            let secret_id = secret_ref.unwrap_or_else(|| password_secret_id(server_id));
            let plaintext = non_empty(password);
            if let Some(value) = plaintext.as_ref() {
                if let Err(err) = write_secret(&secret_id, value) {
                    warn!("{err}");
                }
            }
            let resolved = match read_secret(&secret_id) {
                Ok(Some(secret)) => secret,
                Ok(None) => plaintext.unwrap_or_default(),
                Err(err) => {
                    warn!("{err}");
                    plaintext.unwrap_or_default()
                }
            };
            AuthMethod::Password { password: resolved }
        }
        PersistedAuthMethod::Key {
            key_path,
            passphrase,
            passphrase_secret_ref,
        } => {
            let secret_id =
                passphrase_secret_ref.unwrap_or_else(|| key_passphrase_secret_id(server_id));
            let plaintext = non_empty(passphrase);
            if let Some(value) = plaintext.as_ref() {
                if let Err(err) = write_secret(&secret_id, value) {
                    warn!("{err}");
                }
            }
            let resolved = match read_secret(&secret_id) {
                Ok(Some(secret)) => Some(secret),
                Ok(None) => plaintext,
                Err(err) => {
                    warn!("{err}");
                    plaintext
                }
            };
            AuthMethod::Key {
                key_path,
                passphrase: non_empty(resolved),
            }
        }
        PersistedAuthMethod::Agent => AuthMethod::Agent,
    }
}

fn to_runtime(data: PersistedConfigData) -> ConfigData {
    let servers = data
        .servers
        .into_iter()
        .map(|server| ServerConfig {
            id: server.id.clone(),
            name: server.name,
            icon: server.icon,
            host: server.host,
            port: server.port,
            username: server.username,
            protocol: server.protocol,
            auth_method: to_runtime_auth_method(&server.id, server.auth_method),
            location: server.location,
            lat: server.lat,
            lng: server.lng,
            folder_id: server.folder_id,
            keepalive_interval_secs: server.keepalive_interval_secs,
            scrollback_limit: server.scrollback_limit,
            local_forwards: server.local_forwards,
        })
        .collect();

    ConfigData {
        version: data.version,
        folders: data.folders,
        servers,
    }
}

fn to_persisted_auth_method(server: &ServerConfig) -> Result<PersistedAuthMethod> {
    match &server.auth_method {
        AuthMethod::Password { password } => {
            let secret_id = password_secret_id(&server.id);
            if password.trim().is_empty() {
                delete_secret(&secret_id)?;
            } else {
                write_secret(&secret_id, password)?;
            }
            delete_secret(&key_passphrase_secret_id(&server.id))?;
            Ok(PersistedAuthMethod::Password {
                password: None,
                secret_ref: Some(secret_id),
            })
        }
        AuthMethod::Key {
            key_path,
            passphrase,
        } => {
            let passphrase_secret_id = key_passphrase_secret_id(&server.id);
            let passphrase_secret_ref = if let Some(value) = non_empty(passphrase.clone()) {
                write_secret(&passphrase_secret_id, &value)?;
                Some(passphrase_secret_id)
            } else {
                delete_secret(&passphrase_secret_id)?;
                None
            };
            delete_secret(&password_secret_id(&server.id))?;
            Ok(PersistedAuthMethod::Key {
                key_path: key_path.clone(),
                passphrase: None,
                passphrase_secret_ref,
            })
        }
        AuthMethod::Agent => {
            delete_secret(&password_secret_id(&server.id))?;
            delete_secret(&key_passphrase_secret_id(&server.id))?;
            Ok(PersistedAuthMethod::Agent)
        }
    }
}

fn to_persisted(data: &ConfigData) -> Result<PersistedConfigData> {
    let servers = data
        .servers
        .iter()
        .map(|server| {
            Ok(PersistedServerConfig {
                id: server.id.clone(),
                name: server.name.clone(),
                icon: server.icon.clone(),
                host: server.host.clone(),
                port: server.port,
                username: server.username.clone(),
                protocol: server.protocol.clone(),
                auth_method: to_persisted_auth_method(server)?,
                location: server.location.clone(),
                lat: server.lat,
                lng: server.lng,
                folder_id: server.folder_id.clone(),
                keepalive_interval_secs: server.keepalive_interval_secs,
                scrollback_limit: server.scrollback_limit,
                local_forwards: server.local_forwards.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(PersistedConfigData {
        version: data.version,
        folders: data.folders.clone(),
        servers,
    })
}

pub struct ConfigStore {
    path: PathBuf,
    data: Mutex<ConfigData>,
}

impl ConfigStore {
    pub fn new() -> Self {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.terminey.nodegrid");

        let path = config_dir.join("servers.json");

        let data = Self::load_from_disk(&path).unwrap_or_default();
        if let Err(err) = Self::save_to_disk(&path, &data) {
            warn!("Failed to persist secure config migration: {err}");
        }

        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn load_from_disk(path: &PathBuf) -> Result<ConfigData> {
        let contents = std::fs::read_to_string(path)?;
        let data: PersistedConfigData = serde_json::from_str(&contents)?;
        Ok(to_runtime(data))
    }

    fn save_to_disk(path: &PathBuf, data: &ConfigData) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let persisted = to_persisted(data)?;
        let json = serde_json::to_string_pretty(&persisted)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub async fn get_servers(&self) -> Vec<ServerConfig> {
        let data = self.data.lock().await;
        data.servers.clone()
    }

    pub async fn get_folders(&self) -> Vec<FolderConfig> {
        let data = self.data.lock().await;
        data.folders.clone()
    }

    pub async fn save_server(&self, server: ServerConfig) -> Result<()> {
        let mut data = self.data.lock().await;

        if let Some(existing) = data.servers.iter_mut().find(|s| s.id == server.id) {
            *existing = server;
        } else {
            data.servers.push(server);
        }

        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn delete_server(&self, server_id: &str) -> Result<()> {
        let mut data = self.data.lock().await;
        data.servers.retain(|s| s.id != server_id);
        if let Err(err) = delete_secret(&password_secret_id(server_id)) {
            warn!("{err}");
        }
        if let Err(err) = delete_secret(&key_passphrase_secret_id(server_id)) {
            warn!("{err}");
        }
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn reorder_servers(&self, ordered_ids: Vec<String>) -> Result<()> {
        let mut data = self.data.lock().await;

        if data.servers.len() <= 1 {
            return Ok(());
        }

        let mut remaining = std::mem::take(&mut data.servers);
        let mut reordered = Vec::with_capacity(remaining.len());

        for id in ordered_ids {
            if let Some(idx) = remaining.iter().position(|srv| srv.id == id) {
                reordered.push(remaining.remove(idx));
            }
        }

        reordered.extend(remaining.into_iter());
        data.servers = reordered;

        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn get_server(&self, server_id: &str) -> Option<ServerConfig> {
        let data = self.data.lock().await;
        data.servers.iter().find(|s| s.id == server_id).cloned()
    }

    pub async fn save_folder(&self, folder: FolderConfig) -> Result<()> {
        let mut data = self.data.lock().await;
        if let Some(existing) = data.folders.iter_mut().find(|f| f.id == folder.id) {
            *existing = folder;
        } else {
            data.folders.push(folder);
        }
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }

    pub async fn delete_folder(&self, folder_id: &str) -> Result<()> {
        let mut data = self.data.lock().await;
        data.folders.retain(|f| f.id != folder_id);
        for server in data.servers.iter_mut() {
            if server.folder_id.as_deref() == Some(folder_id) {
                server.folder_id = None;
            }
        }
        Self::save_to_disk(&self.path, &data)?;
        Ok(())
    }
}
