use crate::vdf;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::settings;

#[derive(Serialize, Clone)]
pub struct InstallInfo {
    pub variant: String,
    pub path: String,
    pub appid: Option<String>,
}

#[cfg(windows)]
fn default_steam_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("C:\\Program Files (x86)\\Steam"),
        PathBuf::from("C:\\Program Files\\Steam"),
    ]
}

#[cfg(not(windows))]
fn default_steam_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".steam").join("steam"));
        dirs.push(home.join(".steam").join("root"));
        dirs.push(home.join(".local").join("share").join("Steam"));
        dirs.push(
            home.join(".var")
                .join("app")
                .join("com.valvesoftware.Steam")
                .join(".local")
                .join("share")
                .join("Steam"),
        );
    }
    dirs
}

/// Windows canonicalize() returns `\\?\C:\...`, which never string-matches the
/// plain `C:\...` a saved/browsed path uses and made one install list twice.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn push_canonical(roots: &mut Vec<PathBuf>, path: &Path) {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    roots.push(strip_verbatim_prefix(canonical));
}

fn library_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for steam_dir in default_steam_dirs() {
        if !steam_dir.is_dir() {
            continue;
        }
        push_canonical(&mut roots, &steam_dir);
        let vdf_path = steam_dir.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = std::fs::read_to_string(&vdf_path) {
            for lib_path in vdf::library_paths(&text) {
                push_canonical(&mut roots, &PathBuf::from(lib_path));
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

pub fn managed_dir(game_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.ends_with("_Data") {
            let managed = path.join("Managed");
            if managed.is_dir() {
                return Some(managed);
            }
        }
    }
    None
}

fn find_assembly_csharp(game_dir: &Path) -> Option<PathBuf> {
    let dll = managed_dir(game_dir)?.join("Assembly-CSharp.dll");
    dll.is_file().then_some(dll)
}

fn variant_for_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("demo") {
        "Demo"
    } else if lower.contains("playtest") {
        "Playtest"
    } else {
        "Full Game"
    }
}

fn find_appid(steamapps_dir: &Path, installdir_name: &str) -> Option<String> {
    let entries = std::fs::read_dir(steamapps_dir).ok()?;
    let needle = installdir_name.to_lowercase();
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path.file_name()?.to_string_lossy().to_string();
        if !fname.starts_with("appmanifest_") || !fname.ends_with(".acf") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let matches_installdir = text.lines().any(|l| {
            let l = l.trim();
            l.starts_with("\"installdir\"")
                && vdf::split_quoted_pair(l)
                    .map(|(_, v)| v.to_lowercase() == needle)
                    .unwrap_or(false)
        });
        if !matches_installdir {
            continue;
        }
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("\"appid\"") {
                if let Some((_, value)) = vdf::split_quoted_pair(line) {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn scan_library_all(common_dir: &Path, steamapps_dir: &Path) -> Vec<InstallInfo> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(common_dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.to_uppercase().starts_with("IGTAP") {
            continue;
        }
        if find_assembly_csharp(&path).is_none() {
            continue;
        }
        let variant = variant_for_name(&name);
        found.push(InstallInfo {
            variant: variant.to_string(),
            appid: find_appid(steamapps_dir, &name),
            path: path.to_string_lossy().to_string(),
        });
    }
    found
}

fn variant_sort_key(variant: &str) -> u8 {
    match variant {
        "Full Game" => 0,
        "Playtest" => 1,
        _ => 2, // Demo, or anything else
    }
}

pub fn detect_all() -> Vec<InstallInfo> {
    let mut found = Vec::new();
    for root in library_roots() {
        let steamapps = root.join("steamapps");
        let common = steamapps.join("common");
        found.extend(scan_library_all(&common, &steamapps));
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|i| seen.insert(i.path.to_lowercase()));
    // Full Game first - it's the one that actually supports mods, so it's
    // what most actions here care about.
    found.sort_by_key(|i| variant_sort_key(&i.variant));
    found
}

pub fn detect() -> Option<InstallInfo> {
    detect_all().into_iter().next()
}

#[tauri::command]
pub fn detect_all_igtap_installs() -> Vec<InstallInfo> {
    detect_all()
}

pub fn info_for_path(game_dir: &Path) -> Option<InstallInfo> {
    let game_dir = strip_verbatim_prefix(game_dir.to_path_buf());
    let game_dir = game_dir.as_path();
    find_assembly_csharp(game_dir)?;
    let name = game_dir.file_name()?.to_string_lossy().to_string();
    let variant = variant_for_name(&name);
    let appid = game_dir
        .parent() // .../steamapps/common
        .and_then(|common| common.parent()) // .../steamapps
        .and_then(|steamapps| find_appid(steamapps, &name));
    Some(InstallInfo {
        variant: variant.to_string(),
        appid,
        path: game_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn detect_igtap_install(app: AppHandle) -> Option<InstallInfo> {
    if let Some(path) = settings::get_game_path(app) {
        if let Some(info) = info_for_path(Path::new(&path)) {
            return Some(info);
        }
    }
    detect()
}
