use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::steam;

#[derive(Serialize, Deserialize, Default)]
struct StoredSettings {
    game_path: Option<String>,
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

fn load(app: &AppHandle) -> StoredSettings {
    std::fs::read_to_string(settings_path(app))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, settings: &StoredSettings) {
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        std::fs::write(settings_path(app), json).ok();
    }
}

#[tauri::command]
pub fn get_game_path(app: AppHandle) -> Option<String> {
    load(&app).game_path.or_else(|| steam::detect().map(|i| i.path))
}

#[tauri::command]
pub fn set_game_path(app: AppHandle, path: String) {
    let mut settings = load(&app);
    settings.game_path = Some(path);
    save(&app, &settings);
}

// Settings' "Browse..." button - not a picker, just reveals the current
// (auto-detected only) game folder in the real Windows Explorer for viewing.
#[tauri::command]
pub fn open_game_folder_in_explorer(app: AppHandle) -> Result<(), String> {
    let path = get_game_path(app).ok_or("no installation detected")?;
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
