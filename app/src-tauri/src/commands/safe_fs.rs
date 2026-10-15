//! Replacing files inside the game folder while something may have them open or mapped.
//!
//! Windows refuses to overwrite or delete a loaded DLL (error 1224 ERROR_USER_MAPPED_FILE, 32 sharing violation, 5 access denied) but allows renaming it. So a replace
//! writes `<file>.new`, tries to swap it in, and on a lock error moves the old file aside as `<file>.old-<ms>`, to be swept on a later run once nothing holds it.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Prefix of the error the loader commands return while IGTAP is running; the UI keys on it to offer "Close game and install".
pub const GAME_RUNNING_PREFIX: &str = "IGTAP_RUNNING:";
/// Marker the install script puts in its failure text around the path it couldn't replace: `LOCKED<<path>>`.
pub const LOCKED_MARKER_OPEN: &str = "LOCKED<<";
pub const LOCKED_MARKER_CLOSE: &str = ">>";

/// The file operations a replace needs; tests inject failures through this.
pub trait FsOps {
    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

pub struct RealFs;

impl FsOps for RealFs {
    fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
        std::fs::copy(from, to)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }
    fn remove_file(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }
}

/// Windows codes meaning "someone has it open": 5 access denied, 32 sharing violation, 33 lock violation, 1224 user-mapped section open.
pub fn is_lock_error(e: &io::Error) -> bool {
    (cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33 | 1224))) || e.kind() == io::ErrorKind::PermissionDenied
}

/// Waits between attempts (AV scanners hold a freshly written file for a moment).
pub const BACKOFF_MS: [u64; 4] = [150, 300, 600, 1200];

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn aside_name(path: &Path, ms: u128) -> PathBuf {
    sibling(path, &format!(".old-{ms}"))
}

#[derive(Debug)]
pub struct ReplaceError {
    pub path: PathBuf,
    pub source: io::Error,
    pub locked: bool,
}

impl ReplaceError {
    /// Error text for the UI; `holders` are the process names found holding the file (may be empty).
    pub fn message(&self, holders: &[String]) -> String {
        let full = self.path.to_string_lossy();
        let name = full.rsplit(['/', '\\']).next().unwrap_or(&full).to_string();
        if self.locked {
            let who = if holders.is_empty() { "Another program".to_string() } else { holders.join(", ") };
            format!("{who} still has {name} open ({}) - close the game and press Install again.", self.source)
        } else {
            format!("Couldn't write {name}: {}", self.source)
        }
    }
}

fn pause(backoff: &[u64], i: usize) {
    if let Some(ms) = backoff.get(i) {
        std::thread::sleep(Duration::from_millis(*ms));
    }
}

/// Replace `dest` with the contents of `src`. Returns the aside file when the old one had to be renamed away.
pub fn safe_replace(fs: &dyn FsOps, src: &Path, dest: &Path, backoff: &[u64]) -> Result<Option<PathBuf>, ReplaceError> {
    let new = sibling(dest, ".new");
    let fail = |e: io::Error| ReplaceError { path: dest.to_path_buf(), locked: is_lock_error(&e), source: e };

    // 1. Write the replacement beside the target (a stale .new may be left by an earlier crash).
    let mut last: Option<io::Error> = None;
    for i in 0..=backoff.len() {
        let _ = fs.remove_file(&new);
        match fs.copy(src, &new) {
            Ok(_) => {
                last = None;
                break;
            }
            Err(e) => {
                last = Some(e);
                pause(backoff, i);
            }
        }
    }
    if let Some(e) = last {
        let _ = fs.remove_file(&new);
        return Err(fail(e));
    }

    // 2. Swap it in, retrying briefly.
    let mut last_err: Option<io::Error> = None;
    for i in 0..=backoff.len() {
        match fs.rename(&new, dest) {
            Ok(()) => return Ok(None),
            Err(e) => {
                let lock = is_lock_error(&e);
                last_err = Some(e);
                if !lock {
                    break;
                }
                pause(backoff, i);
            }
        }
    }
    let err = last_err.expect("loop ran at least once");
    if !is_lock_error(&err) {
        let _ = fs.remove_file(&new);
        return Err(fail(err));
    }

    // 3. Still locked: a loaded DLL can be renamed, so move it aside and put the new one in its place.
    let aside = aside_name(dest, now_ms());
    if let Err(e) = fs.rename(dest, &aside) {
        let _ = fs.remove_file(&new);
        return Err(ReplaceError { path: dest.to_path_buf(), locked: is_lock_error(&e), source: e });
    }
    match fs.rename(&new, dest) {
        Ok(()) => Ok(Some(aside)),
        Err(e) => {
            let _ = fs.rename(&aside, dest);
            let _ = fs.remove_file(&new);
            Err(fail(e))
        }
    }
}

