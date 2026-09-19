use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use super::settings;
use super::steam;

enum GameExe {
    Windows(PathBuf),
    Linux(PathBuf),
}

impl GameExe {
    fn path(&self) -> &Path {
        match self {
            GameExe::Windows(p) | GameExe::Linux(p) => p,
        }
    }

    fn file_name(&self) -> String {
        self.path().file_name().unwrap().to_string_lossy().to_string()
    }
}

fn find_exe(game_dir: &Path) -> Option<GameExe> {
    let entries = std::fs::read_dir(game_dir).ok()?;
    let mut windows_exe: Option<PathBuf> = None;
    let mut linux_exe: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix("_Data") else {
            continue;
        };
        if windows_exe.is_none() {
            let candidate = game_dir.join(format!("{stem}.exe"));
            if candidate.is_file() {
                windows_exe = Some(candidate);
            }
        }
        if linux_exe.is_none() {
            for ext in ["x86_64", "x86"] {
                let candidate = game_dir.join(format!("{stem}.{ext}"));
                if candidate.is_file() {
                    linux_exe = Some(candidate);
                    break;
                }
            }
        }
    }

    #[cfg(windows)]
    {
        windows_exe.map(GameExe::Windows)
    }
    #[cfg(not(windows))]
    {
        linux_exe.map(GameExe::Linux).or_else(|| windows_exe.map(GameExe::Windows))
    }
}

#[cfg(windows)]
fn is_process_running(exe_name: &str) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("IMAGENAME eq {exe_name}"), "/NH"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = cmd.output() else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout)
        .to_lowercase()
        .contains(&exe_name.to_lowercase())
}

// pgrep -f matches a zombie (already-exited, not yet reaped by its parent)
// the same as a live one, so a game that exited cleanly could still read as
// "running" indefinitely - confirmed live: Player.log showed a normal exit
// (proper Physics/Input shutdown sequence, no crash), but `ps` still listed
// the process as `<defunct>` and Recharge kept showing Running. Filtering
// those out via /proc/[pid]/stat's state field is what a zombie-aware check
// needs, since pgrep itself has no flag for it.
#[cfg(not(windows))]
fn is_process_running(exe_name: &str) -> bool {
    let Ok(output) = Command::new("pgrep")
        .args(["-f", "-i", &regex_escape_literal(exe_name)])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .any(|pid| !is_zombie(pid))
}

#[cfg(not(windows))]
fn is_zombie(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // Format: "pid (comm) state ...". comm can itself contain spaces/parens,
    // so the state field is found relative to the *last* ')', not the first.
    match stat.rfind(')') {
        Some(idx) => stat[idx + 1..].trim_start().starts_with('Z'),
        None => false,
    }
}

#[cfg(not(windows))]
fn regex_escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".^$*+?()[]{}|\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[tauri::command]
pub fn is_game_running(app: AppHandle) -> bool {
    let Some(game_path) = settings::get_game_path(app) else {
        return false;
    };
    let Some(exe) = find_exe(&PathBuf::from(game_path)) else {
        return false;
    };
    is_process_running(&exe.file_name())
}

fn deploy_build(game_dir: &Path, modded: bool) -> Result<(), String> {
    let Some(managed) = steam::managed_dir(game_dir) else {
        return if modded {
            Err("Couldn't find the game's Managed folder to switch to the modded build.".into())
        } else {
            Ok(())
        };
    };
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
        std::fs::copy(&source, &deployed).map_err(|e| {
            format!(
                "Failed to switch to the {} build: {e}",
                if modded { "modded" } else { "vanilla" }
            )
        })?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub enum LaunchMethod {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "steam")]
    Steam,
}

#[tauri::command]
pub fn launch_game(app: AppHandle, modded: bool) -> Result<LaunchMethod, String> {
    let game_path = settings::get_game_path(app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    let game_dir = PathBuf::from(&game_path);

    let exe = find_exe(&game_dir)
        .ok_or_else(|| format!("Couldn't find a game executable (.exe or .x86_64) in {game_path}"))?;
    if is_process_running(&exe.file_name()) {
        return Err("The game is already running - only one instance at a time.".into());
    }

    deploy_build(&game_dir, modded)?;

    launch_exe(&exe, &game_dir)
}

fn launch_exe(exe: &GameExe, game_dir: &Path) -> Result<LaunchMethod, String> {
    match exe {
        GameExe::Windows(path) => launch_windows_exe(path, game_dir),
        GameExe::Linux(path) => launch_linux_exe(path, game_dir),
    }
}

#[cfg(windows)]
fn launch_windows_exe(exe: &Path, game_dir: &Path) -> Result<LaunchMethod, String> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(game_dir);
    cmd.spawn().map_err(|e| format!("Failed to launch game: {e}"))?;
    Ok(LaunchMethod::Direct)
}

#[cfg(not(windows))]
fn launch_windows_exe(exe: &Path, game_dir: &Path) -> Result<LaunchMethod, String> {
    let appid = steam::info_for_path(game_dir).and_then(|i| i.appid).ok_or_else(|| {
        format!(
            "Couldn't determine this install's Steam appid, so it can't be launched through Proton. \
             Start it from Steam directly instead (found exe: {}).",
            exe.display()
        )
    })?;
    Command::new("steam")
        .arg(format!("steam://rungameid/{appid}"))
        .spawn()
        .map_err(|e| format!("Failed to launch Steam to start the game: {e}"))?;
    Ok(LaunchMethod::Steam)
}

#[cfg(not(windows))]
fn launch_linux_exe(exe: &Path, game_dir: &Path) -> Result<LaunchMethod, String> {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(exe) {
        let mut perms = meta.permissions();
        if perms.mode() & 0o111 == 0 {
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(exe, perms);
        }
    }
    Command::new(exe)
        .current_dir(game_dir)
        .spawn()
        .map_err(|e| format!("Failed to launch game: {e}"))?;
    Ok(LaunchMethod::Direct)
}

#[cfg(windows)]
fn launch_linux_exe(exe: &Path, _game_dir: &Path) -> Result<LaunchMethod, String> {
    Err(format!(
        "Found a native Linux game build ({}), but this is Windows - verify/reinstall the game through Steam.",
        exe.display()
    ))
}

#[tauri::command]
pub fn restore_vanilla_build(app: AppHandle) -> Result<(), String> {
    let game_path = settings::get_game_path(app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    deploy_build(&PathBuf::from(&game_path), false)
}
