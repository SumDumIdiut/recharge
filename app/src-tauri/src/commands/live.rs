//! Live code: app/src and loader/ are pulled from the repo and served locally, gated by app/live.json's API level.

use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const LIVE_PORT: u16 = 39285;
/// Bump with app/live.json's "apiLevel" when a change adds or alters a Rust command, so older binaries stop applying bundles that need it.
const API_LEVEL: u64 = 12;
const REPO: &str = "SumDumIdiut/recharge";
const MAX_BUNDLE_BYTES: u64 = 200 * 1024 * 1024;
const CHECK_EVERY: Duration = Duration::from_secs(20 * 60);
/// Redirects without a confirmed successful load before we give up on live mode.
const MAX_UNCONFIRMED_TRIES: u32 = 3;

#[derive(Default)]
pub struct LiveState {
    server_started: AtomicBool,
    stash: Mutex<Option<String>>,
    /// Set when the newest code on the chosen channel needs a newer package.
    needs_package: AtomicBool,
    /// One update at a time: the timer and a channel switch share the work folder.
    busy: Mutex<()>,
}

pub enum Outcome {
    Applied,
    UpToDate,
    NeedsPackage,
}

fn branch_for(channel: &str) -> &'static str {
    if channel == "beta" { "dev" } else { "master" }
}

#[derive(Serialize)]
pub struct LiveInfo {
    active: bool,
    url: String,
    sha: Option<String>,
    #[serde(rename = "apiLevel")]
    api_level: u64,
}

fn live_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("live"))
}

/// Launcher-managed installs carry src/, loader/ and live.json next to the binary (the launcher keeps it current), so the GitHub live updater stays out; None otherwise.
fn packaged_dir() -> Option<PathBuf> {
    let dir = super::updater::packaged_root()?;
    dir.join("src").join("index.html").is_file().then_some(dir)
}

fn current_dir(app: &AppHandle) -> Option<PathBuf> {
    packaged_dir().or_else(|| live_root(app).map(|r| r.join("current")))
}

fn log(app: &AppHandle, msg: &str) {
    eprintln!("[live] {msg}");
    let Some(root) = live_root(app) else { return };
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

fn required_api_level(dir: &Path) -> u64 {
    std::fs::read_to_string(dir.join("live.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("apiLevel").and_then(|l| l.as_u64()))
        .unwrap_or(1)
}

fn bundle_usable(app: &AppHandle) -> bool {
    if std::env::var_os("RECHARGE_NO_LIVE").is_some() {
        return false;
    }
    let Some(dir) = current_dir(app) else { return false };
    dir.join("src").join("index.html").is_file() && required_api_level(&dir) <= API_LEVEL
}

/// The live copy of build-loader.ps1 (with the packaged decompiler tools beside it), if a live bundle is active.
pub fn loader_script(app: &AppHandle) -> Option<PathBuf> {
    if !bundle_usable(app) {
        return None;
    }
    let script = current_dir(app)?.join("loader").join("build-loader.ps1");
    script.is_file().then_some(script)
}

fn read_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn init(app: &AppHandle) {
    app.manage(LiveState::default());
    if std::env::var_os("RECHARGE_NO_LIVE").is_some() {
        return;
    }
    if bundle_usable(app) {
        start_server(app);
    }
    if packaged_dir().is_some() {
        log(app, "launcher-managed install: screens come from the install folder, GitHub live updates are off");
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Reload automatically just this once (the dismissible banner alone left a stale first load unnoticed).
        let mut first = true;
        loop {
            match check_and_apply(&app) {
                Ok(Outcome::Applied) if first => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("location.reload()");
                    }
                }
                Err(e) => log(&app, &format!("update check failed: {e}")),
                _ => {}
            }
            first = false;
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn start_server(app: &AppHandle) {
    let state = app.state::<LiveState>();
    if state.server_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", LIVE_PORT)) {
            Ok(s) => s,
            Err(e) => {
                log(&app, &format!("live server failed to start: {e}"));
                app.state::<LiveState>().server_started.store(false, Ordering::SeqCst);
                return;
            }
        };
        for request in server.incoming_requests() {
            let response = serve(&app, request.url());
            let _ = request.respond(response);
        }
    });
}

fn serve(app: &AppHandle, url: &str) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let not_found = || tiny_http::Response::from_string("not found").with_status_code(404);
    let Some(src) = current_dir(app).map(|d| d.join("src")) else { return not_found() };

    let path_part = url.split(['?', '#']).next().unwrap_or("/");
    let mut file = src.clone();
    for seg in path_part.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." || seg.contains('\\') || seg.contains(':') {
            return not_found();
        }
        file.push(seg);
    }
    if file == src || file.is_dir() {
        file.push("index.html");
    }
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mut r = tiny_http::Response::from_data(bytes);
            r.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type(&file).as_bytes()).unwrap());
            r.add_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
            r
        }
        Err(_) => not_found(),
    }
}

