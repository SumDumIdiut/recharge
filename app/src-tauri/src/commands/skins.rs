use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

use super::settings;

const CUSTOM_SKINS_MOD_ID: &str = "recharge.customskins";
const IMAGE_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];
// Optional indicator art inside a skin folder - never the skin's own image.
const INDICATOR_STEMS: [&str; 5] = ["dash", "doublejump", "double-jump", "double_jump", "jump"];

fn skins_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
    Some(
        PathBuf::from(game_path)
            .join("Recharge")
            .join("Mods")
            .join(CUSTOM_SKINS_MOD_ID)
            .join("data")
            .join("skins"),
    )
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
    Some(
        PathBuf::from(game_path)
            .join("Recharge")
            .join("Mods")
            .join(CUSTOM_SKINS_MOD_ID)
            .join("data")
            .join("config.json"),
    )
}

#[derive(Serialize, Deserialize, Default)]
struct SkinConfig {
    #[serde(rename = "CurrentSkinFile")]
    current_skin_folder: Option<String>,
    #[serde(rename = "ExportDir", default)]
    export_dir: Option<String>,
}

fn read_config(app: &AppHandle) -> SkinConfig {
    let Some(path) = config_path(app) else {
        return SkinConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return SkinConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &SkinConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("game path not set")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn sanitize_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("invalid name: '{name}'"));
    }
    Ok(())
}

fn find_image_file(skin_folder: &std::path::Path) -> Option<PathBuf> {
    let mut images: Vec<PathBuf> = std::fs::read_dir(skin_folder)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|path| {
            let is_image = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| IMAGE_EXTENSIONS.contains(&s.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            is_image && !INDICATOR_STEMS.contains(&stem.as_str())
        })
        .collect();
    images.sort_by_key(|p| p.file_name().map(|n| n.to_ascii_lowercase()));
    images.into_iter().next()
}

// Written alongside a skin installed from the hub, since the folder itself
// is named after a readable slug of the skin's name (not the hub id) - this
// is what lets the Browse tab still recognize "already installed" and lets
// the Installed tab show the real name instead of guessing from the folder.
pub const HUB_META_FILE: &str = ".recharge-hub-meta.json";

#[derive(Serialize, Deserialize)]
pub struct SkinHubMeta {
    #[serde(rename = "hubId")]
    pub hub_id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct SkinEntry {
    #[serde(rename = "folderName")]
    pub folder_name: String,
    pub enabled: bool,
    #[serde(rename = "hubId", skip_serializing_if = "Option::is_none")]
    pub hub_id: Option<String>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

pub fn read_hub_meta(skin_folder: &std::path::Path) -> Option<SkinHubMeta> {
    let text = std::fs::read_to_string(skin_folder.join(HUB_META_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn list_installed_skins(app: AppHandle) -> Vec<SkinEntry> {
    let mut names: Vec<String> = (|| {
        let dir = skins_dir(&app)?;
        let entries = std::fs::read_dir(dir).ok()?;
        Some(
            entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect::<Vec<_>>(),
        )
    })()
    .unwrap_or_default();
    names.sort_by_key(|n| n.to_ascii_lowercase());

    let config = read_config(&app);
    let dir = skins_dir(&app);
    names
        .into_iter()
        .map(|folder_name| {
            let enabled = config.current_skin_folder.as_deref() == Some(folder_name.as_str());
            let meta = dir.as_ref().and_then(|d| read_hub_meta(&d.join(&folder_name)));
            SkinEntry {
                folder_name,
                enabled,
                hub_id: meta.as_ref().map(|m| m.hub_id.clone()),
                display_name: meta.map(|m| m.name),
            }
        })
        .collect()
}

#[tauri::command]
pub fn set_active_skin(app: AppHandle, folder_name: Option<String>) -> Result<(), String> {
    if let Some(name) = &folder_name {
        sanitize_name(name)?;
    }
    let mut config = read_config(&app);
    config.current_skin_folder = folder_name;
    write_config(&app, &config)
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    out
}

#[tauri::command]
pub fn read_skin_thumbnail(app: AppHandle, folder_name: String) -> Result<String, String> {
    sanitize_name(&folder_name)?;
    let dir = skins_dir(&app).ok_or("game path not set")?;
    let image_path = find_image_file(&dir.join(&folder_name)).ok_or("no image file in this skin's folder")?;
    let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
    let mime = match image_path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()) {
        Some(ref ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
pub fn delete_skin(app: AppHandle, folder_name: String) -> Result<(), String> {
    sanitize_name(&folder_name)?;
    let dir = skins_dir(&app).ok_or("game path not set")?;
    std::fs::remove_dir_all(dir.join(&folder_name)).map_err(|e| e.to_string())?;

    let mut config = read_config(&app);
    if config.current_skin_folder.as_deref() == Some(folder_name.as_str()) {
        config.current_skin_folder = None;
        write_config(&app, &config)?;
    }
    Ok(())
}
