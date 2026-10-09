//! Opt-in move from a package install (NSIS, .deb, install.sh --user, AppImage) to the launcher: download and verify it, let it install and stage the app, optionally remove the old install, hand over and quit. User data lives in the shared Tauri data folder, so nothing moves.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEFAULT_BASE: &str = "https://codecade.co.za/recharge";
const MAX_LAUNCHER_BYTES: u64 = 100 * 1024 * 1024;

fn base() -> String {
    std::env::var("RECHARGE_UPDATE_BASE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn platform_id() -> Option<&'static str> {
    if !cfg!(target_arch = "x86_64") {
        return None;
    }
    if cfg!(windows) {
        Some("windows-x64")
    } else if cfg!(target_os = "linux") {
        Some("linux-x64")
    } else {
        None
    }
}

fn log(app: &AppHandle, msg: &str) {
    eprintln!("[migrate] {msg}");
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("migrate.log")) {
        let _ = writeln!(f, "{msg}");
    }
}

#[derive(Deserialize)]
struct HubLauncher {
    version: String,
    sha256: String,
    size: u64,
}

fn fetch_launcher_info(plat: &str) -> Result<HubLauncher, String> {
    let url = format!("{}/update/launcher/{plat}", base());
    let mut r = ureq::get(&url)
        .header("User-Agent", "Recharge")
        .config()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .call()
        .map_err(|e| format!("update server: {e}"))?;
    let j: HubLauncher = r.body_mut().read_json().map_err(|e| format!("bad launcher info: {e}"))?;
    if j.sha256.len() != 64 || !j.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bad launcher info: sha256".into());
    }
    Ok(j)
}

/// What kind of old install this process is, and what we may do about it.
#[derive(Debug, PartialEq)]
enum Old {
    /// Windows NSIS install with its uninstall.exe next to the binary.
    #[cfg_attr(not(windows), allow(dead_code))]
    Nsis(PathBuf),
    /// ~/.local user install from install.sh --user.
    User,
    /// System package: only a command to show.
    Package(String),
    AppImage(PathBuf),
    Unknown,
}

fn detect_old() -> Old {
    let exe = std::env::current_exe().unwrap_or_default();
    #[cfg(windows)]
    {
        let un = exe.parent().map(|d| d.join("uninstall.exe"));
        return match un {
            Some(u) if u.is_file() => Old::Nsis(u),
            _ => Old::Unknown,
        };
    }
    #[cfg(not(windows))]
    {
        if let Some(a) = std::env::var_os("APPIMAGE") {
            return Old::AppImage(a.into());
        }
        if super::launcher::is_user_install() {
            return Old::User;
        }
        if exe.starts_with("/usr") {
            let ok = |cmd: &str, args: &[&str]| Command::new(cmd).args(args).output().map(|o| o.status.success()).unwrap_or(false);
            if ok("dpkg", &["-s", "recharge"]) {
                return Old::Package("sudo apt remove recharge".into());
            }
            if ok("pacman", &["-Qi", "recharge"]) {
                return Old::Package("sudo pacman -R recharge".into());
            }
        }
        Old::Unknown
    }
}

#[derive(Serialize)]
pub struct MigrateInfo {
    available: bool,
    #[serde(rename = "launcherVersion")]
    launcher_version: String,
    /// "nsis" | "user" | "package" | "appimage" | "unknown"
    old: String,
    /// The old install can be removed for the user (opt-in checkbox).
    #[serde(rename = "canCleanup")]
    can_cleanup: bool,
    /// For installs we do not remove: what the user should run / delete afterwards.
    hint: String,
    /// A development / test build (debug, RECHARGE_NO_LIVE / RECHARGE_LIVE_LOCAL, or run from a cargo target dir): never offered the switch-over.
    dev: bool,
}

/// True for a path inside a cargo target dir (target/release, target/debug, or a CARGO_TARGET_DIR named cargo-target-*).
fn path_is_cargo_target(p: &Path) -> bool {
    let s = p.to_string_lossy().replace('\\', "/");
    s.contains("/target/release/")
        || s.contains("/target/debug/")
        || p.components().any(|c| c.as_os_str().to_string_lossy().starts_with("cargo-target-"))
}

