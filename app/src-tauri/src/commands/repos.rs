use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const OWNER: &str = "SumDumIdiut";
const BRANCH: &str = "main";
const MAX_REPO_BYTES: u64 = 200 * 1024 * 1024;
const ALLOWED_REPOS: [&str; 3] = ["recharge-mods", "recharge-maps", "recharge-skins"];

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
fn download_repo_zip(repo: &str) -> Result<Vec<u8>, String> {
    let token = std::env::var("RECHARGE_GITHUB_TOKEN").ok().filter(|t| !t.is_empty());
    let request = match &token {
        Some(token) => ureq::get(&format!("https://api.github.com/repos/{OWNER}/{repo}/zipball/{BRANCH}"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json"),
        None => ureq::get(&format!("https://github.com/{OWNER}/{repo}/archive/refs/heads/{BRANCH}.zip")),
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
    let bytes = download_repo_zip(repo)?;

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
        copy_dir(&from, &to)
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

/// Makes sure a repo exists locally, pulling it only if it isn't there yet.
pub fn ensure_blocking(app: &AppHandle, repo: &str, folder: Option<&str>) -> Result<PathBuf, String> {
    let mods = source_mods_dir(app)?;
    let path = match folder {
        Some(folder) => mods.join(repo).join(folder),
        None => mods.join(repo),
    };
    if !path.is_dir() {
        pull_blocking(app, repo, folder)?;
    }
    Ok(path)
}