#[tauri::command]
pub fn live_status(app: AppHandle, redirect: Option<bool>) -> LiveInfo {
    let sha = current_dir(&app).and_then(|d| read_file(&d.join("sha")));
    let mut active = bundle_usable(&app) && app.state::<LiveState>().server_started.load(Ordering::SeqCst);

    // If the live page never reports in (e.g. blocked IPC), stop redirecting to it instead of stranding the user.
    if active && redirect.unwrap_or(false) {
        if let Some(root) = live_root(&app) {
            if !root.join("acked").exists() {
                let tries = read_file(&root.join("tries")).and_then(|t| t.parse::<u32>().ok()).unwrap_or(0) + 1;
                let _ = std::fs::write(root.join("tries"), tries.to_string());
                if tries > MAX_UNCONFIRMED_TRIES {
                    log(&app, "live page never confirmed - staying on the built-in screens");
                    active = false;
                }
            }
        }
    }
    LiveInfo { active, url: format!("http://127.0.0.1:{LIVE_PORT}/"), sha, api_level: API_LEVEL }
}

/// Called by the live page once it has loaded and can reach Rust.
#[tauri::command]
pub fn live_ack(app: AppHandle) {
    if let Some(root) = live_root(&app) {
        let _ = std::fs::write(root.join("acked"), "1");
        let _ = std::fs::remove_file(root.join("tries"));
    }
    log(&app, "live page confirmed");
}

/// Settings/session travel between the built-in origin and the live one (storage is per origin) through this one-shot stash.
#[tauri::command]
pub fn live_stash(state: State<LiveState>, json: String) {
    *state.stash.lock().unwrap() = Some(json);
}

#[tauri::command]
pub fn live_take_stash(state: State<LiveState>) -> Option<String> {
    state.stash.lock().unwrap().take()
}

// ---- updating ----

// git's own protocol (like `git ls-remote`) isn't rate-limited like api.github.com, which stays as a fallback.
fn remote_sha(app: &AppHandle, branch: &str) -> Result<String, String> {
    match remote_sha_via_git(branch) {
        Ok(sha) => Ok(sha),
        Err(_) => remote_sha_via_api(app, branch),
    }
}

fn remote_sha_via_git(branch: &str) -> Result<String, String> {
    let body = ureq::get(&format!("https://github.com/{REPO}.git/info/refs?service=git-upload-pack"))
        .header("User-Agent", "git/2.40.0")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let marker = format!(" refs/heads/{branch}\n");
    let pos = body.find(&marker).ok_or_else(|| format!("branch '{branch}' not found in ref advertisement"))?;
    let sha = body.get(pos.saturating_sub(40)..pos).unwrap_or("");
    if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(sha.to_string())
    } else {
        Err("malformed git ref advertisement".to_string())
    }
}

