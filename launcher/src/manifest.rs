//! Manifest contract (format 1), per-file hashing and the diff against what is installed.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub format: u32,
    #[serde(default)]
    pub channel: String,
    pub version: String,
    pub build: u64,
    #[serde(rename = "apiLevel", default)]
    pub api_level: u32,
    #[serde(default)]
    pub published: String,
    pub platforms: BTreeMap<String, Platform>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Platform {
    pub launch: String,
    pub files: Vec<FileEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub component: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exec: bool,
}

/// size + mtime (ns) recorded right after install; lets a normal start skip hashing.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub size: u64,
    pub mtime: u64,
}

pub fn stat_of(p: &Path) -> Option<Stat> {
    let m = fs::metadata(p).ok()?;
    if !m.is_file() {
        return None;
    }
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos() as u64;
    Some(Stat { size: m.len(), mtime })
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Manifest paths come from the network: refuse anything that could escape the app dir.
pub fn safe_rel(p: &str) -> Option<PathBuf> {
    if p.is_empty() || p.contains('\\') || p.contains(':') {
        return None;
    }
    let pb = PathBuf::from(p);
    pb.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then_some(pb)
}

pub fn is_hex_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What to do to get from the installed tree to the manifest.
#[derive(Debug, Default)]
pub struct Plan {
    pub keep: Vec<FileEntry>,
    pub fetch: Vec<FileEntry>,
    /// Files on disk that the manifest no longer lists.
    pub extra: Vec<String>,
}

impl Plan {
    pub fn is_noop(&self) -> bool {
        self.fetch.is_empty() && self.extra.is_empty()
    }
    pub fn fetch_bytes(&self) -> u64 {
        self.fetch.iter().map(|f| f.size).sum()
    }
}

/// Diff manifest files against the installed tree in `app`.
/// `installed` = path->sha from the last install, `cache` = stat taken then.
/// Fast path (no hashing): installed sha == wanted and size+mtime unchanged.
/// Otherwise the file is hashed, so a crash between swap and state write self-heals.
pub fn plan(
    files: &[FileEntry],
    installed: &BTreeMap<String, String>,
    cache: &BTreeMap<String, Stat>,
    app: &Path,
    full_hash: bool,
) -> Plan {
    let mut plan = Plan::default();
    let mut wanted = BTreeSet::new();
    for f in files {
        wanted.insert(f.path.clone());
        let Some(rel) = safe_rel(&f.path) else {
            plan.fetch.push(f.clone()); // rejected later with a clear error
            continue;
        };
        let local = app.join(rel);
        let ok = match stat_of(&local) {
            None => false,
            Some(st) if st.size != f.size => false,
            Some(st) => {
                let cached = !full_hash
                    && installed.get(&f.path) == Some(&f.sha256)
                    && cache.get(&f.path) == Some(&st);
                cached || sha256_file(&local).map(|h| h == f.sha256).unwrap_or(false)
            }
        };
        if ok { plan.keep.push(f.clone()) } else { plan.fetch.push(f.clone()) }
    }
    let mut on_disk = Vec::new();
    list_files(app, app, &mut on_disk);
    plan.extra = on_disk.into_iter().filter(|p| !wanted.contains(p)).collect();
    plan
}

/// Relative '/'-separated paths of all files under `dir`.
pub fn list_files(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => list_files(base, &p, out),
            Ok(_) => {
                if let Ok(r) = p.strip_prefix(base) {
                    out.push(r.to_string_lossy().replace('\\', "/"));
                }
            }
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, content: &[u8]) -> FileEntry {
        let mut h = Sha256::new();
        h.update(content);
        FileEntry { path: path.into(), size: content.len() as u64, sha256: hex(&h.finalize()), component: "app".into(), exec: false }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rl-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hashing_known_vector() {
        let d = tmp("hash");
        fs::write(d.join("a"), b"abc").unwrap();
        assert_eq!(sha256_file(&d.join("a")).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn safe_rel_rejects_escapes() {
        assert!(safe_rel("a/b.txt").is_some());
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "a\\b", "C:/x"] {
            assert!(safe_rel(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn plan_detects_missing_changed_extra_and_keeps_rest() {
        let app = tmp("plan");
        fs::create_dir_all(app.join("d")).unwrap();
        fs::write(app.join("same"), b"one").unwrap();
        fs::write(app.join("d/changed"), b"old").unwrap();
        fs::write(app.join("stale"), b"x").unwrap();
        let files = vec![entry("same", b"one"), entry("d/changed", b"new!"), entry("missing", b"m")];
        let p = plan(&files, &BTreeMap::new(), &BTreeMap::new(), &app, false);
        assert_eq!(p.keep.len(), 1);
        let fetch: Vec<_> = p.fetch.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(fetch, ["d/changed", "missing"]);
        assert_eq!(p.extra, ["stale"]);
        assert!(!p.is_noop());
    }

    #[test]
    fn plan_noop_and_cache_fast_path_vs_repair() {
        let app = tmp("cache");
        fs::write(app.join("f"), b"data").unwrap();
        let f = entry("f", b"data");
        let installed = BTreeMap::from([("f".to_string(), f.sha256.clone())]);
        let cache = BTreeMap::from([("f".to_string(), stat_of(&app.join("f")).unwrap())]);
        assert!(plan(&[f.clone()], &installed, &cache, &app, false).is_noop());
        // Same size + mtime but corrupted contents: cache trusts it, --repair does not.
        let st = stat_of(&app.join("f")).unwrap();
        fs::write(app.join("f"), b"DATA").unwrap();
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_nanos(st.mtime);
        fs::File::options().write(true).open(app.join("f")).unwrap().set_modified(t).unwrap();
        assert!(plan(&[f.clone()], &installed, &cache, &app, false).is_noop());
        assert_eq!(plan(&[f], &installed, &cache, &app, true).fetch.len(), 1);
    }
}
