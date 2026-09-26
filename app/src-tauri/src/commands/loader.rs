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
    /// The game's deployed loader was built from different loader sources
    /// than this app ships, so mods built against the new ModApi would hit
    /// missing methods at runtime. A redeploy fixes it.
    pub outdated: bool,
}

#[tauri::command]
pub fn loader_status(app: AppHandle) -> LoaderStatus {
    let game_path = settings_game_path(&app);
    let installed = game_path
        .as_deref()
        .and_then(|p| super::steam::managed_dir(std::path::Path::new(p)))
        .map(|managed| managed.join("Recharge.ModApi.dll").is_file())
        .unwrap_or(false);

    let outdated = installed
        && match (game_path.as_deref(), loader_stamp(&app)) {
            (Some(p), Some(current)) => std::fs::read_to_string(stamp_path(p))
                .map(|deployed| deployed.trim() != current)
                .unwrap_or(true),
            _ => false,
        };

    LoaderStatus {
        installed,
        version: LOADER_VERSION.to_string(),
        outdated,
    }
}

fn stamp_path(game_path: &str) -> PathBuf {
    PathBuf::from(game_path).join("Recharge").join("loader.stamp")
}

// FNV-1a over every loader source file (ModApi, Runtime, build script), in a
// stable order, so any change to what gets compiled into the game changes it.
fn loader_stamp(app: &AppHandle) -> Option<String> {
    let script = find_build_script(app).ok()?;
    let root = script.parent()?;
    let mut files = vec![script.clone()];
    for dir in ["ModApi", "Runtime"] {
        collect_sources(&root.join(dir), &mut files);
    }
    files.sort();

    let mut hash: u64 = 0xcbf29ce484222325;
    for file in &files {
        let rel = file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/");
        let Ok(bytes) = std::fs::read(file) else { continue };
        for b in rel.bytes().chain(std::iter::once(0)).chain(bytes.into_iter().filter(|b| *b != b'\r')) {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Some(format!("{hash:016x}"))
}

fn collect_sources(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name != "bin" && name != "obj" {
                collect_sources(&path, out);
            }
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("cs" | "csproj")) {
            out.push(path);
        }
    }
}

fn settings_game_path(app: &AppHandle) -> Option<String> {
    super::settings::get_game_path(app.clone())
}

#[cfg(windows)]
fn powershell_command() -> Result<Command, String> {
    Ok(Command::new("powershell.exe"))
}

#[cfg(not(windows))]
fn powershell_command() -> Result<Command, String> {
    if which_on_path("pwsh").is_none() {
        return Err(
            "PowerShell (pwsh) isn't installed - RechargeLoader's build/install pipeline needs it. \
             Install it from your package manager (e.g. `sudo pacman -S powershell` on Arch, \
             or see https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux) \
             and try again."
                .to_string(),
        );
    }
    Ok(Command::new("pwsh"))
}

#[cfg(not(windows))]
fn which_on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

fn find_build_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(script) = super::live::loader_script(app) {
        return Ok(script);
    }
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
pub async fn install_or_update_loader(app: AppHandle) -> Result<(), String> {
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_or_update_loader_blocking(&app))
        .await
        .map_err(|e| format!("installer task panicked: {e}"))
        .and_then(|r| r);
    let _ = emit_app.emit("loader-install-finished", result.is_ok());
    result
}

fn install_or_update_loader_blocking(app: &AppHandle) -> Result<(), String> {
    let game_path = settings_game_path(app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    let script = find_build_script(app)?;

    let info = super::steam::info_for_path(std::path::Path::new(&game_path));
    if info.as_ref().map(|i| i.variant.as_str()) == Some("Demo") {
        return Err(
            "The demo can't be modded - only the full game supports RechargeLoader. Switch to your full game install first.".into(),
        );
    }
    let appid = info.and_then(|i| i.appid);

    let status_file = std::env::temp_dir().join(format!("recharge-install-{}.status", std::process::id()));
    let _ = std::fs::remove_file(&status_file);

    // Navigator (recharge-maps) is required by other mods, so it's always
    // pulled into the mods folder before building; other mods are pulled
    // when the user installs them.
    let mods_dir = super::repos::source_mods_dir(app)?;
    super::repos::ensure_blocking(app, "recharge-maps", None)?;

    let mut cmd = powershell_command()?;
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-GameDir", &game_path])
        .args(["-ModsDir"])
        .arg(&mods_dir)
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

    let managed = super::steam::managed_dir(std::path::Path::new(&game_path))
        .ok_or_else(|| "Install script exited cleanly but Managed folder is missing.".to_string())?;
    if !managed.join("Recharge.ModApi.dll").is_file() {
        return Err("Install script exited cleanly but Recharge.ModApi.dll wasn't deployed.".into());
    }

    if let Some(stamp) = loader_stamp(app) {
        let path = stamp_path(&game_path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, stamp);
    }

    Ok(())
}

#[tauri::command]
pub fn uninstall_loader(app: AppHandle) -> Result<(), String> {
    let game_path = settings_game_path(&app)
        .ok_or_else(|| "IGTAP install not found - set the game path in Settings.".to_string())?;
    let managed = super::steam::managed_dir(std::path::Path::new(&game_path))
        .ok_or_else(|| "Couldn't find the game's Managed folder.".to_string())?;

    let backup = managed.join("Assembly-CSharp.ORIGINAL.dll");
    if backup.is_file() {
        std::fs::copy(&backup, managed.join("Assembly-CSharp.dll"))
            .map_err(|e| format!("Failed to restore the original assembly: {e}"))?;
        let _ = std::fs::remove_file(&backup);
    }
    let _ = std::fs::remove_file(managed.join("Assembly-CSharp.RECHARGE.dll"));
    let _ = std::fs::remove_file(managed.join("Recharge.ModApi.dll"));

    let mods_dir = PathBuf::from(&game_path).join("Recharge").join("Mods");
    if mods_dir.is_dir() {
        std::fs::remove_dir_all(&mods_dir).map_err(|e| format!("Failed to remove deployed mods: {e}"))?;
    }
    Ok(())
}
