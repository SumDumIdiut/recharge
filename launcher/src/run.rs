//! Starting the app, "is it running" tracking and the post-update health check.
use crate::log;
use crate::state::Snapshot;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

fn pid_file(root: &Path) -> PathBuf { root.join("running.pid") }
pub fn started_marker(root: &Path, build: u64) -> PathBuf { root.join(format!("started-{build}.ok")) }

/// The launcher records the pid it spawned; the app counts as running while it is alive (updates only swap when it is not).
pub fn app_running(root: &Path) -> bool {
    fs::read_to_string(pid_file(root))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .map(pid_alive)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub fn pid_alive(pid: u32) -> bool {
    // State 'Z' = exited but not yet reaped: not running.
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|s| s.rsplit(')').next().map(|r| !r.trim_start().starts_with('Z')).unwrap_or(false))
        .unwrap_or(false)
}
#[cfg(all(unix, not(target_os = "linux")))]
pub fn pid_alive(pid: u32) -> bool {
    Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
}
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| tasklist_has_pid(&String::from_utf8_lossy(&o.stdout), pid))
        .unwrap_or(false)
}

/// `tasklist /FO CSV /NH` rows: match the pid field exactly (a substring test also hit memory columns like "1,234 K").
pub fn tasklist_has_pid(out: &str, pid: u32) -> bool {
    out.lines().any(|l| l.split("\",\"").nth(1).map(|f| f.trim_matches('"') == pid.to_string()).unwrap_or(false))
}

/// Forget a pid file whose process is gone (or never was ours): it must not block a swap.
pub fn clear_pid_file(root: &Path) {
    let _ = fs::remove_file(pid_file(root));
}

/// Poll until `pid` is gone. False on timeout.
pub fn wait_exit(pid: u32, max: Duration) -> bool {
    let t0 = Instant::now();
    while pid_alive(pid) {
        if t0.elapsed() > max {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

/// Spawn app/<launch> with the env the app uses to ask for updates/restarts later.
pub fn launch(root: &Path, launcher_exe: &Path, snap: &Snapshot, channel: &str, args: &[OsString]) -> std::io::Result<Child> {
    let app = root.join("app");
    let exe = app.join(&snap.launch);
    // Stale marker from an earlier attempt of this build must not pass the health check.
    let _ = fs::remove_file(started_marker(root, snap.build));
    log!("launching {} (build {})", exe.display(), snap.build);
    let child = Command::new(&exe)
        .args(args)
        .current_dir(&app)
        .env("RECHARGE_LAUNCHER", launcher_exe)
        .env("RECHARGE_INSTALL_ROOT", root)
        .env("RECHARGE_BUILD", snap.build.to_string())
        .env("RECHARGE_VERSION", &snap.version)
        .env("RECHARGE_CHANNEL", channel)
        .spawn()?;
    let _ = fs::write(pid_file(root), child.id().to_string());
    Ok(child)
}

/// Wait for started-<build>.ok; false if the app exits unhappily, exits without the marker, or no marker appears within 20 s (child is killed).
pub fn health_check(root: &Path, child: &mut Child, build: u64) -> bool {
    let marker = started_marker(root, build);
    let t0 = Instant::now();
    loop {
        if marker.exists() {
            return true;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                log!("app exited early with {status} (marker {})", if marker.exists() { "present" } else { "missing" });
                return marker.exists() && status.success();
            }
            Ok(None) => {}
            Err(e) => {
                log!("wait failed: {e}");
                return false;
            }
        }
        if t0.elapsed() > HEALTH_TIMEOUT {
            log!("no started-{build}.ok within {}s, killing app", HEALTH_TIMEOUT.as_secs());
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Drop markers of other builds once one is confirmed.
pub fn clean_markers(root: &Path, keep_build: u64) {
    let keep = format!("started-{keep_build}.ok");
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("started-") && n.ends_with(".ok") && n != keep {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests_any {
    use super::*;
    #[test]
    fn tasklist_pid_match_is_exact() {
        let out = "\"recharge.exe\",\"1234\",\"Console\",\"1\",\"98,765 K\"\r\n";
        assert!(tasklist_has_pid(out, 1234));
        assert!(!tasklist_has_pid(out, 98), "memory column is not a pid");
        assert!(!tasklist_has_pid(out, 123));
        assert!(!tasklist_has_pid("INFO: No tasks are running which match the specified criteria.\r\n", 1234));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn wait_exit_returns_when_process_ends_and_times_out_otherwise() {
        let mut c = Command::new("sleep").arg("0.3").spawn().unwrap();
        let pid = c.id();
        assert!(!wait_exit(pid, Duration::from_millis(50)), "still alive: timeout");
        let _ = c.wait();
        assert!(wait_exit(pid, Duration::from_secs(2)));
    }
}
