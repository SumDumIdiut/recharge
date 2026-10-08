//! Olympus-style staged update: diff manifest -> build a complete app.new/ (hard links for
//! unchanged files, hash-verified downloads for the rest) -> swap app.new -> app (old kept in
//! app.old for rollback). The running tree is never modified in place.
use crate::log;
use crate::manifest::{self, FileEntry, Manifest, Plan, Platform};
use crate::run;
use crate::state::{Snapshot, State};
use crate::ui::Progress;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://codecade.co.za/recharge";
const DOWNLOAD_WORKERS: usize = 4;

pub struct Ctx {
    pub root: PathBuf,
    pub base: String,
    pub platform: &'static str,
    pub channel: String,
    pub repair: bool,
    pub progress: Progress,
}

impl Ctx {
    pub fn app(&self) -> PathBuf { self.root.join("app") }
    fn app_new(&self) -> PathBuf { self.root.join("app.new") }
    fn app_old(&self) -> PathBuf { self.root.join("app.old") }
    /// Marker + snapshot of a fully staged, verified app.new/ (absent while still downloading).
    fn staged_marker(&self) -> PathBuf { self.root.join("app.new.json") }
}

pub fn platform_id() -> &'static str {
    if cfg!(windows) { "windows-x64" } else { "linux-x64" }
}

fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(secs)))
        .build()
        .into()
}

fn get_text(url: &str, secs: u64) -> Result<String, String> {
    let mut r = agent(secs).get(url).call().map_err(|e| format!("GET {url}: {e}"))?;
    r.body_mut().with_config().limit(64 << 20).read_to_string().map_err(|e| format!("GET {url}: {e}"))
}

pub fn fetch_manifest(ctx: &Ctx) -> Result<Manifest, String> {
    let url = format!("{}/update/{}/manifest.json", ctx.base, ctx.channel);
    let m: Manifest = serde_json::from_str(&get_text(&url, 5)?).map_err(|e| format!("bad manifest: {e}"))?;
    if m.format != 1 {
        return Err(format!("unsupported manifest format {}", m.format));
    }
    Ok(m)
}

pub fn platform<'a>(ctx: &Ctx, m: &'a Manifest) -> Result<&'a Platform, String> {
    m.platforms.get(ctx.platform).ok_or_else(|| format!("manifest has no platform {}", ctx.platform))
}

/// Diff the manifest against the installed tree.
pub fn make_plan(ctx: &Ctx, st: &State, p: &Platform) -> Plan {
    let empty = Snapshot::default();
    let cur = st.current.as_ref().unwrap_or(&empty);
    manifest::plan(&p.files, &cur.files, &cur.cache, &ctx.app(), ctx.repair)
}

/// Bring the install up to date. Ok even when offline (then it is a no-op).
/// Returns true when the manifest was reachable.
pub fn prepare(ctx: &Ctx, st: &mut State) -> Result<bool, String> {
    finish_staged(ctx, st)?;
    let m = match fetch_manifest(ctx) {
        Ok(m) => m,
        Err(e) => {
            log!("manifest unavailable, launching installed version: {e}");
            return Ok(false);
        }
    };
    let plat = platform(ctx, &m)?;
    if st.bad_builds.contains(&m.build) {
        log!("build {} previously failed its health check, skipping", m.build);
        return Ok(true);
    }
    let plan = make_plan(ctx, st, plat);
    if plan.is_noop() {
        // Same files under a new version/build number: just record it.
        if let Some(cur) = st.current.as_mut() {
            if cur.build != m.build || cur.version != m.version {
                cur.build = m.build;
                cur.version = m.version.clone();
                let _ = st.save(&ctx.root);
            }
        }
        return Ok(true);
    }
    if let Some(s) = read_staged(ctx) {
        if s.build == m.build {
            log!("build {} already staged, waiting for the app to close", m.build);
            return Ok(true);
        }
    }
    log!(
        "updating to {} (build {}): {} file(s) to fetch ({} bytes), {} to remove, {} unchanged",
        m.version, m.build, plan.fetch.len(), plan.fetch_bytes(), plan.extra.len(), plan.keep.len()
    );
    ctx.progress.begin(plan.fetch_bytes(), "Updating Recharge...");
    let res = stage(ctx, &m, plat, &plan);
    ctx.progress.finish();
    let snap = res?;
    // Windows cannot replace files of a running exe, so only swap when the app is closed.
    if run::app_running(&ctx.root) {
        log!("app is running; staged build {} will be swapped in on the next start", snap.build);
    } else {
        swap_in(ctx, st, snap)?;
    }
    Ok(true)
}

