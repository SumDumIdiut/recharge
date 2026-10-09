//! First-run install (copy self to the install root + shortcut + uninstall entry) and --uninstall.
use crate::log;
use std::fs;
use std::path::{Path, PathBuf};

pub fn default_root() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(if cfg!(windows) { "Recharge" } else { "recharge" })
}

pub fn launcher_path(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "recharge-launcher.exe" } else { "recharge-launcher" })
}

pub fn is_installed(root: &Path, exe: &Path) -> bool {
    let norm = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    norm(&launcher_path(root)) == norm(exe)
}

/// Copy the running exe into the root (tmp + rename so a half copy never looks installed).
pub fn install_self(root: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    let dest = launcher_path(root);
    let tmp = dest.with_extension("tmp");
    fs::copy(exe, &tmp)?;
    crate::update::set_exec(&tmp);
    if dest.exists() {
        let _ = fs::rename(&dest, dest.with_extension("old")); // Windows: replace even if in use
    }
    fs::rename(&tmp, &dest)?;
    log!("installed launcher to {}", dest.display());
    Ok(dest)
}

// ---- shortcuts ----

#[cfg(unix)]
fn desktop_file() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("applications/recharge.desktop"))
}

#[cfg(unix)]
pub fn refresh_shortcut(root: &Path, version: &str) {
    let _ = version;
    let Some(path) = desktop_file() else { return };
    let icon = ["app/icon.png", "app/icons/128x128.png", "app/icons/icon.png"]
        .iter()
        .map(|p| root.join(p))
        .find(|p| p.is_file());
    let mut s = format!(
        "[Desktop Entry]\nType=Application\nName=Recharge\nComment=Recharge launcher\nExec=\"{0}\"\nTerminal=false\nCategories=Game;\nActions=Uninstall;\n",
        launcher_path(root).display()
    );
    if let Some(i) = icon {
        s.push_str(&format!("Icon={}\n", i.display()));
    }
    s.push_str(&format!("\n[Desktop Action Uninstall]\nName=Uninstall Recharge\nExec=\"{}\" --uninstall\n", launcher_path(root).display()));
    let _ = fs::create_dir_all(path.parent().unwrap());
    if fs::read_to_string(&path).map(|old| old != s).unwrap_or(true) {
        if let Err(e) = fs::write(&path, s) {
            log!("could not write {}: {e}", path.display());
        }
    }
}

#[cfg(windows)]
fn lnk_path() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("Microsoft\\Windows\\Start Menu\\Programs\\Recharge.lnk"))
}

#[cfg(windows)]
fn uninstall_lnk_path() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("Microsoft\\Windows\\Start Menu\\Programs\\Uninstall Recharge.lnk"))
}

#[cfg(windows)]
fn hidden(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(program);
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

#[cfg(windows)]
const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Recharge";

#[cfg(windows)]
fn dir_size_kb(p: &Path) -> u32 {
    fn walk(p: &Path) -> u64 {
        let Ok(rd) = fs::read_dir(p) else { return 0 };
        rd.flatten()
            .map(|e| match e.metadata() {
                Ok(m) if m.is_dir() => walk(&e.path()),
                Ok(m) => m.len(),
                Err(_) => 0,
            })
            .sum()
    }
    (walk(p) / 1024).min(u32::MAX as u64) as u32
}

/// Start-menu shortcut + "Apps & features" entry: native (COM + registry) first, PowerShell /
/// reg.exe only if the native call fails.
#[cfg(windows)]
pub fn refresh_shortcut(root: &Path, version: &str) {
    let exe = launcher_path(root);
    if let Some(lnk) = lnk_path() {
        if let Some(dir) = lnk.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Err(e) = winnative::create_shortcut(&lnk, &exe, root, None) {
            log!("native shortcut failed ({e:#x}), falling back to PowerShell");
            let ps = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
                lnk.display(), exe.display(), root.display()
            );
            let _ = hidden("powershell").args(["-NoProfile", "-Command", &ps]).status();
        }
    }
    if let Some(lnk) = uninstall_lnk_path() {
        if let Err(e) = winnative::create_shortcut(&lnk, &exe, root, Some("--uninstall")) {
            log!("native uninstall shortcut failed ({e:#x}), falling back to PowerShell");
            let ps = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='--uninstall';$s.WorkingDirectory='{}';$s.Save()",
                lnk.display(), exe.display(), root.display()
            );
            let _ = hidden("powershell").args(["-NoProfile", "-Command", &ps]).status();
        }
    }
    let exe_s = exe.display().to_string();
    let strings = [
        ("DisplayName", "Recharge".to_string()),
        ("DisplayVersion", version.to_string()),
        ("Publisher", "Recharge".to_string()),
        ("InstallLocation", root.display().to_string()),
        ("DisplayIcon", exe_s.clone()),
        ("UninstallString", format!("\"{exe_s}\" --uninstall")),
    ];
    let dwords = [("NoModify", 1u32), ("NoRepair", 1), ("EstimatedSize", dir_size_kb(root))];
    if let Err(e) = winnative::write_uninstall_entry(&strings, &dwords) {
        log!("native registry write failed ({e}), falling back to reg.exe");
        let reg = |name: &str, kind: &str, data: &str| {
            let _ = hidden("reg").args(["add", UNINSTALL_KEY, "/v", name, "/t", kind, "/d", data, "/f"]).status();
        };
        for (n, v) in &strings {
            reg(n, "REG_SZ", v);
        }
        for (n, v) in &dwords {
            reg(n, "REG_DWORD", &v.to_string());
        }
    }
}

