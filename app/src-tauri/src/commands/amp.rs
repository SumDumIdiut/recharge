//! Amplifier (map editor) updates: app/src/maps/** has its own track on the update hub, so a fix reaches users without a new Recharge version.
//!
//! The hub serves /update/amp/<channel>/manifest.json (files hashed into the shared /update/files/<sha256> store). We check it at startup and every
//! 20 minutes, download a newer version whose apiLevel the app supports into <app data>/amp/<version>/ (via <version>.part and an atomic rename),
//! keep current + previous, and serve it to the page from a small local server so app.js can import its editor.js instead of the built-in one.
//!
//! API level: this module adds commands (amp_status, amp_mark_bad, amp_check_now), so the app's API level (live.rs, app/live.json) went 15 -> 16.
//! app/src/maps/amp.json keeps "apiLevel": 15, the level the editor itself needs; any app with level >= 15 may run it, and the editor stays
//! loadable by apps that predate this module only through the built-in copy (they never download it).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Next to live.rs's LIVE_PORT (39285) and hub.rs's BEAM_PORT (39284).
pub const AMP_PORT: u16 = 39286;
const CHECK_EVERY: Duration = Duration::from_secs(20 * 60);
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 2000;
const DEFAULT_BASE: &str = "https://codecade.co.za/recharge";

#[derive(Default)]
pub struct AmpState {
    server_started: AtomicBool,
    /// One writer at a time: the timer, "check now" and mark-bad all change the same folder.
    busy: Mutex<()>,
}

// ---- manifest ----

#[derive(Debug, Deserialize)]
pub struct FileEnt {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub format: u64,
    pub component: String,
    pub channel: String,
    pub version: String,
    #[serde(rename = "apiLevel")]
    pub api_level: u64,
    pub files: Vec<FileEnt>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed(String),
    UpToDate,
    /// The newest Amplifier needs a newer app (its apiLevel).
    NeedsNewerApp(u64),
    /// Nothing published for this channel yet.
    NoManifest,
    /// The newest version was marked bad earlier.
    SkippedBad,
}

