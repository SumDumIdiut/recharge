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

fn default_steam_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("C:\\Program Files (x86)\\Steam"),
        PathBuf::from("C:\\Program Files\\Steam"),
    ]
}

fn library_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for steam_dir in default_steam_dirs() {
        if !steam_dir.is_dir() {
            continue;
        }
        roots.push(steam_dir.clone());
        let vdf_path = steam_dir.join("steamapps").join("libraryfolders.vdf");
        if let Ok(text) = std::fs::read_to_string(&vdf_path) {
            for lib_path in vdf::library_paths(&text) {
                roots.push(PathBuf::from(lib_path));
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn find_assembly_csharp(game_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if !name.ends_with("_Data") {
            continue;
        }
        let dll = path.join("Managed").join("Assembly-CSharp.dll");
        if dll.is_file() {
            return Some(dll);
        }
    }
    None
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

fn scan_library(common_dir: &Path, steamapps_dir: &Path) -> Option<InstallInfo> {
    let entries = std::fs::read_dir(common_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        if !name.to_uppercase().starts_with("IGTAP") {
            continue;
        }
        if find_assembly_csharp(&path).is_none() {
            continue;
        }
        let variant = if name.to_lowercase().contains("demo") {
            "Demo"
        } else {
            "Playtest"
        };
        return Some(InstallInfo {
            variant: variant.to_string(),
            appid: find_appid(steamapps_dir, &name),
            path: path.to_string_lossy().to_string(),
        });
    }
    None
}

pub fn detect() -> Option<InstallInfo> {
    for root in library_roots() {
        let steamapps = root.join("steamapps");
        let common = steamapps.join("common");
        if let Some(found) = scan_library(&common, &steamapps) {
            return Some(found);
        }
    }
    None
}

// Builds an InstallInfo directly from a known folder (a manually browsed-to
// path isn't necessarily found by the steamapps/common scan `detect()` does -
// e.g. a non-standard Steam library location, or the game moved).
fn info_for_path(game_dir: &Path) -> Option<InstallInfo> {
    find_assembly_csharp(game_dir)?;
    let name = game_dir.file_name()?.to_string_lossy().to_string();
    let variant = if name.to_lowercase().contains("demo") { "Demo" } else { "Playtest" };
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
    // A manually-set path (Settings > Browse) must win over auto-scan - it's
    // there specifically because the user picked it, often because auto-detect
    // couldn't find it on its own. Previously this ignored that entirely, so
    // Browse looked broken: it saved the path, but Home never showed it.
    if let Some(path) = settings::get_game_path(app) {
        if let Some(info) = info_for_path(Path::new(&path)) {
            return Some(info);
        }
    }
    detect()
}