/// Native Win32 helpers (windows-sys has no COM method wrappers, so the two vtables are declared
/// here). Not compiled on Linux: written against the windows-sys 0.61 docs, untested.
#[cfg(windows)]
mod winnative {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Recharge";

    fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        s.as_ref().encode_wide().chain(Some(0)).collect()
    }

    pub fn write_uninstall_entry(strings: &[(&str, String)], dwords: &[(&str, u32)]) -> Result<(), String> {
        unsafe {
            let mut key: HKEY = null_mut();
            let sub = wide(SUBKEY);
            let rc = RegCreateKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, null(), &mut key, null_mut());
            if rc != 0 {
                return Err(format!("RegCreateKeyExW {rc}"));
            }
            let mut res = Ok(());
            for (name, val) in strings {
                let (n, v) = (wide(name), wide(val));
                let rc = RegSetValueExW(key, n.as_ptr(), 0, REG_SZ, v.as_ptr() as *const u8, (v.len() * 2) as u32);
                if rc != 0 {
                    res = Err(format!("RegSetValueExW {name}: {rc}"));
                }
            }
            for (name, val) in dwords {
                let n = wide(name);
                let rc = RegSetValueExW(key, n.as_ptr(), 0, REG_DWORD, val as *const u32 as *const u8, 4);
                if rc != 0 {
                    res = Err(format!("RegSetValueExW {name}: {rc}"));
                }
            }
            RegCloseKey(key);
            res
        }
    }

    pub fn delete_uninstall_entry() -> bool {
        unsafe {
            let sub = wide(SUBKEY);
            let rc = RegDeleteTreeW(HKEY_CURRENT_USER, sub.as_ptr());
            rc == 0 || rc == 2 // ERROR_FILE_NOT_FOUND: already gone
        }
    }

    #[repr(C)]
    struct Unknown {
        query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
        add_ref: usize,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
    }
    /// IShellLinkW: IUnknown + 18 methods; only the used ones are typed, the rest are placeholders.
    #[repr(C)]
    struct ShellLinkVtbl {
        base: Unknown,
        _get_path: usize,
        _get_id_list: usize,
        _set_id_list: usize,
        _get_description: usize,
        set_description: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
        _get_working_directory: usize,
        set_working_directory: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
        _get_arguments: usize,
        set_arguments: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
        _get_hotkey: usize,
        _set_hotkey: usize,
        _get_show_cmd: usize,
        _set_show_cmd: usize,
        _get_icon_location: usize,
        set_icon_location: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32,
        _set_relative_path: usize,
        _resolve: usize,
        set_path: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
    }
    /// IPersistFile: IUnknown + GetClassID, IsDirty, Load, Save, SaveCompleted, GetCurFile.
    #[repr(C)]
    struct PersistFileVtbl {
        base: Unknown,
        _get_class_id: usize,
        _is_dirty: usize,
        _load: usize,
        save: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32,
        _save_completed: usize,
        _get_cur_file: usize,
    }
    #[repr(C)]
    struct Obj<T> {
        vtbl: *const T,
    }

    const CLSID_SHELL_LINK: GUID = GUID { data1: 0x00021401, data2: 0, data3: 0, data4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
    const IID_ISHELL_LINK_W: GUID = GUID { data1: 0x000214F9, data2: 0, data3: 0, data4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };
    const IID_IPERSIST_FILE: GUID = GUID { data1: 0x0000010b, data2: 0, data3: 0, data4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46] };

    /// Err carries the failing HRESULT.
    pub fn create_shortcut(lnk: &Path, target: &Path, workdir: &Path, args: Option<&str>) -> Result<(), u32> {
        unsafe {
            let init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
            let mut link: *mut c_void = null_mut();
            let hr = CoCreateInstance(&CLSID_SHELL_LINK, null_mut(), CLSCTX_INPROC_SERVER, &IID_ISHELL_LINK_W, &mut link);
            if hr < 0 || link.is_null() {
                if init >= 0 {
                    CoUninitialize();
                }
                return Err(hr as u32);
            }
            // A COM object's first field points at its vtable.
            let l = &*(*(link as *mut Obj<ShellLinkVtbl>)).vtbl;
            let (t, w, d) = (wide(target), wide(workdir), wide("Recharge"));
            let mut hr = (l.set_path)(link, t.as_ptr());
            if hr >= 0 {
                hr = (l.set_working_directory)(link, w.as_ptr());
            }
            if hr >= 0 {
                if let Some(a) = args {
                    hr = (l.set_arguments)(link, wide(a).as_ptr());
                }
            }
            if hr >= 0 {
                hr = (l.set_icon_location)(link, t.as_ptr(), 0);
            }
            if hr >= 0 {
                hr = (l.set_description)(link, d.as_ptr());
            }
            if hr >= 0 {
                let mut pf: *mut c_void = null_mut();
                hr = (l.base.query_interface)(link, &IID_IPERSIST_FILE, &mut pf);
                if hr >= 0 && !pf.is_null() {
                    let p = &*(*(pf as *mut Obj<PersistFileVtbl>)).vtbl;
                    hr = (p.save)(pf, wide(lnk).as_ptr(), 1);
                    (p.base.release)(pf);
                }
            }
            (l.base.release)(link);
            if init >= 0 {
                CoUninitialize();
            }
            if hr < 0 { Err(hr as u32) } else { Ok(()) }
        }
    }
}

