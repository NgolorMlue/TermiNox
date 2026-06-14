use anyhow::Result;
use russh_keys::key::PublicKey;
use std::collections::HashSet;
use std::path::PathBuf;

fn known_hosts_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        {
            paths.push(home.join("ssh").join("known_hosts"));
            paths.push(home.join(".ssh").join("known_hosts"));
        }

        #[cfg(not(target_os = "windows"))]
        {
            paths.push(home.join(".ssh").join("known_hosts"));
        }
    }
    paths
}

pub fn verify_known_host(host: &str, port: u16, server_public_key: &PublicKey) -> Result<bool> {
    match russh_keys::check_known_hosts(host, port, server_public_key) {
        Ok(true) => Ok(true),
        Ok(false) => {
            russh_keys::known_hosts::learn_known_hosts(host, port, server_public_key).map_err(
                |err| {
                    anyhow::anyhow!(
                        "Host key for {}:{} is unknown and could not be recorded: {}",
                        host,
                        port,
                        err
                    )
                },
            )?;
            Ok(true)
        }
        Err(russh_keys::Error::KeyChanged { .. }) => anyhow::bail!(
            "Host key mismatch for {}:{} (possible MITM or host key rotation). \
Clear and re-trust only if you verified the new host key.",
            host,
            port
        ),
        Err(err) => anyhow::bail!(
            "Host key verification failed for {}:{}: {}",
            host,
            port,
            err
        ),
    }
}

/// Returns the fingerprint(s) of stored known-host keys for the given host:port, or None if none stored.
pub fn get_known_host_fingerprint(host: &str, port: u16) -> Result<Option<String>> {
    for path in known_hosts_paths() {
        if !path.exists() {
            continue;
        }
        let matches = russh_keys::known_hosts::known_host_keys_path(host, port, &path)
            .map_err(|e| anyhow::anyhow!("Failed to inspect known_hosts: {}", e))?;
        if !matches.is_empty() {
            let fps: Vec<String> = matches
                .iter()
                .map(|(_, key)| key.fingerprint())
                .collect();
            return Ok(Some(fps.join(", ")));
        }
    }
    Ok(None)
}

pub fn clear_known_host(host: &str, port: u16) -> Result<u32> {
    let mut removed_total: u32 = 0;

    for path in known_hosts_paths() {
        if !path.exists() {
            continue;
        }

        let matches = russh_keys::known_hosts::known_host_keys_path(host, port, &path).map_err(|e| {
            anyhow::anyhow!(
                "Failed to inspect known_hosts at '{}': {}",
                path.display(),
                e
            )
        })?;

        if matches.is_empty() {
            continue;
        }

        let remove_lines: HashSet<usize> = matches.into_iter().map(|(line, _)| line).collect();
        let contents = std::fs::read_to_string(&path).map_err(|e| {
            anyhow::anyhow!(
                "Failed to read known_hosts at '{}': {}",
                path.display(),
                e
            )
        })?;

        let mut kept = String::new();
        for (idx, line) in contents.lines().enumerate() {
            let line_no = idx + 1;
            if remove_lines.contains(&line_no) {
                removed_total = removed_total.saturating_add(1);
                continue;
            }
            kept.push_str(line);
            kept.push('\n');
        }

        std::fs::write(&path, kept).map_err(|e| {
            anyhow::anyhow!(
                "Failed to update known_hosts at '{}': {}",
                path.display(),
                e
            )
        })?;
    }

    Ok(removed_total)
}
