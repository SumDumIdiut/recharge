use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// Distinct from RechargeLoader's own version (loader.rs's LOADER_VERSION,
// the mod-framework contract mods build against) - this is Recharge the
// desktop app itself. There's no hosted release feed for this project (no
// git remote, nothing published), so "latest available" is a small local
// manifest bumped by hand when a newer build is actually cut - the same
// honest, no-fake-server spirit as how mod "installs" are really just a
// local rebuild, not a real download.
#[derive(Deserialize)]
struct LauncherManifest {
    version: String,
    #[serde(default)]
    notes: String,
}

#[derive(Serialize)]
pub struct LauncherUpdateInfo {
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    #[serde(rename = "latestVersion")]
    pub latest_version: String,
    #[serde(rename = "updateAvailable")]
    pub update_available: bool,
    pub notes: String,
}

// Plain numeric-segment compare ("0.10.0" > "0.9.0") - matches the same
// non-semver-library approach already used for mod version comparisons on
// the frontend (see isNewerVersion in app/src/mods/script.js).
fn is_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (na, nb) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if na != nb {
            return na > nb;
        }
    }
    false
}

#[tauri::command]
pub fn check_launcher_update(app: AppHandle) -> Result<LauncherUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let manifest_path = app
        .path()
        .resolve("content/launcher.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("launcher.json resource not found: {e}"))?;
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: LauncherManifest = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    Ok(LauncherUpdateInfo {
        update_available: is_newer(&manifest.version, &current_version),
        latest_version: manifest.version,
        current_version,
        notes: manifest.notes,
    })
}
