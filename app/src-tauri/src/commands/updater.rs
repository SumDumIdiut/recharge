//! Glue to the one-file Recharge launcher. Only active when the launcher started us
//! (RECHARGE_LAUNCHER + RECHARGE_INSTALL_ROOT set); otherwise every command reports "not managed".
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const CHECK_EVERY: Duration = Duration::from_secs(20 * 60);
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(15);

/// What the launcher told us through the environment.
#[derive(Clone, Debug, PartialEq)]
pub struct Managed {
    pub launcher: PathBuf,
    pub root: PathBuf,
    pub build: String,
    /// Version string of the running tree (RECHARGE_VERSION, e.g. 4.0.0-beta1); empty from older launchers.
    pub version: String,
    pub channel: String,
}

impl Managed {
    pub fn from_env() -> Option<Managed> {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    fn from_vars(get: impl Fn(&str) -> Option<String>) -> Option<Managed> {
        let launcher = get("RECHARGE_LAUNCHER").filter(|s| !s.is_empty())?;
        let root = get("RECHARGE_INSTALL_ROOT").filter(|s| !s.is_empty())?;
        Some(Managed {
            launcher: launcher.into(),
            root: root.into(),
            build: get("RECHARGE_BUILD").unwrap_or_default().trim().to_string(),
            version: get("RECHARGE_VERSION").unwrap_or_default().trim().to_string(),
            channel: if get("RECHARGE_CHANNEL").as_deref() == Some("beta") { "beta" } else { "stable" }.into(),
        })
    }

    /// The launcher's health check looks for exactly this file.
    fn marker_path(&self) -> PathBuf {
        self.root.join(format!("started-{}.ok", self.build))
    }

    fn write_started_marker(&self) -> std::io::Result<()> {
        if self.build.is_empty() || !self.build.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(()); // no build number (launcher too old): nothing to confirm
        }
        std::fs::write(self.marker_path(), b"ok")
    }
}

/// `--stage` prints "staged <build>" or "up to date".
fn parse_stage_output(out: &str) -> Option<u64> {
    out.lines().rev().find_map(|l| l.trim().strip_prefix("staged ")?.trim().parse().ok())
}

#[derive(Default)]
pub struct UpdaterState {
    /// Build waiting in app.new/ (set by the background check or "Check for updates").
    ready: Mutex<Option<u64>>,
}

fn managed(app: &AppHandle) -> Option<Managed> {
    Managed::from_env().filter(|_| app.try_state::<UpdaterState>().is_some())
}

