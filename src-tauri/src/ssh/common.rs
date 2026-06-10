use anyhow::Result;
use russh::client;
use russh_keys::key;
use std::sync::Arc;

use crate::config::{AuthMethod, ServerConfig};
use crate::ssh::host_key::verify_known_host;

#[derive(Clone)]
pub struct ClientHandler {
    pub host: String,
    pub port: u16,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        verify_known_host(&self.host, self.port, server_public_key)
    }
}

pub async fn connect_authenticated(config: &ServerConfig) -> Result<client::Handle<ClientHandler>> {
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

    Ok(session)
}

/// Authenticate using the system SSH agent (Unix)
#[cfg(unix)]
pub async fn auth_agent(session: &mut client::Handle<ClientHandler>, username: &str) -> Result<()> {
    let mut agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect to SSH agent: {}", e))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list agent keys: {}", e))?;

    if identities.is_empty() {
        anyhow::bail!("SSH agent has no keys loaded");
    }

    let mut current_agent = agent;
    for id in &identities {
        let (returned_agent, result) = session
            .authenticate_future(username, id.clone(), current_agent)
            .await;
        current_agent = returned_agent;
        if let Ok(true) = result {
            return Ok(());
        }
    }
    anyhow::bail!("SSH agent authentication failed - no accepted keys")
}

/// Authenticate using Pageant on Windows
#[cfg(windows)]
pub async fn auth_agent(session: &mut client::Handle<ClientHandler>, username: &str) -> Result<()> {
    // connect_pageant() returns Self directly (not a Result)
    let mut agent = russh_keys::agent::client::AgentClient::connect_pageant().await;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list Pageant keys: {}", e))?;

    if identities.is_empty() {
        anyhow::bail!("Pageant has no keys loaded");
    }

    let mut current_agent = agent;
    for id in &identities {
        let (returned_agent, result) = session
            .authenticate_future(username, id.clone(), current_agent)
            .await;
        current_agent = returned_agent;
        if let Ok(true) = result {
            return Ok(());
        }
    }
    anyhow::bail!("Pageant authentication failed - no accepted keys")
}