/// --stage: like `prepare` but never swaps (and never touches a staged tree it does not replace).
/// Some(build) = a complete app.new/ for that build is waiting; None = nothing newer.
pub fn stage_only(ctx: &Ctx, st: &mut State) -> Result<Option<u64>, String> {
    let m = fetch_manifest(ctx)?;
    let plat = platform(ctx, &m)?;
    if st.bad_builds.contains(&m.build) {
        return Ok(None);
    }
    let plan = make_plan(ctx, st, plat);
    if plan.is_noop() {
        discard_staged(ctx); // e.g. left over from the other channel: must not be swapped in later
        return Ok(None);
    }
    if read_staged(ctx).is_some_and(|s| s.build == m.build) {
        return Ok(Some(m.build));
    }
    log!("staging {} (build {}): {} file(s) to fetch ({} bytes)", m.version, m.build, plan.fetch.len(), plan.fetch_bytes());
    ctx.progress.begin(plan.fetch_bytes(), "Updating Recharge...");
    let res = stage(ctx, &m, plat, &plan);
    ctx.progress.finish();
    Ok(Some(res?.build))
}

/// Build app.new/ completely, then write the staged marker. Failure leaves `app/` untouched.
fn stage(ctx: &Ctx, m: &Manifest, plat: &Platform, plan: &Plan) -> Result<Snapshot, String> {
    let new = ctx.app_new();
    let _ = fs::remove_file(ctx.staged_marker());
    rm_rf(&new);
    fs::create_dir_all(&new).map_err(|e| format!("create app.new: {e}"))?;
    for f in plat.files.iter().map(|f| &f.path) {
        manifest::safe_rel(f).ok_or_else(|| format!("unsafe path in manifest: {f}"))?;
    }
    for f in &plan.keep {
        let rel = manifest::safe_rel(&f.path).unwrap();
        let (from, to) = (ctx.app().join(&rel), new.join(&rel));
        mkparent(&to)?;
        // Hard link keeps mtime (so the stat cache stays valid) and costs no disk; copy as fallback.
        if fs::hard_link(&from, &to).is_err() {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", f.path))?;
        }
    }
    download_all(ctx, &plan.fetch, &new)?;
    let mut snap = Snapshot { version: m.version.clone(), build: m.build, channel: ctx.channel.clone(), launch: plat.launch.clone(), ..Default::default() };
    for f in &plat.files {
        let local = new.join(manifest::safe_rel(&f.path).unwrap());
        if f.exec {
            set_exec(&local);
        }
        snap.files.insert(f.path.clone(), f.sha256.clone());
        if let Some(st) = manifest::stat_of(&local) {
            snap.cache.insert(f.path.clone(), st);
        }
    }
    let launch = new.join(manifest::safe_rel(&plat.launch).ok_or("unsafe launch path")?);
    if !launch.is_file() {
        return Err(format!("launch file {} missing from manifest files", plat.launch));
    }
    set_exec(&launch);
    fs::write(ctx.staged_marker(), serde_json::to_vec(&snap).unwrap()).map_err(|e| format!("write marker: {e}"))?;
    Ok(snap)
}

