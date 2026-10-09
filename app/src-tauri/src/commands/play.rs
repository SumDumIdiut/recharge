use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

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

// A cheap content stamp (FNV-1a, as in loader.rs): "is this byte-for-byte what I wrote".
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

// The install script deploys the dll directly, bypassing deploy_build; without this the next launch reads the stale stamp as a Steam update and deletes it.
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

// Does this assembly carry the loader bootstrap the patch adds? Steam's never does. Without the check a manual build-loader.ps1 run leaves a stale stamp, the next launch reads it as a game update and deletes the only vanilla copy (no way back except Steam).
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

    // The stamp is the hash of what we last wrote (a non-byte-stable rebuild would otherwise look like a Steam update); no stamp falls back to a direct comparison.
    let matches_our_stamp = deployed.is_file()
        && match read_stamp(&stamp_path) {
            Some(stamp) => fnv1a_file(&deployed).as_deref() == Some(stamp.as_str()),
            None => {
                (original.is_file() && same_file(&deployed, &original))
                    || (recharge.is_file() && same_file(&deployed, &recharge))
            }
        };

    // Our own patched build under a stale stamp is not a game update: re-stamp it instead of overwriting ORIGINAL with a modded assembly.
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
            "The modded build is missing (a game update removes it) - open Settings > RechargeLoader > Install / Update, then launch again."
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

/// Append a line to <app data>/<file> (best effort; keeps the last ~200 KB via one rotated .old file).
pub(crate) fn append_log(app: &AppHandle, file: &str, msg: &str) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(file);
    if std::fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join(format!("{file}.old")));
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "[{secs}] {msg}");
    }
}

/// Append a line to <app data>/launch.log.
pub(crate) fn log_launch(app: &AppHandle, msg: &str) {
    append_log(app, "launch.log", msg);
}

/// Frontend background-media diagnostics -> <app data>/media.log (one line, capped length).
#[tauri::command]
pub fn media_log(app: AppHandle, line: String) {
    let line: String = line.chars().filter(|c| !c.is_control()).take(500).collect();
    append_log(&app, "media.log", &line);
}

#[tauri::command]
pub fn launch_game(app: AppHandle, modded: bool) -> Result<LaunchMethod, String> {
    log_launch(&app, &format!("launch requested (modded={modded})"));
    let result = launch_game_inner(&app, modded);
    match &result {
        Ok(m) => log_launch(&app, &format!("launch ok via {}", if matches!(m, LaunchMethod::Steam) { "steam" } else { "direct" })),
        Err(e) => log_launch(&app, &format!("launch FAILED: {e}")),
    }
    result
}

