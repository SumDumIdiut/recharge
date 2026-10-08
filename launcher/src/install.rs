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
        "[Desktop Entry]\nType=Application\nName=Recharge\nComment=Recharge launcher\nExec=\"{}\"\nTerminal=false\nCategories=Game;\n",
        launcher_path(root).display()
    );
    if let Some(i) = icon {
        s.push_str(&format!("Icon={}\n", i.display()));
    }
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
        if let Err(e) = winnative::create_shortcut(&lnk, &exe, root) {
            log!("native shortcut failed ({e:#x}), falling back to PowerShell");
            let ps = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.Save()",
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
    /// IShellLinkW: IUnknown + 18 methods; only the three used are typed, the rest are placeholders.
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
        _set_arguments: usize,
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
    pub fn create_shortcut(lnk: &Path, target: &Path, workdir: &Path) -> Result<(), u32> {
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
            let l = &**(link as *mut Obj<ShellLinkVtbl>);
            let l = &*l.vtbl;
            let (t, w, d) = (wide(target), wide(workdir), wide("Recharge"));
            let mut hr = (l.set_path)(link, t.as_ptr());
            if hr >= 0 {
                hr = (l.set_working_directory)(link, w.as_ptr());
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

pub fn uninstall(root: &Path, yes: bool) -> Result<(), String> {
    // Never rm -rf an arbitrary directory because of a bad --root.
    if !launcher_path(root).exists() && !root.join("state.json").exists() {
        return Err(format!("{} does not look like a Recharge install, refusing", root.display()));
    }
    if !yes {
        eprint!("Remove Recharge from {} ? [y/N] ", root.display());
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        if !matches!(line.trim().to_lowercase().as_str(), "y" | "yes") {
            return Err("cancelled".into());
        }
    }
    #[cfg(unix)]
    if let Some(p) = desktop_file() {
        let _ = fs::remove_file(p);
    }
    #[cfg(windows)]
    {
        if let Some(p) = lnk_path() {
            let _ = fs::remove_file(p);
        }
        if !winnative::delete_uninstall_entry() {
            let _ = hidden("reg").args(["delete", UNINSTALL_KEY, "/f"]).status();
        }
        // The running exe cannot delete itself: hand the folder to a detached cmd that retries.
        let _ = hidden("cmd")
            .args(["/C", &format!("ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{}\"", root.display())])
            .spawn();
        return Ok(());
    }
    #[cfg(unix)]
    {
        fs::remove_dir_all(root).map_err(|e| format!("remove {}: {e}", root.display()))?;
        Ok(())
    }
}
