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
    #[serde(default)]
    pub jump_host_id: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_server(id: &str, protocol: ConnectionProtocol) -> ServerConfig {
        ServerConfig {
            id: id.to_string(),
            name: "Test".to_string(),
            icon: "server".to_string(),
            host: "1.2.3.4".to_string(),
            port: 22,
            username: "root".to_string(),
            protocol,
            auth_method: AuthMethod::Agent,
            location: "US".to_string(),
            lat: 40.0,
            lng: -74.0,
            folder_id: None,
            keepalive_interval_secs: None,
            scrollback_limit: None,
            local_forwards: None,
            jump_host_id: None,
        }
    }

    #[test]
    fn server_config_roundtrip_agent_auth() {
        let server = make_server("srv-1", ConnectionProtocol::Ssh);
        let json = serde_json::to_string(&server).unwrap();
        let back: ServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "srv-1");
        assert!(matches!(back.auth_method, AuthMethod::Agent));
        assert_eq!(back.protocol, ConnectionProtocol::Ssh);
    }

    #[test]
    fn server_config_roundtrip_password_auth() {
        let mut server = make_server("srv-2", ConnectionProtocol::Ssh);
        server.auth_method = AuthMethod::Password { password: "s3cr3t".to_string() };
        let json = serde_json::to_string(&server).unwrap();
        let back: ServerConfig = serde_json::from_str(&json).unwrap();
        assert!(matches!(&back.auth_method, AuthMethod::Password { password } if password == "s3cr3t"));
    }

    #[test]
    fn server_config_roundtrip_key_auth() {
        let mut server = make_server("srv-3", ConnectionProtocol::Ssh);
        server.auth_method = AuthMethod::Key {
            key_path: "/home/user/.ssh/id_ed25519".to_string(),
            passphrase: Some("pass".to_string()),
        };
        let json = serde_json::to_string(&server).unwrap();
        let back: ServerConfig = serde_json::from_str(&json).unwrap();
        assert!(matches!(&back.auth_method, AuthMethod::Key { key_path, passphrase }
            if key_path == "/home/user/.ssh/id_ed25519" && passphrase.as_deref() == Some("pass")));
    }

    #[test]
    fn server_config_optional_fields_default_to_none() {
        let json = r#"{
            "id": "srv-4",
            "name": "Minimal",
            "icon": "server",
            "host": "10.0.0.1",
            "port": 22,
            "username": "admin",
            "auth_method": {"type": "Agent"},
            "location": "",
            "lat": 0.0,
            "lng": 0.0
        }"#;
        let server: ServerConfig = serde_json::from_str(json).unwrap();
        assert!(server.folder_id.is_none());
        assert!(server.keepalive_interval_secs.is_none());
        assert!(server.scrollback_limit.is_none());
        assert!(server.local_forwards.is_none());
        assert!(server.jump_host_id.is_none());
    }

    #[test]
    fn server_config_jump_host_id_roundtrip() {
        let mut server = make_server("srv-5", ConnectionProtocol::Ssh);
        server.jump_host_id = Some("bastion-1".to_string());
        let json = serde_json::to_string(&server).unwrap();
        let back: ServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.jump_host_id.as_deref(), Some("bastion-1"));
    }

    #[test]
    fn telnet_protocol_roundtrip() {
        let server = make_server("srv-6", ConnectionProtocol::Telnet);
        let json = serde_json::to_string(&server).unwrap();
        let back: ServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.protocol, ConnectionProtocol::Telnet);
    }

    #[test]
    fn folder_config_roundtrip() {
        let folder = FolderConfig {
            id: "f-1".to_string(),
            name: "Production".to_string(),
        };
        let json = serde_json::to_string(&folder).unwrap();
        let back: FolderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "f-1");
        assert_eq!(back.name, "Production");
    }
}
