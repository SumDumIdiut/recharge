use serde::Deserialize;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::settings;

pub const BEAM_PORT: u16 = 39284;
const HUB_ORIGIN: &str = "https://codecade.co.za";
const HUB_BASE: &str = "https://codecade.co.za/recharge";

/// The hub's address. `RECHARGE_HUB_BASE` points installs and uploads at a test hub (e.g. http://127.0.0.1:38123); unset, it is the real one.
fn hub_base() -> String {
    match std::env::var("RECHARGE_HUB_BASE") {
        Ok(v) if v.starts_with("http://") || v.starts_with("https://") => v.trim_end_matches('/').to_string(),
        _ => HUB_BASE.to_string(),
    }
}
const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_GALLERY_IMAGES: usize = 8;

fn sanitize_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    Ok(())
}

fn mods_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path_sync(app.clone())?;
    Some(PathBuf::from(game_path).join("Recharge").join("Mods"))
}

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

fn skins_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path_sync(app.clone())?;
    Some(
        PathBuf::from(game_path)
            .join("Recharge")
            .join("Mods")
            .join("recharge.customskins")
            .join("data")
            .join("skins"),
    )
}

#[derive(Deserialize)]
struct HubItem {
    name: String,
    #[serde(default)]
    revision: Option<i64>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
}

/// Which version of a hub entry an install is: written beside it so the app can tell when the hub has a newer one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HubVersion {
    pub revision: i64,
    pub updated_at: Option<String>,
}

impl HubVersion {
    fn of(item: &HubItem) -> Self {
        HubVersion { revision: item.revision.unwrap_or(1), updated_at: item.updated_at.clone() }
    }
}

use super::skins::HUB_META_FILE; // beside an installed mod / skin: which hub entry (and revision) it came from

fn hub_meta_json(hub_id: &str, name: &str, v: &HubVersion) -> String {
    serde_json::json!({ "hubId": hub_id, "name": name, "revision": v.revision, "updatedAt": v.updated_at }).to_string()
}

fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The hub id a map folder was installed or uploaded as (hub.json "id").
fn map_hub_id(folder: &std::path::Path) -> Option<String> {
    read_json_file(&folder.join("hub.json"))?.get("id")?.as_str().map(str::to_string)
}

/// The hub id of an installed mod / skin folder (its meta file's "hubId").
fn meta_hub_id(folder: &std::path::Path) -> Option<String> {
    read_json_file(&folder.join(HUB_META_FILE))?.get("hubId")?.as_str().map(str::to_string)
}

/// The map's own id (map.json "uid"), the same across every copy and save of it.
fn map_uid_of_folder(folder: &std::path::Path) -> Option<String> {
    read_json_file(&folder.join("map.json"))?.get("uid")?.as_str().filter(|u| !u.is_empty()).map(str::to_string)
}

fn zip_map_uid(bytes: &[u8]) -> Option<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut text = String::new();
    archive.by_name("map.json").ok()?.read_to_string(&mut text).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("uid")?.as_str().filter(|u| !u.is_empty()).map(str::to_string)
}

fn sorted_dirs(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v
}

