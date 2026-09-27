use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::settings;

const OWNER: &str = "SumDumIdiut";
const DEFAULT_BRANCH: &str = "main";
const MAX_REPO_BYTES: u64 = 200 * 1024 * 1024;
const ALLOWED_REPOS: [&str; 3] = ["recharge-mods", "recharge-maps", "recharge-skins"];

/// recharge-maps (Navigator) is baked into every install rather than being an
/// optional mod, so it follows the same Stable/Beta split as Recharge itself:
/// "main" for stable, a "dev" branch for beta. Every other repo only has main.
fn branch_for(app: &AppHandle, repo: &str) -> String {
    if repo == "recharge-maps" && settings::update_channel(app) == "beta" {
        "dev".to_string()
    } else {
        DEFAULT_BRANCH.to_string()
    }
}

/// Records which branch a repo folder was last pulled from, so a channel
/// switch re-pulls it instead of silently keeping the old branch's code.
fn branch_marker(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".recharge-branch")
}

/// Records the commit a repo folder was pulled at, so new pushes to its
/// branch are pulled too (not just a first download or a channel switch).
fn commit_marker(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".recharge-commit")
}

/// A branch's newest commit, from the public ref advertisement (no API rate
/// limit). None when offline or the repo isn't reachable.
fn remote_commit(repo: &str, branch: &str) -> Option<String> {
    let body = ureq::get(&format!("https://github.com/{OWNER}/{repo}.git/info/refs?service=git-upload-pack"))
        .header("User-Agent", "git/2.40.0")
        .call()
        .ok()?
        .body_mut()
        .read_to_string()
        .ok()?;
    let marker = format!(" refs/heads/{branch}\n");
    let pos = body.find(&marker)?;
    let sha = body.get(pos.saturating_sub(40)..pos)?;
    (sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit())).then(|| sha.to_string())
}

/// The branch and commit a repo's local source was pulled from, e.g.
/// "dev@1a2b3c..." - changes whenever a newer pull replaces it.
pub fn source_revision(app: &AppHandle, repo: &str) -> Option<String> {
    let dir = source_mods_dir(app).ok()?.join(repo);
    let branch = std::fs::read_to_string(branch_marker(&dir)).ok()?;
    let commit = std::fs::read_to_string(commit_marker(&dir)).unwrap_or_default();
    Some(format!("{}@{}", branch.trim(), commit.trim()))
}

/// Where mod source lives on disk: one folder per repo under here. Override
/// with RECHARGE_MODS_DIR to point at a local checkout while developing.
pub fn source_mods_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("RECHARGE_MODS_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("no app data dir: {e}"))?
            .join("mods"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("invalid name: '{name}'"));
    }
    Ok(())
}

