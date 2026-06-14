use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use serde::Serialize;

const RING_SIZE: usize = 60;

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSample {
    pub timestamp_ms: u64,
    pub cpu_percent: Option<f64>,
    pub ram_percent: Option<f64>,
    pub disk_percent: Option<f64>,
}

pub struct MetricsStore {
    rings: Mutex<HashMap<String, VecDeque<MetricsSample>>>,
}

impl MetricsStore {
    pub fn new() -> Self {
        Self {
            rings: Mutex::new(HashMap::new()),
        }
    }

    pub fn push(&self, server_id: &str, sample: MetricsSample) {
        let mut rings = self.rings.lock().unwrap();
        let ring = rings.entry(server_id.to_string()).or_insert_with(VecDeque::new);
        if ring.len() >= RING_SIZE {
            ring.pop_front();
        }
        ring.push_back(sample);
    }

    pub fn history(&self, server_id: &str) -> Vec<MetricsSample> {
        let rings = self.rings.lock().unwrap();
        rings
            .get(server_id)
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }
}
