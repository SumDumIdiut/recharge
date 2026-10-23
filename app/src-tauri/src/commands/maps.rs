use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::settings;

fn maps_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path_sync(app.clone())?;
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

/// The editor's own durable copy of every picture/music file it has seen: <app data>/map-assets.
fn assets_store(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join("map-assets"))
}

fn write_assets(app: &AppHandle, map_dir: &Path, assets: &[MapAsset]) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }
    let store = assets_store(app).filter(|s| std::fs::create_dir_all(s).is_ok());
    let folder = map_dir.join("assets");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    for a in assets {
        if !safe_file(&a.file) {
            return Err(format!("invalid asset name: '{}'", a.file));
        }
        let bytes = base64_decode(&a.data)?;
        std::fs::write(folder.join(&a.file), &bytes).map_err(|e| format!("couldn't save {}: {e}", a.file))?;
        if let Some(s) = &store {
            let _ = std::fs::write(s.join(&a.file), &bytes); // best effort
        }
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
pub async fn read_map_asset(app: AppHandle,id: String,file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("read_map_asset", || read_map_asset_sync(app, id, file))).await.expect("command thread panicked")
}

pub fn read_map_asset_sync(app: AppHandle, id: String, file: String) -> Result<String, String> {
    if !safe_file(&id) || !safe_file(&file) {
        return Err("invalid name".into());
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    let bytes = std::fs::read(dir.join(&id).join("assets").join(&file)).map_err(|e| format!("couldn't read {file}: {e}"))?;
    Ok(base64_encode(&bytes))
}

/// Keeps a picked file (base64 or data URL) in the app's own folder, so the editor can get it back.
#[tauri::command]
pub async fn store_map_asset(app: AppHandle,file: String,data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("store_map_asset", || store_map_asset_sync(app, file, data))).await.expect("command thread panicked")
}

pub fn store_map_asset_sync(app: AppHandle, file: String, data: String) -> Result<(), String> {
    if !safe_file(&file) {
        return Err(format!("invalid asset name: '{file}'"));
    }
    let dir = assets_store(&app).ok_or("no app data folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&file), base64_decode(&data)?).map_err(|e| format!("couldn't keep {file}: {e}"))
}

/// An asset file by name, base64: from the app's own copy, else from any installed map's assets.
#[tauri::command]
pub async fn find_map_asset(app: AppHandle,file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("find_map_asset", || find_map_asset_sync(app, file))).await.expect("command thread panicked")
}

pub fn find_map_asset_sync(app: AppHandle, file: String) -> Result<String, String> {
    if !safe_file(&file) {
        return Err("invalid name".into());
    }
    if let Some(p) = assets_store(&app).map(|d| d.join(&file)).filter(|p| p.is_file()) {
        if let Ok(b) = std::fs::read(p) {
            return Ok(base64_encode(&b));
        }
    }
    if let Some(dir) = maps_dir(&app) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path().join("assets").join(&file);
            if p.is_file() {
                if let Ok(b) = std::fs::read(p) {
                    return Ok(base64_encode(&b));
                }
            }
        }
    }
    Err(format!("{file} not found"))
}

/// A map's picture (thumb.png beside it), base64, while newer than the map; none when missing or stale.
#[tauri::command]
pub async fn read_map_thumb(app: AppHandle,id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("read_map_thumb", || read_map_thumb_sync(app, id))).await.expect("command thread panicked")
}

pub fn read_map_thumb_sync(app: AppHandle, id: String) -> Option<String> {
    if !safe_file(&id) {
        return None;
    }
    let dir = maps_dir(&app)?.join(&id);
    let modified = |f: &str| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok();
    if modified("thumb.png")? < modified("map.json")? {
        return None;
    }
    std::fs::read(dir.join("thumb.png")).ok().map(|b| base64_encode(&b))
}

#[tauri::command]
pub async fn write_map_thumb(app: AppHandle,id: String,data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("write_map_thumb", || write_map_thumb_sync(app, id, data))).await.expect("command thread panicked")
}

