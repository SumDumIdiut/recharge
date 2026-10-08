//! Opt-in move from a package install (NSIS .exe, .deb, ~/.local user install, AppImage) to the
//! Recharge launcher: download the launcher from the update hub, verify it, let it install and
//! stage the app, optionally remove the old install, then hand over and quit.
//!
//! Settings, mods and saved maps live in the Tauri data folder keyed by the app identifier
//! (co.za.codecade.recharge), which both installs share, so nothing moves.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
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
        let none = MigrateInfo { available: false, launcher_version: String::new(), old: "unknown".into(), can_cleanup: false, hint: String::new() };
        if super::updater::is_managed() {
            return none;
        }
        let Some(plat) = platform_id() else { return none };
        let Ok(l) = fetch_launcher_info(plat) else { return none };
        let (old, can_cleanup, hint) = describe(&detect_old());
        MigrateInfo { available: true, launcher_version: l.version, old: old.into(), can_cleanup, hint }
    })
    .await
    .unwrap_or(MigrateInfo { available: false, launcher_version: String::new(), old: "unknown".into(), can_cleanup: false, hint: String::new() })
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

/// Remove the files install.sh --user copied out of the .deb. Only exact names, never a folder
/// we do not own (~/.local/share/recharge is also the launcher's root).
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

fn spawn_detached(mut c: Command) -> Result<(), String> {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0000_0008 | 0x0800_0000 | 0x0000_0200);
    }
    c.spawn().map(|_| ()).map_err(|e| format!("couldn't start the launcher: {e}"))
}

/// The migration. `cleanup` = also remove the old install when we are able to.
#[tauri::command]
pub async fn migrate_to_launcher(app: AppHandle, cleanup: bool) -> Result<String, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || migrate_blocking(&a, cleanup))
        .await
        .map_err(|e| format!("migration task panicked: {e}"))?
}

fn migrate_blocking(app: &AppHandle, cleanup: bool) -> Result<String, String> {
    if super::updater::is_managed() {
        return Err("this install is already managed by the Recharge launcher".into());
    }
    let plat = platform_id().ok_or("the Recharge launcher isn't available for this platform")?;
    let info = fetch_launcher_info(plat)?;
    log(app, &format!("migrating to launcher {} ({plat}), cleanup={cleanup}", info.version));

    let tmp = std::env::temp_dir().join(format!("recharge-migrate-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("couldn't create a temp folder: {e}"))?;
    let launcher = tmp.join(if cfg!(windows) { "Recharge.exe" } else { "recharge-launcher" });
    let url = format!("{}/update/files/{}", base(), info.sha256);
    download_verified(&url, &info, &launcher).map_err(|e| {
        log(app, &e);
        let _ = std::fs::remove_dir_all(&tmp);
        e
    })?;
    make_exec(&launcher);
    log(app, "launcher downloaded and verified");

    // Step 1: the launcher installs itself and downloads the app (staged only: this install keeps
    // working and nothing is removed until we know the new one is complete).
    let channel = super::settings::update_channel(app);
    let out = {
        let mut c = Command::new(&launcher);
        c.args(["--stage", "--no-ui", "--channel", &channel]).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.output().map_err(|e| format!("couldn't run the launcher: {e}"))?
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    log(app, &format!("launcher --stage: {} / {}", out.status, text.trim()));
    // "staged N" or "up to date" (an earlier attempt already installed everything) are both fine.
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("the new install couldn't be prepared: {}", text.lines().last().unwrap_or("launcher failed")));
    }

    // The launcher copied itself to its install folder; run that copy from now on.
    let installed = installed_launcher_path(&launcher)?;
    let pid = std::process::id().to_string();
    let old = detect_old();

    // Step 2: remove the old install (opt-in) and hand over.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut script = String::from("ping -n 3 127.0.0.1 >nul");
        if let (true, Old::Nsis(un)) = (cleanup, &old) {
            let dir = un.parent().unwrap_or(Path::new("."));
            // _?= makes the uninstaller run in place and block, so the launcher starts after it.
            script.push_str(&format!(" & \"{}\" /S _?={}", un.display(), dir.display()));
            log(app, &format!("will run the old uninstaller {}", un.display()));
        }
        script.push_str(&format!(" & start \"\" \"{}\" --no-ui --wait-pid {pid}", installed.display()));
        let mut c = Command::new("cmd");
        c.arg("/C").raw_arg(format!("\"{script}\""));
        spawn_detached(c)?;
    }
    #[cfg(not(windows))]
    {
        if cleanup && old == Old::User {
            remove_user_install(app)?;
        }
        let mut c = Command::new(&installed);
        c.args(["--no-ui", "--wait-pid", &pid]);
        spawn_detached(c)?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    log(app, "handed over to the launcher, quitting");
    let (_, _, hint) = describe(&old);
    app.exit(0);
    Ok(hint)
}

/// Where the launcher put its own copy: mirrors launcher/src/install.rs default_root().
fn installed_launcher_path(_downloaded: &Path) -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    #[cfg(windows)]
    let (base, name, exe) = (std::env::var_os("LOCALAPPDATA").map(PathBuf::from), "Recharge", "recharge-launcher.exe");
    #[cfg(not(windows))]
    let (base, name, exe) = (base, "recharge", "recharge-launcher");
    let p = base.ok_or("no local data folder")?.join(name).join(exe);
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!("the launcher didn't install itself to {}", p.display()))
    }
}