fn launch_game_inner(app: &AppHandle, modded: bool) -> Result<LaunchMethod, String> {
    let game_path = settings::get_game_path(app.clone())
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
    log_launch(app, &format!("build deployed ({}), starting {}", if modded { "modded" } else { "vanilla" }, exe.path().display()));

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

// ---- closing a running game ----

/// One running process, as read from /proc (Linux) - the matching below is a pure function over these.
#[derive(Debug, Clone)]
pub(crate) struct ProcEntry {
    pub pid: u32,
    /// argv, already split.
    pub args: Vec<String>,
}

fn norm_path(s: &str) -> String {
    let t = s.replace('\\', "/").to_lowercase();
    t.strip_prefix("z:").map(str::to_string).unwrap_or(t)
}

fn base_name(arg: &str) -> String {
    norm_path(arg).rsplit('/').next().unwrap_or("").to_string()
}

/// Pids of processes that are this game (the game exe in a Wine/Proton argument, or the Unity crash handler from the game folder); nothing else, never `self_pid`.
pub(crate) fn matching_game_pids(procs: &[ProcEntry], exe_name: &str, game_dir: &Path, self_pid: u32) -> Vec<u32> {
    // Viewers/editors/shells that may merely have the file name as an argument.
    const NOT_GAME: &[&str] = &[
        "vim", "nvim", "vi", "nano", "less", "more", "cat", "grep", "rg", "pgrep", "pkill", "ls", "tail", "head", "stat", "file", "cp", "mv", "rm",
        "code", "kate", "gedit", "xdg-open", "sh", "bash", "zsh", "fish", "claude", "node", "git", "strings", "sha256sum", "md5sum", "tar", "zip", "unzip",
    ];
    let exe = exe_name.to_lowercase();
    let dir = norm_path(&game_dir.to_string_lossy());
    let dir = dir.trim_end_matches('/');
    procs
        .iter()
        .filter(|p| p.pid != self_pid && p.pid > 1)
        .filter(|p| {
            let Some(first) = p.args.first() else { return false };
            if NOT_GAME.contains(&base_name(first).as_str()) {
                return false;
            }
            p.args.iter().any(|a| {
                let b = base_name(a);
                if b == exe {
                    return true;
                }
                // Crash handler: only the one started from this game's folder.
                b == "unitycrashhandler64.exe" && !dir.is_empty() && norm_path(a).starts_with(&format!("{dir}/"))
            })
        })
        .map(|p| p.pid)
        .collect()
}

#[cfg(not(windows))]
fn list_procs() -> Vec<ProcEntry> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/proc") else { return out };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_string_lossy().parse::<u32>().ok() else { continue };
        let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        if raw.is_empty() || is_zombie(pid) {
            continue;
        }
        let args = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).to_string()).collect();
        out.push(ProcEntry { pid, args });
    }
    out
}

#[cfg(not(windows))]
fn game_pids(exe_name: &str, game_dir: &Path) -> Vec<u32> {
    matching_game_pids(&list_procs(), exe_name, game_dir, std::process::id())
}

#[cfg(not(windows))]
fn signal_pids(pids: &[u32], sig: &str) {
    for pid in pids {
        let _ = Command::new("kill").args([sig, &pid.to_string()]).stderr(std::process::Stdio::null()).status();
    }
}

