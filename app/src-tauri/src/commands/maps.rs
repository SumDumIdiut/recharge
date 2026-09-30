use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::settings;

fn maps_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
    Some(
        PathBuf::from(game_path)
            .join("Recharge")
            .join("Mods")
            .join("recharge.maps")
            .join("maps"),
    )
}

/// A file that travels with a map (custom music, backgrounds): saved as assets/<file>.
#[derive(Deserialize)]
pub struct MapAsset {
    pub file: String,
    pub data: String,
}

fn safe_file(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn write_assets(map_dir: &Path, assets: &[MapAsset]) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }
    let folder = map_dir.join("assets");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    for a in assets {
        if !safe_file(&a.file) {
            return Err(format!("invalid asset name: '{}'", a.file));
        }
        std::fs::write(folder.join(&a.file), base64_decode(&a.data)?).map_err(|e| format!("couldn't save {}: {e}", a.file))?;
    }
    Ok(())
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let body = text.split_once(',').map(|(head, rest)| if head.contains("base64") { rest } else { text }).unwrap_or(text);
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in body.bytes() {
        let v = match c {
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => B64.iter().position(|&x| x == c).ok_or("asset isn't valid base64")? as u32,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// One of an installed map's asset files, base64 (to bring it back into the editor).
#[tauri::command]
pub fn read_map_asset(app: AppHandle, id: String, file: String) -> Result<String, String> {
    if !safe_file(&id) || !safe_file(&file) {
        return Err("invalid name".into());
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    let bytes = std::fs::read(dir.join(&id).join("assets").join(&file)).map_err(|e| format!("couldn't read {file}: {e}"))?;
    Ok(base64_encode(&bytes))
}

#[derive(Serialize)]
pub struct MapSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub images: Vec<String>,
    #[serde(rename = "groupCount")]
    pub group_count: usize,
}

#[tauri::command]
pub fn uninstall_map(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    let target = dir.join(&id);
    if !target.is_dir() {
        return Err(format!("map '{id}' not found"));
    }
    std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_map(app: AppHandle, id: String) -> Result<String, String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    std::fs::read_to_string(dir.join(&id).join("map.json")).map_err(|e| format!("couldn't read map '{id}': {e}"))
}

// Writes the editor's map into the installed maps as <id>/map.json, replacing that map if it exists.
#[tauri::command]
pub fn save_map(app: AppHandle, id: String, map_json: String, assets: Option<Vec<MapAsset>>) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    serde_json::from_str::<serde_json::Value>(&map_json).map_err(|e| format!("map isn't valid JSON: {e}"))?;
    let target = maps_dir(&app).ok_or("game path not set")?.join(&id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::write(target.join("map.json"), map_json).map_err(|e| format!("couldn't save map '{id}': {e}"))?;
    write_assets(&target, assets.as_deref().unwrap_or(&[]))
}

// "Export .zip": asks where to save, then writes map.json zipped there. None if the user cancels.
#[tauri::command]
pub async fn export_map_zip(app: AppHandle, map_json: String, file_name: String, assets: Option<Vec<MapAsset>>) -> Result<Option<String>, String> {
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    serde_json::from_str::<serde_json::Value>(&map_json).map_err(|e| format!("map isn't valid JSON: {e}"))?;
    let Some(picked) = app.dialog().file().set_file_name(&file_name).add_filter("Map", &["zip"]).blocking_save_file() else {
        return Ok(None);
    };
    let mut path = picked.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("zip");
    }
    let file = std::fs::File::create(&path).map_err(|e| format!("couldn't create {}: {e}", path.display()))?;
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file("map.json", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))
        .map_err(|e| e.to_string())?;
    archive.write_all(map_json.as_bytes()).map_err(|e| e.to_string())?;
    for a in assets.as_deref().unwrap_or(&[]) {
        if !safe_file(&a.file) {
            return Err(format!("invalid asset name: '{}'", a.file));
        }
        archive
            .start_file(format!("assets/{}", a.file), zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))
            .map_err(|e| e.to_string())?;
        archive.write_all(&base64_decode(&a.data)?).map_err(|e| e.to_string())?;
    }
    archive.finish().map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub fn list_maps(app: AppHandle) -> Vec<MapSummary> {
    let mut maps = Vec::new();
    let Some(dir) = maps_dir(&app) else {
        return maps;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return maps;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(path.join("map.json")) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let name = json
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let description = json
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let images = json
            .get("images")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let group_count = json
            .get("groups")
            .and_then(|g| g.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        maps.push(MapSummary {
            id,
            name,
            description,
            images,
            group_count,
        });
    }
    maps
}

// "Test in game": installs under a fixed id, flags it via autoplay.txt, then launches modded.
const TEST_MAP_ID: &str = "map-maker-test";

#[tauri::command]
pub fn test_launch_map(app: AppHandle, map_json: String, assets: Option<Vec<MapAsset>>) -> Result<super::play::LaunchMethod, String> {
    serde_json::from_str::<serde_json::Value>(&map_json).map_err(|e| format!("map isn't valid JSON: {e}"))?;
    let dir = maps_dir(&app).ok_or("game path not set")?;
    // Dev: a locally-built Navigator (RECHARGE_DEV_NAVIGATOR_DLL) overrides the installed one.
    if let Some(dll) = std::env::var_os("RECHARGE_DEV_NAVIGATOR_DLL").map(PathBuf::from).filter(|p| p.is_file()) {
        let installed = dir.parent().ok_or("bad maps folder")?.join("RechargeMaps.dll");
        std::fs::copy(&dll, &installed).map_err(|e| format!("couldn't install the dev Navigator: {e}"))?;
    }
    let target = dir.join(TEST_MAP_ID);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::write(target.join("map.json"), map_json).map_err(|e| e.to_string())?;
    write_assets(&target, assets.as_deref().unwrap_or(&[]))?;
    let request = dir.parent().ok_or("bad maps folder")?.join("autoplay.txt");
    std::fs::write(&request, TEST_MAP_ID).map_err(|e| e.to_string())?;
    super::play::launch_game(app, true).map_err(|e| {
        let _ = std::fs::remove_file(&request);
        e
    })
}
