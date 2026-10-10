use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS: [&str; 2] = ["mp4", "webm"];
const AUDIO_EXTS: [&str; 3] = ["mp3", "ogg", "wav"];
const MAX_PLAYLIST_IMAGES: usize = 50;
const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 90 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 20 * 1024 * 1024;

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

// "image" / "video" / "audio" by file extension; None for anything else.
fn media_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some("image")
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some("video")
    } else if AUDIO_EXTS.contains(&ext.as_str()) {
        Some("audio")
    } else {
        None
    }
}

fn is_image(path: &Path) -> bool {
    media_kind(path).is_some()
}

fn max_bytes_for(path: &Path) -> u64 {
    match media_kind(path) {
        Some("video") => MAX_VIDEO_BYTES,
        Some("audio") => MAX_AUDIO_BYTES,
        _ => MAX_IMAGE_BYTES,
    }
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
        return Err("only png, jpg, webp or gif images, mp4 or webm videos, or mp3, ogg or wav audio can be added".to_string());
    }
    let size = std::fs::metadata(&src).map_err(|e| e.to_string())?.len();
    if size > max_bytes_for(&src) {
        return Err(format!("that file is too big (max {} MB for this type)", max_bytes_for(&src) / 1024 / 1024));
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
    changed |= config.image_hub.remove(&file_name).is_some();
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
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "image/png",
    }
}

#[tauri::command]
pub fn read_background_image(app: AppHandle, file_name: String) -> Result<String, String> {
    sanitize_segment(&file_name)?;
    let path = images_dir(&app)?.join(&file_name);
    if media_kind(&path) != Some("image") {
        return Err("only images can be read as a data url - videos and audio are streamed".to_string());
    }
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
    // Sound while this playlist is active: "auto" (an audio file of the playlist, if any), "off",
    // "own" (the video's own sound) or the file name of an audio file in the library.
    #[serde(default = "default_sound")]
    pub sound: String,
    // Hub playlist id this was imported from (Community "Added" badge).
    #[serde(default)]
    pub hub_id: Option<String>,
}

fn default_sound() -> String {
    "auto".to_string()
}

