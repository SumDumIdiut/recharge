use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Emitter};

// Distinct from RechargeLoader's own version (loader.rs's LOADER_VERSION,
// the mod-framework contract mods build against) - this is Recharge the
// desktop app itself. Checks the real GitHub releases feed rather than a
// bundled manifest, since one now actually exists.
const RELEASES_API: &str = "https://api.github.com/repos/SumDumIdiut/recharge/releases/latest";
const MAX_INSTALLER_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
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
    pub url: String,
    // The release's own Setup.exe asset - present whenever a real release
    // (built via tools/release.ps1) attached one, which is every release so
    // far. Falls back to `url` (the GitHub release page) in the frontend if
    // this is ever missing, e.g. a manually-created release with no asset.
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
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

    let release: GithubRelease = ureq::get(RELEASES_API)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from GitHub: {e}"))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let download_url = release
        .assets
        .iter()
        .find(|a| a.name.ends_with("_Setup.exe"))
        .map(|a| a.browser_download_url.clone());

    Ok(LauncherUpdateInfo {
        update_available: is_newer(&latest_version, &current_version),
        latest_version,
        current_version,
        notes: release.body,
        url: release.html_url,
        download_url,
    })
}

// Downloads the release's Setup.exe and runs it, then closes this process so
// the installer (which taskkills recharge.exe itself in .onInit anyway) can
// replace it cleanly. Not silent - the installer's own finish page offers to
// relaunch Recharge, and seeing it run is more legible than a background swap.
#[tauri::command]
pub fn install_launcher_update(app: AppHandle, url: String) -> Result<(), String> {
    let _ = app.emit("launcher-update-progress", "Downloading update...");
    let bytes = ureq::get(&url)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("couldn't download the update: {e}"))?
        .body_mut()
        .with_config()
        .limit(MAX_INSTALLER_BYTES)
        .read_to_vec()
        .map_err(|e| format!("couldn't read the update: {e}"))?;

    let installer_path = std::env::temp_dir().join("Recharge_Update_Setup.exe");
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("couldn't save the update: {e}"))?;

    let _ = app.emit("launcher-update-progress", "Starting installer...");
    Command::new(&installer_path)
        .spawn()
        .map_err(|e| format!("couldn't start the installer: {e}"))?;

    app.exit(0);
    Ok(())
}
