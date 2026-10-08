//! Finds and removes every older, non-launcher Recharge install (NSIS .exe installs, the .deb /
//! pacman package, install.sh --user copies, AppImages, desktop entries pointing at them and
//! other launcher roots). Settings, mods, skins and map saves are never touched: they live in the
//! Tauri data folders, not in any install location.
//!
//! Only paths matching known Recharge install patterns are ever deleted, nothing scans the disk,
//! and every step is logged. `scan` is the dry run (`--scan-old`); `remove` does the work.
use crate::install::launcher_path;
use crate::log;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    File(PathBuf),
    Dir(PathBuf),
    /// Linux system package. `cmd` is run through pkexec.
    Package { name: &'static str, cmd: Vec<String> },
    /// Windows: an old NSIS uninstaller (`exe /S _?=dir`), run silently and awaited.
    #[cfg_attr(not(windows), allow(dead_code))]
    Uninstaller { exe: PathBuf, dir: PathBuf },
    /// Windows: a stale uninstall registry key (`reg delete`), `view` is 32 or 64.
    #[cfg_attr(not(windows), allow(dead_code))]
    RegKey { key: String, view: u8 },
}

impl Item {
    pub fn describe(&self) -> String {
        match self {
            Item::File(p) => format!("file {}", p.display()),
            Item::Dir(p) => format!("folder {}", p.display()),
            Item::Package { name, cmd } => format!("{name} package recharge (pkexec {})", cmd.join(" ")),
            Item::Uninstaller { exe, .. } => format!("uninstaller {}", exe.display()),
            Item::RegKey { key, view } => format!("registry key {key} ({view}-bit view)"),
        }
    }
}

/// Everything old that would be removed, in the order it would be removed.
pub fn scan(root: &Path, exe: &Path) -> Vec<Item> {
    let mut items = Vec::new();
    #[cfg(windows)]
    win::scan(root, exe, &mut items);
    #[cfg(not(windows))]
    unix::scan(root, exe, &mut items);
    dedup(items)
}

fn dedup(items: Vec<Item>) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    for i in items {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// Scan + remove. Never fails the caller: every error is logged and the install goes on.
pub fn cleanup(root: &Path, exe: &Path) {
    let items = scan(root, exe);
    if items.is_empty() {
        log!("old installs: none found");
        return;
    }
    log!("old installs: {} item(s) to remove", items.len());
    remove(&items, root);
}

pub fn remove(items: &[Item], root: &Path) {
    #[cfg(not(windows))]
    let _ = root;
    for it in items {
        log!("removing {}", it.describe());
        match it {
            Item::File(p) => match fs::remove_file(p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log!("  could not remove {}: {e}", p.display()),
            },
            Item::Dir(p) => match fs::remove_dir_all(p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log!("  could not remove {}: {e}", p.display()),
            },
            Item::Package { name, cmd } => remove_package(name, cmd),
            #[cfg(windows)]
            Item::Uninstaller { exe, dir } => {
                win::run_uninstaller(exe, dir);
                // The uninstaller leaves what it cannot delete itself (its own exe): clear the known rest.
                remove(&old_dir_items(dir, root), root);
            }
            #[cfg(windows)]
            Item::RegKey { key, view } => win::delete_key(key, *view),
            #[cfg(not(windows))]
            Item::Uninstaller { .. } | Item::RegKey { .. } => {}
        }
    }
}

// ---- shared helpers ----

fn same_path(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    n(a) == n(b)
}

/// The files of the hand-authored NSIS installer (installer/recharge-installer.nsi) / Tauri's NSIS
/// bundle. Inside the launcher's own root only exactly these are removed.
const NSIS_FILES: [&str; 2] = ["recharge.exe", "uninstall.exe"];
const NSIS_DIRS: [&str; 3] = ["content", "loader", "mods"];

fn has_ci(dir: &Path, name: &str) -> bool {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

fn find_ci(dir: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)).map(|e| e.path())
}