/// Tauri app data folders (identifier co.za.codecade.recharge): settings, mods, skins, map saves,
/// backgrounds, WebView storage. Windows: %APPDATA% and %LOCALAPPDATA%; Linux: ~/.local/share,
/// ~/.config and ~/.cache. Mirrors app_data_dir / app_local_data_dir / app_config_dir / app_cache_dir.
pub const APP_IDENTIFIER: &str = "co.za.codecade.recharge";

pub fn data_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [dirs::data_dir(), dirs::data_local_dir(), dirs::config_dir(), dirs::cache_dir()]
        .into_iter()
        .flatten()
        .map(|b| b.join(APP_IDENTIFIER))
        .collect();
    v.dedup();
    let mut seen = Vec::new();
    v.retain(|p| {
        let new = !seen.contains(p);
        seen.push(p.clone());
        new
    });
    v
}

/// y/n question: on the terminal when there is one, else a dialog (zenity / PowerShell message box).
/// No way to ask means no.
fn ask(question: &str) -> bool {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() {
        eprint!("{question} [y/N] ");
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        return matches!(line.trim().to_lowercase().as_str(), "y" | "yes");
    }
    #[cfg(unix)]
    {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return false;
        }
        std::process::Command::new("zenity")
            .args(["--question", "--title=Recharge", &format!("--text={question}")])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        let ps = format!(
            "Add-Type -AssemblyName PresentationFramework;if([System.Windows.MessageBox]::Show('{}','Recharge','YesNo','Question') -eq 'Yes'){{exit 0}}else{{exit 1}}",
            question.replace('\'', "")
        );
        hidden("powershell").args(["-NoProfile", "-Command", &ps]).status().map(|s| s.success()).unwrap_or(false)
    }
}

/// True when the Start-menu / .desktop entry (and on Windows the Apps & features entry) exist.
#[cfg(unix)]
fn shortcuts_present() -> bool {
    desktop_file().map(|p| p.is_file()).unwrap_or(true)
}
#[cfg(windows)]
fn shortcuts_present() -> bool {
    let lnks = lnk_path().map(|p| p.is_file()).unwrap_or(true) && uninstall_lnk_path().map(|p| p.is_file()).unwrap_or(true);
    let out = hidden("reg").args(["query", UNINSTALL_KEY, "/v", "UninstallString"]).output();
    lnks && out.map(|o| o.status.success()).unwrap_or(true)
}