/// Extracts the package into a scratch folder beside `target` (so a bad package never damages what is installed), lets `finish` add to it, then swaps it in.
fn extract_swap(
    bytes: Vec<u8>,
    target: &std::path::Path,
    finish: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = target.parent().ok_or("bad install folder")?;
    let tmp = parent.join(format!(".beam-tmp-{}-{}", std::process::id(), NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid package: {e}"))?;
        archive.extract(&tmp).map_err(|e| format!("couldn't extract package: {e}"))?;
        finish(&tmp)?;
        let _ = std::fs::remove_dir_all(target);
        std::fs::rename(&tmp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    result
}

#[derive(Deserialize)]
struct ModManifestId {
    id: String,
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    // DNS/nameserver hiccups are transient - retry a couple of times before giving up.
    let mut last = String::new();
    for (i, delay) in [0u64, 1000, 2000].iter().enumerate() {
        if *delay > 0 { std::thread::sleep(std::time::Duration::from_millis(*delay)); }
        match ureq::get(url).call() {
            Ok(mut res) => {
                return match res.body_mut().with_config().limit(MAX_PACKAGE_BYTES).read_to_vec() {
                    Ok(b) => Ok(b),
                    Err(e) => Err(e.to_string()),
                };
            }
            Err(e) => { last = e.to_string(); if i == 2 { return Err(last); } }
        }
    }
    Err(last)
}

fn call_json_retry<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let mut last = String::new();
    for (i, delay) in [0u64, 1000, 2000].iter().enumerate() {
        if *delay > 0 { std::thread::sleep(std::time::Duration::from_millis(*delay)); }
        match ureq::get(url).call() {
            Ok(mut res) => {
                return match res.body_mut().with_config().limit(1024 * 1024).read_json() {
                    Ok(j) => Ok(j),
                    Err(e) => Err(format!("bad response from library: {e}")),
                };
            }
            Err(e) => { last = format!("couldn't reach the library: {e}"); if i == 2 { return Err(last); } }
        }
    }
    Err(last)
}

static NEXT_TMP_ID: AtomicU64 = AtomicU64::new(0);

fn install_mod_zip(app: &AppHandle, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<(), String> {
    let dir = mods_dir(app).ok_or("game path not set")?;
    install_mod_into(&dir, bytes, hub_id, name, ver)
}

/// Installs a mod package into `dir` (the game's Mods folder): its folder is its mod.json id, an update keeps whether it was switched on, and the hub entry + revision are recorded beside it.
fn install_mod_into(dir: &std::path::Path, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let manifest: ModManifestId = {
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|e| format!("not a valid package: {e}"))?;
        let mut text = String::new();
        archive.by_name("mod.json").map_err(|_| "package is missing mod.json".to_string())?.read_to_string(&mut text).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())?
    };
    sanitize_id(&manifest.id)?;

    let target = dir.join(&manifest.id);
    let was_enabled = read_json_file(&target.join("mod.json")).and_then(|j| j.get("enabled").and_then(|v| v.as_bool()));
    extract_swap(bytes, &target, |tmp| {
        if let Some(on) = was_enabled {
            let path = tmp.join("mod.json");
            if let Some(mut j) = read_json_file(&path) {
                j["enabled"] = serde_json::Value::Bool(on);
                std::fs::write(&path, serde_json::to_string_pretty(&j).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(tmp.join(HUB_META_FILE), hub_meta_json(hub_id, name, ver)).map_err(|e| e.to_string())
    })?;
    // The same hub entry under an older mod id (the id was changed in an update): that folder is the old copy.
    for other in sorted_dirs(dir) {
        if other != target && meta_hub_id(&other).as_deref() == Some(hub_id) {
            let _ = std::fs::remove_dir_all(other);
        }
    }
    Ok(())
}

fn install_map_zip(app: &AppHandle, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<(), String> {
    let dir = maps_dir(app).ok_or("game path not set")?;
    install_map_into(&dir, bytes, hub_id, name, ver).map(|_| ())
}

/// Installs a map package into `dir` (the game's maps folder) and returns its folder.
/// - The folder that already holds this hub id is reused (and replaced), whatever the map is called now.
/// - Installed hub copies of the same map (the same map.json uid) under another hub id are replaced too: the first is reused as the folder, any others removed. Local-only copies are left alone: they may hold edits.
/// - Otherwise the folder is a slug of the name; a slug owned by a different map gets a hub-id suffix.
fn install_map_into(dir: &std::path::Path, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let uid = zip_map_uid(&bytes);
    let folders = sorted_dirs(dir);
    let linked = folders.iter().find(|p| map_hub_id(p).as_deref() == Some(hub_id)).cloned();
    let duplicates: Vec<PathBuf> = match &uid {
        Some(u) => folders.iter()
            .filter(|p| Some(*p) != linked.as_ref())
            .filter(|p| map_hub_id(p).is_some() && map_uid_of_folder(p).as_deref() == Some(u.as_str()))
            .cloned()
            .collect(),
        None => Vec::new(),
    };
    let target = match linked.clone().or_else(|| duplicates.first().cloned()) {
        Some(t) => t,
        None => {
            let slug = {
                let s = slugify(name);
                if s.is_empty() { hub_id.to_string() } else { s }
            };
            // A slug owned by another map gets a hub-id suffix instead of being clobbered.
            let t = dir.join(&slug);
            let name_of = |p: &std::path::Path| read_json_file(&p.join("map.json")).and_then(|j| j.get("name").and_then(|v| v.as_str()).map(str::to_string));
            if t.is_dir() && (name_of(&t).map(|n| n != name).unwrap_or(false) || map_hub_id(&t).map(|h| h != hub_id).unwrap_or(false)) {
                dir.join(format!("{}-{}", slug, &hub_id[..8.min(hub_id.len())]))
            } else {
                t
            }
        }
    };
    extract_swap(bytes, &target, |tmp| {
        // Remember the hub id, name and revision alongside, so the list can show them, upload knows the id, and the app can tell when the hub has a newer one.
        let hub_json = serde_json::json!({ "name": name, "id": hub_id, "revision": ver.revision, "updatedAt": ver.updated_at }).to_string();
        std::fs::write(tmp.join("hub.json"), hub_json).map_err(|e| e.to_string())
    })?;
    for d in duplicates {
        if d != target {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    Ok(target)
}

fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_was_dash = false;
    for c in name.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

// Installed under a slug of the skin's name, not the raw hub id (see HUB_META_FILE).
fn install_skin_zip(app: &AppHandle, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<(), String> {
    let dir = skins_dir(app).ok_or("game path not set")?;
    install_skin_into(&dir, bytes, hub_id, name, ver).map(|_| ())
}

/// Installs a skin package into `dir` and returns its folder: the one already holding this hub id (kept even if the skin was renamed, so a chosen skin stays chosen), else a slug of the name, with a hub-id suffix when another skin owns that slug.
fn install_skin_into(dir: &std::path::Path, bytes: Vec<u8>, hub_id: &str, name: &str, ver: &HubVersion) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = match sorted_dirs(dir).into_iter().find(|p| meta_hub_id(p).as_deref() == Some(hub_id)) {
        Some(t) => t,
        None => {
            let slug = slugify(name);
            let slug = if slug.is_empty() { hub_id.to_string() } else { slug };
            let mut candidate = slug.clone();
            if dir.join(&candidate).is_dir() && meta_hub_id(&dir.join(&candidate)).as_deref() != Some(hub_id) {
                candidate = format!("{slug}-{}", &hub_id[..8.min(hub_id.len())]);
            }
            dir.join(candidate)
        }
    };
    extract_swap(bytes, &target, |tmp| {
        std::fs::write(tmp.join(HUB_META_FILE), hub_meta_json(hub_id, name, ver)).map_err(|e| e.to_string())
    })?;
    Ok(target)
}

/// Exports the skin template (sheet, icons, sounds) straight from its repo.
#[tauri::command]
pub async fn download_skin_template_cmd(dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = PathBuf::from(dest_dir).join("SkinTemplate");
        super::repos::export_repo_folder("recharge-skins", "templates/skin-template", &target)
    })
    .await
    .map_err(|e| format!("export task panicked: {e}"))?
}

#[derive(Deserialize)]
struct HubBgMeta {
    name: String,
    #[serde(default)]
    author: String,
}

// Beam of a background image or playlist: the hub kind is singular here ("background"/"playlist"), the plural is accepted too.
fn install_background_from_hub(app: &AppHandle, kind: &str, id: &str) -> Result<String, String> {
    sanitize_id(id)?;
    let playlist = kind == "playlist" || kind == "playlists";
    let api = if playlist { "playlists" } else { "backgrounds" };
    let meta: HubBgMeta = call_json_retry(&format!("{HUB_BASE}/api/{api}/{id}")).map_err(|e| if e.contains("404") { "UNSUPPORTED".to_string() } else { e })?;
    let name = if playlist {
        super::backgrounds::install_hub_playlist(app, id, &meta.name, &meta.author)?
    } else {
        super::backgrounds::install_hub_background(app, id, &meta.name)?
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit(
        "hub-beam-installed",
        serde_json::json!({ "kind": if playlist { "playlist" } else { "background" }, "id": id, "name": name }),
    );
    Ok(name)
}

pub fn install_from_hub(app: &AppHandle, kind: &str, id: &str) -> Result<String, String> {
    install_from_hub_opts(app, kind, id, false)
}

/// `quiet` (an automatic update): no window pop-up and no "Installed" notice; the caller says what happened.
pub fn install_from_hub_opts(app: &AppHandle, kind: &str, id: &str, quiet: bool) -> Result<String, String> {
    if matches!(kind, "background" | "backgrounds" | "playlist" | "playlists") {
        return install_background_from_hub(app, kind, id);
    }
    if kind != "mods" && kind != "maps" && kind != "skins" {
        return Err("kind must be 'mods', 'maps', 'skins', 'background' or 'playlist'".to_string());
    }
    sanitize_id(id)?;

    let hub = hub_base();
    let meta: HubItem = call_json_retry(&format!("{hub}/api/{kind}/{id}"))?;
    let ver = HubVersion::of(&meta);

    let bytes = download(&format!("{hub}/api/{kind}/{id}/file"))?;

    if kind == "mods" {
        install_mod_zip(app, bytes, id, &meta.name, &ver)?;
    } else if kind == "maps" {
        install_map_zip(app, bytes, id, &meta.name, &ver)?;
    } else {
        install_skin_zip(app, bytes, id, &meta.name, &ver)?;
    }

    if !quiet {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit(
            "hub-beam-installed",
            serde_json::json!({ "kind": kind, "id": id, "name": meta.name }),
        );
    }

    Ok(meta.name)
}

#[tauri::command]
pub async fn install_from_hub_cmd(app: AppHandle, kind: String, id: String, quiet: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_from_hub_opts(&app, &kind, &id, quiet.unwrap_or(false)))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[tauri::command]
pub async fn fetch_hub_map_json(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sanitize_id(&id)?;
        let bytes = download(&format!("{}/api/maps/{id}/file", hub_base()))?;
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("not a valid package: {e}"))?;
        let mut file = archive
            .by_name("map.json")
            .map_err(|e| format!("no map.json in that package: {e}"))?;
        let mut out = String::new();
        file.read_to_string(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("map fetch task panicked: {e}"))?
}

#[derive(serde::Deserialize)]
struct SubmitResult {
    id: String,
    /// The upload's revision after this submit (2+ once it has been updated).
    #[serde(default)]
    revision: Option<i64>,
}

/// The optional `updates=<hub id>` field: this upload is a new version of that one of the user's own.
fn with_updates<'a>(form: ureq::unversioned::multipart::Form<'a>, updates: &'a Option<String>) -> ureq::unversioned::multipart::Form<'a> {
    match updates.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => form.text("updates", id),
        _ => form,
    }
}

#[tauri::command]
pub async fn submit_skin_cmd(token: String, folder_path: String, display_name: String, author: String, description: Option<String>, updates: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || submit_skin_blocking(token, folder_path, display_name, author, description, updates))
        .await
        .map_err(|e| format!("upload task panicked: {e}"))?
}

fn submit_skin_blocking(token: String, folder_path: String, display_name: String, author: String, description: Option<String>, updates: Option<String>) -> Result<String, String> {
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
    }
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("'{folder_path}' is not a folder"));
    }
    let description = description.unwrap_or_default();

    let zip_bytes = zip_folder_excluding_build_output(&folder)?;
    let tmp_id = NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("recharge-skin-upload-{}-{tmp_id}.zip", std::process::id()));
    std::fs::write(&tmp, &zip_bytes).map_err(|e| e.to_string())?;

    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "skin")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", "recharge.customskins")
        .file("file", &tmp)
        .map_err(|e| e.to_string())?;
    let form = with_updates(form, &updates);

    let result: Result<SubmitResult, String> = (|| {
        ureq::post(&format!("{}/api/submit", hub_base()))
            .header("Authorization", format!("Bearer {token}"))
            .send(form)
            .map_err(|e| format!("upload failed: {e}"))?
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_json()
            .map_err(|e| format!("bad response from library: {e}"))
    })();
    let _ = std::fs::remove_file(&tmp);

    Ok(result?.id)
}