#[derive(Serialize, Deserialize, Default)]
pub struct BackgroundsConfig {
    pub playlists: Vec<Playlist>,
    pub active_playlist: Option<String>,
    // Image file name -> hub submission id while that image is public.
    #[serde(default)]
    pub image_public: std::collections::HashMap<String, String>,
    // Image file name -> hub id it was imported from (Community "Added" badge).
    #[serde(default)]
    pub image_hub: std::collections::HashMap<String, String>,
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
            let p = Playlist { id, name, images, interval: 0, public_id: None, sound: default_sound(), hub_id: None };
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

#[tauri::command]
pub fn set_playlist_sound(app: AppHandle, id: String, sound: String) -> Result<(), String> {
    if !matches!(sound.as_str(), "auto" | "off" | "own") {
        sanitize_segment(&sound)?;
    }
    let mut config = load_config(&app);
    config.playlists.iter_mut().find(|p| p.id == id).ok_or("playlist not found")?.sound = sound;
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
        let cap = max_bytes_for(Path::new(&base));
        entry.take(cap + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        if data.len() as u64 > cap {
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

// ---- Bulk import (playlist editor) ----

#[derive(Serialize, Debug, Clone)]
pub struct ImportResult {
    pub source: String,
    pub file_name: Option<String>,
    pub error: Option<String>,
}

const MAX_FOLDER_FILES: usize = 500;
const MAX_FOLDER_DEPTH: usize = 12;

// Copies one file into `dir` (same checks + naming as upload_background_image, plus a magic-bytes check).
fn import_one(dir: &Path, path: &str) -> Result<String, String> {
    let src = PathBuf::from(path);
    let meta = std::fs::symlink_metadata(&src).map_err(|_| "file not found".to_string())?;
    let meta = if meta.file_type().is_symlink() { std::fs::metadata(&src).map_err(|_| "file not found".to_string())? } else { meta };
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    let Some(kind) = media_kind(&src) else {
        return Err("unsupported type (png, jpg, webp, gif, mp4, webm, mp3, ogg, wav only)".to_string());
    };
    let limit = max_bytes_for(&src);
    if meta.len() > limit {
        return Err(format!("too big (max {} MB for {kind}s)", limit / 1024 / 1024));
    }
    if meta.len() == 0 {
        return Err("empty file".to_string());
    }
    let mut head = [0u8; 16];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&src).map_err(|e| e.to_string())?;
        let n = f.read(&mut head).map_err(|e| e.to_string())?;
        let sniffed = sniff_ext(&head[..n]).and_then(|e| media_kind(Path::new(&format!("x.{e}"))));
        // Audio is lenient (mp3 headers vary); pictures and videos must look like what their extension says.
        let ok = match sniffed {
            Some(k) => k == kind,
            None => kind == "audio",
        };
        if !ok {
            return Err("the file contents do not match its type".to_string());
        }
    }
    let name = src.file_name().ok_or("invalid file name")?.to_string_lossy().into_owned();
    let candidate = unique_name(dir, &name);
    std::fs::copy(&src, dir.join(&candidate)).map_err(|e| e.to_string())?;
    Ok(candidate)
}

fn import_files_into(dir: &Path, paths: &[String]) -> Vec<ImportResult> {
    paths
        .iter()
        .map(|p| match import_one(dir, p) {
            Ok(name) => ImportResult { source: p.clone(), file_name: Some(name), error: None },
            Err(e) => ImportResult { source: p.clone(), file_name: None, error: Some(e) },
        })
        .collect()
}

// Imports many files into the library; one result per file, in order.
#[tauri::command]
pub async fn import_background_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<ImportResult>, String> {
    let dir = images_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || import_files_into(&dir, &paths))
        .await
        .map_err(|e| format!("import task panicked: {e}"))
}

#[derive(Serialize, Debug, Default)]
pub struct FolderListing {
    pub files: Vec<String>,
    // Files seen with a type that cannot be used.
    pub unsupported: usize,
    // More than MAX_FOLDER_FILES supported files were found; the rest are left out.
    pub truncated: bool,
}

// Supported media files of a folder (optionally its sub-folders). Hidden entries and symlinks are skipped.
fn list_folder(root: &Path, recursive: bool, cap: usize) -> Result<FolderListing, String> {
    if !root.is_dir() {
        return Err("not a folder".to_string());
    }
    let mut out = FolderListing::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.eq_ignore_ascii_case("thumbs.db") || name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let path = e.path();
            if ft.is_dir() {
                if recursive && depth < MAX_FOLDER_DEPTH {
                    subdirs.push((path, depth + 1));
                }
            } else if ft.is_file() {
                if media_kind(&path).is_some() {
                    if out.files.len() >= cap {
                        out.truncated = true;
                    } else {
                        out.files.push(path.to_string_lossy().into_owned());
                    }
                } else {
                    out.unsupported += 1;
                }
            }
        }
        // Keep alphabetical order: visit sub-folders in name order.
        for d in subdirs.into_iter().rev() {
            stack.push(d);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_media_in_folder(path: String, recursive: bool) -> Result<FolderListing, String> {
    tauri::async_runtime::spawn_blocking(move || list_folder(Path::new(&path), recursive, MAX_FOLDER_FILES))
        .await
        .map_err(|e| format!("folder task panicked: {e}"))?
}

// Media extension from the file's first bytes (hub files are untrusted).
fn sniff_ext(b: &[u8]) -> Option<&'static str> {
    if b.len() > 12 && &b[4..8] == b"ftyp" { return Some("mp4"); }
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) { return Some("webm"); }
    if b.starts_with(b"OggS") { return Some("ogg"); }
    if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE" { return Some("wav"); }
    if b.starts_with(b"ID3") || (b.len() > 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) { return Some("mp3"); }
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
    let ext = sniff_ext(&bytes).ok_or("that file isn't a supported image, video or audio file")?;
    let dir = images_dir(app)?;
    let file = unique_name(&dir, &background_file_name(name, ext));
    std::fs::write(dir.join(&file), &bytes).map_err(|e| e.to_string())?;
    let mut config = load_config(app);
    config.image_hub.insert(file.clone(), id.to_string());
    save_config(app, &config)?;
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
    config.playlists.push(Playlist { id: new_id(), name: label.clone(), images, interval: 0, public_id: None, sound: default_sound(), hub_id: Some(id.to_string()) });
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
        if size > max_bytes_for(&path) {
            return Err(format!("public {} can be at most {} MB", match media_kind(&path) { Some("video") => "videos", Some("audio") => "audio files", _ => "images" }, max_bytes_for(&path) / 1024 / 1024));
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
    // "image" or "video"
    pub kind: String,
    // Images only (videos are streamed from the media server, see background_media_base).
    pub data_url: String,
    // None = silent; Some("own") = the video's own sound; Some(file) = an audio file of the library.
    pub sound: Option<String>,
}

// Which sound goes with a background: `pick` chooses among several audio files for "auto".
fn resolve_sound(sound: &str, playlist_files: &[String], exists: &dyn Fn(&str) -> bool, pick: usize) -> Option<String> {
    match sound {
        "off" => None,
        "own" => Some("own".to_string()),
        "auto" => {
            let audio: Vec<&String> = playlist_files.iter().filter(|f| media_kind(Path::new(f.as_str())) == Some("audio") && exists(f)).collect();
            if audio.is_empty() { None } else { Some(audio[pick % audio.len()].clone()) }
        }
        file => if exists(file) { Some(file.to_string()) } else { None },
    }
}

// Random picture or video of the active playlist, never `exclude` unless it's the only one.
#[tauri::command]
pub fn pick_background(app: AppHandle, exclude: Option<String>) -> Result<Option<PickedBackground>, String> {
    let config = load_config(&app);
    let Some(active_id) = config.active_playlist else { return Ok(None) };
    let Some(playlist) = config.playlists.iter().find(|p| p.id == active_id) else { return Ok(None) };

    let Ok(dir) = images_dir(&app) else { return Ok(None) };
    let existing: Vec<String> = playlist
        .images
        .iter()
        .filter(|f| matches!(media_kind(Path::new(f.as_str())), Some("image") | Some("video")) && dir.join(f).is_file())
        .cloned()
        .collect();
    let mut candidates: Vec<String> = existing.iter().filter(|f| Some(*f) != exclude.as_ref()).cloned().collect();
    if candidates.is_empty() {
        candidates = existing;
    }
    let sound = |file: &str| -> Option<String> {
        let s = resolve_sound(&playlist.sound, &playlist.images, &|f| dir.join(f).is_file(), pseudo_random(1000));
        // "own" only makes sense on a video
        if s.as_deref() == Some("own") && media_kind(Path::new(file)) != Some("video") { None } else { s }
    };
    while !candidates.is_empty() {
        let idx = pseudo_random(candidates.len());
        let file = candidates.remove(idx);
        if media_kind(Path::new(&file)) == Some("video") {
            let sound = sound(&file);
            return Ok(Some(PickedBackground { file, kind: "video".to_string(), data_url: String::new(), sound }));
        }
        if let Ok(data_url) = read_background_image(app.clone(), file.clone()) {
            let sound = sound(&file);
            return Ok(Some(PickedBackground { file, kind: "image".to_string(), data_url, sound }));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn pick_random_background(app: AppHandle) -> Result<Option<String>, String> {
    Ok(pick_background(app, None)?.filter(|p| p.kind == "image").map(|p| p.data_url))
}

// --- Local media server: videos and audio are streamed (with Range support), not base64'd into memory ---

// (port, per-session secret). Requests must be /<secret>/<file name>, so other local programs
// or web pages that don't know the secret can't read anything.
static MEDIA_SERVER: std::sync::OnceLock<(u16, String)> = std::sync::OnceLock::new();

fn session_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u32(i);
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            format!("{:016x}", h.finish())
        })
        .collect()
}

// Maps "<token>/<percent-encoded name>" to a regular file directly inside `dir`, or None.
fn resolve_media_path(dir: &Path, token: &str, raw_url: &str) -> Option<PathBuf> {
    let rest = raw_url.split(['?', '#']).next().unwrap_or("").strip_prefix('/')?;
    let (t, name) = rest.split_once('/')?;
    if t != token {
        return None;
    }
    let name = percent_decode(name);
    if sanitize_segment(&name).is_err() || name.contains('\0') || media_kind(Path::new(&name)).is_none() {
        return None;
    }
    let root = dir.canonicalize().ok()?;
    let path = root.join(&name).canonicalize().ok()?;
    if path.parent() != Some(root.as_path()) || !path.is_file() {
        return None;
    }
    Some(path)
}

fn allowed_origin(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
}

// Unix seconds -> RFC 7231 date ("Thu, 01 Jan 2026 00:00:00 GMT").
fn http_date(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let wd = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
    format!("{wd}, {d:02} {mon} {y} {:02}:{:02}:{:02} GMT", rem / 3600, rem % 3600 / 60, rem % 60)
}

// "bytes=a-b" / "bytes=a-" / "bytes=-n" -> inclusive (start, end) within `size`.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split(',').next()?.split_once('-')?;
    let (start, end) = if a.trim().is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        let start: u64 = a.trim().parse().ok()?;
        let end = if b.trim().is_empty() { size - 1 } else { b.trim().parse::<u64>().ok()?.min(size - 1) };
        (start, end)
    };
    if start > end || start >= size { None } else { Some((start, end)) }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// CORS headers for an allowed page origin (tauri://localhost on Linux/macOS, http(s)://tauri.localhost on Windows).
