use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

use super::settings;

// Must match RechargeLoaderBootstrap.ModsRoot exactly.
fn mods_dir(app: &AppHandle) -> Option<PathBuf> {
    let game_path = settings::get_game_path(app.clone())?;
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
    #[serde(rename = "entryAssembly")]
    pub entry_assembly: Option<String>,
    #[serde(default)]
    #[serde(rename = "minLoaderVersion")]
    pub min_loader_version: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    // Surfaced so the frontend can show "requires X" on an already-installed
    // mod's detail view, not just in the pre-install catalog dialog - see
    // RechargeLoaderBootstrap.cs's own "dependencies", which this mirrors.
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

#[tauri::command]
pub fn list_installed_mods(app: AppHandle) -> Vec<ModManifest> {
    each_manifest(&app).into_iter().map(|(_, m)| m).collect()
}

// Flips "enabled" by editing the raw JSON in place (not by re-serializing a
// typed ModManifest over the file) so any field this struct doesn't know
// about - "dependencies" included, and whatever gets added after it -
// survives untouched. A previous version round-tripped through ModManifest
// for the write too, which would have silently dropped "dependencies" (and
// any other field ModManifest didn't mirror) the moment a real mod actually
// used it, since that struct only serializes what it declares.
#[tauri::command]
pub fn set_mod_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
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

// Removes a mod's entire deployed folder (DLL, mod.json, data/) - this is
// intentionally more thorough than just disabling it. Refuses to touch
// recharge.maps: it's infrastructure the Map Editor/Maps tabs depend on
// (see HIDDEN_MOD_IDS in app/src/mods/script.js), never something a user
// should be able to remove from this generic mod list.
#[tauri::command]
pub fn uninstall_mod(app: AppHandle, id: String) -> Result<(), String> {
    if id == "recharge.maps" {
        return Err("recharge.maps is required by the Maps/Amplifier tabs and can't be uninstalled here".to_string());
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