fn download_all(ctx: &Ctx, files: &[FileEntry], dest: &Path) -> Result<(), String> {
    let next = AtomicUsize::new(0);
    let err: Mutex<Option<String>> = Mutex::new(None);
    let agent = agent(600);
    std::thread::scope(|s| {
        for _ in 0..DOWNLOAD_WORKERS.min(files.len()) {
            s.spawn(|| loop {
                if err.lock().unwrap().is_some() {
                    return; // another worker failed: stop early, whole update aborts anyway
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(f) = files.get(i) else { return };
                if let Err(e) = download_one(ctx, &agent, f, dest) {
                    err.lock().unwrap().get_or_insert(e);
                }
            });
        }
    });
    match err.into_inner().unwrap() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Fetch one content-addressed file, verify size + sha256, retry once.
fn download_one(ctx: &Ctx, agent: &ureq::Agent, f: &FileEntry, dest: &Path) -> Result<(), String> {
    let rel = manifest::safe_rel(&f.path).ok_or_else(|| format!("unsafe path in manifest: {}", f.path))?;
    if !manifest::is_hex_sha(&f.sha256) {
        return Err(format!("bad sha256 for {}", f.path));
    }
    let target = dest.join(rel);
    mkparent(&target)?;
    let url = format!("{}/update/files/{}", ctx.base, f.sha256);
    let mut last = String::new();
    for attempt in 1..=2 {
        match fetch_to(agent, &url, &target, f, &ctx.progress) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log!("download {} failed (attempt {attempt}): {e}", f.path);
                last = e;
            }
        }
    }
    Err(format!("{}: {last}", f.path))
}

