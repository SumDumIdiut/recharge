//! Who is holding a locked path, and leftover Recharge processes running from the app folders (Windows only; no-ops elsewhere).
use std::path::{Path, PathBuf};

/// Log the processes that hold files under `path` (Restart Manager).
#[cfg(not(windows))]
pub fn log_holders(_: &Path) {}

/// Terminate processes whose executable lives inside one of `dirs` (never ourselves).
#[cfg(not(windows))]
pub fn terminate_in_folders(_: &[PathBuf]) {}

#[cfg(windows)]
pub use win::{log_holders, terminate_in_folders};

#[cfg(windows)]
mod win {
    use crate::log;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::RestartManager::{RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO};
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};

    const ERROR_MORE_DATA: u32 = 234;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut n = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut n);
            CloseHandle(h);
            if ok == 0 { None } else { Some(String::from_utf16_lossy(&buf[..n as usize])) }
        }
    }

    fn processes() -> Vec<(u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out.push((e.th32ProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    fn norm(s: &str) -> String {
        s.replace('/', "\\").to_lowercase()
    }

    pub fn terminate_in_folders(dirs: &[PathBuf]) {
        let prefixes: Vec<String> = dirs.iter().map(|d| format!("{}\\", norm(&d.to_string_lossy()).trim_end_matches('\\'))).collect();
        let me = unsafe { GetCurrentProcessId() };
        let mut killed = false;
        for (pid, name) in processes() {
            if pid == me {
                continue;
            }
            let Some(img) = image_path(pid) else { continue };
            let n = norm(&img);
            if !prefixes.iter().any(|p| n.starts_with(p)) {
                continue;
            }
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if h.is_null() {
                    log!("leftover process {name} (pid {pid}, {img}) runs from the app folder but cannot be opened");
                    continue;
                }
                let ok = TerminateProcess(h, 1);
                CloseHandle(h);
                log!("leftover process {name} (pid {pid}, {img}): terminate {}", if ok != 0 { "ok" } else { "failed" });
                killed = true;
            }
        }
        if killed {
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
    }

    /// Up to `limit` files under `p` (or `p` itself if it is a file).
    fn files_under(p: &Path, limit: usize) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            if out.len() >= limit {
                break;
            }
            if d.is_dir() {
                if let Ok(rd) = std::fs::read_dir(&d) {
                    for e in rd.flatten() {
                        stack.push(e.path());
                    }
                }
            } else {
                out.push(d);
            }
        }
        out
    }

    pub fn log_holders(path: &Path) {
        if !path.exists() {
            return;
        }
        let files = files_under(path, 128);
        if files.is_empty() {
            return;
        }
        let wide_files: Vec<Vec<u16>> = files.iter().map(|f| wide(&f.to_string_lossy())).collect();
        let ptrs: Vec<*const u16> = wide_files.iter().map(|w| w.as_ptr()).collect();
        unsafe {
            let mut session = 0u32;
            let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
            let rc = RmStartSession(&mut session, 0, key.as_mut_ptr());
            if rc != 0 {
                log!("holders of {}: RmStartSession {rc}", path.display());
                return;
            }
            let rc = RmRegisterResources(session, ptrs.len() as u32, ptrs.as_ptr(), 0, null(), 0, null());
            if rc != 0 {
                log!("holders of {}: RmRegisterResources {rc}", path.display());
                RmEndSession(session);
                return;
            }
            let (mut needed, mut have, mut reasons) = (0u32, 0u32, 0u32);
            let rc = RmGetList(session, &mut needed, &mut have, null_mut(), &mut reasons);
            if rc == 0 && needed == 0 {
                log!("{} is not held by any process Restart Manager can see", path.display());
            } else if rc == 0 || rc == ERROR_MORE_DATA {
                let mut infos: Vec<RM_PROCESS_INFO> = vec![std::mem::zeroed(); needed as usize + 4];
                have = infos.len() as u32;
                let rc = RmGetList(session, &mut needed, &mut have, infos.as_mut_ptr(), &mut reasons);
                if rc == 0 {
                    for i in infos.iter().take(have as usize) {
                        let n = i.strAppName.iter().position(|&c| c == 0).unwrap_or(i.strAppName.len());
                        let pid = i.Process.dwProcessId;
                        log!("{} is held by {} (pid {pid}, {})", path.display(), String::from_utf16_lossy(&i.strAppName[..n]), image_path(pid).unwrap_or_else(|| "?".into()));
                    }
                } else {
                    log!("holders of {}: RmGetList {rc}", path.display());
                }
            } else {
                log!("holders of {}: RmGetList {rc}", path.display());
            }
            RmEndSession(session);
        }
    }
}
