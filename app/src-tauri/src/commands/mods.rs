use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::settings;

fn mods_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path_sync(app.clone())?;
    Some(PathBuf::from(game_path).join("Recharge").join("Mods"))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModManifest {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    #[serde(rename = "entryAssembly")]
    pub entry_assembly: Option<String>,
    #[serde(default)]
    #[serde(rename = "minLoaderVersion")]
    pub min_loader_version: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

fn each_manifest(app: &AppHandle) -> Vec<(PathBuf, ModManifest)> {
    let mut found = Vec::new();
    let Some(dir) = mods_dir(app) else {
        return found;
    };
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let manifest_path = entry.path().join("mod.json");
            if let Ok(text) = std::fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<ModManifest>(&text) {
                    found.push((manifest_path, manifest));
                }
            }
        }
    }
    found
}

// Navigator is baked into every install (see loader.rs); filtered from user-facing lists only, since other mods still load against it.
const BUILTIN_MOD_IDS: [&str; 1] = ["recharge.maps"];

/// Where the mods that were on before a test launch are written down, so they can be put
/// back afterwards. Kept next to the mods themselves rather than in Settings: it describes
/// their state, and Settings would then have to be kept in step with the folder.
fn test_launch_state_path(app: &AppHandle) -> Option<PathBuf> {
    mods_dir(app).map(|d| d.join(".recharge-test-launch-mods.json"))
}

/// Turns every mod in `dir` off except Navigator, and returns the ids that were on.
fn disable_all_but_navigator_in(dir: &Path) -> Result<Vec<String>, String> {
    let mut was_on: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(was_on);
    };
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("mod.json");
        let Ok(text) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
            continue;
        };
        if BUILTIN_MOD_IDS.contains(&id.as_str()) {
            continue; // Navigator is never written to
        }
        let was_enabled = value.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if was_enabled {
            was_on.push(id.clone());
        } else {
            continue; // already off: no rewrite, and it stays out of the restore list
        }
        value["enabled"] = serde_json::Value::Bool(false);
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&manifest_path, json).map_err(|e| format!("couldn't turn off '{id}': {e}"))?;
    }
    Ok(was_on)
}

/// Re-enables the named mods in `dir`. A mod that is gone by now is skipped, not an error.
fn restore_mods_in(dir: &Path, ids: &[String]) {
    for id in ids {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let manifest_path = entry.path().join("mod.json");
            let Ok(text) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if value.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
                continue;
            }
            value["enabled"] = serde_json::Value::Bool(true);
            if let Ok(json) = serde_json::to_string_pretty(&value) {
                let _ = std::fs::write(&manifest_path, json);
            }
            break;
        }
    }
}

/// Turns every mod off except Navigator, and remembers which were on.
///
/// Testing a map wants a known starting point: another mod can change how the game behaves,
/// which makes a broken map look broken for the wrong reason. Navigator is what opens the map
/// at all, so it stays.
pub fn disable_all_but_navigator(app: &AppHandle) -> Result<(), String> {
    let Some(dir) = mods_dir(app) else {
        return Ok(()); // nothing installed; nothing to turn off
    };
    let was_on = disable_all_but_navigator_in(&dir)?;
    if let Some(path) = test_launch_state_path(app) {
        let json = serde_json::json!({ "enabled": was_on }).to_string();
        let _ = std::fs::write(path, json);
    }
    Ok(())
}

/// Puts back the mods that were on before the last test launch. Anything turned on since is
/// left on: this only ever re-enables what it turned off itself.
pub fn restore_after_test_launch(app: &AppHandle) -> Result<(), String> {
    let Some(path) = test_launch_state_path(app) else {
        return Ok(());
    };
    let Some(dir) = mods_dir(app) else {
        return Ok(());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(()); // no test launch to undo
    };
    // Taken before the note is deleted, so a malformed one still gets cleared.
    let ids: Vec<String> = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("enabled").and_then(|x| x.as_array()).cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    restore_mods_in(&dir, &ids);
    Ok(())
}