/// Every launcher run: recreate missing shortcuts / uninstall entry (a reinstall over leftovers,
/// or a user who deleted the shortcut). Idempotent and cheap when nothing is missing.
pub fn ensure_shortcuts(root: &Path, version: &str) {
    if !shortcuts_present() {
        log!("shortcuts or uninstall entry missing, recreating");
        refresh_shortcut(root, version);
    }
}

// ---- uninstall ----

const COPY_ENV: &str = "RECHARGE_UNINSTALL_COPY";

/// First stage of --uninstall: copy this exe to the OS temp dir and run that copy, so nothing in
/// the install root is locked by the process that deletes it. Returns the copy's exit code on
/// unix (the root exe can be deleted while running); on Windows the copy is detached and we return
/// at once so our own exe in the root gets freed.
pub fn uninstall_via_copy(root: &Path, exe: &Path, args: &[std::ffi::OsString], yes: bool) -> Result<i32, String> {
    let name = format!("recharge-uninstall-{}{}", std::process::id(), if cfg!(windows) { ".exe" } else { "" });
    let copy = std::env::temp_dir().join(name);
    fs::copy(exe, &copy).map_err(|e| format!("could not copy the uninstaller to {}: {e}", copy.display()))?;
    crate::update::set_exec(&copy);
    let mut cmd = std::process::Command::new(&copy);
    cmd.args(args).env(COPY_ENV, "1");
    if !args.iter().any(|a| a == "--root") {
        cmd.arg("--root").arg(root);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP survive our exit; silent runs get no window.
        let flags = if yes { 0x0800_0000 | 0x0000_0200 } else { 0x0000_0200 };
        let _ = yes;
        cmd.creation_flags(flags);
        cmd.spawn().map_err(|e| format!("could not start the uninstaller: {e}"))?;
        return Ok(0);
    }
    #[cfg(unix)]
    {
        let _ = yes;
        let st = cmd.status().map_err(|e| format!("could not start the uninstaller: {e}"))?;
        Ok(st.code().unwrap_or(1))
    }
}

pub fn is_uninstall_copy() -> bool {
    std::env::var_os(COPY_ENV).is_some()
}

/// Ids of processes whose executable lives under `dir` (Linux: /proc/<pid>/exe).
#[cfg(target_os = "linux")]
fn pids_running_from(dir: &Path) -> Vec<u32> {
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let me = std::process::id();
    let mut v = Vec::new();
    let Ok(rd) = fs::read_dir("/proc") else { return v };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        if pid == me {
            continue;
        }
        if let Ok(p) = fs::read_link(format!("/proc/{pid}/exe")) {
            let s = p.to_string_lossy().trim_end_matches(" (deleted)").to_string();
            if Path::new(&s).starts_with(&dir) && crate::run::pid_alive(pid) {
                v.push(pid);
            }
        }
    }
    v
}

#[cfg(target_os = "linux")]
fn ppid_of(pid: u32) -> Option<u32> {
    let s = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    s.rsplit(')').next()?.split_whitespace().nth(1)?.parse().ok()
}

/// `roots` plus all their descendants (WebKitWebProcess etc. on Linux).
#[cfg(target_os = "linux")]
fn with_descendants(roots: &[u32]) -> Vec<u32> {
    let mut all: Vec<u32> = roots.to_vec();
    let Ok(rd) = fs::read_dir("/proc") else { return all };
    let procs: Vec<(u32, u32)> = rd
        .flatten()
        .filter_map(|e| {
            let pid = e.file_name().to_str()?.parse::<u32>().ok()?;
            Some((pid, ppid_of(pid)?))
        })
        .collect();
    loop {
        let before = all.len();
        for (pid, pp) in &procs {
            if all.contains(pp) && !all.contains(pid) {
                all.push(*pid);
            }
        }
        if all.len() == before {
            return all;
        }
    }
}

/// Is a Recharge app running from <root>/app?
pub fn app_is_running(root: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        !pids_running_from(&root.join("app")).is_empty()
    }
    #[cfg(windows)]
    {
        !win_ps(&format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -like '{}\\app\\*' }} | ForEach-Object {{ $_.ProcessId }}",
            ps_quote(root)
        ))
        .trim()
        .is_empty()
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = root;
        false
    }
}