fn fetch_to(agent: &ureq::Agent, url: &str, target: &Path, f: &FileEntry, progress: &Progress) -> Result<(), String> {
    // Appended, not with_extension(): foo.dll and foo.xml must not share one part file (parallel workers).
    let part = {
        let mut n = target.as_os_str().to_owned();
        n.push(".rl-part");
        PathBuf::from(n)
    };
    let r = (|| -> Result<(), String> {
        let mut resp = agent.get(url).call().map_err(|e| e.to_string())?;
        let mut rd = resp.body_mut().as_reader();
        let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
        let (mut h, mut n) = (Sha256::new(), 0u64);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let k = rd.read(&mut buf).map_err(|e| e.to_string())?;
            if k == 0 {
                break;
            }
            n += k as u64;
            if n > f.size {
                return Err("larger than manifest size".into());
            }
            h.update(&buf[..k]);
            out.write_all(&buf[..k]).map_err(|e| e.to_string())?;
            progress.add(k as u64);
        }
        if n != f.size {
            return Err(format!("size {n} != {}", f.size));
        }
        let got = manifest::hex(&h.finalize());
        if !got.eq_ignore_ascii_case(&f.sha256) {
            return Err(format!("sha256 mismatch ({got})"));
        }
        Ok(())
    })();
    match r {
        Ok(()) => fs::rename(&part, target).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

fn read_staged(ctx: &Ctx) -> Option<Snapshot> {
    if !ctx.app_new().is_dir() {
        return None;
    }
    serde_json::from_slice(&fs::read(ctx.staged_marker()).ok()?).ok()
}

/// A previous run may have left a complete app.new/ (app was running). Swap it in if possible,
/// discard it if it is partial or known bad.
fn finish_staged(ctx: &Ctx, st: &mut State) -> Result<(), String> {
    if !ctx.app_new().exists() {
        let _ = fs::remove_file(ctx.staged_marker());
        return Ok(());
    }
    match read_staged(ctx) {
        Some(s) if st.bad_builds.contains(&s.build) => discard_staged(ctx),
        Some(s) if !run::app_running(&ctx.root) => {
            log!("swapping in previously staged build {}", s.build);
            swap_in(ctx, st, s)?;
        }
        Some(_) => {}
        None => discard_staged(ctx),
    }
    Ok(())
}

fn discard_staged(ctx: &Ctx) {
    rm_rf(&ctx.app_new());
    let _ = fs::remove_file(ctx.staged_marker());
}

/// app -> app.old, app.new -> app. On failure the previous app is put back.
pub fn swap_in(ctx: &Ctx, st: &mut State, snap: Snapshot) -> Result<(), String> {
    let (app, new, old) = (ctx.app(), ctx.app_new(), ctx.app_old());
    rm_rf(&old);
    let had_app = app.exists();
    if had_app {
        rename_retry(&app, &old).map_err(|e| format!("app -> app.old: {e}"))?;
    }
    if let Err(e) = rename_retry(&new, &app) {
        if had_app {
            let _ = rename_retry(&old, &app);
        }
        return Err(format!("app.new -> app: {e}"));
    }
    let _ = fs::remove_file(ctx.staged_marker());
    log!("swapped in build {} ({})", snap.build, snap.version);
    st.pending = Some(snap.build);
    st.prev = st.current.replace(snap);
    st.save(&ctx.root).map_err(|e| format!("save state: {e}"))
}

/// Put app.old back after a failed first launch; remember the bad build.
pub fn rollback(ctx: &Ctx, st: &mut State) -> Result<(), String> {
    let (app, old) = (ctx.app(), ctx.app_old());
    if st.prev.is_none() || !old.is_dir() {
        return Err("no previous version to roll back to".into());
    }
    let bad = ctx.root.join("app.bad");
    rm_rf(&bad);
    rename_retry(&app, &bad).map_err(|e| format!("app -> app.bad: {e}"))?;
    if let Err(e) = rename_retry(&old, &app) {
        let _ = rename_retry(&bad, &app);
        return Err(format!("app.old -> app: {e}"));
    }
    if let Some(b) = st.current.take() {
        log!("rolled back build {} ({})", b.build, b.version);
        st.bad_builds.push(b.build);
    }
    st.current = st.prev.take();
    st.pending = None;
    st.save(&ctx.root).map_err(|e| format!("save state: {e}"))?;
    rm_rf(&bad);
    Ok(())
}

// ---- launcher self-update (rare) ----

/// Replace our own exe if the hub publishes a different one. Returns true if replaced.
pub fn update_launcher(ctx: &Ctx, exe: &Path) -> Result<bool, String> {
    #[derive(serde::Deserialize)]
    struct Info { sha256: String, size: u64 }
    let url = format!("{}/update/launcher/{}", ctx.base, ctx.platform);
    let info: Info = match get_text(&url, 5) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("bad launcher info: {e}"))?,
        Err(_) => return Ok(false), // not published / unreachable: nothing to do
    };
    if !manifest::is_hex_sha(&info.sha256) {
        return Err("bad launcher sha256".into());
    }
    let mine = manifest::sha256_file(exe).map_err(|e| e.to_string())?;
    if mine.eq_ignore_ascii_case(&info.sha256) {
        return Ok(false);
    }
    log!("launcher update available ({} -> {})", &mine[..8], &info.sha256[..8]);
    let new = exe.with_extension("new");
    let entry = FileEntry { path: "launcher".into(), size: info.size, sha256: info.sha256.clone(), component: String::new(), exec: true };
    fetch_to(&agent(120), &format!("{}/update/files/{}", ctx.base, info.sha256), &new, &entry, &ctx.progress)?;
    // A running exe can be renamed (not overwritten) on Windows; do the same on Linux for symmetry.
    let old = exe.with_extension("old");
    let _ = fs::remove_file(&old);
    rename_retry(exe, &old).map_err(|e| e.to_string())?;
    if let Err(e) = rename_retry(&new, exe) {
        let _ = rename_retry(&old, exe);
        return Err(e.to_string());
    }
    set_exec(exe);
    Ok(true)
}

// ---- small fs helpers ----

fn mkparent(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| format!("mkdir: {e}"))
}