#[cfg(test)]
mod test_launch_mods {
    use super::*;

    fn write_mod(dir: &Path, name: &str, id: &str, enabled: bool) {
        let d = dir.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("mod.json"),
            serde_json::json!({ "id": id, "displayName": id, "enabled": enabled }).to_string(),
        )
        .unwrap();
    }

    fn is_enabled(dir: &Path, name: &str) -> Option<bool> {
        let text = std::fs::read_to_string(dir.join(name).join("mod.json")).ok()?;
        serde_json::from_str::<serde_json::Value>(&text).ok()?.get("enabled")?.as_bool()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("recharge-testmods-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn navigator_stays_on_and_the_rest_go_off() {
        let dir = scratch("off");
        write_mod(&dir, "maps", "recharge.maps", true);
        write_mod(&dir, "gun", "recharge.gun", true);
        write_mod(&dir, "off-one", "recharge.off", false);

        let was_on = disable_all_but_navigator_in(&dir).unwrap();

        assert_eq!(was_on, vec!["recharge.gun".to_string()]);
        assert_eq!(is_enabled(&dir, "maps"), Some(true), "Navigator must never be touched");
        assert_eq!(is_enabled(&dir, "gun"), Some(false));
        assert_eq!(is_enabled(&dir, "off-one"), Some(false));
    }

    #[test]
    fn restoring_puts_back_exactly_what_was_off_before() {
        let dir = scratch("restore");
        write_mod(&dir, "maps", "recharge.maps", true);
        write_mod(&dir, "a", "recharge.a", true);
        write_mod(&dir, "b", "recharge.b", true);
        write_mod(&dir, "c", "recharge.c", false);

        let was_on = disable_all_but_navigator_in(&dir).unwrap();
        assert_eq!(is_enabled(&dir, "c"), Some(false), "an already-off mod stays off");
        restore_mods_in(&dir, &was_on);

        assert_eq!(is_enabled(&dir, "a"), Some(true));
        assert_eq!(is_enabled(&dir, "b"), Some(true));
        assert_eq!(is_enabled(&dir, "c"), Some(false), "and is not turned on by the restore");
    }

    #[test]
    fn turning_one_on_during_the_test_is_left_alone_by_the_restore() {
        let dir = scratch("during");
        write_mod(&dir, "a", "recharge.a", true);
        write_mod(&dir, "b", "recharge.b", false);

        let was_on = disable_all_but_navigator_in(&dir).unwrap();
        // The user switches one back on while the game is running.
        write_mod(&dir, "b", "recharge.b", true);
        restore_mods_in(&dir, &was_on);

        assert_eq!(is_enabled(&dir, "a"), Some(true));
        assert_eq!(is_enabled(&dir, "b"), Some(true), "already on; the restore must not mind");
    }

    #[test]
    fn a_mod_uninstalled_mid_test_is_skipped_not_fatal() {
        let dir = scratch("gone");
        write_mod(&dir, "a", "recharge.a", true);
        let was_on = disable_all_but_navigator_in(&dir).unwrap();
        std::fs::remove_dir_all(dir.join("a")).unwrap();
        restore_mods_in(&dir, &was_on); // must not panic
        assert!(!dir.join("a").exists());
    }

    #[test]
    fn a_missing_or_empty_mods_folder_is_not_an_error() {
        let dir = scratch("empty");
        assert_eq!(disable_all_but_navigator_in(&dir).unwrap(), Vec::<String>::new());
        let gone = dir.join("does-not-exist");
        assert_eq!(disable_all_but_navigator_in(&gone).unwrap(), Vec::<String>::new());
        restore_mods_in(&gone, &["recharge.gun".to_string()]);
    }

    #[test]
    fn a_manifest_with_no_id_or_bad_json_is_left_alone() {
        let dir = scratch("junk");
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        std::fs::write(dir.join("broken").join("mod.json"), "{ not json").unwrap();
        write_mod(&dir, "real", "recharge.real", true);

        let was_on = disable_all_but_navigator_in(&dir).unwrap();

        assert_eq!(was_on, vec!["recharge.real".to_string()]);
        assert_eq!(std::fs::read_to_string(dir.join("broken").join("mod.json")).unwrap(), "{ not json");
    }
}