#[tauri::command]
pub async fn submit_map_cmd(
    token: String,
    file_path: String,
    display_name: String,
    author: String,
    description: String,
    gallery_paths: Option<Vec<String>>,
    updates: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || submit_map_blocking(token, file_path, display_name, author, description, gallery_paths, updates).map(|r| r.id))
        .await
        .map_err(|e| format!("upload task panicked: {e}"))?
}

fn submit_map_blocking(
    token: String,
    file_path: String,
    display_name: String,
    author: String,
    description: String,
    gallery_paths: Option<Vec<String>>,
    updates: Option<String>,
) -> Result<SubmitResult, String> {
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
    }
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err(format!("'{file_path}' not found"));
    }
    let gallery_paths = gallery_paths.unwrap_or_default();
    if gallery_paths.len() > MAX_GALLERY_IMAGES {
        return Err(format!("at most {MAX_GALLERY_IMAGES} screenshots can be uploaded"));
    }
    for p in &gallery_paths {
        let gp = PathBuf::from(p);
        if !gp.is_file() {
            return Err(format!("screenshot '{p}' not found"));
        }
        let ext = gp.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg" | "webp" | "gif")) {
            return Err(format!("'{p}' isn't a png, jpg, webp or gif image"));
        }
    }

    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "map")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", "recharge.maps")
        .file("file", &path)
        .map_err(|e| e.to_string())?;
    let mut form = with_updates(form, &updates);
    for p in &gallery_paths {
        form = form.file("gallery", p).map_err(|e| e.to_string())?;
    }

    let result: SubmitResult = ureq::post(&format!("{}/api/submit", hub_base()))
        .header("Authorization", format!("Bearer {token}"))
        .send(form)
        .map_err(|e| format!("upload failed: {e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from library: {e}"))?;

    Ok(result)
}