fn is_dev_build() -> bool {
    cfg!(debug_assertions)
        || std::env::var_os("RECHARGE_NO_LIVE").is_some()
        || std::env::var_os("RECHARGE_LIVE_LOCAL").is_some()
        || std::env::current_exe().map(|p| path_is_cargo_target(&p)).unwrap_or(false)
}

fn describe(old: &Old) -> (&'static str, bool, String) {
    match old {
        Old::Nsis(_) => ("nsis", true, String::new()),
        Old::User => ("user", true, String::new()),
        Old::Package(cmd) => ("package", false, format!("Afterwards, remove the old package with: {cmd}")),
        Old::AppImage(p) => ("appimage", false, format!("Afterwards, you can delete the old AppImage: {}", p.display())),
        Old::Unknown => ("unknown", false, String::new()),
    }
}

#[tauri::command]
pub async fn migrate_info(_app: AppHandle) -> MigrateInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let none = MigrateInfo { available: false, launcher_version: String::new(), old: "unknown".into(), can_cleanup: false, hint: String::new(), dev: false };
        if super::updater::is_managed() {
            return none;
        }
        if is_dev_build() {
            return MigrateInfo { dev: true, ..none };
        }
        let Some(plat) = platform_id() else { return none };
        let Ok(l) = fetch_launcher_info(plat) else { return none };
        let (old, can_cleanup, hint) = describe(&detect_old());
        MigrateInfo { available: true, launcher_version: l.version, old: old.into(), can_cleanup, hint, dev: false }
    })
    .await
    .unwrap_or(MigrateInfo { available: false, launcher_version: String::new(), old: "unknown".into(), can_cleanup: false, hint: String::new(), dev: false })
}

/// Download `sha` to `dest`, checking size and hash; nothing is left behind on failure.
fn download_verified(plat_url: &str, want: &HubLauncher, dest: &Path) -> Result<(), String> {
    let mut r = ureq::get(plat_url)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| format!("couldn't download the launcher: {e}"))?;
    let mut reader = r.body_mut().with_config().limit(MAX_LAUNCHER_BYTES).reader();
    let mut out = std::fs::File::create(dest).map_err(|e| format!("couldn't save the launcher: {e}"))?;
    let (mut h, mut n, mut buf) = (Sha256::new(), 0u64, vec![0u8; 64 * 1024]);
    let res = (|| loop {
        let k = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if k == 0 {
            return Ok(());
        }
        h.update(&buf[..k]);
        n += k as u64;
        out.write_all(&buf[..k]).map_err(|e| format!("couldn't save the launcher: {e}"))?;
    })();
    drop(out);
    let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let res = res.and_then(|_| {
        if n != want.size {
            Err(format!("launcher download has the wrong size ({n} instead of {})", want.size))
        } else if !digest.eq_ignore_ascii_case(&want.sha256) {
            Err("launcher download failed its checksum - not running it".to_string())
        } else {
            Ok(())
        }
    });
    if res.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    res
}

#[cfg(unix)]
fn make_exec(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = std::fs::metadata(p) {
        let mut perm = m.permissions();
        perm.set_mode(0o755);
        let _ = std::fs::set_permissions(p, perm);
    }
}
#[cfg(not(unix))]
fn make_exec(_: &Path) {}

/// Remove the files install.sh --user copied out of the .deb: exact names only, never a folder we do not own (~/.local/share/recharge is also the launcher's root).
#[cfg(not(windows))]
fn remove_user_install(app: &AppHandle) -> Result<(), String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("no HOME")?);
    let p = home.join(".local");
    let mut gone = vec![
        p.join("bin/recharge"),
        p.join("share/applications/Recharge.desktop"),
        p.join("share/recharge/.user-install"),
    ];
    if let Ok(rd) = std::fs::read_dir(p.join("share/icons/hicolor")) {
        gone.extend(rd.flatten().map(|d| d.path().join("apps/recharge.png")));
    }
    for f in gone.iter().filter(|f| f.is_file()) {
        match std::fs::remove_file(f) {
            Ok(()) => log(app, &format!("removed {}", f.display())),
            Err(e) => log(app, &format!("could not remove {}: {e}", f.display())),
        }
    }
    let lib = p.join("lib/Recharge");
    if lib.join("loader").is_dir() || lib.join("electron").is_dir() {
        let _ = std::fs::remove_dir_all(&lib);
        log(app, &format!("removed {}", lib.display()));
    }
    Ok(())
}