// Sent on EVERY response (200, 206, HEAD, errors, preflight): Chromium rejects a crossorigin <video> or taints the
// canvas if any one of them lacks the header.
fn cors_headers(origin: Option<&str>) -> Vec<tiny_http::Header> {
    let h = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let Some(o) = origin.filter(|o| allowed_origin(o)) else { return Vec::new() };
    vec![
        h("Access-Control-Allow-Origin", o),
        h("Vary", "Origin"),
        h("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
        h("Access-Control-Allow-Headers", "Range, If-Range, Content-Type"),
        h("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Last-Modified, Content-Type"),
        h("Access-Control-Allow-Private-Network", "true"),
        h("Timing-Allow-Origin", o),
        h("Cross-Origin-Resource-Policy", "cross-origin"),
    ]
}

fn handle_media_request(dir: &Path, token: &str, request: tiny_http::Request) {
    use std::io::{Read, Seek, SeekFrom};
    let h = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let origin = request.headers().iter().find(|x| x.field.equiv("Origin")).map(|x| x.value.as_str().to_string());
    let cors = cors_headers(origin.as_deref());
    let plain = |code: u16| {
        let mut r = tiny_http::Response::from_string("").with_status_code(code);
        for c in &cors { r.add_header(c.clone()); }
        r
    };
    if matches!(request.method(), tiny_http::Method::Options) {
        let _ = request.respond(plain(204));
        return;
    }
    if !matches!(request.method(), tiny_http::Method::Get | tiny_http::Method::Head) {
        let _ = request.respond(plain(405));
        return;
    }
    let Some(path) = resolve_media_path(dir, token, request.url()) else {
        let _ = request.respond(plain(404));
        return;
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        let _ = request.respond(plain(404));
        return;
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request.headers().iter().find(|x| x.field.equiv("Range")).map(|x| x.value.as_str().to_string());
    let range = range.as_deref().and_then(|r| parse_range(r, size));
    let mut headers = vec![
        h("Content-Type", mime_of(&path)),
        h("Accept-Ranges", "bytes"),
        h("Cache-Control", "no-store"),
        h("X-Content-Type-Options", "nosniff"),
    ];
    // Last-Modified (CORS-safelisted) lets the page key its cached thumbnails by file + mtime.
    if let Some(secs) = file.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()) {
        headers.push(h("Last-Modified", &http_date(secs)));
    }
    headers.extend(cors.iter().cloned());
    let (code, start, len) = match range {
        Some((a, b)) => {
            headers.push(h("Content-Range", &format!("bytes {a}-{b}/{size}")));
            (206, a, b - a + 1)
        }
        None => (200, 0, size),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        let _ = request.respond(plain(500));
        return;
    }
    let response = tiny_http::Response::new(tiny_http::StatusCode(code), headers, file.take(len), Some(len as usize), None);
    let _ = request.respond(response);
}

// Base url (with trailing slash) of the local media server; start it on first use.
#[tauri::command]
pub fn background_media_base(app: AppHandle) -> Result<String, String> {
    if let Some((port, token)) = MEDIA_SERVER.get() {
        return Ok(format!("http://127.0.0.1:{port}/{token}/"));
    }
    let dir = images_dir(&app)?;
    let server = tiny_http::Server::http(("127.0.0.1", 0)).map_err(|e| format!("media server failed: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("media server has no port")?;
    let token = session_token();
    if MEDIA_SERVER.set((port, token.clone())).is_err() {
        let (p, t) = MEDIA_SERVER.get().unwrap();
        return Ok(format!("http://127.0.0.1:{p}/{t}/"));
    }
    let serve_token = token.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let (dir, token) = (dir.clone(), serve_token.clone());
            std::thread::spawn(move || handle_media_request(&dir, &token, request));
        }
    });
    Ok(format!("http://127.0.0.1:{port}/{token}/"))
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

    fn png_bytes() -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        v.extend_from_slice(&[0u8; 32]);
        v
    }

    #[test]
    fn http_date_formats_known_instants() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_767_225_600), "Thu, 01 Jan 2026 00:00:00 GMT");
        assert_eq!(http_date(1_709_210_096), "Thu, 29 Feb 2024 12:34:56 GMT");
    }

    #[test]
    fn bulk_import_mixed_files() {
        let src = tmp("bulk-src");
        let dst = tmp("bulk-dst");
        std::fs::write(src.join("a.png"), png_bytes()).unwrap();
        std::fs::write(dst.join("a.png"), b"existing").unwrap();
        std::fs::write(src.join("fake.png"), b"this is text").unwrap();
        std::fs::write(src.join("notes.txt"), b"hi").unwrap();
        std::fs::write(src.join("big.png"), vec![0x89; 1]).unwrap();
        let big = std::fs::File::create(src.join("huge.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        let mut ogg = b"OggS".to_vec();
        ogg.extend_from_slice(&[0; 20]);
        std::fs::write(src.join("song.ogg"), ogg).unwrap();
        let paths: Vec<String> = ["a.png", "fake.png", "notes.txt", "huge.png", "song.ogg", "missing.png"]
            .iter()
            .map(|n| src.join(n).to_string_lossy().into_owned())
            .collect();
        let r = import_files_into(&dst, &paths);
        assert_eq!(r[0].file_name.as_deref(), Some("a-2.png"));
        assert_eq!(std::fs::read(dst.join("a.png")).unwrap(), b"existing");
        assert!(r[1].error.as_ref().unwrap().contains("do not match"));
        assert!(r[2].error.as_ref().unwrap().contains("unsupported"));
        assert!(r[3].error.as_ref().unwrap().contains("too big"));
        assert_eq!(r[4].file_name.as_deref(), Some("song.ogg"));
        assert!(r[5].error.is_some());
        // same file twice -> -2, -3
        let again = import_files_into(&dst, &[paths[0].clone(), paths[0].clone()]);
        assert_eq!(again[0].file_name.as_deref(), Some("a-3.png"));
        assert_eq!(again[1].file_name.as_deref(), Some("a-4.png"));
    }

    #[test]
    fn folder_listing_recursion_hidden_symlinks_cap() {
        let root = tmp("folder");
        std::fs::create_dir_all(root.join("sub/deeper")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        for f in ["a.png", "b.mp4", "c.txt", ".secret.png", "sub/d.jpg", "sub/deeper/e.wav", ".hidden/f.png"] {
            std::fs::write(root.join(f), b"x").unwrap();
        }
        let flat = list_folder(&root, false, 500).unwrap();
        assert_eq!(flat.files.len(), 2);
        assert_eq!(flat.unsupported, 1);
        let deep = list_folder(&root, true, 500).unwrap();
        assert_eq!(deep.files.len(), 4);
        assert!(deep.files.iter().all(|f| !f.contains(".hidden") && !f.contains(".secret")));
        let capped = list_folder(&root, true, 3).unwrap();
        assert_eq!(capped.files.len(), 3);
        assert!(capped.truncated);
        assert!(list_folder(&root.join("nope"), true, 3).is_err());
        #[cfg(unix)]
        {
            let outside = tmp("outside");
            std::fs::write(outside.join("o.png"), b"x").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            std::os::unix::fs::symlink(outside.join("o.png"), root.join("lnk.png")).unwrap();
            let l = list_folder(&root, true, 500).unwrap();
            assert_eq!(l.files.len(), 4);
        }
    }

    #[test]
    fn real_user_config_shape_parses() {
        let json = r#"{"playlists":[{"id":"pl_1","name":"X","images":["a.png"],"interval":300,"public_id":"p","sound":"own","hub_id":null}],"active_playlist":"pl_1","image_public":{},"image_hub":{},"future_field":1}"#;
        let cfg: BackgroundsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.playlists[0].sound, "own");
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

    #[test]
    fn media_kinds_and_sniffing() {
        assert_eq!(media_kind(Path::new("a.MP4")), Some("video"));
        assert_eq!(media_kind(Path::new("a.webm")), Some("video"));
        assert_eq!(media_kind(Path::new("a.ogg")), Some("audio"));
        assert_eq!(media_kind(Path::new("a.exe")), None);
        assert_eq!(max_bytes_for(Path::new("a.mp4")), 90 * 1024 * 1024);
        assert_eq!(max_bytes_for(Path::new("a.mp3")), 20 * 1024 * 1024);
        assert_eq!(sniff_ext(b"\0\0\0\x18ftypmp42xxxxxxxx"), Some("mp4"));
        assert_eq!(sniff_ext(&[0x1A, 0x45, 0xDF, 0xA3, 0]), Some("webm"));
        assert_eq!(sniff_ext(b"OggS\0\0"), Some("ogg"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WAVEfmt "), Some("wav"));
        assert_eq!(sniff_ext(b"ID3\x04"), Some("mp3"));
        assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("nonsense", 100), None);
    }

    #[test]
    fn media_path_rejects_traversal_and_bad_tokens() {
        let dir = tmp("media_srv");
        let outside = tmp("media_srv_outside");
        std::fs::write(dir.join("a b.mp4"), b"x").unwrap();
        std::fs::write(outside.join("secret.mp4"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.mp4"), dir.join("link.mp4")).unwrap();
        assert!(resolve_media_path(&dir, "tok", "/tok/a%20b.mp4?x=1").is_some());
        assert!(resolve_media_path(&dir, "tok", "/a%20b.mp4").is_none());
        assert!(resolve_media_path(&dir, "tok", "/bad/a%20b.mp4").is_none());
        assert!(resolve_media_path(&dir, "tok", "/tok/").is_none());
        for evil in ["/tok/../secret.mp4", "/tok/%2e%2e/secret.mp4", "/tok/%2E%2E%2Fsecret.mp4", "/tok/..%5csecret.mp4",
            "/tok//etc/passwd", "/tok/%2Fetc%2Fpasswd", "/tok/a%00.mp4", "/tok/missing.mp4", "/tok/a%20b.txt"] {
            assert!(resolve_media_path(&dir, "tok", evil).is_none(), "{evil}");
        }
        #[cfg(unix)]
        assert!(resolve_media_path(&dir, "tok", "/tok/link.mp4").is_none());
        assert!(allowed_origin("tauri://localhost") && !allowed_origin("https://evil.com") && !allowed_origin("*"));
        assert_ne!(session_token(), session_token());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%20b.mp4"), "a b.mp4");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("x%2"), "x%2");
    }

    #[test]
    fn sound_resolution() {
        let files = vec!["a.png".to_string(), "m.mp3".to_string(), "n.ogg".to_string()];
        let yes = |_: &str| true;
        assert_eq!(resolve_sound("off", &files, &yes, 0), None);
        assert_eq!(resolve_sound("own", &files, &yes, 0).as_deref(), Some("own"));
        assert_eq!(resolve_sound("auto", &files, &yes, 1).as_deref(), Some("n.ogg"));
        assert_eq!(resolve_sound("auto", &["a.png".to_string()], &yes, 0), None);
        assert_eq!(resolve_sound("x.wav", &files, &|_| false, 0), None);
        assert_eq!(resolve_sound("x.wav", &files, &yes, 0).as_deref(), Some("x.wav"));
    }

    #[test]
    fn old_playlists_default_to_auto_sound() {
        let cfg: BackgroundsConfig = serde_json::from_str(r#"{"playlists":[{"id":"a","name":"A","images":[]}],"active_playlist":null}"#).unwrap();
        assert_eq!(cfg.playlists[0].sound, "auto");
    }

    // Real requests against the media server handler: what a webview's <audio> sends (Range, HEAD, Origin).
    #[test]
    fn media_server_serves_audio_with_ranges() {
        use std::io::{Read, Write};
        let dir = tmp("media-server");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        std::fs::write(dir.join("song.ogg"), &bytes).unwrap();
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let d = dir.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let d = d.clone();
                std::thread::spawn(move || handle_media_request(&d, "tok", request));
            }
        });
        let fetch = |method: &str, extra: &str| -> (String, Vec<u8>) {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "{method} /tok/song.ogg HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://tauri.localhost\r\n{extra}Connection: close\r\n\r\n").unwrap();
            let mut raw = Vec::new();
            s.read_to_end(&mut raw).unwrap();
            let at = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&raw[..at]).to_ascii_lowercase(), raw[at + 4..].to_vec())
        };
        let (head, body) = fetch("GET", "");
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("content-type: audio/ogg") && head.contains("accept-ranges: bytes") && head.contains("content-length: 1000"), "{head}");
        assert!(head.contains("access-control-allow-origin: http://tauri.localhost"), "{head}");
        assert_eq!(body, bytes);
        let (head, body) = fetch("GET", "Range: bytes=0-1\r\n");
        assert!(head.starts_with("http/1.1 206") && head.contains("content-range: bytes 0-1/1000"), "{head}");
        assert_eq!(body, &bytes[0..2]);
        let (head, body) = fetch("GET", "Range: bytes=990-\r\n");
        assert!(head.starts_with("http/1.1 206") && head.contains("content-range: bytes 990-999/1000"), "{head}");
        assert_eq!(body, &bytes[990..]);
        let (head, body) = fetch("HEAD", "");
        assert!(head.starts_with("http/1.1 200") && head.contains("content-length: 1000"), "{head}");
        assert!(head.contains("access-control-allow-origin: http://tauri.localhost"), "HEAD: {head}");
        assert!(body.is_empty());
        // CORS on 206 and on a preflight, for every origin a webview uses (Windows: http/https tauri.localhost).
        for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
            let fetch_o = |method: &str, extra: &str| {
                let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(s, "{method} /tok/song.ogg HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {origin}\r\n{extra}Connection: close\r\n\r\n").unwrap();
                let mut raw = Vec::new();
                s.read_to_end(&mut raw).unwrap();
                let at = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                String::from_utf8_lossy(&raw[..at]).to_ascii_lowercase()
            };
            let want = format!("access-control-allow-origin: {origin}");
            let head = fetch_o("GET", "Range: bytes=10-19\r\n");
            assert!(head.starts_with("http/1.1 206") && head.contains(&want), "206 {origin}: {head}");
            assert!(head.contains("access-control-expose-headers") && head.contains("content-range"), "{head}");
            let head = fetch_o("HEAD", "Range: bytes=0-\r\n");
            assert!(head.contains(&want), "HEAD {origin}: {head}");
            let head = fetch_o("OPTIONS", "Access-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: range\r\nAccess-Control-Request-Private-Network: true\r\n");
            assert!(head.starts_with("http/1.1 204") && head.contains(&want) && head.contains("access-control-allow-headers: range") && head.contains("access-control-allow-private-network: true"), "OPTIONS {origin}: {head}");
        }
        // A foreign origin gets no CORS header at all.
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /tok/song.ogg HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).unwrap();
        assert!(!String::from_utf8_lossy(&raw).to_ascii_lowercase().contains("access-control-allow-origin"));
    }
}