/// Uploads an installed map as a Hub package (map.json, files, picture, zipped); the map then remembers its Hub id and name in hub.json.
#[tauri::command]
pub async fn submit_installed_map_cmd(
    app: AppHandle,
    token: String,
    id: String,
    display_name: String,
    author: String,
    description: String,
    gallery_paths: Option<Vec<String>>,
    updates: Option<String>,
) -> Result<String, String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    let dir = maps_dir(&app).ok_or("game path not set")?.join(&id);
    tauri::async_runtime::spawn_blocking(move || {
        if !dir.join("map.json").is_file() {
            return Err(format!("map '{id}' not found"));
        }
        let tmp = std::env::temp_dir().join(format!("recharge-map-upload-{}-{}.zip", std::process::id(), NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&tmp, zip_map_folder(&dir)?).map_err(|e| e.to_string())?;
        let result = submit_map_blocking(token, tmp.to_string_lossy().to_string(), display_name.clone(), author, description, gallery_paths, updates);
        let _ = std::fs::remove_file(&tmp);
        let result = result?;
        // This folder is the uploaded version, so it counts as up to date: the revision the hub now holds (the time of the update is the hub's, and read on the next catalog load).
        let _ = std::fs::write(dir.join("hub.json"), serde_json::json!({ "name": display_name, "id": result.id, "revision": result.revision.unwrap_or(1) }).to_string());
        Ok(result.id)
    })
    .await
    .map_err(|e| format!("upload task panicked: {e}"))?
}