/// What to delete in a directory that may hold an old (non-launcher) Windows install. Empty unless
/// it really looks like one. `root` is the launcher's own folder, which shares %LOCALAPPDATA%\Recharge
/// with the old NSIS install dir, so there only the NSIS payload is removed.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn old_dir_items(dir: &Path, root: &Path) -> Vec<Item> {
    if !NSIS_FILES.iter().any(|f| has_ci(dir, f)) {
        return vec![];
    }
    if same_path(dir, root) {
        let mut v: Vec<Item> = NSIS_FILES.iter().filter_map(|f| find_ci(dir, f)).map(Item::File).collect();
        v.extend(NSIS_DIRS.iter().filter_map(|d| find_ci(dir, d)).filter(|p| p.is_dir()).map(Item::Dir));
        return v;
    }
    let name_ok = dir.file_name().map(|n| n.to_string_lossy().to_lowercase().contains("recharge")).unwrap_or(false);
    let is_launcher = has_ci(dir, "recharge-launcher.exe") || has_ci(dir, "state.json");
    if !name_ok || is_launcher || root.starts_with(dir) {
        return vec![];
    }
    vec![Item::Dir(dir.to_path_buf())]
}

/// First token of the first `Exec=` line of a .desktop file's main section (quotes honoured).
pub fn desktop_exec(contents: &str) -> Option<String> {
    let mut in_main = false;
    for line in contents.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            if in_main {
                return None; // an Action section: not the main Exec
            }
            in_main = l == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some(v) = l.strip_prefix("Exec=") {
            let v = v.trim();
            return Some(if let Some(r) = v.strip_prefix('"') {
                r.split('"').next().unwrap_or("").to_string()
            } else {
                v.split_whitespace().next().unwrap_or("").to_string()
            })
            .filter(|s| !s.is_empty());
        }
    }
    None
}

fn remove_package(name: &str, cmd: &[String]) {
    let shown = match name {
        "dpkg" => "sudo apt-get remove -y recharge",
        _ => "sudo pacman -R recharge",
    };
    if !on_path("pkexec") {
        log!("  pkexec not available: remove the old package yourself with: {shown}");
        notify(&format!("An old Recharge package is still installed. Remove it with:\n{shown}"));
        return;
    }
    match Command::new("pkexec").args(cmd).stdin(std::process::Stdio::null()).status() {
        Ok(s) if s.success() => log!("  package removed"),
        Ok(s) => {
            log!("  pkexec exited with {s}: remove the old package yourself with: {shown}");
            notify(&format!("The old Recharge package was not removed. Remove it with:\n{shown}"));
        }
        Err(e) => log!("  could not run pkexec ({e}): remove the old package yourself with: {shown}"),
    }
}

fn on_path(prog: &str) -> bool {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(prog).is_file())).unwrap_or(false)
}

#[cfg(unix)]
fn notify(msg: &str) {
    if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        let _ = Command::new("zenity").args(["--info", "--title=Recharge", &format!("--text={msg}")]).spawn();
    }
}
#[cfg(windows)]
fn notify(_: &str) {}

// ---- Linux ----

#[cfg(not(windows))]
mod unix {
    use super::*;

    fn cmd_ok(prog: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(prog).args(args).stdin(std::process::Stdio::null()).output().ok()?;
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
    }

    pub fn scan(root: &Path, exe: &Path, items: &mut Vec<Item>) {
        let Some(home) = dirs::home_dir() else { return };
        let local = home.join(".local");
        let ours = launcher_path(root);

        // install.sh --user: copies the .deb payload into ~/.local and drops this marker.
        let marker = local.join("share/recharge/.user-install");
        if marker.is_file() {
            items.push(Item::File(local.join("bin/recharge")));
            items.push(Item::File(local.join("share/applications/Recharge.desktop")));
            if let Ok(rd) = fs::read_dir(local.join("share/icons/hicolor")) {
                items.extend(rd.flatten().map(|d| d.path().join("apps/recharge.png")).filter(|p| p.is_file()).map(Item::File));
            }
            let lib = local.join("lib/Recharge");
            if lib.is_dir() {
                items.push(Item::Dir(lib));
            }
            items.push(Item::File(marker));
            items.retain(|i| !matches!(i, Item::File(p) if !p.exists()));
        }

        // Desktop entries pointing at an old binary, an AppImage or another launcher root.
        let mut dirs_: Vec<PathBuf> = vec![local.join("share/applications"), home.join("Desktop")];
        dirs_.extend(dirs::data_dir().map(|d| d.join("applications")));
        dirs_.extend(dirs::desktop_dir());
        dirs_.dedup();
        for d in dirs_ {
            let Ok(rd) = fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if !name.ends_with(".desktop") || !name.contains("recharge") {
                    continue;
                }
                let path = e.path();
                let Some(target) = fs::read_to_string(&path).ok().and_then(|c| desktop_exec(&c)).map(PathBuf::from) else { continue };
                if same_path(&target, &ours) || same_path(&target, exe) {
                    continue; // ours
                }
                let base = target.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !base.contains("recharge") {
                    continue; // a desktop file that merely has "recharge" in its name
                }
                if base == "recharge-launcher" {
                    // Another launcher-managed root (made with --root): only if it really is one.
                    match target.parent() {
                        Some(r) if r.join("state.json").is_file() && !same_path(r, root) => items.push(Item::Dir(r.to_path_buf())),
                        Some(r) if same_path(r, root) => continue,
                        _ => {}
                    }
                    items.push(Item::File(path));
                } else if base.ends_with(".appimage") {
                    if target.is_file() {
                        items.push(Item::File(target));
                    }
                    items.push(Item::File(path));
                } else if target.starts_with(&local) && base == "recharge" {
                    items.push(Item::File(target));
                    items.push(Item::File(path));
                } else if !target.exists() {
                    items.push(Item::File(path)); // dead entry
                } else {
                    log!("old installs: leaving {} (starts {})", path.display(), target.display());
                }
            }
        }

