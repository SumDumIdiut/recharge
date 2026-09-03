use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use super::settings;

fn find_exe(game_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix("_Data") {
            let exe = game_dir.join(format!("{stem}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn managed_dir(game_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_dir).ok()?;
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

fn is_process_running(exe_name: &str) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("IMAGENAME eq {exe_name}"), "/NH"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = cmd.output() else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
        .to_lowercase()
        .contains(&exe_name.to_lowercase())
}

#[tauri::command]
pub fn is_game_running(app: AppHandle) -> bool {
    let Some(game_path) = settings::get_game_path(app) else {
        return false;
    };
    let Some(exe) = find_exe(&PathBuf::from(game_path)) else {
        return false;
    };
    let exe_name = exe.file_name().unwrap().to_string_lossy().to_string();
    is_process_running(&exe_name)
}

#[tauri::command]
pub fn launch_game(app: AppHandle, modded: bool) -> Result<(), String> {
    let game_path = settings::get_game_path(app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    let game_dir = PathBuf::from(&game_path);

    let exe = find_exe(&game_dir)
        .ok_or_else(|| format!("Couldn't find the game's .exe in {game_path}"))?;
    let exe_name = exe.file_name().unwrap().to_string_lossy().to_string();
    if is_process_running(&exe_name) {
        return Err("The game is already running - only one instance at a time.".into());
    }

    if let Some(managed) = managed_dir(&game_dir) {
        let deployed = managed.join("Assembly-CSharp.dll");
        let source = if modded {
            managed.join("Assembly-CSharp.RECHARGE.dll")
        } else {
            managed.join("Assembly-CSharp.ORIGINAL.dll")
        };
        if modded && !source.is_file() {
            return Err(
                "Modded launch needs RechargeLoader installed first (Settings > Install/Update)."
                    .into(),
            );
        }
        if source.is_file() {
            std::fs::copy(&source, &deployed)
                .map_err(|e| format!("Failed to switch to the {} build: {e}", if modded { "modded" } else { "vanilla" }))?;
        }
    } else if modded {
        return Err("Couldn't find the game's Managed folder to switch to the modded build.".into());
    }

    Command::new(&exe)
        .current_dir(&game_dir)
        .spawn()
        .map_err(|e| format!("Failed to launch game: {e}"))?;
    Ok(())
}
