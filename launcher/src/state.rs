//! root/state.json: what is installed (so starts can skip hashing) plus rollback bookkeeping.
use crate::manifest::Stat;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// One installed tree: enough to diff against a manifest and to restore on rollback.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Snapshot {
    pub version: String,
    pub build: u64,
    pub launch: String,
    /// path -> sha256 as installed
    pub files: BTreeMap<String, String>,
    pub cache: BTreeMap<String, Stat>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct State {
    pub current: Option<Snapshot>,
    /// Version in app.old/, restored by rollback.
    pub prev: Option<Snapshot>,
    /// Build just swapped in and not yet confirmed by started-<build>.ok.
    pub pending: Option<u64>,
    /// Builds that failed the health check; skipped until a different build is published.
    pub bad_builds: Vec<u64>,
}

impl State {
    pub fn load(root: &Path) -> State {
        fs::read(root.join("state.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Write-then-rename so a crash never leaves a half-written state.json.
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let tmp = root.join("state.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap())?;
        fs::rename(&tmp, root.join("state.json"))
    }
}