pub fn write_map_thumb_sync(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if !safe_file(&id) {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?.join(&id);
    if !dir.join("map.json").is_file() {
        return Ok(());
    }
    std::fs::write(dir.join("thumb.png"), base64_decode(&data)?).map_err(|e| e.to_string())
}

// ---- the drawn map view pictures: <app data>/map-thumbs/<id>@<stamp>.png, one per map (a newer stamp replaces the old file) ----

fn views_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join("map-thumbs"))
}

/// A stamp (the map's last-updated time or version) as safe file-name text.
fn view_stamp(stamp: &str) -> String {
    stamp.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect()
}

fn view_name(id: &str, stamp: &str) -> String {
    format!("{id}@{}.png", view_stamp(stamp))
}

/// When an installed map was last changed (its map.json's modified time, in ms), as the stamp its picture is kept under.
#[tauri::command]
pub async fn map_view_stamp(app: AppHandle,id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("map_view_stamp", || map_view_stamp_sync(app, id))).await.expect("command thread panicked")
}

pub fn map_view_stamp_sync(app: AppHandle, id: String) -> Option<String> {
    if !safe_file(&id) {
        return None;
    }
    let t = std::fs::metadata(maps_dir(&app)?.join(&id).join("map.json")).and_then(|m| m.modified()).ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis().to_string())
}

/// The kept drawn picture for this map and stamp, base64; none when there isn't one for exactly this stamp.
#[tauri::command]
pub async fn read_map_view(app: AppHandle,id: String,stamp: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("read_map_view", || read_map_view_sync(app, id, stamp))).await.expect("command thread panicked")
}

pub fn read_map_view_sync(app: AppHandle, id: String, stamp: String) -> Option<String> {
    if !safe_file(&id) {
        return None;
    }
    std::fs::read(views_dir(&app)?.join(view_name(&id, &stamp))).ok().map(|b| base64_encode(&b))
}

/// Keeps the drawn picture for this map and stamp, dropping the ones for its older stamps.
#[tauri::command]
pub async fn write_map_view(app: AppHandle,id: String,stamp: String,data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("write_map_view", || write_map_view_sync(app, id, stamp, data))).await.expect("command thread panicked")
}

pub fn write_map_view_sync(app: AppHandle, id: String, stamp: String, data: String) -> Result<(), String> {
    if !safe_file(&id) {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = views_dir(&app).ok_or("no app data folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let keep = view_name(&id, &stamp);
    let prefix = format!("{id}@");
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(&prefix) && n != keep {
            let _ = std::fs::remove_file(e.path());
        }
    }
    std::fs::write(dir.join(keep), base64_decode(&data)?).map_err(|e| e.to_string())
}

/// The path of the kept picture (for an upload, which takes files), when there is one for this stamp.
#[tauri::command]
pub async fn map_view_path(app: AppHandle,id: String,stamp: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("map_view_path", || map_view_path_sync(app, id, stamp))).await.expect("command thread panicked")
}