// Private repos need RECHARGE_GITHUB_TOKEN; public ones download anonymously.
// `rev` is a branch name or a commit.
fn download_repo_zip(repo: &str, rev: &str) -> Result<Vec<u8>, String> {
    let token = std::env::var("RECHARGE_GITHUB_TOKEN").ok().filter(|t| !t.is_empty());
    let request = match &token {
        Some(token) => ureq::get(&format!("https://api.github.com/repos/{OWNER}/{repo}/zipball/{rev}"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json"),
        None => ureq::get(&format!("https://github.com/{OWNER}/{repo}/archive/{rev}.zip")),
    };
    request
        .header("User-Agent", "recharge")
        .call()
        .map_err(|e| format!("couldn't download {repo}: {e}"))?
        .body_mut()
        .with_config()
        .limit(MAX_REPO_BYTES)
        .read_to_vec()
        .map_err(|e| e.to_string())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Downloads a mod repo (or just one mod folder inside it) into the mods
/// source folder, replacing whatever was there.
pub fn pull_blocking(app: &AppHandle, repo: &str, folder: Option<&str>) -> Result<(), String> {
    if !ALLOWED_REPOS.contains(&repo) {
        return Err(format!("unknown mod repo: '{repo}'"));
    }
    if let Some(folder) = folder {
        check_name(folder)?;
    }
    let mods = source_mods_dir(app)?;
    let branch = branch_for(app, repo);
    // Pinned to the branch's current commit when it can be read, so the
    // recorded commit is exactly what was downloaded.
    let commit = remote_commit(repo, &branch);
    let bytes = download_repo_zip(repo, commit.as_deref().unwrap_or(&branch))?;

    let tmp = mods.join(format!(".pull-tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("not a valid archive: {e}"))?
            .extract(&tmp)
            .map_err(|e| format!("couldn't extract {repo}: {e}"))?;

        // GitHub archives wrap everything in a single "<repo>-<sha>/" folder.
        let root = std::fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.is_dir())
            .ok_or("archive was empty")?;

        let (from, to) = match folder {
            Some(folder) => (root.join(folder), mods.join(repo).join(folder)),
            None => (root, mods.join(repo)),
        };
        if !from.is_dir() {
            return Err(format!("'{}' not found in {repo}", folder.unwrap_or("")));
        }
        let _ = std::fs::remove_dir_all(&to);
        copy_dir(&from, &to)?;
        let _ = std::fs::write(branch_marker(&to), &branch);
        match &commit {
            Some(commit) if folder.is_none() => { let _ = std::fs::write(commit_marker(&to), commit); }
            _ => { let _ = std::fs::remove_file(commit_marker(&to)); }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Copies one folder of a repo (e.g. Skinmod's "templates/skin-template") to
/// `dest`, overwriting files that are already there. Reads the repo's zip
/// directly instead of pulling it into the mods folder, so it never leaves a
/// half-populated repo folder that would stop the real mod from being pulled.
pub fn export_repo_folder(repo: &str, subdir: &str, dest: &Path) -> Result<(), String> {
    if !ALLOWED_REPOS.contains(&repo) {
        return Err(format!("unknown mod repo: '{repo}'"));
    }
    for part in subdir.split('/') {
        check_name(part)?;
    }
    let bytes = download_repo_zip(repo, DEFAULT_BRANCH)?;

    let tmp = std::env::temp_dir().join(format!("recharge-export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("not a valid archive: {e}"))?
            .extract(&tmp)
            .map_err(|e| format!("couldn't extract {repo}: {e}"))?;
        let root = std::fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.is_dir())
            .ok_or("archive was empty")?;
        let from = root.join(subdir);
        if !from.is_dir() {
            return Err(format!("'{subdir}' not found in {repo}"));
        }
        copy_dir(&from, dest)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[tauri::command]
pub async fn pull_mod_repo(app: AppHandle, repo: String, folder: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pull_blocking(&app, &repo, folder.as_deref()))
        .await
        .map_err(|e| format!("pull task panicked: {e}"))?
}

/// Makes sure a repo exists locally, pulling it only if it isn't there yet -
/// or if it's there but was pulled for a different channel's branch (e.g. the
/// user switched Stable/Beta since the last pull).
pub fn ensure_blocking(app: &AppHandle, repo: &str, folder: Option<&str>) -> Result<PathBuf, String> {
    let mods = source_mods_dir(app)?;
    let path = match folder {
        Some(folder) => mods.join(repo).join(folder),
        None => mods.join(repo),
    };
    let wanted_branch = branch_for(app, repo);
    let current_branch = std::fs::read_to_string(branch_marker(&path)).ok();
    if !path.is_dir() || current_branch.as_deref() != Some(wanted_branch.as_str()) {
        pull_blocking(app, repo, folder)?;
    }
    Ok(path)
}

/// Like ensure_blocking, and also pulls again when the branch has newer
/// commits than the local copy. Offline (or GitHub unreachable), the local
/// copy is kept as it is.
pub fn refresh_blocking(app: &AppHandle, repo: &str) -> Result<PathBuf, String> {
    let path = ensure_blocking(app, repo, None)?;
    let branch = branch_for(app, repo);
    if let Some(remote) = remote_commit(repo, &branch) {
        let local = std::fs::read_to_string(commit_marker(&path)).ok();
        if local.as_deref().map(str::trim) != Some(remote.as_str()) {
            pull_blocking(app, repo, None)?;
        }
    }
    Ok(path)
}