// A map's package: map.json, its picture, and its files (assets/), as the Hub installs them.
fn zip_map_folder(dir: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut files = vec![("map.json".to_string(), dir.join("map.json"))];
    if dir.join("thumb.png").is_file() {
        files.push(("thumb.png".to_string(), dir.join("thumb.png")));
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("assets")) {
        for e in entries.flatten() {
            if e.path().is_file() {
                files.push((format!("assets/{}", e.file_name().to_string_lossy()), e.path()));
            }
        }
    }
    for (name, path) in files {
        writer.start_file(name, options).map_err(|e| e.to_string())?;
        writer.write_all(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(writer.finish().map_err(|e| e.to_string())?.into_inner())
}

#[derive(serde::Deserialize)]
struct ModManifestForUpload {
    id: String,
    #[serde(default = "default_mod_version")]
    version: String,
}

fn default_mod_version() -> String {
    "1.0.0".to_string()
}

fn zip_folder_excluding_build_output(folder: &std::path::Path) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default();
    add_dir_to_zip(&mut writer, folder, folder, options)?;
    let cursor = writer.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn add_dir_to_zip<W: std::io::Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    base: &std::path::Path,
    dir: &std::path::Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        // Build output is regenerated and .git is the source repo's history: neither belongs in a published download.
        if name == "bin" || name == "obj" || name == ".git" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            add_dir_to_zip(writer, base, &path, options)?;
        } else {
            let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
            writer
                .start_file(rel.to_string_lossy(), options)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(writer, &std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn submit_mod_cmd(
    app: AppHandle,
    token: String,
    folder_path: String,
    display_name: String,
    author: String,
    description: Option<String>,
    gallery_paths: Option<Vec<String>>,
    updates: Option<String>,
) -> Result<String, String> {
    let mods = mods_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let (id, mod_id, revision) = submit_mod_blocking(token, folder_path, display_name.clone(), author, description, gallery_paths, updates)?;
        // The installed copy of the mod just uploaded is that version: it must not be "updated" back from the hub.
        if let Some(dir) = mods.map(|d| d.join(&mod_id)).filter(|d| d.is_dir()) {
            let _ = std::fs::write(dir.join(HUB_META_FILE), hub_meta_json(&id, &display_name, &HubVersion { revision: revision.unwrap_or(1), updated_at: None }));
        }
        Ok(id)
    })
    .await
    .map_err(|e| format!("upload task panicked: {e}"))?
}

fn submit_mod_blocking(
    token: String,
    folder_path: String,
    display_name: String,
    author: String,
    description: Option<String>,
    gallery_paths: Option<Vec<String>>,
    updates: Option<String>,
) -> Result<(String, String, Option<i64>), String> {
    let description = description.unwrap_or_default();
    let gallery_paths = gallery_paths.unwrap_or_default();
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
    }
    if gallery_paths.len() > MAX_GALLERY_IMAGES {
        return Err(format!("at most {MAX_GALLERY_IMAGES} screenshots can be uploaded"));
    }
    for p in &gallery_paths {
        let path = PathBuf::from(p);
        if !path.is_file() {
            return Err(format!("screenshot '{p}' not found"));
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg" | "webp" | "gif")) {
            return Err(format!("'{p}' isn't a png, jpg, webp or gif image"));
        }
    }
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("'{folder_path}' is not a folder"));
    }
    let manifest_text = std::fs::read_to_string(folder.join("mod.json"))
        .map_err(|_| "the selected folder doesn't have a mod.json in it".to_string())?;
    let manifest: ModManifestForUpload = serde_json::from_str(&manifest_text).map_err(|e| e.to_string())?;

    let zip_bytes = zip_folder_excluding_build_output(&folder)?;
    let tmp_id = NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("recharge-mod-upload-{}-{tmp_id}.igtap", std::process::id()));
    std::fs::write(&tmp, &zip_bytes).map_err(|e| e.to_string())?;

    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "mod")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", &manifest.id)
        .text("version", &manifest.version)
        .file("file", &tmp)
        .map_err(|e| e.to_string())?;
    let mut form = with_updates(form, &updates);
    for p in &gallery_paths {
        form = form.file("gallery", p).map_err(|e| e.to_string())?;
    }

    let result: Result<SubmitResult, String> = (|| {
        ureq::post(&format!("{}/api/submit", hub_base()))
            .header("Authorization", format!("Bearer {token}"))
            .send(form)
            .map_err(|e| format!("upload failed: {e}"))?
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_json()
            .map_err(|e| format!("bad response from library: {e}"))
    })();
    let _ = std::fs::remove_file(&tmp);

    let r = result?;
    Ok((r.id, manifest.id, r.revision))
}

/// The mod id (mod.json "id") of a mod folder, so the upload form can pre-pick which of the user's uploads it updates.
#[tauri::command]
pub async fn mod_folder_id(folder_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("mod_folder_id", || mod_folder_id_sync(folder_path))).await.expect("command thread panicked")
}

pub fn mod_folder_id_sync(folder_path: String) -> Option<String> {
    read_json_file(&PathBuf::from(folder_path).join("mod.json"))?.get("id")?.as_str().map(str::to_string)
}

#[tauri::command]
pub async fn delete_hub_submission_cmd(token: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_hub_submission_blocking(token, id))
        .await
        .map_err(|e| format!("delete task panicked: {e}"))?
}

fn delete_hub_submission_blocking(token: String, id: String) -> Result<(), String> {
    sanitize_id(&id)?;
    ureq::delete(&format!("{HUB_BASE}/api/submissions/{id}"))
        .header("Authorization", format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("delete failed: {e}"))?;
    Ok(())
}

// --- Background playlists on the hub (used by backgrounds.rs) ---

// ureq error -> message; a 404 means the hub doesn't know playlists at all.
fn playlist_err(what: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(404) => "UNSUPPORTED".to_string(),
        other => format!("{what} failed: {other}"),
    }
}

pub fn hub_submit_playlist(token: &str, name: &str, author: &str, zip_bytes: &[u8]) -> Result<String, String> {
    let tmp_id = NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("recharge-playlist-upload-{}-{tmp_id}.zip", std::process::id()));
    std::fs::write(&tmp, zip_bytes).map_err(|e| e.to_string())?;
    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "playlist")
        .text("name", name)
        .text("author", author)
        .file("file", &tmp)
        .map_err(|e| e.to_string())?;
    let result: Result<SubmitResult, String> = (|| {
        ureq::post(&format!("{}/api/submit", hub_base()))
            .header("Authorization", format!("Bearer {token}"))
            .send(form)
            .map_err(|e| playlist_err("upload", e))?
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_json()
            .map_err(|e| format!("bad response from library: {e}"))
    })();
    let _ = std::fs::remove_file(&tmp);
    Ok(result?.id)
}