pub fn map_view_path_sync(app: AppHandle, id: String, stamp: String) -> Option<String> {
    if !safe_file(&id) {
        return None;
    }
    let p = views_dir(&app)?.join(view_name(&id, &stamp));
    p.is_file().then(|| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod view_tests {
    use super::*;

    #[test]
    fn view_names_are_keyed_by_id_and_stamp_and_path_safe() {
        assert_eq!(view_name("abc", "1.0.0|2026-10-09T19:42:53.944Z"), "abc@1.0.0_2026-10-09T19_42_53.944Z.png");
        assert_ne!(view_name("abc", "1"), view_name("abc", "2"));
        assert!(!view_name("abc", "../x/y").contains('/'));
    }
}

#[derive(Serialize)]
pub struct MapSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub images: Vec<String>,
    #[serde(rename = "groupCount")]
    pub group_count: usize,
    /// The editor's id for the map itself, the same across saves and copies of its file.
    pub uid: Option<String>,
    /// The Hub id it was uploaded as, from here (hub.json), when it was.
    pub hub: Option<String>,
    /// Which revision of that Hub entry this copy is (hub.json), and when the Hub says that revision was made.
    pub revision: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

/// The name an installed map has on the Hub, kept beside it (hub.json) for the game's map list.
#[tauri::command]
pub async fn set_map_hub_name(app: AppHandle,id: String,name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("set_map_hub_name", || set_map_hub_name_sync(app, id, name))).await.expect("command thread panicked")
}

pub fn set_map_hub_name_sync(app: AppHandle, id: String, name: String) -> Result<(), String> {
    if !safe_file(&id) {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?.join(&id);
    if !dir.join("map.json").is_file() {
        return Ok(());
    }
    let file = dir.join("hub.json");
    let text = serde_json::json!({ "name": name }).to_string();
    if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    std::fs::write(file, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_map(app: AppHandle,id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("uninstall_map", || uninstall_map_sync(app, id))).await.expect("command thread panicked")
}

pub fn uninstall_map_sync(app: AppHandle, id: String) -> Result<(), String> {
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
pub async fn read_map(app: AppHandle,id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("read_map", || read_map_sync(app, id))).await.expect("command thread panicked")
}

pub fn read_map_sync(app: AppHandle, id: String) -> Result<String, String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    std::fs::read_to_string(dir.join(&id).join("map.json")).map_err(|e| format!("couldn't read map '{id}': {e}"))
}

// Writes the editor's map into the installed maps as <id>/map.json; the replaced version goes to <id>/history (autosaves kept apart so they never push out saves).
#[tauri::command]
pub async fn save_map(app: AppHandle,id: String,map_json: String,assets: Option<Vec<MapAsset>>,auto: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("save_map", || save_map_sync(app, id, map_json, assets, auto))).await.expect("command thread panicked")
}

pub fn save_map_sync(app: AppHandle, id: String, map_json: String, assets: Option<Vec<MapAsset>>, auto: Option<bool>) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid_map: invalid map id '{id}'"));
    }
    if map_json.len() > 64 * 1024 * 1024 {
        return Err(format!("too_large: map JSON is {} bytes", map_json.len()));
    }
    serde_json::from_str::<serde_json::Value>(&map_json).map_err(|e| format!("invalid_map: map isn't valid JSON: {e}"))?;
    let dir = maps_dir(&app).ok_or_else(|| "io: game path not set".to_string())?;
    let target = dir.join(&id);
    std::fs::create_dir_all(&target).map_err(|e| format!("io: couldn't create map folder '{id}': {e}"))?;
    let current = target.join("map.json");
    if let Ok(old) = std::fs::read_to_string(&current) {
        if old != map_json {
            keep_history(&target, &old, auto.unwrap_or(false));
        }
    }
    std::fs::write(&current, &map_json).map_err(|e| format!("io: couldn't save map '{id}': {e}"))?;
    write_assets(&app, &target, assets.as_deref().unwrap_or(&[])).map_err(|e| {
        // write_assets already returns free text; classify by content.
        if e.starts_with("invalid") { format!("invalid_map: {e}") } else { format!("io: {e}") }
    })
}

const HISTORY_SAVES: usize = 20;
const HISTORY_AUTOSAVES: usize = 10;

fn keep_history(map_dir: &Path, old: &str, auto: bool) {
    let dir = map_dir.join("history");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let suffix = if auto { "-auto" } else { "" };
    let _ = std::fs::write(dir.join(format!("{ms}{suffix}.json")), old);
    for (keep_auto, limit) in [(false, HISTORY_SAVES), (true, HISTORY_AUTOSAVES)] {
        let mut files: Vec<String> = history_files(&dir).into_iter().filter(|f| f.ends_with("-auto.json") == keep_auto).collect();
        files.sort();
        while files.len() > limit {
            let _ = std::fs::remove_file(dir.join(files.remove(0)));
        }
    }
}

fn history_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| f.ends_with(".json") && f.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct MapVersion {
    pub file: String,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
    pub auto: bool,
    pub size: u64,
}

