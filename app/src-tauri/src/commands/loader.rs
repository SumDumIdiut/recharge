use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const LOADER_VERSION: &str = "1.0.0";

#[derive(Serialize)]
pub struct LoaderStatus {
    pub installed: bool,
    pub version: String,
}

fn managed_dir(game_path: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_path).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.ends_with("_Data") {
            let managed = path.join("Managed");
            if managed.is_dir() {
                return Some(managed);
            }
        }
    }
    None
}

#[tauri::command]
pub fn loader_status(app: AppHandle) -> LoaderStatus {
    let installed = settings_game_path(&app)
        .and_then(|p| managed_dir(&p))
        .map(|managed| managed.join("Recharge.ModApi.dll").is_file())
        .unwrap_or(false);

    LoaderStatus {
        installed,
        version: LOADER_VERSION.to_string(),
    }
}

fn settings_game_path(app: &AppHandle) -> Option<String> {
    super::settings::get_game_path(app.clone())
}

fn find_build_script(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve("loader/build-loader.ps1", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("build-loader.ps1 resource not found: {e}"))?;
    let s = path.to_string_lossy();
    Ok(match s.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path.clone(),
    })
}

#[tauri::command]
pub fn install_or_update_loader(app: AppHandle) -> Result<(), String> {
    let game_path = settings_game_path(&app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    let script = find_build_script(&app)?;

    // Steam's own appid for the Demo vs. Playtest branches differs - read it
    // from the real appmanifest rather than guessing, so steam_appid.txt (see
    // build-loader.ps1) always matches whichever one is actually installed.
    let appid = super::steam::info_for_path(std::path::Path::new(&game_path)).and_then(|i| i.appid);

    let status_file = std::env::temp_dir().join(format!("recharge-install-{}.status", std::process::id()));
    let _ = std::fs::remove_file(&status_file);

    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-GameDir", &game_path])
        .args(["-StatusFile"])
        .arg(&status_file);
    if let Some(appid) = &appid {
        cmd.args(["-SteamAppId", appid]);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch installer script: {e}"))?;

    let mut last_status = String::new();
    let exit_status = loop {
        if let Ok(text) = std::fs::read_to_string(&status_file) {
            let text = text.trim().to_string();
            if !text.is_empty() && text != last_status {
                last_status = text.clone();
                let _ = app.emit("loader-progress", &text);
            }
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let _ = std::fs::remove_file(&status_file);

    if !exit_status.success() {
        return Err(if last_status.is_empty() {
            format!("Install failed (exit {:?})", exit_status.code())
        } else {
            last_status
        });
    }

    let managed = managed_dir(&game_path)
        .ok_or_else(|| "Install script exited cleanly but Managed folder is missing.".to_string())?;
    if !managed.join("Recharge.ModApi.dll").is_file() {
        return Err("Install script exited cleanly but Recharge.ModApi.dll wasn't deployed.".into());
    }

    Ok(())
}