// A missing submission counts as deleted.
pub fn hub_delete_submission(token: &str, id: &str) -> Result<(), String> {
    sanitize_id(id)?;
    match ureq::delete(&format!("{HUB_BASE}/api/submissions/{id}")).header("Authorization", format!("Bearer {token}")).call() {
        Ok(_) | Err(ureq::Error::StatusCode(404)) => Ok(()),
        Err(e) => Err(format!("delete failed: {e}")),
    }
}

pub fn hub_submit_background(token: &str, name: &str, author: &str, path: &std::path::Path, poster: Option<&std::path::Path>) -> Result<String, String> {
    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "background")
        .text("name", name)
        .text("author", author)
        .file("file", path)
        .map_err(|e| e.to_string())?;
    // the poster picture of a video travels as the optional `poster` field
    let form = match poster {
        Some(p) => form.file("poster", p).map_err(|e| e.to_string())?,
        None => form,
    };
    let res: SubmitResult = ureq::post(&format!("{}/api/submit", hub_base()))
        .header("Authorization", format!("Bearer {token}"))
        .send(form)
        .map_err(|e| playlist_err("upload", e))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from library: {e}"))?;
    Ok(res.id)
}

// `posters` of a hub row ({ original file name: poster file name }); empty when the hub has none. kind_path: "playlists" | "backgrounds".
pub fn hub_row_posters(kind_path: &str, id: &str) -> Result<std::collections::HashMap<String, String>, String> {
    sanitize_id(id)?;
    let row: serde_json::Value = call_json_retry(&format!("{HUB_BASE}/api/{kind_path}/{id}"))?;
    Ok(row
        .get("posters")
        .and_then(|p| p.as_object())
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// One poster picture from the item's gallery route (<= 2 MB).
pub fn hub_download_poster(kind_path: &str, id: &str, file: &str) -> Result<Vec<u8>, String> {
    sanitize_id(id)?;
    let mut res = ureq::get(&format!("{HUB_BASE}/api/{kind_path}/{id}/gallery/{}", percent_encode(file))).call().map_err(|e| playlist_err("poster download", e))?;
    res.body_mut().with_config().limit(2 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())
}

pub fn hub_download_background(id: &str) -> Result<Vec<u8>, String> {
    sanitize_id(id)?;
    let mut res = ureq::get(&format!("{HUB_BASE}/api/backgrounds/{id}/file")).call().map_err(|e| playlist_err("download", e))?;
    res.body_mut().with_config().limit(95 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_hub_backgrounds_cmd() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ureq::get(&format!("{HUB_BASE}/api/backgrounds"))
            .call()
            .map_err(|e| playlist_err("loading images", e))?
            .body_mut()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_json()
            .map_err(|e| format!("bad response from library: {e}"))
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

// "What's new": the changelog of a channel; "NOT_FOUND" when the hub has none yet.
#[tauri::command]
pub async fn fetch_changelog_cmd(channel: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let channel = if channel == "beta" { "beta" } else { "stable" };
        match ureq::get(&format!("{HUB_BASE}/update/{channel}/changelog.json")).call() {
            Ok(mut r) => r.body_mut().with_config().limit(2 * 1024 * 1024).read_json().map_err(|e| format!("bad changelog: {e}")),
            Err(ureq::Error::StatusCode(404)) => Err("NOT_FOUND".to_string()),
            Err(e) => Err(format!("couldn't load the changelog: {e}")),
        }
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

// Streams the playlist zip (up to ~95 MB of media on a slow server can take minutes), reporting (done, total) bytes.
// `total` is 0 when the server sent no length. Generous but finite timeouts so a dead connection ends with a message.
pub fn hub_download_playlist_zip(id: &str, progress: &dyn Fn(u64, u64)) -> Result<Vec<u8>, String> {
    sanitize_id(id)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(30)))
        .timeout_global(Some(std::time::Duration::from_secs(30 * 60)))
        .build()
        .into();
    let mut res = agent.get(&format!("{HUB_BASE}/api/playlists/{id}/file")).call().map_err(|e| playlist_err("download", e))?;
    let total = res.body().content_length().unwrap_or(0);
    let mut reader = res.body_mut().with_config().limit(MAX_PACKAGE_BYTES).reader();
    let mut out = Vec::with_capacity(total.min(MAX_PACKAGE_BYTES) as usize);
    let mut buf = vec![0u8; 64 * 1024];
    progress(0, total);
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted after {} MB: {e}", out.len() / 1024 / 1024))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        progress(out.len() as u64, total);
    }
    if total > 0 && (out.len() as u64) < total {
        return Err(format!("download cut short ({} of {} MB)", out.len() / 1024 / 1024, total / 1024 / 1024));
    }
    Ok(out)
}

#[tauri::command]
pub async fn fetch_hub_playlists_cmd() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ureq::get(&format!("{HUB_BASE}/api/playlists"))
            .call()
            .map_err(|e| playlist_err("loading playlists", e))?
            .body_mut()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_json()
            .map_err(|e| format!("bad response from library: {e}"))
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

pub fn start_beam_server(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", BEAM_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[hub] beam server failed to start: {e}");
                return;
            }
        };
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let (status, body) = handle_beam_request(&app, &url);
            let cors = tiny_http::Header::from_bytes(
                &b"Access-Control-Allow-Origin"[..],
                HUB_ORIGIN.as_bytes(),
            )
            .unwrap();
            let ctype =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let response = tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header(cors)
                .with_header(ctype);
            let _ = request.respond(response);
        }
    });
}