// The versions a save replaced, newest first.
#[tauri::command]
pub async fn map_history(app: AppHandle,id: String) -> Result<Vec<MapVersion>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("map_history", || map_history_sync(app, id))).await.expect("command thread panicked")
}

pub fn map_history_sync(app: AppHandle, id: String) -> Result<Vec<MapVersion>, String> {
    if !safe_file(&id) {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?.join(&id).join("history");
    let mut out: Vec<MapVersion> = history_files(&dir)
        .into_iter()
        .map(|file| {
            let saved_at = file.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(0);
            let size = std::fs::metadata(dir.join(&file)).map(|m| m.len()).unwrap_or(0);
            MapVersion { auto: file.ends_with("-auto.json"), file, saved_at, size }
        })
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

#[tauri::command]
pub async fn read_map_version(app: AppHandle,id: String,file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("read_map_version", || read_map_version_sync(app, id, file))).await.expect("command thread panicked")
}

pub fn read_map_version_sync(app: AppHandle, id: String, file: String) -> Result<String, String> {
    if !safe_file(&id) || !safe_file(&file) {
        return Err("invalid name".into());
    }
    let dir = maps_dir(&app).ok_or("game path not set")?;
    std::fs::read_to_string(dir.join(&id).join("history").join(&file)).map_err(|e| format!("couldn't read that version: {e}"))
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
pub async fn list_maps(app: AppHandle) -> Vec<MapSummary> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("list_maps", || list_maps_sync(app))).await.expect("command thread panicked")
}

/// What the map list needs from a map.json. Maps are big (tens of MB of tiles), so this is read with a streaming skip (no tree built) and remembered by file size + mtime.
#[derive(Serialize, Deserialize, Clone, Default)]
struct MapHead {
    name: Option<String>,
    description: Option<String>,
    images: Vec<String>,
    group_count: usize,
    uid: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HeadCacheEntry {
    len: u64,
    mtime_ns: u128,
    head: MapHead,
}

// A value of an unexpected type counts as absent, like the old `json.get(..).and_then(as_str)`.
#[derive(Deserialize)]
#[serde(untagged)]
enum Lenient<T> {
    Value(T),
    Other(serde::de::IgnoredAny),
}

fn lenient<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Ok(match Lenient::<T>::deserialize(d)? {
        Lenient::Value(v) => Some(v),
        Lenient::Other(_) => None,
    })
}

// Lenient list of strings: non-strings are dropped, a non-array is empty.
fn lenient_strings<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Item {
        S(String),
        Other(serde::de::IgnoredAny),
    }
    let items: Option<Vec<Item>> = lenient(d)?;
    Ok(items.unwrap_or_default().into_iter().filter_map(|i| if let Item::S(s) = i { Some(s) } else { None }).collect())
}

// Counts the elements of an array without keeping them.
struct CountSeq(usize);

impl<'de> Deserialize<'de> for CountSeq {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::{MapAccess, SeqAccess, Visitor};
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CountSeq;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("anything")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<CountSeq, A::Error> {
                let mut n = 0;
                while a.next_element::<serde::de::IgnoredAny>()?.is_some() {
                    n += 1;
                }
                Ok(CountSeq(n))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<CountSeq, A::Error> {
                while a.next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?.is_some() {}
                Ok(CountSeq(0))
            }
            fn visit_bool<E>(self, _: bool) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_i64<E>(self, _: i64) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_u64<E>(self, _: u64) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_f64<E>(self, _: f64) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_str<E>(self, _: &str) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_unit<E>(self) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
            fn visit_none<E>(self) -> Result<CountSeq, E> { Ok(CountSeq(0)) }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct RawHead {
    #[serde(default, deserialize_with = "lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    description: Option<String>,
    #[serde(default, deserialize_with = "lenient_strings")]
    images: Vec<String>,
    #[serde(default)]
    groups: Option<CountSeq>,
    #[serde(default, deserialize_with = "lenient")]
    uid: Option<String>,
}

/// None when the file isn't valid JSON (the map is then left out of the list, as before).
fn parse_map_head(bytes: &[u8]) -> Option<MapHead> {
    if let Ok(h) = serde_json::from_slice::<RawHead>(bytes) {
        return Some(MapHead { name: h.name, description: h.description, images: h.images, group_count: h.groups.map_or(0, |c| c.0), uid: h.uid });
    }
    // Valid JSON that isn't an object: same result the old tree walk gave (everything absent).
    serde_json::from_slice::<serde_json::Value>(bytes).ok().map(|_| MapHead::default())
}

fn head_cache_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("list-maps-cache.json"))
}

