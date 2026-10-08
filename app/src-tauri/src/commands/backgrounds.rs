use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
const MAX_PLAYLIST_IMAGES: usize = 50;
const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;

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

// A file name that doesn't clash with anything in `dir` (adds -2, -3, ...).
fn unique_name(dir: &Path, name: &str) -> String {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let mut candidate = name.to_string();
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    candidate
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
    let candidate = unique_name(&dir, &src.file_name().ok_or("invalid file name")?.to_string_lossy());
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
    let mut changed = config.image_public.remove(&file_name).is_some();
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
    // Seconds between background changes; 0 = once per launch.
    #[serde(default)]
    pub interval: u64,
    // Hub submission id while the playlist is public.
    #[serde(default)]
    pub public_id: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct BackgroundsConfig {
    pub playlists: Vec<Playlist>,
    pub active_playlist: Option<String>,
    // Image file name -> hub submission id while that image is public.
    #[serde(default)]
    pub image_public: std::collections::HashMap<String, String>,
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
    let id = id.unwrap_or_else(new_id);
    // Editing keeps the playlist's interval and public id.
    let playlist = match config.playlists.iter_mut().find(|p| p.id == id) {
        Some(slot) => {
            slot.name = name;
            slot.images = images;
            slot.clone()
        }
        None => {
            let p = Playlist { id, name, images, interval: 0, public_id: None };
            config.playlists.push(p.clone());
            p
        }
    };
    save_config(&app, &config)?;
    Ok(playlist)
}

#[tauri::command]
pub fn set_playlist_interval(app: AppHandle, id: String, interval: u64) -> Result<(), String> {
    let mut config = load_config(&app);
    config.playlists.iter_mut().find(|p| p.id == id).ok_or("playlist not found")?.interval = interval;
    save_config(&app, &config)
}

fn set_public_id(app: &AppHandle, id: &str, public_id: Option<String>) -> Result<(), String> {
    let mut config = load_config(app);
    config.playlists.iter_mut().find(|p| p.id == id).ok_or("playlist not found")?.public_id = public_id;
    save_config(app, &config)
}

// Flat zip of the images, original file names.
fn build_playlist_zip(dir: &Path, names: &[String]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for name in names {
        sanitize_segment(name)?;
        let bytes = std::fs::read(dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
        writer.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
        writer.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(writer.finish().map_err(|e| e.to_string())?.into_inner())
}

// Saves the images of a playlist zip into `dir` (flat, no name clashes), returns the new file names.
fn extract_playlist_zip(bytes: &[u8], dir: &Path) -> Result<Vec<String>, String> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("bad playlist zip: {e}"))?;
    let mut saved = Vec::new();
    for i in 0..archive.len() {
        if saved.len() >= MAX_PLAYLIST_IMAGES {
            break;
        }
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if !entry.is_file() {
            continue;
        }
        let Some(base) = entry.name().rsplit(['/', '\\']).next().map(str::to_string) else { continue };
        if base.starts_with('.') || !is_image(Path::new(&base)) {
            continue;
        }
        let mut data = Vec::new();
        entry.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_IMAGE_BYTES {
            continue;
        }
        let name = unique_name(dir, &base);
        std::fs::write(dir.join(&name), &data).map_err(|e| e.to_string())?;
        saved.push(name);
    }
    Ok(saved)
}

// Makes the playlist public (or re-uploads it if it already is): new submission first, then the old one goes.
#[tauri::command]
pub async fn publish_playlist(app: AppHandle, token: String, id: String, author: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&app);
        let playlist = config.playlists.iter().find(|p| p.id == id).ok_or("playlist not found")?;
        if playlist.images.is_empty() {
            return Err("add at least one image before making a playlist public".to_string());
        }
        if playlist.images.len() > MAX_PLAYLIST_IMAGES {
            return Err(format!("public playlists can have at most {MAX_PLAYLIST_IMAGES} images"));
        }
        let zip_bytes = build_playlist_zip(&images_dir(&app)?, &playlist.images)?;
        let new_id = super::hub::hub_submit_playlist(&token, &playlist.name, &author, &zip_bytes)?;
        set_public_id(&app, &id, Some(new_id.clone()))?;
        if let Some(old) = &playlist.public_id {
            let _ = super::hub::hub_delete_submission(&token, old);
        }
        Ok(new_id)
    })
    .await
    .map_err(|e| format!("upload task panicked: {e}"))?
}