fn remote_sha_via_api(app: &AppHandle, branch: &str) -> Result<String, String> {
    let cache_dir = live_root(app);
    let etag_path = cache_dir.as_ref().map(|d| d.join(format!("etag-{branch}")));
    let sha_path = cache_dir.as_ref().map(|d| d.join(format!("sha-cache-{branch}")));
    let cached_etag = etag_path.as_ref().and_then(|p| read_file(p));
    let cached_sha = sha_path.as_ref().and_then(|p| read_file(p));

    let mut request = ureq::get(&format!("https://api.github.com/repos/{REPO}/commits/{branch}"))
        .header("User-Agent", "Recharge")
        .header("Accept", "application/vnd.github.sha");
    if let Some(etag) = &cached_etag {
        request = request.header("If-None-Match", etag);
    }

    let response = match request.call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(304)) => {
            return cached_sha.ok_or_else(|| "GitHub said 304 Not Modified but nothing was cached".to_string());
        }
        Err(ureq::Error::StatusCode(403)) => {
            return Err("GitHub's rate limit is exhausted for your network right now - try again in a few minutes".to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    if response.status() == 304 {
        return cached_sha.ok_or_else(|| "GitHub said 304 Not Modified but nothing was cached".to_string());
    }

    let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let mut response = response;
    let body = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let sha = body.trim().to_string();
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("unexpected response: {sha}"));
    }

    if let (Some(path), Some(etag)) = (&etag_path, &etag) {
        let _ = std::fs::write(path, etag);
    }
    if let Some(path) = &sha_path {
        let _ = std::fs::write(path, &sha);
    }
    Ok(sha)
}

/// Build output and machine-local folders of a local checkout; never part of a bundle.
const SKIP_DIRS: [&str; 6] = [".dotnet-sdk", ".git", "bin", "obj", "node_modules", "tools"];

