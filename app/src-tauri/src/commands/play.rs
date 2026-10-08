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

// pgrep -f matches an already-exited zombie too, so filter those via /proc/[pid]/stat's state field.
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
    // "pid (comm) state ..." - comm can contain parens, so find the *last* ')'.
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

// A cheap content stamp (same FNV-1a as loader.rs's own source stamp) - "is this byte-for-byte what I wrote".
fn fnv1a_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("{hash:016x}"))
}

fn deployed_stamp_path(managed: &Path) -> PathBuf {
    managed.join("Assembly-CSharp.deployed.stamp")
}

// The install script deploys the dll directly, bypassing deploy_build - without this the next launch's stale stamp reads as a Steam update and deletes it.
pub(crate) fn refresh_deploy_stamp(managed: &Path) {
    let deployed = managed.join("Assembly-CSharp.dll");
    if let Some(stamp) = fnv1a_file(&deployed) {
        let _ = std::fs::write(deployed_stamp_path(managed), stamp);
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => {
            matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y)
        }
        _ => false,
    }
}

// Does this assembly carry the loader bootstrap the Recharge patch adds? Steam's own
// never does - it is the one reliable way to tell our patched build from the game's.
//
// Without this, a manual `build-loader.ps1` run writes Assembly-CSharp.dll directly and
// leaves the old stamp behind, so the next launch reads that as a game update: it copies
// our patched dll over ORIGINAL and deletes Assembly-CSharp.RECHARGE.dll. That destroys
// the only vanilla copy of the assembly, and there is no way back except Steam.
fn is_patched_build(path: &Path) -> bool {
    const MARKER: &[u8] = b"RechargeLoaderBootstrap";
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    bytes.windows(MARKER.len()).any(|w| w == MARKER)
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
    let original = managed.join("Assembly-CSharp.ORIGINAL.dll");
    let recharge = managed.join("Assembly-CSharp.RECHARGE.dll");
    let stamp_path = deployed_stamp_path(&managed);

    // The stamp is the hash of what *we* last wrote - a rebuild's non-byte-stable output would otherwise look like a Steam update. No stamp yet falls back to a direct comparison.
    let matches_our_stamp = deployed.is_file()
        && match read_stamp(&stamp_path) {
            Some(stamp) => fnv1a_file(&deployed).as_deref() == Some(stamp.as_str()),
            None => {
                (original.is_file() && same_file(&deployed, &original))
                    || (recharge.is_file() && same_file(&deployed, &recharge))
            }
        };

    // Our own patched build sitting there under a stale stamp is not a game update -
    // re-stamp it instead of overwriting ORIGINAL with a modded assembly.
    let deployed_is_ours = deployed.is_file() && is_patched_build(&deployed);
    if deployed_is_ours && !matches_our_stamp {
        if let Some(stamp) = fnv1a_file(&deployed) {
            let _ = std::fs::write(&stamp_path, stamp);
        }
    } else if deployed.is_file() && (original.is_file() || recharge.is_file()) && !matches_our_stamp {
        // Steam replaced the assembly - keep its file as the new original and drop the now-stale modded build.
        std::fs::copy(&deployed, &original)
            .map_err(|e| format!("Couldn't keep the game's updated assembly: {e}"))?;
        let _ = std::fs::remove_file(&recharge);
        let _ = std::fs::remove_file(&stamp_path);
    }

    // Never hand a patched assembly back as the "vanilla" build.
    if !modded && original.is_file() && is_patched_build(&original) {
        return Err("The saved vanilla Assembly-CSharp.dll is missing or is itself a modded build. \
                    Verify the game's files in Steam, then reinstall Recharge (Settings > Install/Update)."
            .into());
    }

    let source = if modded { &recharge } else { &original };
    if modded && !source.is_file() {
        return Err(
            "Modded launch needs RechargeLoader installed (or reinstalled after a game update) - Settings > Install/Update."
                .into(),
        );
    }
    if source.is_file() {
        std::fs::copy(source, &deployed).map_err(|e| {
            format!(
                "Failed to switch to the {} build: {e}",
                if modded { "modded" } else { "vanilla" }
            )
        })?;
        if let Some(stamp) = fnv1a_file(&deployed) {
            let _ = std::fs::write(&stamp_path, stamp);
        }
    }
    Ok(())
}

fn read_stamp(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
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

    if modded && super::steam::info_for_path(&game_dir).map(|i| i.variant) == Some("Demo".to_string()) {
        return Err("The demo can only be played vanilla - mods aren't supported on it.".into());
    }

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