// Takes the playlist off the hub and makes it private again.
#[tauri::command]
pub async fn unpublish_playlist(app: AppHandle, token: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&app);
        let playlist = config.playlists.iter().find(|p| p.id == id).ok_or("playlist not found")?;
        if let Some(public_id) = &playlist.public_id {
            super::hub::hub_delete_submission(&token, public_id)?;
        }
        set_public_id(&app, &id, None)
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

// Image extension from the file's first bytes (hub files are untrusted).
fn sniff_ext(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) { Some("png") }
    else if b.starts_with(&[0xFF, 0xD8, 0xFF]) { Some("jpg") }
    else if b.starts_with(b"GIF8") { Some("gif") }
    else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" { Some("webp") }
    else { None }
}

// File name for a downloaded hub image: the hub name as a safe stem + the real extension.
fn background_file_name(name: &str, ext: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(60)
        .collect();
    let stem = if stem.is_empty() { "background".to_string() } else { stem };
    format!("{stem}.{ext}")
}

pub fn install_hub_background(app: &AppHandle, id: &str, name: &str) -> Result<String, String> {
    let bytes = super::hub::hub_download_background(id)?;
    let ext = sniff_ext(&bytes).ok_or("that file isn't a png, jpg, webp or gif image")?;
    let dir = images_dir(app)?;
    let file = unique_name(&dir, &background_file_name(name, ext));
    std::fs::write(dir.join(&file), &bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

pub fn install_hub_playlist(app: &AppHandle, id: &str, name: &str, author: &str) -> Result<String, String> {
    let bytes = super::hub::hub_download_playlist_zip(id)?;
    let images = extract_playlist_zip(&bytes, &images_dir(app)?)?;
    if images.is_empty() {
        return Err("that playlist has no usable images".to_string());
    }
    let mut config = load_config(app);
    let label = if author.trim().is_empty() { name.to_string() } else { format!("{name} (by {author})") };
    config.playlists.push(Playlist { id: new_id(), name: label.clone(), images, interval: 0, public_id: None });
    save_config(app, &config)?;
    Ok(label)
}

// Community "Add" for one image: saved into the library, returns the file name.
#[tauri::command]
pub async fn download_hub_background(app: AppHandle, id: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_hub_background(&app, &id, &name))
        .await
        .map_err(|e| format!("download task panicked: {e}"))?
}

// Makes one image public (re-uploads when already public: new submission first, then the old one goes).
#[tauri::command]
pub async fn publish_background_image(app: AppHandle, token: String, file_name: String, author: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sanitize_segment(&file_name)?;
        let path = images_dir(&app)?.join(&file_name);
        let size = std::fs::metadata(&path).map_err(|e| format!("{file_name}: {e}"))?.len();
        if size > MAX_IMAGE_BYTES {
            return Err("public images can be at most 15 MB".to_string());
        }
        let label = Path::new(&file_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| file_name.clone());
        let new_id = super::hub::hub_submit_background(&token, &label, &author, &path)?;
        let mut config = load_config(&app);
        let old = config.image_public.insert(file_name, new_id.clone());
        save_config(&app, &config)?;
        if let Some(old) = old {
            let _ = super::hub::hub_delete_submission(&token, &old);
        }
        Ok(new_id)
    })
    .await
    .map_err(|e| format!("upload task panicked: {e}"))?
}

#[tauri::command]
pub async fn unpublish_background_image(app: AppHandle, token: String, file_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = load_config(&app);
        if let Some(public_id) = config.image_public.get(&file_name).cloned() {
            super::hub::hub_delete_submission(&token, &public_id)?;
            config.image_public.remove(&file_name);
            save_config(&app, &config)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("delete task panicked: {e}"))?
}