/// Delete `path`; if it is locked, rename it aside instead. Missing files are fine.
pub fn safe_remove(fs: &dyn FsOps, path: &Path, backoff: &[u64]) -> Result<Option<PathBuf>, ReplaceError> {
    let mut last: Option<io::Error> = None;
    for i in 0..=backoff.len() {
        match fs.remove_file(path) {
            Ok(()) => return Ok(None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                let lock = is_lock_error(&e);
                last = Some(e);
                if !lock {
                    break;
                }
                pause(backoff, i);
            }
        }
    }
    let err = last.expect("loop ran at least once");
    let wrap = |e: io::Error| ReplaceError { path: path.to_path_buf(), locked: is_lock_error(&e), source: e };
    if !is_lock_error(&err) {
        return Err(wrap(err));
    }
    let aside = aside_name(path, now_ms());
    fs.rename(path, &aside).map_err(wrap)?;
    Ok(Some(aside))
}

/// True for `<name>.old-<digits>`.
pub fn is_aside_name(name: &str) -> bool {
    match name.rsplit_once(".old-") {
        Some((stem, ms)) => !stem.is_empty() && !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Delete leftover asides (files or folders) directly in `dir`; those still locked stay for next time. Returns how many were removed.
pub fn sweep_asides(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        if !is_aside_name(&e.file_name().to_string_lossy()) {
            continue;
        }
        let p = e.path();
        let ok = if p.is_dir() { std::fs::remove_dir_all(&p).is_ok() } else { std::fs::remove_file(&p).is_ok() };
        if ok {
            n += 1;
        }
    }
    n
}

/// Sweep the asides of an install: the Managed folder, and `<game>/Recharge`, `<game>/Recharge/Mods` and each deployed mod folder.
pub fn sweep_install(game_dir: &Path, managed: &Path) -> usize {
    let mut n = sweep_asides(managed);
    let rc = game_dir.join("Recharge");
    n += sweep_asides(&rc);
    let mods = rc.join("Mods");
    n += sweep_asides(&mods);
    if let Ok(rd) = std::fs::read_dir(&mods) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                n += sweep_asides(&e.path());
            }
        }
    }
    n
}

/// Names of other processes holding `path` open as a loaded module (Windows, best effort via PowerShell); empty elsewhere or on any failure.
#[cfg(windows)]
pub fn holders_of(path: &Path) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    let p = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$p='{p}'; Get-Process | ForEach-Object {{ try {{ if ($_.Modules | Where-Object {{ $_.FileName -ieq $p }}) {{ $_.ProcessName + '.exe' }} }} catch {{}} }}"
    );
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
    else {
        return Vec::new();
    };
    let mut names: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(not(windows))]
