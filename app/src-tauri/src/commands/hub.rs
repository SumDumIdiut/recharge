use serde::Deserialize;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::settings;

// The recharge-hub web viewer's "Beam to Client" button fetch()es this port
// directly from https://codecade.co.za - 127.0.0.1/localhost are treated as
// potentially-trustworthy origins by browsers, so an https page can call a
// plain http:// localhost server without a mixed-content block. This avoids
// needing a custom URL-protocol handler (NSIS/registry changes that are hard
// to verify without a real fresh install).
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

#[derive(Deserialize)]
struct HubItem {
    name: String,
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

// Extracted into a temp folder first because the real install dir name is
// the mod's own manifest id, not the recharge-hub submission id - those two
// only happen to match by coincidence.
// Requests are handled one at a time on a single background thread (see
// start_beam_server), but a queue on the web side can still fire the next
// install before this thread is done cleaning up after the previous one -
// a bare process-id tmp name would collide across requests, so each one
// gets its own counter value too.
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

// Maps have no manifest-driven id of their own yet, so the recharge-hub
// submission id (already unique) is used as the install folder name.
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

// Downloads one approved submission from recharge-hub and installs it in
// place. Shared by the local beam HTTP endpoint below.
pub fn install_from_hub(app: &AppHandle, kind: &str, id: &str) -> Result<String, String> {
    if kind != "mods" && kind != "maps" {
        return Err("kind must be 'mods' or 'maps'".to_string());
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
    } else {
        install_map_zip(app, bytes, id)?;
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

// The app's own Mods/Maps > Browse tabs call this directly via invoke() -
// same underlying logic the local beam HTTP endpoint below exposes to the
// external web viewer, just reached the normal way for in-app JS.
#[tauri::command]
pub fn install_from_hub_cmd(app: AppHandle, kind: String, id: String) -> Result<String, String> {
    install_from_hub(&app, &kind, &id)
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

// Minimal percent-decoding for query values - the only characters the
// browser's encodeURIComponent(id) can actually produce for a UUID/slug id.
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