#[cfg(not(windows))]
fn wait_gone(exe_name: &str, game_dir: &Path, max: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < max {
        if game_pids(exe_name, game_dir).is_empty() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    game_pids(exe_name, game_dir).is_empty()
}

/// End every running instance of the game. Returns true if anything was running.
#[cfg(not(windows))]
fn close_game_processes(exe_name: &str, game_dir: &Path) -> Result<bool, String> {
    let pids = game_pids(exe_name, game_dir);
    if pids.is_empty() {
        return Ok(false);
    }
    signal_pids(&pids, "-TERM");
    if !wait_gone(exe_name, game_dir, std::time::Duration::from_secs(5)) {
        signal_pids(&game_pids(exe_name, game_dir), "-KILL");
        if !wait_gone(exe_name, game_dir, std::time::Duration::from_secs(3)) {
            return Err("The running game wouldn't close - close it yourself and try again.".into());
        }
    }
    // Steam keeps the app marked as running for a moment after the processes are gone; a launch in that window is refused.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    Ok(true)
}

#[cfg(windows)]
fn close_game_processes(exe_name: &str, game_dir: &Path) -> Result<bool, String> {
    if !is_process_running(exe_name) {
        return Ok(false);
    }
    let hidden = |program: &str| {
        let mut c = Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    let _ = hidden("taskkill").args(["/IM", exe_name, "/F", "/T"]).output();
    // The crash handler may outlive its parent: end whatever still runs from the game folder.
    let dir = game_dir.to_string_lossy().replace('\'', "''");
    let _ = hidden("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and $_.ExecutablePath.StartsWith('{dir}', [StringComparison]::OrdinalIgnoreCase) }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
            ),
        ])
        .output();
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(8) {
        if !is_process_running(exe_name) {
            std::thread::sleep(std::time::Duration::from_millis(500));
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("The running game wouldn't close - close it yourself and try again.".into())
}

/// "Test in game": close any running IGTAP first (emits `test-game-status` {phase:"closing"} only if one was running, then {phase:"launching"}), then launch modded; blocking.
pub fn close_then_launch(app: AppHandle) -> Result<LaunchMethod, String> {
    if let Some(game_path) = settings::get_game_path(app.clone()) {
        let game_dir = PathBuf::from(&game_path);
        if let Some(exe) = find_exe(&game_dir) {
            let name = exe.file_name();
            if is_process_running(&name) {
                let _ = app.emit("test-game-status", serde_json::json!({ "phase": "closing" }));
                if let Err(e) = close_game_processes(&name, &game_dir) {
                    let _ = app.emit("test-game-status", serde_json::json!({ "phase": "failed", "error": e }));
                    return Err(e);
                }
            }
        }
    }
    let _ = app.emit("test-game-status", serde_json::json!({ "phase": "launching" }));
    launch_game(app, true)
}

#[cfg(test)]
mod close_tests {
    use super::*;

    fn p(pid: u32, args: &[&str]) -> ProcEntry {
        ProcEntry { pid, args: args.iter().map(|s| s.to_string()).collect() }
    }
    const DIR: &str = "/home/u/.steam/steamapps/common/IGTAP";

    #[test]
    fn matches_only_igtap() {
        let procs = vec![
            p(10, &["Z:\\home\\u\\.steam\\steamapps\\common\\IGTAP\\IGTAPfullGame.exe"]),
            p(11, &["/usr/bin/proton", "waitforexitandrun", "/home/u/.steam/steamapps/common/IGTAP/IGTAPfullGame.exe"]),
            p(12, &["Z:\\home\\u\\.steam\\steamapps\\common\\IGTAP\\UnityCrashHandler64.exe", "--attach"]),
            p(13, &["/usr/bin/wine64", "C:\\Other\\Game\\Game.exe"]),
            p(14, &["Z:\\home\\u\\.steam\\steamapps\\common\\OtherUnity\\UnityCrashHandler64.exe"]),
            p(15, &["/usr/bin/firefox"]),
            p(16, &["vim", "IGTAPfullGame.exe"]),
            p(17, &["/usr/bin/steam", "steam://rungameid/1"]),
            p(18, &["/opt/IGTAPfullGame.exe.bak.sh"]),
            p(19, &["grep", "-r", "IGTAPfullGame.exe", "."]),
            p(20, &["c:\\x\\igtapfullgame.EXE"]),
            p(21, &[]),
        ];
        assert_eq!(matching_game_pids(&procs, "IGTAPfullGame.exe", Path::new(DIR), 0), vec![10, 11, 12, 20]);
    }

    #[test]
    fn never_self_or_init() {
        let procs = vec![p(1, &["IGTAPfullGame.exe"]), p(99, &["IGTAPfullGame.exe"]), p(5, &["IGTAPfullGame.exe"])];
        assert_eq!(matching_game_pids(&procs, "IGTAPfullGame.exe", Path::new(DIR), 99), vec![5]);
    }

    #[test]
    fn empty_when_nothing_runs() {
        assert!(matching_game_pids(&[p(2, &["/bin/sleep", "5"])], "IGTAPfullGame.exe", Path::new(DIR), 0).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn live_dummy_process_is_matched_and_killed() {
        // A copy of `sleep` named like the game, in a temp dir: only it may be matched and ended.
        let dir = std::env::temp_dir().join(format!("rl-igtap-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("IGTAPfullGame.exe");
        std::fs::copy("/bin/sleep", &fake).unwrap();
        let mut child = Command::new(&fake).arg("60").spawn().unwrap();
        let bystander = Command::new("/bin/sleep").arg("60").spawn();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let found = game_pids("IGTAPfullGame.exe", &dir);
        assert_eq!(found, vec![child.id()]);
        signal_pids(&found, "-KILL");
        let _ = child.wait();
        assert!(game_pids("IGTAPfullGame.exe", &dir).is_empty());
        if let Ok(mut b) = bystander {
            assert!(b.try_wait().unwrap().is_none(), "bystander must survive");
            let _ = b.kill();
            let _ = b.wait();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
