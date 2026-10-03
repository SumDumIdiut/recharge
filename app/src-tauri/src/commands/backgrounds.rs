use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

fn backgrounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("no app data dir: {e}"))?.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = backgrounds_dir(app)?.join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn sanitize_segment(s: &str) -> Result<(), String> {
    if s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\\') {
        return Err(format!("invalid name: '{s}'"));
    }
    Ok(())
}

// Every background image you've uploaded, newest first.
#[tauri::command]
pub fn list_background_images(app: AppHandle) -> Vec<String> {
    let Ok(dir) = images_dir(&app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut rows: Vec<(std::time::SystemTime, String)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_image(p))
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().into_owned();
            let modified = p.metadata().and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            Some((modified, name))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, name)| name).collect()
}

#[tauri::command]
pub fn upload_background_image(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("'{path}' not found"));
    }
    if !is_image(&src) {
        return Err("only png, jpg, webp or gif images can be uploaded".to_string());
    }
    let dir = images_dir(&app)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let mut candidate = src.file_name().ok_or("invalid file name")?.to_string_lossy().into_owned();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    std::fs::copy(&src, dir.join(&candidate)).map_err(|e| e.to_string())?;
    Ok(candidate)
}

#[tauri::command]
pub fn delete_background_image(app: AppHandle, file_name: String) -> Result<(), String> {
    sanitize_segment(&file_name)?;
    let dir = images_dir(&app)?;
    std::fs::remove_file(dir.join(&file_name)).map_err(|e| e.to_string())?;

    // Drop it from every playlist that referenced it too, so nothing dangles.
    let mut config = load_config(&app);
    let mut changed = false;
    for playlist in &mut config.playlists {
        let before = playlist.images.len();
        playlist.images.retain(|i| i != &file_name);
        changed |= playlist.images.len() != before;
    }
    if changed {
        save_config(&app, &config)?;
    }
    Ok(())
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

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

#[tauri::command]
pub fn read_background_image(app: AppHandle, file_name: String) -> Result<String, String> {
    sanitize_segment(&file_name)?;
    let path = images_dir(&app)?.join(&file_name);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(format!("data:{};base64,{}", mime_of(&path), base64_encode(&bytes)))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub images: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct BackgroundsConfig {
    pub playlists: Vec<Playlist>,
    pub active_playlist: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(backgrounds_dir(app)?.join("playlists.json"))
}

fn load_config(app: &AppHandle) -> BackgroundsConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &BackgroundsConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(app)?, json).map_err(|e| e.to_string())
}

fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("pl_{nanos:x}")
}

#[tauri::command]
pub fn get_backgrounds_config(app: AppHandle) -> BackgroundsConfig {
    load_config(&app)
}

#[tauri::command]
pub fn save_playlist(app: AppHandle, id: Option<String>, name: String, images: Vec<String>) -> Result<Playlist, String> {
    if name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    let mut config = load_config(&app);
    let playlist = Playlist { id: id.clone().unwrap_or_else(new_id), name, images };
    match config.playlists.iter_mut().find(|p| p.id == playlist.id) {
        Some(slot) => *slot = playlist.clone(),
        None => config.playlists.push(playlist.clone()),
    }
    save_config(&app, &config)?;
    Ok(playlist)
}

#[tauri::command]
pub fn delete_playlist(app: AppHandle, id: String) -> Result<(), String> {
    let mut config = load_config(&app);
    config.playlists.retain(|p| p.id != id);
    if config.active_playlist.as_deref() == Some(id.as_str()) {
        config.active_playlist = None;
    }
    save_config(&app, &config)
}

#[tauri::command]
pub fn set_active_playlist(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let mut config = load_config(&app);
    config.active_playlist = id;
    save_config(&app, &config)
}

// Cheap, non-cryptographic pick - good enough for choosing a random wallpaper.
fn pseudo_random(max: usize) -> usize {
    if max == 0 {
        return 0;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (nanos % max as u128) as usize
}

#[tauri::command]
pub fn pick_random_background(app: AppHandle) -> Result<Option<String>, String> {
    let config = load_config(&app);
    let Some(active_id) = config.active_playlist else { return Ok(None) };
    let Some(playlist) = config.playlists.iter().find(|p| p.id == active_id) else { return Ok(None) };

    let Ok(dir) = images_dir(&app) else { return Ok(None) };
    let mut candidates = playlist.images.clone();
    while !candidates.is_empty() {
        let idx = pseudo_random(candidates.len());
        let file_name = candidates.remove(idx);
        if dir.join(&file_name).is_file() {
            return read_background_image(app, file_name).map(Some);
        }
    }
    Ok(None)
}