/// An installed mod: its manifest, plus (when it came from the Hub) which entry and revision.
#[derive(Serialize)]
pub struct InstalledMod {
    #[serde(flatten)]
    pub manifest: ModManifest,
    #[serde(rename = "hubId", skip_serializing_if = "Option::is_none")]
    pub hub_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[tauri::command]
pub async fn list_installed_mods(app: AppHandle) -> Vec<InstalledMod> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("list_installed_mods", || list_installed_mods_sync(app))).await.expect("command thread panicked")
}

pub fn list_installed_mods_sync(app: AppHandle) -> Vec<InstalledMod> {
    each_manifest(&app)
        .into_iter()
        .filter(|(_, m)| !BUILTIN_MOD_IDS.contains(&m.id.as_str()))
        .map(|(path, manifest)| {
            let meta = path.parent().and_then(super::skins::read_hub_meta);
            InstalledMod {
                manifest,
                hub_id: meta.as_ref().map(|m| m.hub_id.clone()),
                revision: meta.as_ref().and_then(|m| m.revision),
                updated_at: meta.and_then(|m| m.updated_at),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn set_mod_enabled(app: AppHandle,id: String,enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("set_mod_enabled", || set_mod_enabled_sync(app, id, enabled))).await.expect("command thread panicked")
}

pub fn set_mod_enabled_sync(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if BUILTIN_MOD_IDS.contains(&id.as_str()) {
        return Err(format!("{id} is built into Recharge and can't be toggled"));
    }
    let Some(dir) = mods_dir(&app) else {
        return Err("game path not set".to_string());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Err(format!("mod '{id}' not found"));
    };
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("mod.json");
        let Ok(text) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if value.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
            continue;
        }
        value["enabled"] = serde_json::Value::Bool(enabled);
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&manifest_path, json).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(format!("mod '{id}' not found"))
}

#[tauri::command]
pub async fn uninstall_mod(app: AppHandle,id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("uninstall_mod", || uninstall_mod_sync(app, id))).await.expect("command thread panicked")
}

pub fn uninstall_mod_sync(app: AppHandle, id: String) -> Result<(), String> {
    if BUILTIN_MOD_IDS.contains(&id.as_str()) {
        return Err(format!("{id} is built into Recharge and can't be uninstalled"));
    }
    for (manifest_path, manifest) in each_manifest(&app) {
        if manifest.id != id {
            continue;
        }
        let mod_dir = manifest_path
            .parent()
            .ok_or_else(|| "malformed mod path".to_string())?;
        std::fs::remove_dir_all(mod_dir).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(format!("mod '{id}' not found"))
}

#[tauri::command]
pub async fn export_example_mod(app: AppHandle,dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::perf::timed("export_example_mod", || export_example_mod_sync(app, dest_dir))).await.expect("command thread panicked")
}

pub fn export_example_mod_sync(app: AppHandle, dest_dir: String) -> Result<(), String> {
    let src = super::repos::ensure_blocking(&app, "recharge-mods", Some("recharge-example"))?;
    let dest = PathBuf::from(dest_dir).join("recharge-example");
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    copy_dir_skipping_build_output(&src, &dest)
}

fn copy_dir_skipping_build_output(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == "bin" || name == "obj" {
            continue;
        }
        let src_path = entry.path();
        let dest_path = dest.join(&name);
        if src_path.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            copy_dir_skipping_build_output(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