#[cfg(windows)]
fn ps_quote(p: &Path) -> String {
    p.display().to_string().replace('\'', "''")
}

#[cfg(windows)]
fn win_ps(script: &str) -> String {
    hidden("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Stop the app under <root>/app and its helper processes (WebView2 children that hold the
/// co.za.codecade.recharge\EBWebView user-data folder; WebKit processes on Linux). Nothing else.
pub fn close_app(root: &Path) {
    #[cfg(target_os = "linux")]
    {
        let app = pids_running_from(&root.join("app"));
        if app.is_empty() {
            return;
        }
        let all = with_descendants(&app);
        log!("closing Recharge (pids {all:?})");
        let kill = |sig: &str| {
            for p in &all {
                let _ = std::process::Command::new("kill").args([sig, &p.to_string()]).status();
            }
        };
        kill("-TERM");
        for _ in 0..20 {
            if all.iter().all(|p| !crate::run::pid_alive(*p)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        kill("-KILL");
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    #[cfg(windows)]
    {
        // Own windows first (graceful), then force. WebView2 helpers are matched by the user-data
        // folder in their command line so other apps' WebView2 processes are never touched.
        let script = format!(
            "$r='{root}\\app\\*'; \
             Get-Process | Where-Object {{ $_.Path -like $r }} | ForEach-Object {{ [void]$_.CloseMainWindow() }}; \
             Start-Sleep -Milliseconds 1500; \
             Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -like $r -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*{id}\\EBWebView*') }} | \
             ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
            root = ps_quote(root),
            id = APP_IDENTIFIER
        );
        log!("closing Recharge and its WebView2 processes");
        win_ps(&script);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    let _ = root;
}

/// remove_dir_all with retries: files may stay locked for a moment after their process dies.
fn remove_dir_retry(d: &Path) -> Result<(), String> {
    let mut last = String::new();
    for _ in 0..20 {
        match fs::remove_dir_all(d) {
            Ok(()) => return Ok(()),
            Err(e) if !d.exists() && e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err(last)
}

pub fn uninstall(root: &Path, yes: bool, mut delete: bool) -> Result<(), String> {
    // Never rm -rf an arbitrary directory because of a bad --root.
    if !launcher_path(root).exists() && !root.join("state.json").exists() {
        return Err(format!("{} does not look like a Recharge install, refusing", root.display()));
    }
    if !yes {
        if !ask(&format!("Remove Recharge from {} ?", root.display())) {
            return Err("cancelled".into());
        }
        if !delete {
            delete = ask("Also delete your Recharge settings, mods, skins and map saves?");
        }
        if app_is_running(root) && !ask("Recharge is running - close it?") {
            return Err("cancelled: Recharge is still running".into());
        }
    }
    close_app(root);
    #[cfg(unix)]
    if let Some(p) = desktop_file() {
        let _ = fs::remove_file(p);
    }
    #[cfg(windows)]
    {
        for p in [lnk_path(), uninstall_lnk_path()].into_iter().flatten() {
            let _ = fs::remove_file(p);
        }
        if !winnative::delete_uninstall_entry() {
            let _ = hidden("reg").args(["delete", UNINSTALL_KEY, "/f"]).status();
        }
    }
    let mut failed = Vec::new();
    if let Err(e) = remove_dir_retry(root) {
        log!("could not remove {}: {e}", root.display());
        failed.push(format!("{}: {e}", root.display()));
    }
    if delete {
        for d in data_dirs() {
            if d.exists() {
                match remove_dir_retry(&d) {
                    Ok(()) => log!("removed {}", d.display()),
                    Err(e) => {
                        log!("could not remove {}: {e}", d.display());
                        failed.push(format!("{}: {e}", d.display()));
                    }
                }
            }
        }
    }
    if failed.is_empty() { Ok(()) } else { Err(format!("some files could not be removed: {}", failed.join("; "))) }
}

/// The temp copy deletes itself after it exits.
pub fn schedule_self_delete() {
    if !is_uninstall_copy() {
        return;
    }
    let Ok(me) = std::env::current_exe() else { return };
    #[cfg(windows)]
    {
        let _ = hidden("cmd").args(["/C", &format!("ping -n 3 127.0.0.1 >nul & del /f /q \"{}\"", me.display())]).spawn();
    }
    #[cfg(unix)]
    {
        let _ = fs::remove_file(me);
    }
}