pub fn holders_of(path: &Path) -> Vec<String> {
    let want = match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return Vec::new(),
    };
    let mut names = Vec::new();
    let Ok(rd) = std::fs::read_dir("/proc") else { return names };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_string_lossy().parse::<u32>().ok() else { continue };
        let Ok(maps) = std::fs::read_to_string(format!("/proc/{pid}/maps")) else { continue };
        if maps.lines().any(|l| l.ends_with(&want)) {
            if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                names.push(comm.trim().to_string());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Turn the install script's failure text into the final message: if it names a locked path (`LOCKED<<path>>`), add the holding process.
pub fn explain_script_failure(text: &str, holders: &dyn Fn(&Path) -> Vec<String>) -> String {
    let Some(start) = text.find(LOCKED_MARKER_OPEN) else { return text.to_string() };
    let rest = &text[start + LOCKED_MARKER_OPEN.len()..];
    let Some(end) = rest.find(LOCKED_MARKER_CLOSE) else { return text.to_string() };
    let path = PathBuf::from(&rest[..end]);
    let detail = rest[end + LOCKED_MARKER_CLOSE.len()..].trim().trim_start_matches(':').trim();
    let err = ReplaceError {
        path: path.clone(),
        source: io::Error::new(io::ErrorKind::PermissionDenied, if detail.is_empty() { "file in use" } else { detail }),
        locked: true,
    };
    err.message(&holders(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rl-safefs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Real fs, except an existing `locked` path can't be renamed onto (like a loaded DLL) for the first `lock_attempts` tries; renaming it away works if `allow_aside`.
    struct MappedFs {
        locked: PathBuf,
        lock_attempts: RefCell<u32>,
        attempts_seen: RefCell<u32>,
        allow_aside: bool,
    }
    impl MappedFs {
        fn new(locked: &Path, lock_attempts: u32, allow_aside: bool) -> Self {
            MappedFs { locked: locked.to_path_buf(), lock_attempts: RefCell::new(lock_attempts), attempts_seen: RefCell::new(0), allow_aside }
        }
    }
    impl FsOps for MappedFs {
        fn copy(&self, f: &Path, t: &Path) -> io::Result<u64> {
            std::fs::copy(f, t)
        }
        fn rename(&self, f: &Path, t: &Path) -> io::Result<()> {
            if t == self.locked && t.exists() {
                *self.attempts_seen.borrow_mut() += 1;
                let mut n = self.lock_attempts.borrow_mut();
                if *n > 0 {
                    *n -= 1;
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied, "user-mapped section open"));
                }
            }
            if f == self.locked && !self.allow_aside {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
            }
            std::fs::rename(f, t)
        }
        fn remove_file(&self, p: &Path) -> io::Result<()> {
            std::fs::remove_file(p)
        }
    }

    #[test]
    fn plain_replace_leaves_no_aside() {
        let d = tmp("plain");
        std::fs::write(d.join("a.dll"), b"old").unwrap();
        std::fs::write(d.join("src.dll"), b"new").unwrap();
        let r = safe_replace(&RealFs, &d.join("src.dll"), &d.join("a.dll"), &[]).unwrap();
        assert!(r.is_none());
        assert_eq!(std::fs::read(d.join("a.dll")).unwrap(), b"new");
        assert!(!d.join("a.dll.new").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn locked_target_is_renamed_aside_then_swept() {
        let d = tmp("aside");
        let dest = d.join("a.dll");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(d.join("src.dll"), b"new").unwrap();
        let fs = MappedFs::new(&dest, 100, true);
        let aside = safe_replace(&fs, &d.join("src.dll"), &dest, &[1, 1, 1]).unwrap().expect("aside used");
        assert_eq!(*fs.attempts_seen.borrow(), 4, "retried before giving up");
        assert!(is_aside_name(&aside.file_name().unwrap().to_string_lossy()));
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert_eq!(std::fs::read(&aside).unwrap(), b"old");
        assert!(!d.join("a.dll.new").exists());
        assert_eq!(sweep_asides(&d), 1);
        assert!(!aside.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn retry_succeeds_without_aside_when_lock_clears() {
        let d = tmp("retry");
        let dest = d.join("a.dll");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(d.join("src.dll"), b"new").unwrap();
        let fs = MappedFs::new(&dest, 2, true);
        assert!(safe_replace(&fs, &d.join("src.dll"), &dest, &[1, 1, 1]).unwrap().is_none());
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unrenamable_lock_fails_and_keeps_old_file() {
        let d = tmp("hard");
        let dest = d.join("a.dll");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(d.join("src.dll"), b"new").unwrap();
        let fs = MappedFs::new(&dest, 100, false);
        let e = safe_replace(&fs, &d.join("src.dll"), &dest, &[1, 1]).unwrap_err();
        assert!(e.locked);
        assert_eq!(*fs.attempts_seen.borrow(), 3);
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert!(!d.join("a.dll.new").exists());
        let msg = e.message(&["IGTAP.exe".to_string()]);
        assert!(msg.contains("IGTAP.exe still has a.dll open"), "{msg}");
        assert!(msg.contains("close the game and press Install again"), "{msg}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remove_falls_back_to_aside() {
        let d = tmp("rm");
        let dest = d.join("m.dll");
        std::fs::write(&dest, b"x").unwrap();
        struct NoDelete;
        impl FsOps for NoDelete {
            fn copy(&self, f: &Path, t: &Path) -> io::Result<u64> { std::fs::copy(f, t) }
            fn rename(&self, f: &Path, t: &Path) -> io::Result<()> { std::fs::rename(f, t) }
            fn remove_file(&self, _: &Path) -> io::Result<()> { Err(io::Error::new(io::ErrorKind::PermissionDenied, "mapped")) }
        }
        let aside = safe_remove(&NoDelete, &dest, &[1]).unwrap().expect("aside");
        assert!(!dest.exists() && aside.exists());
        assert!(safe_remove(&RealFs, &d.join("missing"), &[]).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn aside_name_detection() {
        assert!(is_aside_name("Assembly-CSharp.dll.old-1700000000000"));
        assert!(!is_aside_name("Assembly-CSharp.ORIGINAL.dll"));
        assert!(!is_aside_name("x.old-"));
        assert!(!is_aside_name("x.old-12a"));
    }

    #[test]
    fn sweep_install_clears_managed_and_mod_folders() {
        let g = tmp("sweep");
        let managed = g.join("Game_Data").join("Managed");
        let mod_dir = g.join("Recharge").join("Mods").join("recharge.maps");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(managed.join("Assembly-CSharp.dll.old-1"), b"x").unwrap();
        std::fs::write(managed.join("Assembly-CSharp.dll"), b"keep").unwrap();
        std::fs::write(mod_dir.join("Maps.dll.old-22"), b"x").unwrap();
        assert_eq!(sweep_install(&g, &managed), 2);
        assert!(managed.join("Assembly-CSharp.dll").exists());
        let _ = std::fs::remove_dir_all(&g);
    }

    #[test]
    fn script_failure_names_holder() {
        let t = "Failed: LOCKED<<C:\\g\\Managed\\Assembly-CSharp.dll>> The requested operation cannot be performed on a file with a user-mapped section open.";
        let m = explain_script_failure(t, &|_| vec!["IGTAP.exe".into()]);
        assert!(m.contains("IGTAP.exe still has Assembly-CSharp.dll open"), "{m}");
        assert!(m.contains("user-mapped section"), "{m}");
        assert_eq!(explain_script_failure("Failed: other", &|_| vec![]), "Failed: other");
        let m2 = explain_script_failure(t, &|_| vec![]);
        assert!(m2.starts_with("Another program still has Assembly-CSharp.dll open"), "{m2}");
    }
}