pub fn rm_rf(p: &Path) {
    if p.is_dir() {
        let _ = fs::remove_dir_all(p);
    } else {
        let _ = fs::remove_file(p);
    }
}

/// Windows AV/indexers briefly lock freshly written files; retry renames a few times.
fn rename_retry(a: &Path, b: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..5 {
        match fs::rename(a, b) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(last.unwrap())
}

#[cfg(unix)]
pub fn set_exec(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(p) {
        let mut perm = m.permissions();
        perm.set_mode(perm.mode() | 0o755);
        let _ = fs::set_permissions(p, perm);
    }
}
#[cfg(not(unix))]
pub fn set_exec(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(root: &Path) -> Ctx {
        Ctx { root: root.into(), base: String::new(), platform: "linux-x64", channel: "stable".into(), repair: false, progress: Progress::new(false) }
    }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rl-upd-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn snap(build: u64) -> Snapshot {
        Snapshot { version: format!("v{build}"), build, launch: "x".into(), ..Default::default() }
    }

    #[test]
    fn swap_then_rollback_restores_old_and_marks_bad() {
        let root = tmp("swap");
        let c = ctx(&root);
        let mut st = State::default();
        fs::create_dir_all(c.app()).unwrap();
        fs::write(c.app().join("v"), "1").unwrap();
        st.current = Some(snap(1));
        fs::create_dir_all(c.app_new()).unwrap();
        fs::write(c.app_new().join("v"), "2").unwrap();
        swap_in(&c, &mut st, snap(2)).unwrap();
        assert_eq!(fs::read_to_string(c.app().join("v")).unwrap(), "2");
        assert_eq!(fs::read_to_string(c.app_old().join("v")).unwrap(), "1");
        assert_eq!(st.pending, Some(2));
        rollback(&c, &mut st).unwrap();
        assert_eq!(fs::read_to_string(c.app().join("v")).unwrap(), "1");
        assert_eq!(st.current.as_ref().unwrap().build, 1);
        assert_eq!(st.bad_builds, [2]);
        assert!(st.pending.is_none());
        assert!(State::load(&root).bad_builds == [2]);
    }

    #[test]
    fn staged_marker_matches_only_complete_tree() {
        let root = tmp("staged");
        let c = ctx(&root);
        assert!(read_staged(&c).is_none());
        fs::create_dir_all(c.app_new()).unwrap();
        assert!(read_staged(&c).is_none(), "dir without marker is partial");
        fs::write(c.staged_marker(), serde_json::to_vec(&snap(4)).unwrap()).unwrap();
        assert_eq!(read_staged(&c).unwrap().build, 4);
    }

    #[test]
    fn stage_only_offline_errors_and_leaves_app_alone() {
        let root = tmp("stageoff");
        let mut c = ctx(&root);
        c.base = "http://127.0.0.1:1".into();
        fs::create_dir_all(c.app()).unwrap();
        let mut st = State { current: Some(snap(1)), ..Default::default() };
        assert!(stage_only(&c, &mut st).is_err());
        assert!(c.app().is_dir() && !c.app_new().exists());
    }

    #[test]
    fn rollback_without_previous_fails_and_changes_nothing() {
        let root = tmp("norb");
        let c = ctx(&root);
        let mut st = State { current: Some(snap(5)), ..Default::default() };
        fs::create_dir_all(c.app()).unwrap();
        assert!(rollback(&c, &mut st).is_err());
        assert_eq!(st.current.as_ref().unwrap().build, 5);
        assert!(c.app().is_dir());
    }

    #[test]
    fn first_install_swap_has_no_prev() {
        let root = tmp("first");
        let c = ctx(&root);
        let mut st = State::default();
        fs::create_dir_all(c.app_new()).unwrap();
        swap_in(&c, &mut st, snap(1)).unwrap();
        assert!(c.app().is_dir() && st.prev.is_none());
    }
}
