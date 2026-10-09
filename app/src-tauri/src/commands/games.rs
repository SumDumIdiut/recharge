//! The Games library: whole game builds hosted on the hub (WebGL via Electron, or standalone).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

const HUB_BASE: &str = "https://codecade.co.za/recharge";
const ELECTRON_VERSION: &str = "44.4.5";
const MARKER: &str = ".recharge-game.json";

#[derive(Clone, Serialize, Deserialize)]
struct HubGame {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    /// "webgl" (played in the Electron runner) or "standalone" (an executable).
    #[serde(rename = "type")]
    kind: String,
    /// "any", "windows" or "linux" - which OS a standalone build runs on.
    #[serde(default = "any_platform")]
    platform: String,
    #[serde(default)]
    exe: Option<String>,
    #[serde(default)]
    version: String,
    #[serde(default)]
    size: u64,
}

fn any_platform() -> String {
    "any".to_string()
}

#[derive(Serialize)]
pub struct LibraryGame {
    #[serde(flatten)]
    game: HubGame,
    installed: bool,
    /// Why this can't be played on this machine, if it can't.
    #[serde(rename = "unplayableReason")]
    unplayable_reason: Option<String>,
}

fn games_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("games");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid game id: '{id}'"));
    }
    Ok(())
}

fn this_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Windows builds run on Linux through Steam's Proton.
fn needs_proton(game: &HubGame) -> bool {
    cfg!(target_os = "linux") && game.kind == "standalone" && game.platform == "windows"
}

fn unplayable_reason(game: &HubGame) -> Option<String> {
    if game.kind != "standalone" || game.platform == "any" || game.platform == this_platform() {
        return None;
    }
    if needs_proton(game) {
        #[cfg(not(windows))]
        if super::steam::find_proton().is_none() {
            return Some("This is a Windows build. It runs through Steam's Proton, which isn't installed - install Proton in Steam (Library > Tools).".to_string());
        }
        return None;
    }
    Some(format!("This is a {} build - it can't run on this computer.", game.platform))
}

// The Windows build script strips the `\\?\` prefix Tauri gives resource paths for the same reason: many programs can't open that form.
fn plain(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

fn fetch_catalog() -> Result<Vec<HubGame>, String> {
    ureq::get(&format!("{HUB_BASE}/api/games"))
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("couldn't reach the Recharge library: {e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from the library: {e}"))
}

#[tauri::command]
pub async fn list_library_games(app: AppHandle) -> Result<Vec<LibraryGame>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = games_dir(&app)?;
        Ok(fetch_catalog()?
            .into_iter()
            .filter(|g| check_id(&g.id).is_ok())
            .map(|game| LibraryGame {
                installed: dir.join(&game.id).join(MARKER).is_file(),
                unplayable_reason: unplayable_reason(&game),
                game,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

fn progress(app: &AppHandle, id: &str, text: &str, percent: Option<f64>) {
    let _ = app.emit(
        "game-progress",
        serde_json::json!({ "id": id, "text": text, "percent": percent }),
    );
}

/// Streams `url` into `dest`, reporting progress as it goes.
fn download_to(app: &AppHandle, id: &str, label: &str, url: &str, dest: &Path) -> Result<(), String> {
    let mut response = ureq::get(url)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mut reader = response.body_mut().as_reader();
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last_percent: i64 = -1;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        let percent = total.map(|t| (done as f64 / t as f64 * 100.0).min(100.0));
        if let Some(p) = percent {
            if p as i64 != last_percent {
                last_percent = p as i64;
                progress(app, id, &format!("{label} {}%", p as i64), Some(p));
            }
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if let Some(total) = total {
        if done != total {
            return Err(format!("download incomplete ({done} of {total} bytes)"));
        }
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, target: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid package: {e}"))?;
    archive.extract(target).map_err(|e| format!("couldn't unpack: {e}"))
}

#[tauri::command]
pub async fn install_library_game(app: AppHandle, id: String) -> Result<(), String> {
    check_id(&id)?;
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let id = id.clone();
        move || install_blocking(&app, &id)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?;
    progress(&app, &id, "", None);
    result
}

fn install_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let game = fetch_catalog()?
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("that game isn't in the library any more")?;

    let dir = games_dir(app)?;
    let tmp_zip = dir.join(format!(".download-{id}.zip"));
    let staging = dir.join(format!(".unpack-{id}"));
    let target = dir.join(id);
    let _ = std::fs::remove_dir_all(&staging);

    let result = (|| {
        download_to(app, id, "Downloading", &format!("{HUB_BASE}/api/games/{id}/file"), &tmp_zip)?;
        progress(app, id, "Unpacking…", None);
        extract_zip(&tmp_zip, &staging)?;

        let manifest = serde_json::to_string(&game).map_err(|e| e.to_string())?;
        std::fs::write(staging.join(MARKER), manifest).map_err(|e| e.to_string())?;

        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target).map_err(|e| format!("couldn't finish installing: {e}"))
    })();
    let _ = std::fs::remove_file(&tmp_zip);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

#[tauri::command]
pub fn uninstall_library_game(app: AppHandle, id: String) -> Result<(), String> {
    check_id(&id)?;
    let target = games_dir(&app)?.join(&id);
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("couldn't remove it: {e}"))?;
    }
    // A Windows build run through Proton keeps its own Wine prefix (its saves included).
    let _ = std::fs::remove_dir_all(proton_prefix(&app, &id)?);
    Ok(())
}

fn proton_prefix(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("proton")
        .join(id))
}

#[cfg(not(windows))]
fn launch_with_proton(app: &AppHandle, id: &str, exe: &Path, dir: &Path) -> Result<(), String> {
    let (proton, client) = super::steam::find_proton().ok_or("Steam's Proton isn't installed")?;
    let prefix = proton_prefix(app, id)?;
    std::fs::create_dir_all(&prefix).map_err(|e| e.to_string())?;
    // Proton's output goes to a log beside the prefix, since a failed launch is otherwise silent.
    let log = std::fs::File::create(prefix.with_extension("log")).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    Command::new(&proton)
        .arg("run")
        .arg(exe)
        .current_dir(dir)
        .env("STEAM_COMPAT_DATA_PATH", &prefix)
        .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &client)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("couldn't start Proton: {e}"))?;
    Ok(())
}

