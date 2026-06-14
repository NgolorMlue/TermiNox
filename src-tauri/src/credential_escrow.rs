use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const TOKEN_TTL: Duration = Duration::from_secs(30);

struct EscrowEntry {
    password: String,
    expires_at: Instant,
}

pub struct CredentialEscrow {
    tokens: Mutex<HashMap<String, EscrowEntry>>,
}

impl CredentialEscrow {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Store a password and return a single-use token valid for 30 seconds.
    pub fn store(&self, password: String) -> String {
        let token = Uuid::new_v4().to_string();
        let mut tokens = self.tokens.lock().unwrap();
        // Purge expired entries opportunistically
        tokens.retain(|_, e| e.expires_at > Instant::now());
        tokens.insert(token.clone(), EscrowEntry {
            password,
            expires_at: Instant::now() + TOKEN_TTL,
        });
        token
    }

    /// Claim a token: returns the password and removes it (single-use).
    /// Returns None if token is unknown or expired.
    pub fn claim(&self, token: &str) -> Option<String> {
        let mut tokens = self.tokens.lock().unwrap();
        let entry = tokens.remove(token)?;
        if entry.expires_at <= Instant::now() {
            return None;
        }
        Some(entry.password)
    }
}
