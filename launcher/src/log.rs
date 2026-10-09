//! Tiny file logger: root/launcher.log, rotated to launcher.log.1 at 1 MB.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static LOG: OnceLock<Mutex<Option<File>>> = OnceLock::new();
const MAX_BYTES: u64 = 1024 * 1024;

pub fn init(root: &Path) {
    let _ = fs::create_dir_all(root);
    let path = root.join("launcher.log");
    // Rotate once per start; a launcher run never writes anywhere near 1 MB itself.
    if fs::metadata(&path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, root.join("launcher.log.1"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    let _ = LOG.set(Mutex::new(file));
}

/// Log to an explicit file (the uninstall copy logs to the temp dir: the root is being deleted).
pub fn init_at(path: &Path) {
    let file = OpenOptions::new().create(true).append(true).open(path).ok();
    let _ = LOG.set(Mutex::new(file));
}

pub fn write(msg: &str) {
    eprintln!("{msg}");
    if let Some(m) = LOG.get() {
        if let Ok(mut g) = m.lock() {
            if let Some(f) = g.as_mut() {
                let _ = writeln!(f, "[{}] {msg}", now());
            }
        }
    }
}

fn now() -> String {
    // Seconds since epoch: no date crate available, and it sorts fine.
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    s.to_string()
}

#[macro_export]
macro_rules! log {
    ($($t:tt)*) => { $crate::log::write(&format!($($t)*)) };
}

/// RECHARGE_LAUNCHER_LOG_CWD=1 (tests): print the working directory the launcher runs in.
pub fn debug_cwd() {
    if std::env::var_os("RECHARGE_LAUNCHER_LOG_CWD").is_some() {
        let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
        eprintln!("launcher-cwd {cwd}");
    }
}