fn electron_asset() -> Result<String, String> {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("Web games aren't supported on this operating system yet.".into());
    };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    Ok(format!("electron-v{ELECTRON_VERSION}-{os}-{arch}.zip"))
}

/// The Electron runtime the web games run in (~120-160 MB), downloaded once on first use instead of shipped.
fn ensure_electron(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("electron")
        .join(ELECTRON_VERSION);
    let exe = root.join(if cfg!(windows) { "electron.exe" } else { "electron" });
    if exe.is_file() {
        return Ok(exe);
    }

    let asset = electron_asset()?;
    let parent = root.parent().ok_or("bad electron path")?.to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let tmp_zip = parent.join(format!(".download-{asset}"));
    let staging = parent.join(format!(".unpack-{ELECTRON_VERSION}"));
    let _ = std::fs::remove_dir_all(&staging);

    let result = (|| {
        download_to(
            app,
            id,
            "Downloading the game player",
            &format!("https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{asset}"),
            &tmp_zip,
        )?;
        progress(app, id, "Unpacking the game player…", None);
        extract_zip(&tmp_zip, &staging)?;
        let _ = std::fs::remove_dir_all(&root);
        std::fs::rename(&staging, &root).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&tmp_zip);
    let _ = std::fs::remove_dir_all(&staging);
    result?;

    if exe.is_file() {
        Ok(exe)
    } else {
        Err("the game player download didn't contain the expected files".into())
    }
}

fn runner_dir(app: &AppHandle) -> Result<PathBuf, String> {
    super::updater::resource_path(app, "electron")
        .map(|p| plain(&p))
        .map_err(|e| format!("game runner not found: {e}"))
}

#[tauri::command]
pub async fn play_library_game(app: AppHandle, id: String) -> Result<(), String> {
    check_id(&id)?;
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let id = id.clone();
        move || play_blocking(&app, &id)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?;
    progress(&app, &id, "", None);
    result
}

fn play_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let dir = games_dir(app)?.join(id);
    let marker = std::fs::read_to_string(dir.join(MARKER)).map_err(|_| "that game isn't installed".to_string())?;
    let game: HubGame = serde_json::from_str(&marker).map_err(|e| e.to_string())?;
    if let Some(reason) = unplayable_reason(&game) {
        return Err(reason);
    }

    if game.kind == "webgl" {
        let electron = ensure_electron(app, id)?;
        let runner = runner_dir(app)?;
        let mut cmd = Command::new(&electron);
        // The app bundle's chrome-sandbox isn't setuid, so Chromium's sandbox can't start on Linux.
        if cfg!(target_os = "linux") {
            cmd.arg("--no-sandbox");
        }
        cmd.arg(&runner)
            .arg("--game")
            .arg(&dir)
            .arg("--title")
            .arg(&game.name)
            // Set when Recharge itself is launched from an Electron host (e.g. an editor terminal); it would make Electron run as plain Node.
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn().map_err(|e| format!("couldn't start the game player: {e}"))?;
        return Ok(());
    }

    let via_proton = needs_proton(&game);
    let exe_rel = game.exe.ok_or("this game has no executable listed")?;
    let exe = dir.join(&exe_rel);
    if !exe.is_file() {
        return Err(format!("'{exe_rel}' is missing from the install - try reinstalling."));
    }
    #[cfg(not(windows))]
    if via_proton {
        return launch_with_proton(app, id, &exe, &dir);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&exe) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(perms.mode() | 0o111);
                let _ = std::fs::set_permissions(&exe, perms);
            }
        }
    }
    Command::new(&exe)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't start the game: {e}"))?;
    Ok(())
}
