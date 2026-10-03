use serde::Deserialize;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::settings;

pub const BEAM_PORT: u16 = 39284;
const HUB_ORIGIN: &str = "https://codecade.co.za";
const HUB_BASE: &str = "https://codecade.co.za/recharge";
const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_GALLERY_IMAGES: usize = 8;

fn sanitize_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(format!("invalid id: '{id}'"));
    }
    Ok(())
}

fn mods_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
    Some(PathBuf::from(game_path).join("Recharge").join("Mods"))
}

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

fn skins_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
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

fn install_mod_zip(app: &AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    let dir = mods_dir(app).ok_or("game path not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let tmp_id = NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".beam-tmp-{}-{tmp_id}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid package: {e}"))?;
    archive
        .extract(&tmp)
        .map_err(|e| format!("couldn't extract package: {e}"))?;

    let manifest_text = std::fs::read_to_string(tmp.join("mod.json"))
        .map_err(|_| "package is missing mod.json".to_string())?;
    let manifest: ModManifestId = serde_json::from_str(&manifest_text).map_err(|e| e.to_string())?;
    sanitize_id(&manifest.id)?;

    let target = dir.join(&manifest.id);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_map_zip(app: &AppHandle, bytes: Vec<u8>, hub_id: &str) -> Result<(), String> {
    let dir = maps_dir(app).ok_or("game path not set")?;
    let target = dir.join(hub_id);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid package: {e}"))?;
    archive
        .extract(&target)
        .map_err(|e| format!("couldn't extract package: {e}"))?;
    Ok(())
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

// Installed under a slug of the skin's name, not the raw hub id - see HUB_META_FILE.
fn install_skin_zip(app: &AppHandle, bytes: Vec<u8>, hub_id: &str, name: &str) -> Result<(), String> {
    let dir = skins_dir(app).ok_or("game path not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let slug = slugify(name);
    let slug = if slug.is_empty() { hub_id.to_string() } else { slug };

    // A same-slug folder belonging to a different hub id gets a suffixed slug instead of being clobbered.
    let mut candidate = slug.clone();
    if dir.join(&candidate).is_dir() {
        let existing_hub_id = super::skins::read_hub_meta(&dir.join(&candidate)).map(|m| m.hub_id);
        if existing_hub_id.as_deref() != Some(hub_id) {
            candidate = format!("{slug}-{}", &hub_id[..8.min(hub_id.len())]);
        }
    }

    let target = dir.join(&candidate);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid package: {e}"))?;
    archive
        .extract(&target)
        .map_err(|e| format!("couldn't extract package: {e}"))?;

    let meta = super::skins::SkinHubMeta { hub_id: hub_id.to_string(), name: name.to_string() };
    if let Ok(json) = serde_json::to_string(&meta) {
        let _ = std::fs::write(target.join(super::skins::HUB_META_FILE), json);
    }
    Ok(())
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

pub fn install_from_hub(app: &AppHandle, kind: &str, id: &str) -> Result<String, String> {
    if kind != "mods" && kind != "maps" && kind != "skins" {
        return Err("kind must be 'mods', 'maps' or 'skins'".to_string());
    }
    sanitize_id(id)?;

    let meta: HubItem = call_json_retry(&format!("{HUB_BASE}/api/{kind}/{id}"))?;

    let bytes = download(&format!("{HUB_BASE}/api/{kind}/{id}/file"))?;

    if kind == "mods" {
        install_mod_zip(app, bytes)?;
    } else if kind == "maps" {
        install_map_zip(app, bytes, id)?;
    } else {
        install_skin_zip(app, bytes, id, &meta.name)?;
    }

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit(
        "hub-beam-installed",
        serde_json::json!({ "kind": kind, "id": id, "name": meta.name }),
    );

    Ok(meta.name)
}

#[tauri::command]
pub async fn install_from_hub_cmd(app: AppHandle, kind: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_from_hub(&app, &kind, &id))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

#[tauri::command]
pub async fn fetch_hub_map_json(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sanitize_id(&id)?;
        let bytes = download(&format!("{HUB_BASE}/api/maps/{id}/file"))?;
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
}

#[tauri::command]
pub async fn submit_skin_cmd(token: String, folder_path: String, display_name: String, author: String, description: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || submit_skin_blocking(token, folder_path, display_name, author, description))
        .await
        .map_err(|e| format!("upload task panicked: {e}"))?
}

fn submit_skin_blocking(token: String, folder_path: String, display_name: String, author: String, description: Option<String>) -> Result<String, String> {
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

    let result: Result<SubmitResult, String> = (|| {
        ureq::post(&format!("{HUB_BASE}/api/submit"))
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
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || submit_map_blocking(token, file_path, display_name, author, description, gallery_paths))
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
) -> Result<String, String> {
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

    let mut form = ureq::unversioned::multipart::Form::new()
        .text("kind", "map")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", "recharge.maps")
        .file("file", &path)
        .map_err(|e| e.to_string())?;
    for p in &gallery_paths {
        form = form.file("gallery", p).map_err(|e| e.to_string())?;
    }

    let result: SubmitResult = ureq::post(&format!("{HUB_BASE}/api/submit"))
        .header("Authorization", format!("Bearer {token}"))
        .send(form)
        .map_err(|e| format!("upload failed: {e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from library: {e}"))?;

    Ok(result.id)
}

/// Uploads an installed map as a Hub package: its folder's map.json, files and picture, zipped.
/// The map then remembers its Hub id and name (hub.json), so it isn't offered for upload again.
#[tauri::command]
pub async fn submit_installed_map_cmd(
    app: AppHandle,
    token: String,
    id: String,
    display_name: String,
    author: String,
    description: String,
    gallery_paths: Option<Vec<String>>,
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
        let result = submit_map_blocking(token, tmp.to_string_lossy().to_string(), display_name.clone(), author, description, gallery_paths);
        let _ = std::fs::remove_file(&tmp);
        let hub_id = result?;
        let _ = std::fs::write(dir.join("hub.json"), serde_json::json!({ "name": display_name, "id": hub_id }).to_string());
        Ok(hub_id)
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
        if name == "bin" || name == "obj" {
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
    token: String,
    folder_path: String,
    display_name: String,
    author: String,
    description: Option<String>,
    gallery_paths: Option<Vec<String>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        submit_mod_blocking(token, folder_path, display_name, author, description, gallery_paths)
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
) -> Result<String, String> {
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

    let mut form = ureq::unversioned::multipart::Form::new()
        .text("kind", "mod")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", &manifest.id)
        .text("version", &manifest.version)
        .file("file", &tmp)
        .map_err(|e| e.to_string())?;
    for p in &gallery_paths {
        form = form.file("gallery", p).map_err(|e| e.to_string())?;
    }

    let result: Result<SubmitResult, String> = (|| {
        ureq::post(&format!("{HUB_BASE}/api/submit"))
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