/// Shown when the hand-over could not be confirmed; the install itself is complete by then.
const START_FROM_MENU: &str = "The new Recharge is installed - start it from your apps menu (Recharge).";
/// No growth in the download for this long means it is stuck.
const IDLE_LIMIT: Duration = Duration::from_secs(180);

#[derive(Serialize, Clone)]
struct Progress<'a> {
    phase: &'a str,
    message: String,
    done: u64,
    total: u64,
}

/// Progress for the settings UI (migrate-ui.js listens for "migrate-progress").
fn emit(app: &AppHandle, phase: &str, message: impl Into<String>, done: u64, total: u64) {
    use tauri::Emitter;
    let _ = app.emit("migrate-progress", Progress { phase, message: message.into(), done, total });
}

/// Total bytes the launcher announces in its log ("staging 4.0.0 (build 18): 221 file(s) to fetch (68223193 bytes)").
fn parse_total(log: &str) -> Option<u64> {
    let line = log.lines().rev().find(|l| l.contains("file(s) to fetch"))?;
    let tail = line.rsplit('(').next()?;
    tail.strip_suffix(" bytes)")?.trim().parse().ok()
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Windows: leave the job object / console the old app sits in. Unix: own process group, so killing the group takes the launcher and its installed copy together.
fn detach_flags(c: &mut Command, breakaway: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = breakaway;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP (| CREATE_BREAKAWAY_FROM_JOB)
        c.creation_flags(0x0000_0008 | 0x0800_0000 | 0x0000_0200 | if breakaway { 0x0100_0000 } else { 0 });
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", child.id())]).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Start `prog args` fully detached with cwd `cwd` (never a folder inside the install: the launcher swaps and deletes those), strongest detachment first; returns the pid of the one that stuck.
fn spawn_detached(app: &AppHandle, prog: &Path, args: &[String], cwd: &Path) -> Result<u32, String> {
    let mut attempts: Vec<(&str, Command)> = Vec::new();
    for (label, breakaway) in [("breakaway", true), ("detached", false)] {
        if !breakaway || cfg!(windows) {
            let mut c = Command::new(prog);
            c.args(args);
            detach_flags(&mut c, breakaway);
            attempts.push((label, c));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/c", "start", "", "/b"]).arg(prog).args(args).creation_flags(0x0800_0000);
        attempts.push(("cmd-start", c));
    }
    #[cfg(unix)]
    {
        // nohup through a shell as a last resort (some sandboxes refuse setpgid).
        let mut c = Command::new("sh");
        c.arg("-c").arg("nohup \"$0\" \"$@\" >/dev/null 2>&1 &").arg(prog).args(args);
        attempts.push(("sh-nohup", c));
    }
    let mut errors = Vec::new();
    for (label, mut c) in attempts {
        c.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match c.spawn() {
            Ok(mut child) => {
                std::thread::sleep(Duration::from_millis(500));
                match child.try_wait() {
                    Ok(Some(st)) if !st.success() => {
                        let e = format!("{label}: exited at once with {st}");
                        log(app, &e);
                        errors.push(e);
                    }
                    _ => {
                        log(app, &format!("{label}: started pid {}", child.id()));
                        return Ok(child.id());
                    }
                }
            }
            Err(e) => {
                let e = format!("{label}: {e}");
                log(app, &format!("spawn failed, {e}"));
                errors.push(e);
            }
        }
    }
    Err(errors.join("; "))
}

/// The migration. `cleanup` = also remove the old install when we are able to.
#[tauri::command]
pub async fn migrate_to_launcher(app: AppHandle, cleanup: bool) -> Result<String, String> {
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || migrate_blocking(&a, cleanup))
        .await
        .map_err(|e| format!("migration task panicked: {e}"))?;
    if let Err(e) = &r {
        log(&app, &format!("migration failed: {e}"));
        emit(&app, "error", e.clone(), 0, 0);
    }
    r
}

fn migrate_blocking(app: &AppHandle, cleanup: bool) -> Result<String, String> {
    if super::updater::is_managed() {
        return Err("this install is already managed by the Recharge launcher".into());
    }
    let plat = platform_id().ok_or("the Recharge launcher isn't available for this platform")?;
    emit(app, "launcher", "Contacting the update server...", 0, 0);
    let info = fetch_launcher_info(plat)?;
    log(app, &format!("migrating to launcher {} ({plat}), cleanup={cleanup}", info.version));

    let tmp = std::env::temp_dir().join(format!("recharge-migrate-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("couldn't create a temp folder: {e}"))?;
    let result = migrate_in(app, cleanup, plat, &info, &tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn migrate_in(app: &AppHandle, cleanup: bool, _plat: &str, info: &HubLauncher, tmp: &Path) -> Result<String, String> {
    let launcher = tmp.join(if cfg!(windows) { "Recharge.exe" } else { "recharge-launcher" });
    let url = format!("{}/update/files/{}", base(), info.sha256);
    emit(app, "launcher", "Downloading the Recharge launcher...", 0, 0);
    download_verified(&url, info, &launcher).map_err(|e| {
        log(app, &e);
        e
    })?;
    make_exec(&launcher);
    log(app, "launcher downloaded and verified");

    // Step 1: the launcher installs itself and stages the app (nothing is removed yet). Output goes to a file, not a pipe, which anything the launcher leaves running would hold open forever; we poll the child and give up when it stalls.
    let channel = super::settings::update_channel(app);
    let installed = installed_launcher_path()?;
    let root = installed.parent().map(Path::to_path_buf).ok_or("no launcher folder")?;
    let stage_log = tmp.join("stage.log");
    let out = std::fs::File::create(&stage_log).map_err(|e| format!("couldn't create a temp file: {e}"))?;
    let mut c = Command::new(&launcher);
    c.args(["--stage", "--no-ui", "--channel", &channel])
        .current_dir(tmp)
        .stdin(Stdio::null())
        .stdout(out.try_clone().map_err(|e| e.to_string())?)
        .stderr(out);
    detach_flags(&mut c, false);
    let mut child = c.spawn().map_err(|e| format!("couldn't run the launcher: {e}"))?;
    let (mut last_change, mut last_key) = (Instant::now(), (0u64, 0u64));
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(format!("couldn't wait for the launcher: {e}")),
        }
        let text = std::fs::read_to_string(&stage_log).unwrap_or_default();
        let done = dir_size(&root.join("app.new"));
        let total = parse_total(&text).unwrap_or(0);
        if (text.len() as u64, done) != last_key {
            last_key = (text.len() as u64, done);
            last_change = Instant::now();
        }
        let msg = if total > 0 {
            format!("Downloading the new Recharge: {:.0} MB of {:.0} MB", done as f64 / 1e6, total as f64 / 1e6)
        } else {
            "Setting up the new Recharge...".to_string()
        };
        emit(app, "download", msg, done, total);
        if last_change.elapsed() > IDLE_LIMIT {
            kill_tree(&mut child);
            log(app, "launcher --stage stalled, killed");
            return Err("The download stalled - check your connection and try again.".into());
        }
        std::thread::sleep(Duration::from_millis(400));
    };
    let text = std::fs::read_to_string(&stage_log).unwrap_or_default();
    log(app, &format!("launcher --stage: {status} / {}", text.trim().replace('\n', " | ")));
    // "staged N" or "up to date" (an earlier attempt already installed everything) are both fine.
    if !status.success() {
        let last = text.lines().rev().find(|l| l.contains("stage failed")).or(text.lines().last()).unwrap_or("launcher failed");
        return Err(format!("the new install couldn't be prepared: {last}"));
    }
    if !installed.is_file() {
        return Err(format!("the launcher didn't install itself to {}", installed.display()));
    }
    emit(app, "handover", "Starting the new Recharge...", 0, 0);

    // Step 2: hand over to the installed launcher (waits for our exit, swaps app.new in, creates menu entries, starts the app) and quit; if it cannot start, the user starts it from the menu.
    let pid = std::process::id().to_string();
    let old = detect_old();
    let (prog, args): (PathBuf, Vec<String>);
    #[cfg(windows)]
    {
        let mut line_args = vec!["--no-ui".to_string(), "--wait-pid".into(), pid.clone(), "--channel".into(), channel.clone()];
        if let (true, Old::Nsis(un)) = (cleanup, &old) {
            // Uninstall the old version first, then start the launcher: a small batch file in the root.
            let dir = un.parent().unwrap_or(Path::new("."));
            // _?= makes the uninstaller run in place and block, so the launcher starts after it.
            let bat = root.join("handover.cmd");
            let body = format!(
                "@echo off\r\nping -n 3 127.0.0.1 >nul\r\n\"{}\" /S _?={}\r\n\"{}\" {}\r\ndel \"%~f0\"\r\n",
                un.display(),
                dir.display(),
                installed.display(),
                line_args.join(" ")
            );
            std::fs::write(&bat, body).map_err(|e| format!("couldn't prepare the hand-over: {e}"))?;
            log(app, &format!("will run the old uninstaller {}", un.display()));
            prog = PathBuf::from("cmd");
            line_args = vec!["/C".into(), bat.display().to_string()];
        } else {
            prog = installed.clone();
        }
        args = line_args;
    }
    #[cfg(not(windows))]
    {
        prog = installed.clone();
        args = vec!["--no-ui".into(), "--wait-pid".into(), pid, "--channel".into(), channel.clone()];
    }
    // cwd = the install root: never the old app's folder (it may be removed) or our temp dir.
    if let Err(e) = spawn_detached(app, &prog, &args, &root) {
        log(app, &format!("hand-over failed: {e}"));
        return Err(format!("{START_FROM_MENU} ({e})"));
    }
    #[cfg(not(windows))]
    if cleanup && old == Old::User {
        remove_user_install(app)?;
    }
    log(app, "handed over to the launcher, quitting");
    let (_, _, hint) = describe(&old);
    emit(app, "done", "Restarting into the new Recharge...", 0, 0);
    // Exit for real even if the webview is slow to close: the launcher waits for this pid.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        std::process::exit(0);
    });
    app.exit(0);
    Ok(hint)
}

/// Where the launcher puts its own copy: mirrors launcher/src/install.rs default_root().
fn installed_launcher_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    #[cfg(windows)]
    let (base, name, exe) = (std::env::var_os("LOCALAPPDATA").map(PathBuf::from), "Recharge", "recharge-launcher.exe");
    #[cfg(not(windows))]
    let (base, name, exe) = (base, "recharge", "recharge-launcher");
    Ok(base.ok_or("no local data folder")?.join(name).join(exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_target_paths_are_dev_builds() {
        assert!(path_is_cargo_target(Path::new("/home/o/Recharge/app/src-tauri/target/release/recharge")));
        assert!(path_is_cargo_target(Path::new("/x/target/debug/recharge")));
        assert!(path_is_cargo_target(Path::new("/run/media/o/Drive/claude-activity/cargo-target-app/release/recharge")));
        assert!(!path_is_cargo_target(Path::new("/usr/bin/recharge")));
        assert!(!path_is_cargo_target(Path::new("/opt/Recharge/recharge")));
        assert!(!path_is_cargo_target(Path::new("/home/o/.local/share/recharge/app/recharge")));
    }

    #[test]
    fn total_is_read_from_the_launcher_log() {
        let l = "first install\nstaging 4.0.0-beta8 (build 18): 221 file(s) to fetch (68223193 bytes)\n";
        assert_eq!(parse_total(l), Some(68223193));
        assert_eq!(parse_total("nothing"), None);
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let d = std::env::temp_dir().join(format!("rl-mig-size-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::write(d.join("x"), [0u8; 10]).unwrap();
        std::fs::write(d.join("a/b/y"), [0u8; 5]).unwrap();
        assert_eq!(dir_size(&d), 15);
        assert_eq!(dir_size(&d.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
