use serde::Serialize;
use std::path::PathBuf;
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

// Populated by the runtime mod's RealAssetPalette.ExportTileTextures the first
// time a real course scene is scanned in-game - won't exist until then.
fn textures_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
    Some(
        PathBuf::from(game_path)
            .join("Recharge")
            .join("Mods")
            .join("recharge.maps")
            .join("textures"),
    )
}

// Rejects anything that isn't a plain single path segment - no separators,
// no "..", no empty string - since `id` and `filename` come from the editor
// and end up directly in a filesystem path.
fn sanitize_segment(segment: &str) -> Result<&str, String> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains('/')
        || segment.contains('\\')
    {
        return Err(format!("invalid name: '{segment}'"));
    }
    Ok(segment)
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

#[tauri::command]
pub fn get_map(app: AppHandle, id: String) -> Result<String, String> {
    let id = sanitize_segment(&id)?;
    let dir = maps_dir(&app).ok_or("game path not set")?;
    std::fs::read_to_string(dir.join(id).join("map.json")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_map(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let id = sanitize_segment(&id)?;
    // Validate it's real JSON before writing - a malformed save should fail
    // loudly in the editor, not silently corrupt the file on disk.
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| e.to_string())?;
    let dir = maps_dir(&app).ok_or("game path not set")?.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("map.json"), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_map(app: AppHandle, id: String) -> Result<(), String> {
    let id = sanitize_segment(&id)?;
    let dir = maps_dir(&app).ok_or("game path not set")?.join(id);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_map_image(
    app: AppHandle,
    id: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let id = sanitize_segment(&id)?;
    let filename = sanitize_segment(&filename)?;
    let gallery = maps_dir(&app)
        .ok_or("game path not set")?
        .join(id)
        .join("gallery");
    std::fs::create_dir_all(&gallery).map_err(|e| e.to_string())?;
    std::fs::write(gallery.join(filename), bytes).map_err(|e| e.to_string())?;
    Ok(format!("gallery/{filename}"))
}

// `tilemap` is one of "ground" / "blueBlocks" / "orangeBlocks" - real names
// extracted at runtime, in the same order as the PNG files (0.png, 1.png, ...).
#[tauri::command]
pub fn list_tile_textures(app: AppHandle, tilemap: String) -> Result<Vec<String>, String> {
    let tilemap = sanitize_segment(&tilemap)?;
    let dir = textures_dir(&app).ok_or("game path not set")?.join(tilemap);
    let text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|_| "no textures found yet - launch the game and visit a course first".to_string())?;
    serde_json::from_str::<Vec<String>>(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_tile_texture(app: AppHandle, tilemap: String, index: usize) -> Result<Vec<u8>, String> {
    let tilemap = sanitize_segment(&tilemap)?;
    let dir = textures_dir(&app).ok_or("game path not set")?.join(tilemap);
    std::fs::read(dir.join(format!("{index}.png"))).map_err(|e| e.to_string())
}

// Real Unity RuleTile neighbor-matching rules (RealAssetPalette.ExportTileRules),
// parallel array to manifest.json - null entries mean "not a RuleTile / no rules".
// Returned as a raw JSON string (schema owned by the editor, not this backend).
#[tauri::command]
pub fn read_tile_rules(app: AppHandle, tilemap: String) -> Result<String, String> {
    let tilemap = sanitize_segment(&tilemap)?;
    let dir = textures_dir(&app).ok_or("game path not set")?.join(tilemap);
    std::fs::read_to_string(dir.join("rules.json")).map_err(|_| "no rule data yet - launch the game and visit a course first".to_string())
}
