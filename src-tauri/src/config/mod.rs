pub mod store;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalForwardConfig {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_server_icon")]
    pub icon: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_connection_protocol")]
    pub protocol: ConnectionProtocol,
    pub auth_method: AuthMethod,
    pub location: String,
    pub lat: f64,
    pub lng: f64,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub keepalive_interval_secs: Option<u64>,
    #[serde(default)]
    pub scrollback_limit: Option<u32>,
    #[serde(default)]
    pub local_forwards: Option<Vec<LocalForwardConfig>>,
}

fn default_server_icon() -> String {
    "server".to_string()
}

fn default_connection_protocol() -> ConnectionProtocol {
    ConnectionProtocol::Ssh
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionProtocol {
    Ssh,
    Telnet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    Key {
        key_path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigData {
    pub version: u32,
    #[serde(default)]
    pub folders: Vec<FolderConfig>,
    #[serde(default)]
    pub servers: Vec<ServerConfig>,
}

impl Default for ConfigData {
    fn default() -> Self {
        Self {
            version: 2,
            folders: Vec::new(),
            servers: Vec::new(),
        }
    }
}
