use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct SshConfigEntry {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

fn ssh_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".ssh").join("config"));
    }
    paths
}

fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        if let Some(home) = dirs::home_dir() {
            return path.replacen('~', &home.to_string_lossy(), 1);
        }
    }
    path.to_string()
}

pub fn parse_ssh_config() -> Vec<SshConfigEntry> {
    let mut entries: Vec<SshConfigEntry> = Vec::new();

    for config_path in ssh_config_paths() {
        let text = match fs::read_to_string(&config_path) {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Current block state
        let mut current_alias: Option<String> = None;
        let mut current_hostname: Option<String> = None;
        let mut current_port: Option<u16> = None;
        let mut current_user: Option<String> = None;
        let mut current_identity: Option<String> = None;

        let flush = |alias: &Option<String>,
                     hostname: &Option<String>,
                     port: &Option<u16>,
                     user: &Option<String>,
                     identity: &Option<String>,
                     out: &mut Vec<SshConfigEntry>| {
            if let (Some(a), Some(h)) = (alias, hostname) {
                // Skip wildcard patterns
                if a.contains('*') || a.contains('?') {
                    return;
                }
                out.push(SshConfigEntry {
                    alias: a.clone(),
                    hostname: h.clone(),
                    port: port.unwrap_or(22),
                    user: user.clone(),
                    identity_file: identity.clone(),
                });
            }
        };

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            // Split on first whitespace
            let mut parts = line.splitn(2, |c: char| c.is_whitespace());
            let key = match parts.next() {
                Some(k) => k.to_ascii_lowercase(),
                None => continue,
            };
            let val = parts.next().unwrap_or("").trim().to_string();

            match key.as_str() {
                "host" => {
                    flush(
                        &current_alias,
                        &current_hostname,
                        &current_port,
                        &current_user,
                        &current_identity,
                        &mut entries,
                    );
                    current_alias = Some(val);
                    current_hostname = None;
                    current_port = None;
                    current_user = None;
                    current_identity = None;
                }
                "hostname" => {
                    current_hostname = Some(val);
                }
                "port" => {
                    current_port = val.parse::<u16>().ok();
                }
                "user" => {
                    current_user = Some(val);
                }
                "identityfile" => {
                    current_identity = Some(expand_tilde(&val));
                }
                _ => {}
            }
        }

        // Flush last block
        flush(
            &current_alias,
            &current_hostname,
            &current_port,
            &current_user,
            &current_identity,
            &mut entries,
        );
    }

    entries
}
