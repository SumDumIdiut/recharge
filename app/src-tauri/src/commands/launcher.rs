use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// Distinct from RechargeLoader's own version (loader.rs's LOADER_VERSION,
// the mod-framework contract mods build against) - this is Recharge the
// desktop app itself. Checks the real GitHub releases feed rather than a
// bundled manifest, since one now actually exists.
const RELEASES_API: &str = "https://api.github.com/repos/SumDumIdiut/recharge/releases/latest";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    html_url: String,
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

    Ok(LauncherUpdateInfo {
        update_available: is_newer(&latest_version, &current_version),
        latest_version,
        current_version,
        notes: release.body,
        url: release.html_url,
    })
}