fn handle_beam_request(app: &AppHandle, url: &str) -> (u16, String) {
    if !url.starts_with("/beam") {
        return (404, serde_json::json!({ "error": "not found" }).to_string());
    }
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
    let mut kind = None;
    let mut id = None;
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let value = url_decode(it.next().unwrap_or(""));
        match key {
            "kind" => kind = Some(value),
            "id" => id = Some(value),
            _ => {}
        }
    }
    let (Some(kind), Some(id)) = (kind, id) else {
        return (
            400,
            serde_json::json!({ "error": "kind and id are required" }).to_string(),
        );
    };

    match install_from_hub(app, &kind, &id) {
        Ok(name) => (200, serde_json::json!({ "status": "ok", "name": name }).to_string()),
        Err(err) => (500, serde_json::json!({ "error": err }).to_string()),
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod install_tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rl-hubinst-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn map_zip(name: &str, uid: Option<&str>, marker: &str) -> Vec<u8> {
        let json = match uid {
            Some(u) => format!(r#"{{"uid":"{u}","name":"{name}","marker":"{marker}"}}"#),
            None => format!(r#"{{"name":"{name}","marker":"{marker}"}}"#),
        };
        zip_of(&[("map.json", &json), ("assets/a.txt", marker)])
    }

    fn v(rev: i64) -> HubVersion {
        HubVersion { revision: rev, updated_at: Some(format!("2026-01-0{rev}T00:00:00Z")) }
    }

    fn folders(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = sorted_dirs(dir).iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).collect();
        v.sort();
        v
    }

    fn marker(folder: &std::path::Path) -> String {
        read_json_file(&folder.join("map.json")).unwrap()["marker"].as_str().unwrap().to_string()
    }

    #[test]
    fn map_update_reuses_the_folder_even_when_renamed() {
        let dir = tmp("map-rename");
        let first = install_map_into(&dir, map_zip("Clau v0.3A", Some("u1"), "one"), "hub-aaaaaaaa", "Clau v0.3A", &v(1)).unwrap();
        assert_eq!(folders(&dir), ["clau-v0-3a"]);
        // renamed on the hub: same hub id, new name
        let second = install_map_into(&dir, map_zip("Clau v0.3B", Some("u1"), "two"), "hub-aaaaaaaa", "Clau v0.3B", &v(2)).unwrap();
        assert_eq!(first, second, "same folder");
        assert_eq!(folders(&dir), ["clau-v0-3a"], "no second folder");
        assert_eq!(marker(&second), "two");
        let hub = read_json_file(&second.join("hub.json")).unwrap();
        assert_eq!((hub["id"].as_str(), hub["name"].as_str(), hub["revision"].as_i64()), (Some("hub-aaaaaaaa"), Some("Clau v0.3B"), Some(2)));
        assert_eq!(hub["updatedAt"].as_str(), Some("2026-01-02T00:00:00Z"));
        assert!(!std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".beam-tmp")), "scratch folder cleaned up");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn map_with_the_same_uid_under_another_hub_id_replaces_the_old_copy() {
        let dir = tmp("map-dup");
        install_map_into(&dir, map_zip("Clau v0.3A", Some("u1"), "one"), "hub-aaaaaaaa", "Clau v0.3A", &v(1)).unwrap();
        install_map_into(&dir, map_zip("Other", Some("u2"), "other"), "hub-cccccccc", "Other", &v(1)).unwrap();
        let t = install_map_into(&dir, map_zip("Clau v0.3B", Some("u1"), "two"), "hub-bbbbbbbb", "Clau v0.3B", &v(1)).unwrap();
        assert_eq!(folders(&dir), ["clau-v0-3a", "other"], "the old copy's folder is reused, the unrelated map untouched");
        assert_eq!(marker(&t), "two");
        assert_eq!(read_json_file(&t.join("hub.json")).unwrap()["id"].as_str(), Some("hub-bbbbbbbb"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn extra_duplicates_are_removed_and_local_only_copies_kept() {
        let dir = tmp("map-dup2");
        install_map_into(&dir, map_zip("A", Some("u1"), "a"), "hub-aaaaaaaa", "A", &v(1)).unwrap();
        install_map_into(&dir, map_zip("B", Some("u9"), "b"), "hub-bbbbbbbb", "B", &v(1)).unwrap();
        // make B a second copy of u1 (as if installed before it carried the same id as A)
        std::fs::write(dir.join("b").join("map.json"), r#"{"uid":"u1","name":"B","marker":"b"}"#).unwrap();
        // a local-only copy of the same map (the user's own edits, never on the hub)
        std::fs::create_dir_all(dir.join("mine")).unwrap();
        std::fs::write(dir.join("mine").join("map.json"), r#"{"uid":"u1","name":"mine","marker":"mine"}"#).unwrap();
        install_map_into(&dir, map_zip("C", Some("u1"), "c"), "hub-cccccccc", "C", &v(1)).unwrap();
        assert_eq!(folders(&dir), ["a", "mine"], "one hub copy remains (reused), the other removed, the local copy kept");
        assert_eq!(marker(&dir.join("a")), "c");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn maps_without_uid_never_count_as_duplicates() {
        let dir = tmp("map-nouid");
        install_map_into(&dir, map_zip("A", None, "a"), "hub-aaaaaaaa", "A", &v(1)).unwrap();
        install_map_into(&dir, map_zip("B", None, "b"), "hub-bbbbbbbb", "B", &v(1)).unwrap();
        assert_eq!(folders(&dir), ["a", "b"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_slug_owned_by_another_hub_map_gets_a_suffix() {
        let dir = tmp("map-slug");
        install_map_into(&dir, map_zip("Same", Some("u1"), "one"), "hub-aaaaaaaa", "Same", &v(1)).unwrap();
        install_map_into(&dir, map_zip("Same", Some("u2"), "two"), "hub-bbbbbbbb", "Same", &v(1)).unwrap();
        assert_eq!(folders(&dir), ["same", "same-hub-bbbb"]);
        assert_eq!(marker(&dir.join("same")), "one");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_broken_package_leaves_the_installed_map_alone() {
        let dir = tmp("map-bad");
        let t = install_map_into(&dir, map_zip("A", Some("u1"), "good"), "hub-aaaaaaaa", "A", &v(1)).unwrap();
        assert!(install_map_into(&dir, b"not a zip".to_vec(), "hub-aaaaaaaa", "A", &v(2)).is_err());
        assert_eq!(marker(&t), "good");
        assert_eq!(folders(&dir), ["a"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn skin_update_keeps_the_folder_and_records_the_revision() {
        let dir = tmp("skin");
        let a = install_skin_into(&dir, zip_of(&[("skin.png", "v1")]), "hub-aaaaaaaa", "Fancy", &v(1)).unwrap();
        let b = install_skin_into(&dir, zip_of(&[("skin2.png", "v2")]), "hub-aaaaaaaa", "Fancy Reborn", &v(2)).unwrap();
        assert_eq!(a, b);
        assert_eq!(folders(&dir), ["fancy"]);
        assert!(!b.join("skin.png").exists() && b.join("skin2.png").exists(), "contents replaced");
        let meta = super::super::skins::read_hub_meta(&b).unwrap();
        assert_eq!((meta.hub_id.as_str(), meta.name.as_str(), meta.revision), ("hub-aaaaaaaa", "Fancy Reborn", Some(2)));
        // a different hub skin with the same name gets its own folder
        let c = install_skin_into(&dir, zip_of(&[("s.png", "x")]), "hub-bbbbbbbb", "Fancy", &v(1)).unwrap();
        assert_ne!(a, c);
        assert_eq!(folders(&dir), ["fancy", "fancy-hub-bbbb"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mod_update_replaces_files_keeps_enabled_and_records_the_hub_entry() {
        let dir = tmp("mod");
        let pkg = |ver: &str, file: &str| zip_of(&[("mod.json", &format!(r#"{{"id":"cool.mod","displayName":"Cool","version":"{ver}","enabled":false}}"#)), (file, "x")]);
        install_mod_into(&dir, pkg("1.0.0", "a.dll"), "hub-aaaaaaaa", "Cool", &v(1)).unwrap();
        // the user switches it on
        let mj = dir.join("cool.mod").join("mod.json");
        let mut j = read_json_file(&mj).unwrap();
        j["enabled"] = serde_json::Value::Bool(true);
        std::fs::write(&mj, j.to_string()).unwrap();
        install_mod_into(&dir, pkg("1.1.0", "b.dll"), "hub-aaaaaaaa", "Cool", &v(2)).unwrap();
        let j = read_json_file(&mj).unwrap();
        assert_eq!((j["version"].as_str(), j["enabled"].as_bool()), (Some("1.1.0"), Some(true)));
        assert!(!dir.join("cool.mod/a.dll").exists() && dir.join("cool.mod/b.dll").exists());
        let meta = super::super::skins::read_hub_meta(&dir.join("cool.mod")).unwrap();
        assert_eq!((meta.hub_id.as_str(), meta.revision), ("hub-aaaaaaaa", Some(2)));
        // the update changes the mod id: the old folder of the same hub entry goes
        let renamed = zip_of(&[("mod.json", r#"{"id":"cool.mod2","displayName":"Cool","version":"2.0.0"}"#)]);
        install_mod_into(&dir, renamed, "hub-aaaaaaaa", "Cool", &v(3)).unwrap();
        assert_eq!(folders(&dir), ["cool.mod2"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mod_package_without_mod_json_is_refused() {
        let dir = tmp("mod-bad");
        assert!(install_mod_into(&dir, zip_of(&[("a.txt", "x")]), "h", "n", &v(1)).is_err());
        assert!(folders(&dir).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