fn valid_version(v: &str) -> bool {
    v.starts_with("amp-")
        && v.len() <= 64
        && !v.ends_with(".part")
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn safe_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 500
        && !p.starts_with('/')
        && !p.contains(['\\', '\0', ':'])
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Parses and sanity-checks a manifest for this channel. Does not apply the API gate (see `gate`).
pub fn parse_manifest(text: &str, channel: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| format!("bad amp manifest: {e}"))?;
    if m.format != 1 || m.component != "amp" {
        return Err("not an amp manifest".into());
    }
    if m.channel != channel {
        return Err(format!("manifest is for channel {}, wanted {channel}", m.channel));
    }
    if !valid_version(&m.version) {
        return Err(format!("bad version {:?}", m.version));
    }
    if m.files.is_empty() || m.files.len() > MAX_FILES {
        return Err("bad file count".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for f in &m.files {
        if !safe_rel(&f.path) {
            return Err(format!("unsafe path {:?}", f.path));
        }
        if !seen.insert(f.path.as_str()) {
            return Err(format!("duplicate path {}", f.path));
        }
        if !is_hex64(&f.sha256) {
            return Err(format!("bad sha256 for {}", f.path));
        }
        if f.size > MAX_FILE_BYTES {
            return Err(format!("{} is too large", f.path));
        }
        total += f.size;
    }
    if total > MAX_TOTAL_BYTES {
        return Err("amp bundle too large".into());
    }
    if !seen.contains("editor.js") {
        return Err("editor.js missing".into());
    }
    Ok(m)
}

/// What to do with a manifest given the app's API level, the active version and the bad list.
pub fn gate(m: &Manifest, builtin_api: u64, active: Option<&str>, bad: &[String]) -> Option<Outcome> {
    if m.api_level > builtin_api {
        return Some(Outcome::NeedsNewerApp(m.api_level));
    }
    if bad.iter().any(|b| b == &m.version) {
        return Some(Outcome::SkippedBad);
    }
    if active == Some(m.version.as_str()) {
        return Some(Outcome::UpToDate);
    }
    None
}

// ---- on-disk state: <amp>/<version>/, <amp>/current, <amp>/previous, <amp>/bad ----

fn read_line(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn write_atomic(p: &Path, text: &str) -> std::io::Result<()> {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, p)
}

fn bad_list(amp: &Path) -> Vec<String> {
    std::fs::read_to_string(amp.join("bad")).map(|t| t.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
}

/// A version folder that exists, holds an editor.js and whose own amp.json (if any) is not above `api`.
fn version_usable(amp: &Path, version: &str, api: u64) -> bool {
    if !valid_version(version) {
        return false;
    }
    let dir = amp.join(version);
    if !dir.join("editor.js").is_file() {
        return false;
    }
    let need = std::fs::read_to_string(dir.join("amp.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("apiLevel").and_then(|l| l.as_u64()))
        .unwrap_or(0);
    need <= api
}

/// The downloaded version to use, if any.
pub fn current_usable(amp: &Path, api: u64) -> Option<String> {
    let v = read_line(&amp.join("current"))?;
    (version_usable(amp, &v, api) && !bad_list(amp).contains(&v)).then_some(v)
}

fn sha_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Makes `version` the current one (previous = what was current), then prunes every other version folder and leftover .part folders.
pub fn switch_to(amp: &Path, version: &str) -> std::io::Result<()> {
    let old = read_line(&amp.join("current")).filter(|o| o != version && amp.join(o).is_dir());
    match &old {
        Some(o) => write_atomic(&amp.join("previous"), o)?,
        None => {
            let _ = std::fs::remove_file(amp.join("previous"));
        }
    }
    write_atomic(&amp.join("current"), version)?;
    prune(amp);
    Ok(())
}

fn prune(amp: &Path) {
    let keep: Vec<String> = ["current", "previous"].iter().filter_map(|f| read_line(&amp.join(f))).collect();
    let Ok(rd) = std::fs::read_dir(amp) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if e.path().is_dir() && name.starts_with("amp-") && !keep.contains(&name) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Marks a version bad and, if it was current, falls back to the previous one (or to none, which means the built-in Amplifier).
pub fn mark_bad(amp: &Path, version: &str, api: u64) -> std::io::Result<()> {
    if !valid_version(version) {
        return Ok(());
    }
    std::fs::create_dir_all(amp)?;
    let mut bad = bad_list(amp);
    if !bad.iter().any(|b| b == version) {
        bad.push(version.to_string());
        let keep = bad.len().saturating_sub(50);
        write_atomic(&amp.join("bad"), &bad[keep..].join("\n"))?;
    }
    if read_line(&amp.join("current")).as_deref() == Some(version) {
        let prev = read_line(&amp.join("previous")).filter(|p| p != version && !bad.contains(p) && version_usable(amp, p, api));
        match prev {
            Some(p) => {
                write_atomic(&amp.join("current"), &p)?;
            }
            None => {
                let _ = std::fs::remove_file(amp.join("current"));
            }
        }
        let _ = std::fs::remove_file(amp.join("previous"));
    }
    let _ = std::fs::remove_dir_all(amp.join(version));
    prune(amp);
    Ok(())
}

// ---- downloading ----

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).build().into()
}

fn get_bytes(agent: &ureq::Agent, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    agent
        .get(url)
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_vec()
        .map_err(|e| e.to_string())
}

/// Builds <amp>/<version>/ from the manifest: identical files of `active` are copied (verified by hash), the rest downloaded from <base>/update/files/<sha>
/// and checked for size and sha256. Everything goes to <version>.part first and is renamed in one step. Does not switch current.
pub fn install(base: &str, amp: &Path, m: &Manifest, active: Option<&str>) -> Result<(), String> {
    let part = amp.join(format!("{}.part", m.version));
    let _ = std::fs::remove_dir_all(&part);
    std::fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    let result = (|| {
        let ag = agent();
        for f in &m.files {
            let bytes = match active.map(|a| amp.join(a).join(&f.path)).and_then(|p| std::fs::read(p).ok()).filter(|b| sha_hex(b) == f.sha256) {
                Some(b) => b,
                None => get_bytes(&ag, &format!("{base}/update/files/{}", f.sha256), f.size + 1).map_err(|e| format!("{}: {e}", f.path))?,
            };
            if bytes.len() as u64 != f.size {
                return Err(format!("{}: size {} != {}", f.path, bytes.len(), f.size));
            }
            if sha_hex(&bytes) != f.sha256 {
                return Err(format!("{}: sha256 mismatch", f.path));
            }
            let dest = part.join(&f.path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        }
        let dir = amp.join(&m.version);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&part, &dir).map_err(|e| format!("couldn't move the new version into place: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&part);
    }
    result
}

/// One full check: fetch the manifest, gate it, install and switch. `base` has no trailing slash.
pub fn check_and_install(base: &str, channel: &str, amp: &Path, builtin_api: u64) -> Result<Outcome, String> {
    std::fs::create_dir_all(amp).map_err(|e| e.to_string())?;
    let url = format!("{base}/update/amp/{channel}/manifest.json");
    let text = match agent().get(&url).header("User-Agent", "Recharge").call() {
        Ok(mut r) => r.body_mut().with_config().limit(2 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::StatusCode(404)) => return Ok(Outcome::NoManifest),
        Err(e) => return Err(e.to_string()),
    };
    let m = parse_manifest(&text, channel)?;
    let active = current_usable(amp, builtin_api);
    if let Some(done) = gate(&m, builtin_api, active.as_deref(), &bad_list(amp)) {
        return Ok(done);
    }
    install(base, amp, &m, active.as_deref())?;
    switch_to(amp, &m.version).map_err(|e| e.to_string())?;
    Ok(Outcome::Installed(m.version))
}

// ---- local server ----

/// Origins that may read the files: the app's own (per platform) and the live page.
fn allowed_origins() -> [String; 4] {
    [
        "tauri://localhost".into(),
        "http://tauri.localhost".into(),
        "https://tauri.localhost".into(),
        format!("http://127.0.0.1:{}", super::live::LIVE_PORT),
    ]
}

/// The Access-Control-Allow-Origin value for a request's Origin, or None for anyone else.
pub fn cors_origin(origin: Option<&str>) -> Option<String> {
    let o = origin?;
    allowed_origins().into_iter().find(|a| a == o)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolves "/<version>/<path...>" under `amp`; None for anything unsafe, unknown or not a file.
pub fn resolve(amp: &Path, url: &str) -> Option<PathBuf> {
    let path_part = url.split(['?', '#']).next().unwrap_or("/");
    let mut segs = path_part.split('/').filter(|s| !s.is_empty());
    let version = segs.next()?;
    if !valid_version(version) {
        return None;
    }
    let root = amp.join(version);
    let mut file = root.clone();
    for seg in segs {
        if seg == ".." || seg == "." || seg.contains(['\\', ':', '\0']) {
            return None;
        }
        file.push(seg);
    }
    (file != root && file.is_file()).then_some(file)
}

fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

/// Builds the response for one request. `origin` / `req_headers` come from the Origin / Access-Control-Request-Headers headers.
pub fn respond(amp: &Path, method: &tiny_http::Method, url: &str, origin: Option<&str>, req_headers: Option<&str>) -> tiny_http::Response<Cursor<Vec<u8>>> {
    use tiny_http::Method;
    let cors = |mut r: tiny_http::Response<Cursor<Vec<u8>>>| {
        if let Some(o) = cors_origin(origin) {
            r.add_header(header("Access-Control-Allow-Origin", &o));
        }
        r.add_header(header("Vary", "Origin"));
        r.add_header(header("Cache-Control", "no-store"));
        r
    };
    if matches!(method, Method::Options) {
        let mut r = tiny_http::Response::from_data(Vec::new()).with_status_code(204);
        r.add_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"));
        r.add_header(header("Access-Control-Allow-Headers", req_headers.unwrap_or("*")));
        r.add_header(header("Access-Control-Max-Age", "600"));
        return cors(r);
    }
    if !matches!(method, Method::Get | Method::Head) {
        return cors(tiny_http::Response::from_string("method not allowed").with_status_code(405));
    }
    let Some(file) = resolve(amp, url) else {
        return cors(tiny_http::Response::from_string("not found").with_status_code(404));
    };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mut r = tiny_http::Response::from_data(bytes);
            r.add_header(header("Content-Type", content_type(&file)));
            cors(r)
        }
        Err(_) => cors(tiny_http::Response::from_string("not found").with_status_code(404)),
    }
}

fn amp_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("amp"))
}

fn log(app: &AppHandle, msg: &str) {
    eprintln!("[amp] {msg}");
    let Some(root) = amp_root(app) else { return };
    let _ = std::fs::create_dir_all(&root);
    let path = root.join("debug.log");
    if std::fs::metadata(&path).map(|m| m.len() > 100_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

fn start_server(app: &AppHandle, amp: PathBuf) {
    let server = match tiny_http::Server::http(("127.0.0.1", AMP_PORT)) {
        Ok(s) => s,
        Err(e) => {
            log(app, &format!("amp server failed to start: {e}"));
            return;
        }
    };
    app.state::<AmpState>().server_started.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let amp = amp.clone();
            std::thread::spawn(move || {
                let hv = |name: &str| header_value(&request, name);
                let response = respond(&amp, request.method(), request.url(), hv("Origin").as_deref(), hv("Access-Control-Request-Headers").as_deref());
                let _ = request.respond(response);
            });
        }
    });
}

// ---- app glue ----

fn base_url() -> String {
    std::env::var("RECHARGE_UPDATE_BASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_BASE.into()).trim_end_matches('/').to_string()
}

/// The Recharge channel: the launcher's when managed (it can change while we run), else the app's own setting.
fn channel(app: &AppHandle) -> String {
    super::updater::managed_channel(app).unwrap_or_else(|| super::settings::update_channel(app))
}

fn run_check(app: &AppHandle) -> Result<Outcome, String> {
    let amp = amp_root(app).ok_or("no app data folder")?;
    let state = app.state::<AmpState>();
    let _busy = state.busy.lock().unwrap();
    let out = check_and_install(&base_url(), &channel(app), &amp, super::live::API_LEVEL)?;
    if let Outcome::Installed(v) = &out {
        log(app, &format!("installed Amplifier {v}"));
        let _ = app.emit("amp-update-ready", v);
    }
    Ok(out)
}

pub fn init(app: &AppHandle) {
    app.manage(AmpState::default());
    let Some(amp) = amp_root(app) else { return };
    let _ = std::fs::create_dir_all(&amp);
    start_server(app, amp);
    if std::env::var_os("RECHARGE_NO_AMP_UPDATE").is_some() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = run_check(&app) {
            log(&app, &format!("update check failed: {e}"));
        }
        std::thread::sleep(CHECK_EVERY);
    });
}

#[derive(Serialize)]
pub struct AmpInfo {
    active: bool,
    url: Option<String>,
    version: Option<String>,
    builtin_api: u64,
}

/// `url` is the base to import editor.js from (".../<version>/"); it is pinned to a version so a later switch can't mix files of two versions in an open page.
#[tauri::command]
pub fn amp_status(app: AppHandle) -> AmpInfo {
    let running = app.try_state::<AmpState>().map(|s| s.server_started.load(Ordering::SeqCst)).unwrap_or(false);
    let version = amp_root(&app).and_then(|a| current_usable(&a, super::live::API_LEVEL)).filter(|_| running);
    AmpInfo {
        active: version.is_some(),
        url: version.as_ref().map(|v| format!("http://127.0.0.1:{AMP_PORT}/{v}/")),
        version,
        builtin_api: super::live::API_LEVEL,
    }
}

/// The page calls this when the downloaded Amplifier failed to load or open: stop using that version (back to the previous one, or the built-in).
#[tauri::command]
pub fn amp_mark_bad(app: AppHandle, version: String) -> Result<(), String> {
    let amp = amp_root(&app).ok_or("no app data folder")?;
    let state = app.state::<AmpState>();
    let _busy = state.busy.lock().unwrap();
    log(&app, &format!("marking {version} bad"));
    mark_bad(&amp, &version, super::live::API_LEVEL).map_err(|e| e.to_string())
}

/// Returns "installed", "upToDate", "needsNewerApp", "none" or "skippedBad".
#[tauri::command]
pub async fn amp_check_now(app: AppHandle) -> Result<String, String> {
    let worker = app.clone();
    let out = tauri::async_runtime::spawn_blocking(move || run_check(&worker)).await.map_err(|e| e.to_string())??;
    Ok(match out {
        Outcome::Installed(_) => "installed",
        Outcome::UpToDate => "upToDate",
        Outcome::NeedsNewerApp(_) => "needsNewerApp",
        Outcome::NoManifest => "none",
        Outcome::SkippedBad => "skippedBad",
    }
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("recharge-amp-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn manifest_json(version: &str, api: u64, files: &[(&str, &[u8])]) -> String {
        let list: Vec<_> = files.iter().map(|(p, b)| serde_json::json!({"path": p, "size": b.len(), "sha256": sha_hex(b)})).collect();
        serde_json::json!({"format": 1, "component": "amp", "channel": "beta", "version": version, "build": 1, "apiLevel": api, "files": list}).to_string()
    }

    /// A fake hub: serves the manifest and /update/files/<sha> from `store` (sha -> bytes); counts file requests.
    fn fake_hub(manifest: String, store: HashMap<String, Vec<u8>>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let url = req.url().to_string();
                if url == "/update/amp/beta/manifest.json" {
                    let _ = req.respond(tiny_http::Response::from_string(manifest.clone()));
                } else if let Some(sha) = url.strip_prefix("/update/files/") {
                    h.fetch_add(1, Ordering::SeqCst);
                    match store.get(sha) {
                        Some(b) => {
                            let _ = req.respond(tiny_http::Response::from_data(b.clone()));
                        }
                        None => {
                            let _ = req.respond(tiny_http::Response::from_string("nf").with_status_code(404));
                        }
                    }
                } else {
                    let _ = req.respond(tiny_http::Response::from_string("nf").with_status_code(404));
                }
            }
        });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    fn store_of(files: &[(&str, &[u8])]) -> HashMap<String, Vec<u8>> {
        files.iter().map(|(_, b)| (sha_hex(b), b.to_vec())).collect()
    }

    const EDITOR: &[u8] = b"export const v = 1;";

    #[test]
    fn manifest_parses_and_rejects_bad_input() {
        let ok = manifest_json("amp-3", 15, &[("editor.js", EDITOR), ("fonts/a.woff2", b"f")]);
        let m = parse_manifest(&ok, "beta").unwrap();
        assert_eq!((m.version.as_str(), m.api_level, m.files.len()), ("amp-3", 15, 2));
        assert!(parse_manifest(&ok, "stable").is_err(), "channel mismatch");
        assert!(parse_manifest("not json", "beta").is_err());
        assert!(parse_manifest(&manifest_json("amp-3", 15, &[("other.js", EDITOR)]), "beta").is_err(), "editor.js required");
        assert!(parse_manifest(&manifest_json("1.2.3", 15, &[("editor.js", EDITOR)]), "beta").is_err(), "version shape");
        assert!(parse_manifest(&manifest_json("amp-1/../x", 15, &[("editor.js", EDITOR)]), "beta").is_err());
        for bad in ["../x", "/abs", "a/../b", "a\\b", "C:x", "a//b", ""] {
            let j = manifest_json("amp-1", 15, &[("editor.js", EDITOR), (bad, b"x")]);
            assert!(parse_manifest(&j, "beta").is_err(), "{bad:?} must be rejected");
        }
        let dup = manifest_json("amp-1", 15, &[("editor.js", EDITOR), ("editor.js", EDITOR)]);
        assert!(parse_manifest(&dup, "beta").is_err());
    }

    #[test]
    fn gate_applies_api_level_version_and_bad_list() {
        let m = parse_manifest(&manifest_json("amp-5", 16, &[("editor.js", EDITOR)]), "beta").unwrap();
        assert_eq!(gate(&m, 15, None, &[]), Some(Outcome::NeedsNewerApp(16)));
        assert_eq!(gate(&m, 16, None, &[]), None);
        assert_eq!(gate(&m, 99, Some("amp-4"), &[]), None);
        assert_eq!(gate(&m, 16, Some("amp-5"), &[]), Some(Outcome::UpToDate));
        assert_eq!(gate(&m, 16, Some("amp-4"), &["amp-5".into()]), Some(Outcome::SkippedBad));
    }

    #[test]
    fn download_verifies_installs_and_switches_atomically() {
        let amp = tmp("install");
        let files: Vec<(&str, &[u8])> = vec![("editor.js", EDITOR), ("amp.json", b"{\"apiLevel\":15}"), ("sub/data.json", b"{}")];
        let (base, hits) = fake_hub(manifest_json("amp-1", 15, &files), store_of(&files));
        assert_eq!(check_and_install(&base, "beta", &amp, 16).unwrap(), Outcome::Installed("amp-1".into()));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        assert_eq!(std::fs::read(amp.join("amp-1/sub/data.json")).unwrap(), b"{}");
        assert_eq!(read_line(&amp.join("current")).as_deref(), Some("amp-1"));
        assert!(read_line(&amp.join("previous")).is_none());
        assert!(!amp.join("amp-1.part").exists());
        assert_eq!(current_usable(&amp, 16).as_deref(), Some("amp-1"));
        // same version again: nothing to do, nothing downloaded
        assert_eq!(check_and_install(&base, "beta", &amp, 16).unwrap(), Outcome::UpToDate);
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        // a gated manifest is not touched
        let (base2, _) = fake_hub(manifest_json("amp-9", 99, &files), store_of(&files));
        assert_eq!(check_and_install(&base2, "beta", &amp, 16).unwrap(), Outcome::NeedsNewerApp(99));
        assert!(!amp.join("amp-9").exists());
        // no manifest published
        let (base3, _) = fake_hub("x".into(), HashMap::new());
        let o = check_and_install(&base3, "stable", &amp, 16).unwrap();
        assert_eq!(o, Outcome::NoManifest);
    }

    #[test]
    fn sha_mismatch_fails_and_leaves_nothing_behind() {
        let amp = tmp("shabad");
        let files: Vec<(&str, &[u8])> = vec![("editor.js", EDITOR), ("b.js", b"real")];
        // the hub hands out different bytes (same length) under b.js's hash
        let mut store = store_of(&files);
        store.insert(sha_hex(b"real"), b"fake".to_vec());
        let (base, _) = fake_hub(manifest_json("amp-2", 15, &files), store);
        let err = check_and_install(&base, "beta", &amp, 16).unwrap_err();
        assert!(err.contains("sha256 mismatch"), "{err}");
        assert!(!amp.join("amp-2").exists() && !amp.join("amp-2.part").exists());
        assert!(read_line(&amp.join("current")).is_none());
        // wrong size too
        let mut store = store_of(&files);
        store.insert(sha_hex(b"real"), b"real!!".to_vec());
        let (base, _) = fake_hub(manifest_json("amp-2", 15, &files), store);
        assert!(check_and_install(&base, "beta", &amp, 16).is_err());
    }

    #[test]
    fn identical_files_of_the_active_version_are_reused_and_old_versions_pruned() {
        let amp = tmp("reuse");
        let a: Vec<(&str, &[u8])> = vec![("editor.js", EDITOR), ("big.png", b"png-bytes")];
        let (base, hits) = fake_hub(manifest_json("amp-1", 15, &a), store_of(&a));
        check_and_install(&base, "beta", &amp, 16).unwrap();
        let b: Vec<(&str, &[u8])> = vec![("editor.js", b"export const v = 2;"), ("big.png", b"png-bytes")];
        let (base, hits2) = fake_hub(manifest_json("amp-2", 15, &b), store_of(&b));
        let before = hits.load(Ordering::SeqCst);
        assert_eq!(check_and_install(&base, "beta", &amp, 16).unwrap(), Outcome::Installed("amp-2".into()));
        assert_eq!(hits2.load(Ordering::SeqCst), 1, "only editor.js is new");
        assert_eq!(hits.load(Ordering::SeqCst), before);
        assert_eq!(read_line(&amp.join("current")).as_deref(), Some("amp-2"));
        assert_eq!(read_line(&amp.join("previous")).as_deref(), Some("amp-1"));
        assert!(amp.join("amp-1").is_dir() && amp.join("amp-2").is_dir());
        // a third version prunes the first
        let c: Vec<(&str, &[u8])> = vec![("editor.js", b"export const v = 3;")];
        let (base, _) = fake_hub(manifest_json("amp-3", 15, &c), store_of(&c));
        check_and_install(&base, "beta", &amp, 16).unwrap();
        assert!(!amp.join("amp-1").exists());
        assert!(amp.join("amp-2").is_dir() && amp.join("amp-3").is_dir());
        assert_eq!(read_line(&amp.join("previous")).as_deref(), Some("amp-2"));
    }

    #[test]
    fn mark_bad_falls_back_to_previous_then_to_builtin() {
        let amp = tmp("bad");
        for (i, v) in ["amp-1", "amp-2"].iter().enumerate() {
            let f: Vec<(&str, &[u8])> = vec![("editor.js", if i == 0 { b"one" } else { b"two" })];
            let (base, _) = fake_hub(manifest_json(v, 15, &f).replace("\"beta\"", "\"beta\""), store_of(&f));
            check_and_install(&base, "beta", &amp, 16).unwrap();
        }
        assert_eq!(current_usable(&amp, 16).as_deref(), Some("amp-2"));
        mark_bad(&amp, "amp-2", 16).unwrap();
        assert_eq!(current_usable(&amp, 16).as_deref(), Some("amp-1"));
        assert!(!amp.join("amp-2").exists());
        assert!(bad_list(&amp).contains(&"amp-2".to_string()));
        mark_bad(&amp, "amp-1", 16).unwrap();
        assert_eq!(current_usable(&amp, 16), None);
        // a bad version is not installed again
        let f: Vec<(&str, &[u8])> = vec![("editor.js", b"two")];
        let (base, _) = fake_hub(manifest_json("amp-2", 15, &f), store_of(&f));
        assert_eq!(check_and_install(&base, "beta", &amp, 16).unwrap(), Outcome::SkippedBad);
        assert_eq!(current_usable(&amp, 16), None);
        // invalid names are ignored, never touching paths
        mark_bad(&amp, "../evil", 16).unwrap();
    }

    #[test]
    fn a_version_above_the_apps_api_level_is_not_used() {
        let amp = tmp("apiuse");
        std::fs::create_dir_all(amp.join("amp-1")).unwrap();
        std::fs::write(amp.join("amp-1/editor.js"), "x").unwrap();
        std::fs::write(amp.join("amp-1/amp.json"), "{\"apiLevel\": 20}").unwrap();
        std::fs::write(amp.join("current"), "amp-1").unwrap();
        assert_eq!(current_usable(&amp, 16), None);
        assert_eq!(current_usable(&amp, 20).as_deref(), Some("amp-1"));
    }

    #[test]
    fn resolve_rejects_traversal_and_unknown_versions() {
        let amp = tmp("resolve");
        std::fs::create_dir_all(amp.join("amp-1/sub")).unwrap();
        std::fs::write(amp.join("amp-1/editor.js"), "x").unwrap();
        std::fs::write(amp.join("amp-1/sub/a.png"), "x").unwrap();
        std::fs::write(amp.join("secret.txt"), "s").unwrap();
        assert!(resolve(&amp, "/amp-1/editor.js").is_some());
        assert!(resolve(&amp, "/amp-1/editor.js?x=1").is_some());
        assert!(resolve(&amp, "/amp-1/sub/a.png").is_some());
        for bad in ["/amp-1/../secret.txt", "/amp-1/sub/../../secret.txt", "/../secret.txt", "/amp-1/..\\secret.txt", "/amp-1/C:/x", "/amp-1/", "/amp-1", "/", "/current", "/bad", "/amp-1.part/editor.js", "/amp-2/editor.js", "/secret.txt", "/amp-1/sub", "/amp-1/missing.js"] {
            assert!(resolve(&amp, bad).is_none(), "{bad} must not resolve");
        }
    }

    #[test]
    fn cors_echoes_only_the_apps_own_origins() {
        for o in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:39285"] {
            assert_eq!(cors_origin(Some(o)).as_deref(), Some(o));
        }
        for o in ["http://evil.example", "http://127.0.0.1:39286", "http://127.0.0.1:39285.evil.com", "null", "", "http://localhost:39285"] {
            assert_eq!(cors_origin(Some(o)), None, "{o}");
        }
        assert_eq!(cors_origin(None), None);
    }

    #[test]
    fn server_answers_get_head_options_with_headers() {
        let amp = tmp("server");
        std::fs::create_dir_all(amp.join("amp-1")).unwrap();
        std::fs::write(amp.join("amp-1/editor.js"), "export {}").unwrap();
        std::fs::write(amp.join("amp-1/tiles.png"), [1u8, 2, 3]).unwrap();
        let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let a = amp.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let hv = |n: &str| header_value(&request, n);
                let r = respond(&a, request.method(), request.url(), hv("Origin").as_deref(), hv("Access-Control-Request-Headers").as_deref());
                let _ = request.respond(r);
            }
        });
        let fetch = |method: &str, path: &str, origin: &str| -> (String, Vec<u8>) {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {origin}\r\nAccess-Control-Request-Headers: x-test\r\nConnection: close\r\n\r\n").unwrap();
            let mut raw = Vec::new();
            s.read_to_end(&mut raw).unwrap();
            let at = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&raw[..at]).to_ascii_lowercase(), raw[at + 4..].to_vec())
        };
        let (head, body) = fetch("GET", "/amp-1/editor.js", "http://tauri.localhost");
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("content-type: text/javascript"), "{head}");
        assert!(head.contains("cache-control: no-store"), "{head}");
        assert!(head.contains("access-control-allow-origin: http://tauri.localhost"), "{head}");
        assert_eq!(body, b"export {}");
        let (head, _) = fetch("GET", "/amp-1/tiles.png", "tauri://localhost");
        assert!(head.contains("content-type: image/png") && head.contains("access-control-allow-origin: tauri://localhost"), "{head}");
        let (head, _) = fetch("GET", "/amp-1/editor.js", "http://evil.example");
        assert!(head.starts_with("http/1.1 200") && !head.contains("access-control-allow-origin"), "{head}");
        let (head, _) = fetch("GET", "/amp-1/%2e%2e/x", "tauri://localhost");
        assert!(head.starts_with("http/1.1 404"), "{head}");
        let (head, _) = fetch("GET", "/amp-1/../x", "tauri://localhost");
        assert!(head.starts_with("http/1.1 404"), "{head}");
        let (head, body) = fetch("OPTIONS", "/amp-1/editor.js", "http://127.0.0.1:39285");
        assert!(head.starts_with("http/1.1 204"), "{head}");
        assert!(head.contains("access-control-allow-origin: http://127.0.0.1:39285") && head.contains("access-control-allow-methods") && head.contains("access-control-allow-headers: x-test"), "{head}");
        assert!(body.is_empty());
        let (head, _) = fetch("POST", "/amp-1/editor.js", "tauri://localhost");
        assert!(head.starts_with("http/1.1 405"), "{head}");
    }
}
