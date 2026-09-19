use serde::Deserialize;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::settings;

pub const BEAM_PORT: u16 = 39284;
const HUB_ORIGIN: &str = "https://codecade.co.za";
const HUB_BASE: &str = "https://codecade.co.za/recharge";
const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;

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
    #[serde(rename = "fileName")]
    file_name: String,
}

#[derive(Deserialize)]
struct ModManifestId {
    id: String,
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    ureq::get(url)
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(MAX_PACKAGE_BYTES)
        .read_to_vec()
        .map_err(|e| e.to_string())
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
    let mut slug = String::new();
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn install_skin_file(app: &AppHandle, bytes: Vec<u8>, meta: &HubItem) -> Result<(), String> {
    let dir = skins_dir(app).ok_or("game path not set")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let ext = PathBuf::from(&meta.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    let slug = slugify(&meta.name);
    let filename = format!("{}.{ext}", if slug.is_empty() { "skin".to_string() } else { slug });

    std::fs::write(dir.join(filename), &bytes).map_err(|e| e.to_string())
}

pub fn install_from_hub(app: &AppHandle, kind: &str, id: &str) -> Result<String, String> {
    if kind != "mods" && kind != "maps" && kind != "skins" {
        return Err("kind must be 'mods', 'maps' or 'skins'".to_string());
    }
    sanitize_id(id)?;

    let meta: HubItem = ureq::get(&format!("{HUB_BASE}/api/{kind}/{id}"))
        .call()
        .map_err(|e| format!("couldn't reach the library: {e}"))?
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_json()
        .map_err(|e| format!("bad response from library: {e}"))?;

    let bytes = download(&format!("{HUB_BASE}/api/{kind}/{id}/file"))?;

    if kind == "mods" {
        install_mod_zip(app, bytes)?;
    } else if kind == "maps" {
        install_map_zip(app, bytes, id)?;
    } else {
        install_skin_file(app, bytes, &meta)?;
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
pub fn install_from_hub_cmd(app: AppHandle, kind: String, id: String) -> Result<String, String> {
    install_from_hub(&app, &kind, &id)
}

#[derive(serde::Deserialize)]
struct SubmitResult {
    id: String,
}

#[tauri::command]
pub fn submit_skin_cmd(token: String, file_path: String, display_name: String, author: String) -> Result<String, String> {
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
    }
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err(format!("'{file_path}' not found"));
    }

    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "skin")
        .text("name", &display_name)
        .text("author", &author)
        .text("modId", "recharge.customskins")
        .file("file", &path)
        .map_err(|e| e.to_string())?;

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

#[tauri::command]
pub fn submit_map_cmd(token: String, file_path: String, display_name: String, author: String, description: String) -> Result<String, String> {
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
    }
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err(format!("'{file_path}' not found"));
    }

    let form = ureq::unversioned::multipart::Form::new()
        .text("kind", "map")
        .text("name", &display_name)
        .text("author", &author)
        .text("description", &description)
        .text("modId", "recharge.maps")
        .file("file", &path)
        .map_err(|e| e.to_string())?;

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
pub fn submit_mod_cmd(token: String, folder_path: String, display_name: String, author: String) -> Result<String, String> {
    if display_name.trim().is_empty() || author.trim().is_empty() {
        return Err("name and author are required".to_string());
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
        .text("modId", &manifest.id)
        .text("version", &manifest.version)
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
pub fn delete_hub_submission_cmd(token: String, id: String) -> Result<(), String> {
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
