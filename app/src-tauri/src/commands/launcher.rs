use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

use super::settings;

// One permanent, reused release per channel (see autorelease.yml), fetched by tag rather than /releases/latest so old releases can't confuse it.
const STABLE_RELEASE_API: &str = "https://api.github.com/repos/SumDumIdiut/recharge/releases/tags/latest";
const BETA_RELEASE_API: &str = "https://api.github.com/repos/SumDumIdiut/recharge/releases/tags/latest-beta";
#[cfg(not(windows))]
const INSTALLER_SCRIPT_URL: &str = "https://github.com/SumDumIdiut/recharge/releases/download/installer/install.sh";
const MAX_INSTALLER_BYTES: u64 = 200 * 1024 * 1024;

// The commit this backend was built from, embedded at compile time.
fn built_sha() -> &'static str {
    env!("RECHARGE_BUILD_SHA")
}

// When this backend was built (UTC, same format as GitHub's published_at) - lets a SHA mismatch be checked for direction.
fn built_at() -> &'static str {
    env!("RECHARGE_BUILD_TIME")
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

// GitHub returns JSON null (not a missing key) for an empty release body,
// which plain #[serde(default)] doesn't cover - only a missing key does.
fn null_as_default<'de, D: serde::Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    Ok(Option::deserialize(d)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct GithubRelease {
    #[serde(default, deserialize_with = "null_as_default")]
    body: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
    // Refreshed every un-draft (every build), unlike created_at which freezes at first creation - needed for the downgrade check below on a reused release.
    #[serde(default, deserialize_with = "null_as_default")]
    published_at: String,
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
    let path = super::repos::source_mods_dir(app).ok()?.join("recharge-maps").join("mod.json");
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

fn fetch_asset_text(assets: &[GithubAsset], name: &str) -> Option<String> {
    let url = assets.iter().find(|a| a.name == name)?.browser_download_url.clone();
    let mut r = ureq::get(&url).header("User-Agent", "Recharge").call().ok()?;
    Some(r.body_mut().read_to_string().ok()?.trim().to_string())
}

#[cfg(windows)]
fn self_update_asset_url(assets: &[GithubAsset]) -> Option<String> {
    assets
        .iter()
        .find(|a| a.name.to_lowercase().ends_with("setup.exe"))
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
    if is_installed_via_deb() || is_user_install() {
        return assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".deb"))
            .map(|a| a.browser_download_url.clone());
    }
    None
}

// Installed by installer/bootstrap/install.sh under ~/.local (no package
// manager involved), which leaves a marker file behind.
#[cfg(not(windows))]
pub(super) fn is_user_install() -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return false };
    home.join(".local/share/recharge/.user-install").is_file()
        && std::env::current_exe().map(|exe| exe.starts_with(home.join(".local"))).unwrap_or(false)
}

#[cfg(not(windows))]
fn is_running_as_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

#[cfg(not(windows))]
fn is_installed_via_deb() -> bool {
    // A copy running from elsewhere (a local build) isn't what the package manages.
    let running_from_package = std::env::current_exe().map(|e| e.starts_with("/usr")).unwrap_or(false);
    running_from_package
        && Command::new("dpkg")
        .args(["-s", "recharge"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn check_launcher_update(app: AppHandle) -> Result<LauncherUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_launcher_update_blocking(&app))
        .await
        .map_err(|e| format!("update check task panicked: {e}"))?
}

fn check_launcher_update_blocking(app: &AppHandle) -> Result<LauncherUpdateInfo, String> {
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

    // Under the Recharge launcher it owns package updates; only the Navigator redeploy hint stays.
    if super::updater::is_managed() {
        return Ok(no_release_info());
    }

    let beta = settings::update_channel(&app) == "beta";
    let api = if beta { BETA_RELEASE_API } else { STABLE_RELEASE_API };
    // A draft release (briefly, mid-build) 404s same as "doesn't exist yet" - a transient DNS blip gets one retry so it isn't a hard error either.
    let mut response = match ureq::get(api).header("User-Agent", "Recharge").call() {
        Err(ureq::Error::StatusCode(404)) => return Ok(no_release_info()),
        Err(_) => {
            std::thread::sleep(std::time::Duration::from_millis(800));
            match ureq::get(api).header("User-Agent", "Recharge").call() {
                Err(ureq::Error::StatusCode(404)) => return Ok(no_release_info()),
                Err(e) => return Err(format!("couldn't reach GitHub: {e}")),
                Ok(r) => r,
            }
        }
        Ok(r) => r,
    };

    let release: GithubRelease = response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from GitHub: {e}"))?;

    let latest_version = fetch_asset_text(&release.assets, "VERSION.txt").unwrap_or_else(|| current_version.clone());
    let download_url = self_update_asset_url(&release.assets);

    // No SOURCE_SHA.txt - fall back to version. A SHA mismatch alone isn't "behind".
    let app_update_available = match fetch_asset_text(&release.assets, "SOURCE_SHA.txt") {
        Some(sha) => sha != built_sha() && release.published_at.as_str() > built_at(),
        None => is_newer(&latest_version, &current_version),
    };

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

#[tauri::command]
pub async fn install_launcher_update(app: AppHandle, url: String) -> Result<(), String> {
    if super::updater::is_managed() {
        return Err("Updates are handled by the Recharge launcher".into());
    }
    tauri::async_runtime::spawn_blocking(move || install_launcher_update_blocking(app, url))
        .await
        .map_err(|e| format!("update install task panicked: {e}"))?
}

#[cfg(windows)]
fn install_launcher_update_blocking(app: AppHandle, url: String) -> Result<(), String> {
    let bytes = download_update(&app, &url)?;

    let installer_path = std::env::temp_dir().join("Recharge_Update_Setup.exe");
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("couldn't save the update: {e}"))?;

    // Not .status(): the installer's own .onInit taskkills us, so waiting here would hang.
    let _ = app.emit("launcher-update-progress", "Installing...");
    Command::new(&installer_path)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("couldn't start the installer: {e}"))?;

    app.exit(0);
    Ok(())
}

#[cfg(not(windows))]
fn install_launcher_update_blocking(app: AppHandle, url: String) -> Result<(), String> {
    if let Some(appimage_path) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        return install_appimage_update(&app, &url, &appimage_path);
    }
    if is_installed_via_deb() {
        return install_deb_update(&app, &url);
    }
    if is_user_install() {
        return install_user_update(&app);
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
fn install_user_update(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit("launcher-update-progress", "Downloading and installing the update...");
    let status = Command::new("bash")
        .args(["-c", &format!("curl -fsSL {INSTALLER_SCRIPT_URL} | bash -s -- --user --no-launch")])
        .status()
        .map_err(|e| format!("couldn't run the installer: {e}"))?;
    if !status.success() {
        return Err("the update failed - check your internet connection and try again.".to_string());
    }

    let exe = std::env::current_exe().map_err(|e| format!("update installed, but couldn't relaunch: {e}"))?;
    let _ = app.emit("launcher-update-progress", "Starting the new version...");
    Command::new(exe)
        .spawn()
        .map_err(|e| format!("update installed, but couldn't relaunch: {e}"))?;

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