// Community "Add": imports the images and makes a private local playlist.
#[tauri::command]
pub async fn download_hub_playlist(app: AppHandle, id: String, name: String, author: String) -> Result<Playlist, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_hub_playlist(&app, &id, &name, &author)?;
        load_config(&app).playlists.pop().ok_or_else(|| "playlist not saved".to_string())
    })
    .await
    .map_err(|e| format!("download task panicked: {e}"))?
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

#[derive(Serialize)]
pub struct PickedBackground {
    pub file: String,
    pub data_url: String,
}

// Random image of the active playlist, never `exclude` unless it's the only one.
#[tauri::command]
pub fn pick_background(app: AppHandle, exclude: Option<String>) -> Result<Option<PickedBackground>, String> {
    let config = load_config(&app);
    let Some(active_id) = config.active_playlist else { return Ok(None) };
    let Some(playlist) = config.playlists.iter().find(|p| p.id == active_id) else { return Ok(None) };

    let Ok(dir) = images_dir(&app) else { return Ok(None) };
    let existing: Vec<String> = playlist.images.iter().filter(|f| dir.join(f).is_file()).cloned().collect();
    let mut candidates: Vec<String> = existing.iter().filter(|f| Some(*f) != exclude.as_ref()).cloned().collect();
    if candidates.is_empty() {
        candidates = existing;
    }
    while !candidates.is_empty() {
        let idx = pseudo_random(candidates.len());
        let file = candidates.remove(idx);
        if let Ok(data_url) = read_background_image(app.clone(), file.clone()) {
            return Ok(Some(PickedBackground { file, data_url }));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn pick_random_background(app: AppHandle) -> Result<Option<String>, String> {
    Ok(pick_background(app, None)?.map(|p| p.data_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("recharge-bg-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn old_playlists_load_with_defaults() {
        let cfg: BackgroundsConfig = serde_json::from_str(r#"{"playlists":[{"id":"a","name":"A","images":["x.png"]}],"active_playlist":"a"}"#).unwrap();
        assert_eq!(cfg.playlists[0].interval, 0);
        assert!(cfg.playlists[0].public_id.is_none());
    }

    #[test]
    fn old_config_has_empty_image_public() {
        let cfg: BackgroundsConfig = serde_json::from_str(r#"{"playlists":[],"active_playlist":null}"#).unwrap();
        assert!(cfg.image_public.is_empty());
        let mut cfg = cfg;
        cfg.image_public.insert("a.png".into(), "id1".into());
        let back: BackgroundsConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back.image_public.get("a.png").map(String::as_str), Some("id1"));
    }

    #[test]
    fn sniffs_and_names_hub_images() {
        assert_eq!(sniff_ext(&[0x89, b'P', b'N', b'G', 1]), Some("png"));
        assert_eq!(sniff_ext(b"<html>"), None);
        assert_eq!(background_file_name("../evil/na me", "png"), "___evil_na me.png");
        assert_eq!(background_file_name("", "jpg"), "background.jpg");
    }

    #[test]
    fn zip_roundtrip_is_flat_and_avoids_clashes() {
        let src = tmp("src");
        let dst = tmp("dst");
        std::fs::write(src.join("a.png"), b"AAA").unwrap();
        std::fs::write(src.join("b.jpg"), b"BBB").unwrap();
        std::fs::write(dst.join("a.png"), b"old").unwrap();
        let zip_bytes = build_playlist_zip(&src, &["a.png".to_string(), "b.jpg".to_string()]).unwrap();
        let saved = extract_playlist_zip(&zip_bytes, &dst).unwrap();
        assert_eq!(saved, vec!["a-2.png".to_string(), "b.jpg".to_string()]);
        assert_eq!(std::fs::read(dst.join("a.png")).unwrap(), b"old");
        assert_eq!(std::fs::read(dst.join("a-2.png")).unwrap(), b"AAA");
        assert!(build_playlist_zip(&src, &["../x.png".to_string()]).is_err());
    }
}