// Windows can briefly deny renaming a directory just written (antivirus); retry.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last_err = None;
    for attempt in 0..20 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150));
        }
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap())
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.path().is_dir() {
            if SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()) {
                continue;
            }
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn extract_bundle(bytes: Vec<u8>, next: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else { continue };
        // Drop the "<repo>-<sha>/" wrapper GitHub puts around everything.
        let rel: PathBuf = name.components().skip(1).collect();
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        let dest = if let Some(rest) = rel_str.strip_prefix("app/src/") {
            next.join("src").join(rest)
        } else if let Some(rest) = rel_str.strip_prefix("loader/") {
            next.join("loader").join(rest)
        } else if rel_str == "app/live.json" {
            next.join("live.json")
        } else {
            continue;
        };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        std::fs::write(&dest, data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bundle source: a local checkout (RECHARGE_LIVE_LOCAL) or the newest master commit on GitHub.
fn fetch_bundle(app: &AppHandle, next: &Path) -> Result<Option<String>, String> {
    if let Some(local) = std::env::var_os("RECHARGE_LIVE_LOCAL").map(PathBuf::from) {
        let current_sha = current_dir(app).and_then(|d| read_file(&d.join("sha")));
        if current_sha.as_deref() == Some("local") && std::env::var_os("RECHARGE_LIVE_FORCE").is_none() {
            return Ok(None);
        }
        copy_dir(&local.join("app").join("src"), &next.join("src")).map_err(|e| e.to_string())?;
        copy_dir(&local.join("loader"), &next.join("loader")).map_err(|e| e.to_string())?;
        let _ = std::fs::copy(local.join("app").join("live.json"), next.join("live.json"));
        return Ok(Some("local".to_string()));
    }

    let sha = remote_sha(app, branch_for(&super::settings::update_channel(app)))?;
    if current_dir(app).and_then(|d| read_file(&d.join("sha"))).as_deref() == Some(sha.as_str()) {
        return Ok(None);
    }
    log(app, &format!("downloading code {}", &sha[..7]));
    let bytes = ureq::get(&format!("https://github.com/{REPO}/archive/{sha}.zip"))
        .header("User-Agent", "Recharge")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(MAX_BUNDLE_BYTES)
        .read_to_vec()
        .map_err(|e| e.to_string())?;
    extract_bundle(bytes, next)?;
    Ok(Some(sha))
}

fn check_and_apply(app: &AppHandle) -> Result<Outcome, String> {
    if packaged_dir().is_some() {
        return Ok(Outcome::UpToDate); // the launcher delivers screens
    }
    let state = app.state::<LiveState>();
    let _one_at_a_time = state.busy.lock().unwrap();
    let root = live_root(app).ok_or("no data folder")?;
    let next = root.join("next");
    let _ = std::fs::remove_dir_all(&next);
    std::fs::create_dir_all(&next).map_err(|e| e.to_string())?;

    let sha = match fetch_bundle(app, &next)? {
        Some(sha) => sha,
        None => {
            let _ = std::fs::remove_dir_all(&next);
            app.state::<LiveState>().needs_package.store(false, Ordering::SeqCst);
            return Ok(Outcome::UpToDate);
        }
    };

    if !next.join("src").join("index.html").is_file() {
        let _ = std::fs::remove_dir_all(&next);
        return Err("the downloaded code had no app/src/index.html".to_string());
    }
    let needed = required_api_level(&next);
    if needed > API_LEVEL {
        let _ = std::fs::remove_dir_all(&next);
        log(app, &format!("new code needs API level {needed} (this app is {API_LEVEL}) - a package update is required"));
        app.state::<LiveState>().needs_package.store(true, Ordering::SeqCst);
        return Ok(Outcome::NeedsPackage);
    }

    // The loader script looks for its decompiler next to itself, which isn't in the repo: reuse the packaged copy.
    if let Ok(packaged) = super::updater::resource_path(app, "loader/tools") {
        let packaged = PathBuf::from(packaged.to_string_lossy().trim_start_matches(r"\\?\"));
        if packaged.is_dir() {
            copy_dir(&packaged, &next.join("loader").join("tools")).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(next.join("sha"), &sha).map_err(|e| e.to_string())?;

    let cur = root.join("current");
    let old = root.join("old");
    let _ = std::fs::remove_dir_all(&old);
    if cur.exists() {
        rename_with_retry(&cur, &old).map_err(|e| e.to_string())?;
    }
    rename_with_retry(&next, &cur).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&old);

    // A fresh bundle gets a fresh chance to prove it can load.
    let _ = std::fs::remove_file(root.join("acked"));
    let _ = std::fs::remove_file(root.join("tries"));
    log(app, &format!("applied code {}", &sha[..sha.len().min(7)]));

    app.state::<LiveState>().needs_package.store(false, Ordering::SeqCst);
    start_server(app);
    let _ = app.emit("live-updated", sha);
    Ok(Outcome::Applied)
}

#[derive(Serialize)]
pub struct ChannelInfo {
    channel: String,
    sha: Option<String>,
    #[serde(rename = "needsPackage")]
    needs_package: bool,
}

#[tauri::command]
pub fn live_get_channel(app: AppHandle) -> ChannelInfo {
    ChannelInfo {
        channel: super::settings::update_channel(&app),
        sha: current_dir(&app).and_then(|d| read_file(&d.join("sha"))),
        needs_package: app.state::<LiveState>().needs_package.load(Ordering::SeqCst),
    }
}

/// Switches between "stable" (master) and "beta" (dev) and fetches that channel's code right away.
#[tauri::command]
pub async fn live_set_channel(app: AppHandle, channel: String) -> Result<String, String> {
    if channel != "stable" && channel != "beta" {
        return Err(format!("unknown channel: {channel}"));
    }
    super::settings::save_update_channel(&app, &channel);
    let worker = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || check_and_apply(&worker))
        .await
        .map_err(|e| e.to_string())??;
    Ok(match outcome {
        Outcome::Applied => "applied",
        Outcome::UpToDate => "upToDate",
        Outcome::NeedsPackage => "needsPackage",
    }
    .to_string())
}