        // AppImages in the places people put them. Never a recursive scan.
        for d in [home.join("Applications"), home.join("AppImages"), local.join("bin")] {
            let Ok(rd) = fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if n.starts_with("recharge") && n.ends_with(".appimage") && e.path().is_file() && !same_path(&e.path(), exe) {
                    items.push(Item::File(e.path()));
                }
            }
        }

        // The .deb / pacman package (a system install: needs polkit).
        if cmd_ok("dpkg-query", &["-W", "-f=${Status}", "recharge"]).is_some_and(|s| s.contains("install ok installed")) {
            items.push(Item::Package { name: "dpkg", cmd: ["apt-get", "remove", "-y", "recharge"].map(String::from).to_vec() });
        } else if cmd_ok("pacman", &["-Q", "recharge"]).is_some() {
            items.push(Item::Package { name: "pacman", cmd: ["pacman", "-R", "--noconfirm", "recharge"].map(String::from).to_vec() });
        }
    }
}

// ---- Windows ----

/// One `reg query /s` result: the key and its string values.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, PartialEq)]
pub struct RegEntry {
    pub key: String,
    pub values: std::collections::BTreeMap<String, String>,
}

/// Parse `reg query <key> /s` output (keys at column 0, values indented "name    REG_SZ    data").
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_reg_query(text: &str) -> Vec<RegEntry> {
    let mut out: Vec<RegEntry> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') {
            out.push(RegEntry { key: line.trim().to_string(), ..Default::default() });
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        let t = line.trim_start();
        let Some(i) = t.find("    REG_") else { continue };
        let name = t[..i].to_string();
        let rest = &t[i + 4..];
        let data = match rest.find("    ") {
            Some(j) => rest[j..].trim().to_string(),
            None => String::new(),
        };
        cur.values.insert(name, data);
    }
    out
}

/// "C:\x\uninstall.exe" /S  ->  C:\x\uninstall.exe  (also unquoted paths ending in .exe).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn uninstall_exe_of(s: &str) -> Option<String> {
    let s = s.trim();
    if let Some(r) = s.strip_prefix('"') {
        return r.split('"').next().map(String::from).filter(|x| !x.is_empty());
    }
    let low = s.to_lowercase();
    low.find(".exe").map(|i| s[..i + 4].to_string())
}

