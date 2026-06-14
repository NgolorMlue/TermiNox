use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::session::SshSession;
use crate::config::ServerConfig;

/// Manages all active SSH sessions.
/// Registered as Tauri managed state.
pub struct SshSessionManager {
    sessions: Mutex<HashMap<String, Arc<SshSession>>>,
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Connect to a server and return the session ID.
    /// If `jump_config` is provided, the connection is tunneled through that host first.
    pub async fn connect(
        &self,
        config: &ServerConfig,
        jump_config: Option<&ServerConfig>,
        app: AppHandle,
        cols: u32,
        rows: u32,
    ) -> Result<String> {
        let session_id = Uuid::new_v4().to_string();

        let session = Arc::new(
            SshSession::connect(config, jump_config, &session_id, app, cols, rows).await?,
        );

        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);

        Ok(session_id)
    }

    /// Write data to a session's SSH channel
    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?
        };
        session.write(data).await
    }

    /// Resize a session's PTY
    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?
        };
        session.resize(cols, rows).await
    }

    /// Disconnect and remove a session
    pub async fn disconnect(&self, session_id: &str) -> Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            session.disconnect().await?;
        }
        Ok(())
    }
}