pub fn list_maps_sync(app: AppHandle) -> Vec<MapSummary> {
    let mut maps = Vec::new();
    let Some(dir) = maps_dir(&app) else {
        return maps;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return maps;
    };
    let cache_path = head_cache_path(&app);
    let old: std::collections::HashMap<String, HeadCacheEntry> = cache_path
        .as_ref()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut fresh: std::collections::HashMap<String, HeadCacheEntry> = std::collections::HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let map_file = path.join("map.json");
        let Ok(meta) = std::fs::metadata(&map_file) else {
            continue;
        };
        let len = meta.len();
        let mtime_ns = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        let key = map_file.to_string_lossy().to_string();
        let head = match old.get(&key) {
            Some(c) if c.len == len && c.mtime_ns == mtime_ns && mtime_ns != 0 => c.head.clone(),
            _ => {
                let Ok(bytes) = std::fs::read(&map_file) else {
                    continue;
                };
                let Some(head) = parse_map_head(&bytes) else {
                    continue;
                };
                head
            }
        };
        fresh.insert(key, HeadCacheEntry { len, mtime_ns, head: head.clone() });
        let name = head.name.unwrap_or_else(|| id.clone());
        let hub_json = std::fs::read_to_string(path.join("hub.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let hub = hub_json.as_ref().and_then(|h| h.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()));
        let revision = hub_json.as_ref().and_then(|h| h.get("revision").and_then(|v| v.as_i64()));
        let updated_at = hub_json.as_ref().and_then(|h| h.get("updatedAt").and_then(|v| v.as_str()).map(|s| s.to_string()));
        maps.push(MapSummary {
            id,
            name,
            description: head.description.unwrap_or_default(),
            images: head.images,
            group_count: head.group_count,
            uid: head.uid,
            hub,
            revision,
            updated_at,
        });
    }
    if let Some(p) = cache_path {
        if fresh.len() != old.len() || fresh.iter().any(|(k, v)| old.get(k).map_or(true, |o| o.len != v.len || o.mtime_ns != v.mtime_ns)) {
            if let Ok(json) = serde_json::to_vec(&fresh) {
                let tmp = p.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, &p);
                }
            }
        }
    }
    maps
}

// "Test in game": installs under a fixed id, flags it via autoplay.txt, then launches modded.
const TEST_MAP_ID: &str = "map-maker-test";

#[tauri::command]
pub async fn test_launch_map(app: AppHandle, map_json: String, assets: Option<Vec<MapAsset>>) -> Result<super::play::LaunchMethod, String> {
    // Closing a running game polls for a few seconds: keep that off the UI thread.
    tauri::async_runtime::spawn_blocking(move || test_launch_map_blocking(app, map_json, assets)).await.map_err(|e| e.to_string())?
}

