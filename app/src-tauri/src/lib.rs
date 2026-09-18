mod commands;
mod vdf;

use commands::{hub, launcher, loader, maps, mods, play, settings, steam};

#[cfg(target_os = "linux")]
fn apply_nvidia_webkit_workarounds() {
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_nvidia_webkit_workarounds();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            hub::start_beam_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            steam::detect_igtap_install,
            steam::detect_all_igtap_installs,
            settings::get_game_path,
            settings::get_saved_game_path,
            settings::set_game_path,
            settings::auto_detect_game_path,
            settings::open_game_folder_in_explorer,
            mods::list_installed_mods,
            mods::set_mod_enabled,
            mods::uninstall_mod,
            hub::install_from_hub_cmd,
            maps::list_maps,
            loader::loader_status,
            loader::install_or_update_loader,
            loader::uninstall_loader,
            launcher::check_launcher_update,
            launcher::install_launcher_update,
            play::launch_game,
            play::is_game_running,
            play::restore_vanilla_build,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