/// Hidden launcher child (no console window on Windows).
fn launcher_cmd(m: &Managed) -> Command {
    #[allow(unused_mut)] // only mutated on Windows
    let mut c = Command::new(&m.launcher);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn run_stage(m: &Managed) -> Result<Option<u64>, String> {
    let out = launcher_cmd(m)
        .args(["--stage", "--no-ui"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run the launcher: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(text.lines().last().unwrap_or("launcher failed").to_string());
    }
    Ok(parse_stage_output(&text))
}

fn check_and_notify(app: &AppHandle, m: &Managed) -> Result<Option<u64>, String> {
    let staged = run_stage(m)?;
    *app.state::<UpdaterState>().ready.lock().unwrap() = staged;
    if let Some(b) = staged {
        let _ = app.emit("launcher-update-ready", b);
    }
    Ok(staged)
}

pub fn init(app: &AppHandle) {
    app.manage(UpdaterState::default());
    let Some(m) = Managed::from_env() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        // The window exists once setup is over; wait for it so the marker means "the UI came up".
        for _ in 0..100 {
            if app.get_webview_window("main").is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = m.write_started_marker();
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            let _ = check_and_notify(&app, &m);
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// The launcher starts the next process once we are gone, so detach it from us.
fn spawn_detached(m: &Managed, args: &[&str]) -> Result<(), String> {
    let mut c = Command::new(&m.launcher);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0000_0008 | 0x0800_0000 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    c.spawn().map(|_| ()).map_err(|e| format!("couldn't start the launcher: {e}"))
}

fn write_channel_file(root: &Path, channel: &str) -> std::io::Result<()> {
    std::fs::write(root.join("channel.txt"), channel)
}

fn read_channel_file(root: &Path) -> Option<String> {
    match std::fs::read_to_string(root.join("channel.txt")).ok()?.trim() {
        c @ ("stable" | "beta") => Some(c.to_string()),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct LauncherInfo {
    managed: bool,
    build: String,
    /// Version of the running install, e.g. "4.0.0-beta1" (empty when unknown).
    version: String,
    channel: String,
    /// Build staged and waiting for a restart.
    ready: Option<u64>,
    /// Version of the staged build (from app.new.json), when one is waiting.
    #[serde(rename = "readyVersion")]
    ready_version: Option<String>,
}

/// Fields of the launcher's state.json / app.new.json we care about.
#[derive(serde::Deserialize, Default)]
struct SnapFile {
    #[serde(default)]
    version: String,
    #[serde(default)]
    build: u64,
    #[serde(default)]
    channel: String,
}

#[derive(serde::Deserialize, Default)]
struct StateFile {
    current: Option<SnapFile>,
}

fn read_current(root: &Path) -> Option<SnapFile> {
    serde_json::from_slice::<StateFile>(&std::fs::read(root.join("state.json")).ok()?).ok()?.current
}

/// The fully staged build waiting in app.new/ (the launcher writes app.new.json only once complete).
fn read_staged(root: &Path) -> Option<SnapFile> {
    if !root.join("app.new").is_dir() {
        return None;
    }
    serde_json::from_slice(&std::fs::read(root.join("app.new.json")).ok()?).ok()
}

fn info_from(m: &Managed, ready: Option<u64>) -> LauncherInfo {
    let cur = read_current(&m.root);
    let staged = read_staged(&m.root);
    let cur_build: Option<u64> = m.build.parse().ok().or(cur.as_ref().map(|c| c.build));
    // A staged tree of the build we are already running is not an update.
    let staged = staged.filter(|s| Some(s.build) != cur_build);
    let ready = ready.or(staged.as_ref().map(|s| s.build));
    let version = Some(m.version.clone()).filter(|v| !v.is_empty()).or(cur.as_ref().map(|c| c.version.clone()).filter(|v| !v.is_empty()));
    // channel.txt wins over the env and state.json: it changes while we run.
    let channel = read_channel_file(&m.root)
        .or(cur.map(|c| c.channel).filter(|c| c == "stable" || c == "beta"))
        .unwrap_or_else(|| m.channel.clone());
    LauncherInfo {
        managed: true,
        build: m.build.clone(),
        version: version.unwrap_or_default(),
        channel,
        ready,
        ready_version: staged.map(|s| s.version).filter(|v| !v.is_empty()),
    }
}

#[tauri::command]
pub fn launcher_info(app: AppHandle) -> LauncherInfo {
    match managed(&app) {
        Some(m) => {
            let ready = *app.state::<UpdaterState>().ready.lock().unwrap();
            info_from(&m, ready)
        }
        None => LauncherInfo { managed: false, build: String::new(), version: String::new(), channel: String::new(), ready: None, ready_version: None },
    }
}

/// "Check for updates": returns the staged build, if any.
#[tauri::command]
pub async fn launcher_check_now(app: AppHandle) -> Result<Option<u64>, String> {
    let m = managed(&app).ok_or("not started by the Recharge launcher")?;
    tauri::async_runtime::spawn_blocking(move || check_and_notify(&app, &m))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes the launcher's channel.txt and keeps the app's own channel setting in step.
#[tauri::command]
pub fn launcher_set_channel(app: AppHandle, channel: String) -> Result<(), String> {
    if channel != "stable" && channel != "beta" {
        return Err(format!("unknown channel: {channel}"));
    }
    let m = managed(&app).ok_or("not started by the Recharge launcher")?;
    write_channel_file(&m.root, &channel).map_err(|e| format!("couldn't save the channel: {e}"))?;
    super::settings::save_update_channel(&app, &channel);
    *app.state::<UpdaterState>().ready.lock().unwrap() = None; // belongs to the old channel
    Ok(())
}

/// "Restart to update" (repair = false) or "Repair install": hand over to the launcher and quit.
#[tauri::command]
pub fn launcher_restart(app: AppHandle, repair: bool) -> Result<(), String> {
    let m = managed(&app).ok_or("not started by the Recharge launcher")?;
    let pid = std::process::id().to_string();
    if repair {
        spawn_detached(&m, &["--repair", "--wait-pid", &pid])?;
    } else {
        spawn_detached(&m, &["--wait-pid", &pid, "--no-ui"])?;
    }
    app.exit(0);
    Ok(())
}

/// Settings > Uninstall Recharge: optionally put the game back to vanilla (RechargeLoader removed),
/// then hand over to the launcher's uninstaller (it waits for us to exit) and quit.
#[tauri::command]
pub fn launcher_uninstall(app: AppHandle, delete_data: bool, restore_game: bool) -> Result<(), String> {
    let m = managed(&app).ok_or("this install isn't managed by the Recharge launcher")?;
    if restore_game {
        super::loader::uninstall_loader(app.clone())?;
    }
    let pid = std::process::id().to_string();
    let mut args = uninstall_args(delete_data);
    args.extend(["--wait-pid".to_string(), pid]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    spawn_detached(&m, &refs)?;
    app.exit(0);
    Ok(())
}

fn uninstall_args(delete_data: bool) -> Vec<String> {
    let mut a = vec!["--uninstall".to_string(), "--yes".to_string()];
    if delete_data {
        a.push("--delete-data".into());
    }
    a
}

/// Folder holding the running binary when the launcher manages this install (the launcher lays
/// loader/, electron/, src/ out right next to it). None otherwise.
pub fn packaged_root() -> Option<PathBuf> {
    if !is_managed() {
        return None;
    }
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// A bundled resource: next to the binary for launcher installs (Tauri's own lookup would point
/// at /usr/lib/Recharge on Linux), Tauri's resource dir for everything else.
pub fn resource_path(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    if let Some(p) = packaged_root().map(|r| r.join(rel)).filter(|p| p.exists()) {
        return Ok(p);
    }
    app.path().resolve(rel, tauri::path::BaseDirectory::Resource).map_err(|e| e.to_string())
}

/// The launcher owns package updates; commands/launcher.rs checks this.
pub fn is_managed() -> bool {
    Managed::from_env().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn managed_needs_both_launcher_and_root() {
        assert!(Managed::from_vars(vars(&[])).is_none());
        assert!(Managed::from_vars(vars(&[("RECHARGE_LAUNCHER", "/l")])).is_none());
        assert!(Managed::from_vars(vars(&[("RECHARGE_INSTALL_ROOT", "/r")])).is_none());
        assert!(Managed::from_vars(vars(&[("RECHARGE_LAUNCHER", ""), ("RECHARGE_INSTALL_ROOT", "/r")])).is_none());
        let m = Managed::from_vars(vars(&[("RECHARGE_LAUNCHER", "/l"), ("RECHARGE_INSTALL_ROOT", "/r"), ("RECHARGE_BUILD", "12"), ("RECHARGE_CHANNEL", "beta")])).unwrap();
        assert_eq!((m.build.as_str(), m.channel.as_str()), ("12", "beta"));
    }

    #[test]
    fn unknown_channel_falls_back_to_stable() {
        let m = Managed::from_vars(vars(&[("RECHARGE_LAUNCHER", "/l"), ("RECHARGE_INSTALL_ROOT", "/r"), ("RECHARGE_CHANNEL", "x")])).unwrap();
        assert_eq!(m.channel, "stable");
    }

    #[test]
    fn started_marker_written_for_the_build_only() {
        let d = std::env::temp_dir().join(format!("rl-app-marker-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let mk = |build: &str| Managed { launcher: "/l".into(), root: d.clone(), build: build.into(), version: String::new(), channel: "stable".into() };
        mk("7").write_started_marker().unwrap();
        assert!(d.join("started-7.ok").is_file());
        mk("").write_started_marker().unwrap();
        mk("../x").write_started_marker().unwrap();
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
        write_channel_file(&d, "beta").unwrap();
        assert_eq!(read_channel_file(&d).as_deref(), Some("beta"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn stage_output_parsing() {
        assert_eq!(parse_stage_output("staged 42\n"), Some(42));
        assert_eq!(parse_stage_output("up to date\n"), None);
        assert_eq!(parse_stage_output("staged x\n"), None);
        assert_eq!(parse_stage_output(""), None);
    }

    #[test]
    fn info_reads_version_channel_and_staged_from_the_launcher_files() {
        let d = std::env::temp_dir().join(format!("rl-app-info-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("state.json"), br#"{"current":{"version":"4.0.0-beta1","build":10,"channel":"beta","launch":"x"},"pending":null}"#).unwrap();
        let m = Managed { launcher: "/l".into(), root: d.clone(), build: "10".into(), version: String::new(), channel: "stable".into() };
        let i = info_from(&m, None);
        assert_eq!((i.version.as_str(), i.channel.as_str(), i.ready, i.ready_version.clone()), ("4.0.0-beta1", "beta", None, None));
        // staged marker without app.new/ is not a ready update
        std::fs::write(d.join("app.new.json"), br#"{"version":"4.0.0-beta2","build":11,"channel":"beta"}"#).unwrap();
        assert_eq!(info_from(&m, None).ready, None);
        std::fs::create_dir_all(d.join("app.new")).unwrap();
        let i = info_from(&m, None);
        assert_eq!((i.ready, i.ready_version.as_deref()), (Some(11), Some("4.0.0-beta2")));
        // channel.txt and RECHARGE_VERSION win
        write_channel_file(&d, "stable").unwrap();
        let m2 = Managed { version: "9.9.9".into(), ..m.clone() };
        let i = info_from(&m2, None);
        assert_eq!((i.version.as_str(), i.channel.as_str()), ("9.9.9", "stable"));
        // the build we already run is not an update
        std::fs::write(d.join("app.new.json"), br#"{"version":"4.0.0-beta1","build":10}"#).unwrap();
        assert_eq!(info_from(&m, None).ready, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn uninstall_args_are_unattended_and_data_is_opt_in() {
        assert_eq!(uninstall_args(false), ["--uninstall", "--yes"]);
        assert_eq!(uninstall_args(true), ["--uninstall", "--yes", "--delete-data"]);
    }
}