/// Is this uninstall key an old Recharge install (and not the launcher's own entry)?
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_old_entry(e: &RegEntry) -> bool {
    let leaf = e.key.rsplit('\\').next().unwrap_or("").to_lowercase();
    let display = e.values.get("DisplayName").map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let un = e.values.get("UninstallString").cloned().unwrap_or_default();
    let named = leaf == "recharge" || leaf == "co.za.codecade.recharge" || display == "recharge";
    named && !un.to_lowercase().contains("recharge-launcher")
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::os::windows::process::CommandExt;

    fn hidden(program: &str) -> Command {
        let mut c = Command::new(program);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }

    fn env_path(k: &str) -> Option<PathBuf> {
        std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute())
    }

    pub fn scan(root: &Path, _exe: &Path, items: &mut Vec<Item>) {
        let unkey = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
        let mut dirs_: Vec<PathBuf> = Vec::new();
        for hive in ["HKCU", "HKLM"] {
            for view in [64u8, 32] {
                let key = format!(r"{hive}\{unkey}");
                let Ok(o) = hidden("reg").args(["query", &key, "/s", &format!("/reg:{view}")]).output() else { continue };
                if !o.status.success() {
                    continue;
                }
                for e in parse_reg_query(&String::from_utf8_lossy(&o.stdout)).into_iter().filter(is_old_entry) {
                    log!("old installs: registry entry {} ({view}-bit)", e.key);
                    let un = e.values.get("UninstallString").and_then(|s| uninstall_exe_of(s)).map(PathBuf::from);
                    let loc = e.values.get("InstallLocation").map(|s| PathBuf::from(s.trim().trim_matches('"'))).filter(|p| p.is_absolute());
                    let dir = loc.or_else(|| un.as_ref().and_then(|u| u.parent().map(Path::to_path_buf)));
                    // Only a real NSIS-style uninstaller sitting in a Recharge folder is run.
                    let runnable = un.filter(|u| {
                        u.is_file()
                            && u.file_name().map(|n| n.to_string_lossy().to_lowercase().starts_with("uninst")).unwrap_or(false)
                    });
                    match (runnable, dir) {
                        (Some(exe), Some(dir)) => {
                            items.push(Item::Uninstaller { exe, dir: dir.clone() });
                            dirs_.push(dir);
                        }
                        (None, dir) => {
                            dirs_.extend(dir);
                            items.push(Item::RegKey { key: e.key.clone(), view });
                        }
                        (Some(_), None) => {}
                    }
                }
            }
        }
        // Known install locations even when no registry entry points at them (deleted key, copy).
        let local = dirs::data_local_dir();
        dirs_.extend(local.iter().map(|l| l.join("Recharge")));
        dirs_.extend(local.iter().map(|l| l.join("Programs").join("Recharge")));
        dirs_.extend(env_path("ProgramFiles").map(|p| p.join("Recharge")));
        dirs_.extend(env_path("ProgramFiles(x86)").map(|p| p.join("Recharge")));
        for d in dirs_ {
            if d.is_dir() {
                items.extend(old_dir_items(&d, root));
            }
        }
        shortcuts(items);
    }

    /// Start-menu folder and desktop shortcuts of the old installer, deleted only when the shortcut
    /// really points at an old exe (the launcher's own shortcut targets recharge-launcher.exe).
    fn shortcuts(items: &mut Vec<Item>) {
        let mut cands: Vec<PathBuf> = Vec::new();
        let menus = [dirs::data_dir(), env_path("ProgramData")];
        for m in menus.into_iter().flatten() {
            let p = m.join(r"Microsoft\Windows\Start Menu\Programs\Recharge");
            cands.push(p.join("Recharge.lnk"));
            cands.push(p.join("Uninstall Recharge.lnk"));
        }
        cands.extend(dirs::desktop_dir().map(|d| d.join("Recharge.lnk")));
        cands.extend(env_path("PUBLIC").map(|d| d.join(r"Desktop\Recharge.lnk")));
        let cands: Vec<PathBuf> = cands.into_iter().filter(|p| p.is_file()).collect();
        if cands.is_empty() {
            return;
        }
        let list = cands.iter().map(|p| format!("'{}'", p.display().to_string().replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let ps = format!("$w=New-Object -ComObject WScript.Shell;foreach($p in @({list})){{ try{{ Write-Output ($p+'|'+$w.CreateShortcut($p).TargetPath) }}catch{{}} }}");
        let Ok(o) = hidden("powershell").args(["-NoProfile", "-Command", &ps]).output() else { return };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let Some((lnk, target)) = line.rsplit_once('|') else { continue };
            let t = target.to_lowercase();
            if t.ends_with("\\recharge.exe") || t.ends_with("\\uninstall.exe") {
                items.push(Item::File(PathBuf::from(lnk.trim())));
                // The old Start-menu folder, once its shortcuts are gone (remove_dir only if empty).
                if let Some(p) = Path::new(lnk.trim()).parent().filter(|p| p.ends_with("Recharge") && p.to_string_lossy().contains("Start Menu")) {
                    items.push(Item::Dir(p.to_path_buf()));
                }
            }
        }
    }

    /// `exe /S _?=dir`: _?= makes the NSIS uninstaller run in place (not from a temp copy) and block
    /// until done; it must be the last argument and unquoted.
    pub fn run_uninstaller(exe: &Path, dir: &Path) {
        let mut c = hidden(&exe.display().to_string());
        c.arg("/S").raw_arg(format!("_?={}", dir.display())).current_dir(std::env::temp_dir());
        match c.status() {
            Ok(s) => log!("  uninstaller exited with {s}"),
            Err(e) => log!("  could not run the uninstaller: {e}"),
        }
    }

    pub fn delete_key(key: &str, view: u8) {
        match hidden("reg").args(["delete", key, "/f", &format!("/reg:{view}")]).status() {
            Ok(s) if s.success() => {}
            Ok(s) => log!("  reg delete exited with {s} (a machine-wide key needs admin)"),
            Err(e) => log!("  could not run reg: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rl-old-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn desktop_exec_takes_main_section_first_token() {
        let d = "[Desktop Entry]\nName=Recharge\nExec=\"/a b/recharge-launcher\" %U\n[Desktop Action X]\nExec=/other\n";
        assert_eq!(desktop_exec(d).as_deref(), Some("/a b/recharge-launcher"));
        assert_eq!(desktop_exec("[Desktop Entry]\nExec=/usr/bin/recharge %U\n").as_deref(), Some("/usr/bin/recharge"));
        assert_eq!(desktop_exec("[Desktop Entry]\nName=x\n[Desktop Action A]\nExec=/o\n"), None);
    }

    #[test]
    fn reg_output_parses_and_filters_old_entries() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Recharge\r\n    DisplayName    REG_SZ    Recharge\r\n    UninstallString    REG_SZ    \"C:\\Users\\a\\AppData\\Local\\Recharge\\uninstall.exe\"\r\n    NoModify    REG_DWORD    0x1\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other\r\n    DisplayName    REG_SZ    Something\r\n";
        let es = parse_reg_query(out);
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].values["DisplayName"], "Recharge");
        assert_eq!(uninstall_exe_of(&es[0].values["UninstallString"]).as_deref(), Some("C:\\Users\\a\\AppData\\Local\\Recharge\\uninstall.exe"));
        assert!(is_old_entry(&es[0]) && !is_old_entry(&es[1]));
        // the launcher's own key must never be treated as old
        let mut own = RegEntry { key: "HKCU\\...\\Uninstall\\Recharge".into(), ..Default::default() };
        own.values.insert("UninstallString".into(), "\"C:\\x\\recharge-launcher.exe\" --uninstall".into());
        assert!(!is_old_entry(&own));
        assert_eq!(uninstall_exe_of("C:\\a b\\unins000.exe /SILENT").as_deref(), Some("C:\\a b\\unins000.exe"));
    }

    #[test]
    fn old_dir_in_launcher_root_removes_only_nsis_payload() {
        let root = tmp("rootdir");
        for f in ["recharge.exe", "uninstall.exe", "recharge-launcher.exe", "state.json"] {
            fs::write(root.join(f), "x").unwrap();
        }
        for d in ["content", "loader", "mods", "app", "app.old"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let items = old_dir_items(&root, &root);
        let names: Vec<String> = items
            .iter()
            .map(|i| match i {
                Item::File(p) | Item::Dir(p) => p.file_name().unwrap().to_string_lossy().into_owned(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(names, ["recharge.exe", "uninstall.exe", "content", "loader", "mods"]);
        remove(&items, &root);
        assert!(root.join("recharge-launcher.exe").is_file() && root.join("state.json").is_file() && root.join("app").is_dir());
        assert!(!root.join("recharge.exe").exists() && !root.join("mods").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn foreign_old_dir_needs_recharge_name_and_payload_and_no_launcher() {
        let base = tmp("foreign");
        let root = base.join("own");
        fs::create_dir_all(&root).unwrap();
        let old = base.join("Programs/Recharge");
        fs::create_dir_all(&old).unwrap();
        assert!(old_dir_items(&old, &root).is_empty(), "no payload: not an install");
        fs::write(old.join("recharge.exe"), "x").unwrap();
        assert_eq!(old_dir_items(&old, &root), [Item::Dir(old.clone())]);
        let other = base.join("Stuff");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("recharge.exe"), "x").unwrap();
        assert!(old_dir_items(&other, &root).is_empty(), "name must contain recharge");
        fs::write(old.join("state.json"), "{}").unwrap();
        assert!(old_dir_items(&old, &root).is_empty(), "a launcher root is not an old install");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dedup_keeps_first() {
        let a = Item::File("/a".into());
        assert_eq!(dedup(vec![a.clone(), Item::File("/b".into()), a.clone()]).len(), 2);
    }
}