fn test_launch_map_blocking(app: AppHandle, map_json: String, assets: Option<Vec<MapAsset>>) -> Result<super::play::LaunchMethod, String> {
    serde_json::from_str::<serde_json::Value>(&map_json).map_err(|e| format!("invalid_map: map isn't valid JSON: {e}"))?;
    let dir = maps_dir(&app).ok_or_else(|| "not_installed: game path not set".to_string())?;
    // The game executable must be present.
    if super::play::find_exe(&PathBuf::from(settings::get_game_path_sync(app.clone()).unwrap_or_default())).is_none() {
        return Err("not_installed: IGTAP executable not found".into());
    }
    // Navigator must be deployed beside the maps folder.
    let navigator = dir.parent().map(|p| p.join("RechargeMaps.dll")).unwrap_or_default();
    if !navigator.is_file() && std::env::var_os("RECHARGE_DEV_NAVIGATOR_DLL").map(PathBuf::from).filter(|p| p.is_file()).is_none() {
        return Err("navigator_missing: RechargeMaps.dll not found in the test build".into());
    }
    // Dev: a locally-built Navigator (RECHARGE_DEV_NAVIGATOR_DLL) overrides the installed one.
    if let Some(dll) = std::env::var_os("RECHARGE_DEV_NAVIGATOR_DLL").map(PathBuf::from).filter(|p| p.is_file()) {
        let installed = dir.parent().ok_or_else(|| "io: bad maps folder".to_string())?.join("RechargeMaps.dll");
        std::fs::copy(&dll, &installed).map_err(|e| format!("io: couldn't install the dev Navigator: {e}"))?;
    }
    let target = dir.join(TEST_MAP_ID);
    // Testing a map wants a known starting point: another mod can change how the game behaves,
    // so a broken map can look broken for the wrong reason. Only Navigator is left on, and the
    // ones that were on are written down to put back when the game closes.
    super::mods::restore_after_test_launch(&app).map_err(|e| format!("io: {e}"))?; // clear any note left by an earlier run
    super::mods::disable_all_but_navigator(&app).map_err(|e| format!("io: {e}"))?;
    std::fs::create_dir_all(&target).map_err(|e| format!("io: {e}"))?;
    std::fs::write(target.join("map.json"), &map_json).map_err(|e| format!("io: {e}"))?;
    write_assets(&app, &target, assets.as_deref().unwrap_or(&[])).map_err(|e| {
        if e.starts_with("invalid") { format!("invalid_map: {e}") } else { format!("io: {e}") }
    })?;
    let request_parent = dir.parent().ok_or_else(|| "io: bad maps folder".to_string())?;
    let request = request_parent.join("autoplay.txt");
    std::fs::write(&request, TEST_MAP_ID).map_err(|e| format!("io: {e}"))?;
    super::play::close_then_launch(app).map_err(|e| {
        let _ = std::fs::remove_file(&request);
        // classify launch errors
        let low = e.to_lowercase();
        if low.contains("not found") && (low.contains("executable") || low.contains("game path") || low.contains("igtap install")) {
            format!("not_installed: {e}")
        } else if low.contains("rechargemaps") || low.contains("navigator") || low.contains("modded build is missing") {
            format!("navigator_missing: {e}")
        } else if low.contains("failed to launch") || low.contains("failed to start") {
            format!("spawn_failed: {e}")
        } else {
            format!("io: {e}")
        }
    })
}

#[cfg(test)]
mod head_tests {
    use super::parse_map_head;

    #[test]
    fn head_reads_only_what_the_list_needs() {
        let h = parse_map_head(br#"{"tiles":[[1,2],[3]],"name":"N","description":"D","images":["a.png",3,"b.png"],"groups":[{"x":1},{},[]],"uid":"u1"}"#).unwrap();
        assert_eq!(h.name.as_deref(), Some("N"));
        assert_eq!(h.description.as_deref(), Some("D"));
        assert_eq!(h.images, vec!["a.png", "b.png"]);
        assert_eq!(h.group_count, 3);
        assert_eq!(h.uid.as_deref(), Some("u1"));
    }

    #[test]
    fn wrong_types_count_as_absent_and_bad_json_is_skipped() {
        let h = parse_map_head(br#"{"name":5,"images":"x","groups":7,"uid":null}"#).unwrap();
        assert!(h.name.is_none() && h.images.is_empty() && h.group_count == 0 && h.uid.is_none());
        assert!(parse_map_head(b"[1,2]").is_some());
        assert!(parse_map_head(b"{ nope").is_none());
    }
}
