use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

use super::settings;

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
    #[serde(rename = "appUpdateAvailable")]
    pub app_update_available: bool,
    pub notes: String,
    pub url: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(rename = "mapsUpdateAvailable")]
    pub maps_update_available: bool,
    #[serde(rename = "bundledMapsVersion")]
    pub bundled_maps_version: Option<String>,
    #[serde(rename = "deployedMapsVersion")]
    pub deployed_maps_version: Option<String>,
}

fn read_manifest_version(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(|s| s.to_string())
}

fn bundled_maps_version(app: &AppHandle) -> Option<String> {
    let path = app
        .path()
        .resolve("mods/recharge-maps/mod.json", tauri::path::BaseDirectory::Resource)
        .ok()?;
    read_manifest_version(&path)
}

fn deployed_maps_version(app: &AppHandle) -> Option<String> {
    let game_path = settings::get_game_path(app.clone())?;
    let path = PathBuf::from(game_path)
        .join("Recharge")
        .join("Mods")
        .join("recharge.maps")
        .join("mod.json");
    read_manifest_version(&path)
}

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

#[cfg(windows)]
fn self_update_asset_url(assets: &[GithubAsset]) -> Option<String> {
    assets
        .iter()
        .find(|a| a.name.ends_with("_Setup.exe"))
        .map(|a| a.browser_download_url.clone())
}

#[cfg(not(windows))]
fn self_update_asset_url(assets: &[GithubAsset]) -> Option<String> {
    if is_running_as_appimage() {
        return assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".appimage"))
            .map(|a| a.browser_download_url.clone());
    }
    if is_installed_via_deb() {
        return assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".deb"))
            .map(|a| a.browser_download_url.clone());
    }
    None
}

#[cfg(not(windows))]
fn is_running_as_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

#[cfg(not(windows))]
fn is_installed_via_deb() -> bool {
    Command::new("dpkg")
        .args(["-s", "recharge"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn check_launcher_update(app: AppHandle) -> Result<LauncherUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let bundled_maps_version = bundled_maps_version(&app);
    let deployed_maps_version = deployed_maps_version(&app);
    let maps_update_available = match (&bundled_maps_version, &deployed_maps_version) {
        (Some(bundled), Some(deployed)) => is_newer(bundled, deployed),
        _ => false, // not deployed yet - onboarding flow, not an update
    };

    let no_release_info = || LauncherUpdateInfo {
        update_available: maps_update_available,
        app_update_available: false,
        latest_version: current_version.clone(),
        current_version: current_version.clone(),
        notes: String::new(),
        url: "https://github.com/SumDumIdiut/recharge/releases".to_string(),
        download_url: None,
        maps_update_available,
        bundled_maps_version: bundled_maps_version.clone(),
        deployed_maps_version: deployed_maps_version.clone(),
    };

    let mut response = match ureq::get(RELEASES_API).header("User-Agent", "Recharge").call() {
        // No release has been published yet (only drafts, or none at all) -
        // GitHub's "latest" endpoint 404s in that case. That's a normal
        // state, not something worth surfacing as an error.
        Err(ureq::Error::StatusCode(404)) => return Ok(no_release_info()),
        Err(e) => return Err(format!("couldn't reach GitHub: {e}")),
        Ok(r) => r,
    };

    let release: GithubRelease = response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from GitHub: {e}"))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let download_url = self_update_asset_url(&release.assets);

    let app_update_available = is_newer(&latest_version, &current_version);

    Ok(LauncherUpdateInfo {
        update_available: app_update_available || maps_update_available,
        app_update_available,
        latest_version,
        current_version,
        notes: release.body,
        url: release.html_url,
        download_url,
        maps_update_available,
        bundled_maps_version,
        deployed_maps_version,
    })
}

#[cfg(windows)]
#[tauri::command]
pub fn install_launcher_update(app: AppHandle, url: String) -> Result<(), String> {
    let bytes = download_update(&app, &url)?;

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

#[cfg(not(windows))]
#[tauri::command]
pub fn install_launcher_update(app: AppHandle, url: String) -> Result<(), String> {
    if let Some(appimage_path) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        return install_appimage_update(&app, &url, &appimage_path);
    }
    if is_installed_via_deb() {
        return install_deb_update(&app, &url);
    }
    Err("not running as an AppImage or a .deb install - can't self-update this install.".to_string())
}

#[cfg(not(windows))]
fn install_appimage_update(app: &AppHandle, url: &str, appimage_path: &std::path::Path) -> Result<(), String> {
    let bytes = download_update(app, url)?;

    let tmp_path = appimage_path.with_extension("new");
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("couldn't save the update: {e}"))?;

    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&tmp_path)
        .map_err(|e| format!("couldn't read the update's permissions: {e}"))?
        .permissions();
    perms.set_mode(perms.mode() | 0o111);
    std::fs::set_permissions(&tmp_path, perms)
        .map_err(|e| format!("couldn't make the update executable: {e}"))?;

    std::fs::rename(&tmp_path, appimage_path)
        .map_err(|e| format!("couldn't replace the running AppImage: {e}"))?;

    let _ = app.emit("launcher-update-progress", "Starting the new version...");
    Command::new(appimage_path)
        .spawn()
        .map_err(|e| format!("couldn't start the updated AppImage: {e}"))?;

    app.exit(0);
    Ok(())
}

#[cfg(not(windows))]
fn install_deb_update(app: &AppHandle, url: &str) -> Result<(), String> {
    let bytes = download_update(app, url)?;

    let tmp_path = std::env::temp_dir().join("Recharge_Update.deb");
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("couldn't save the update: {e}"))?;

    let _ = app.emit(
        "launcher-update-progress",
        "Installing update - you may be asked to authenticate...",
    );
    let status = Command::new("pkexec")
        .args(["dpkg", "--force-depends", "-i"])
        .arg(&tmp_path)
        .status()
        .map_err(|e| format!("couldn't launch the privileged installer (pkexec): {e}"))?;
    let _ = std::fs::remove_file(&tmp_path);
    if !status.success() {
        return Err("the privileged install step failed or was cancelled.".to_string());
    }

    let _ = app.emit("launcher-update-progress", "Starting the new version...");
    Command::new("recharge")
        .spawn()
        .map_err(|e| format!("update installed, but couldn't relaunch: {e}"))?;

    app.exit(0);
    Ok(())
}

fn download_update(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    let _ = app.emit("launcher-update-progress", "Downloading update...");
    ureq::get(url)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("couldn't download the update: {e}"))?
        .body_mut()
        .with_config()
        .limit(MAX_INSTALLER_BYTES)
        .read_to_vec()
        .map_err(|e| format!("couldn't read the update: {e}"))
}
