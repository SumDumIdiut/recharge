mod commands;
mod vdf;

use commands::{hub, launcher, loader, maps, mods, play, settings, steam};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            hub::start_beam_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            steam::detect_igtap_install,
            settings::get_game_path,
            settings::set_game_path,
            settings::open_game_folder_in_explorer,
            mods::list_installed_mods,
            mods::set_mod_enabled,
            mods::uninstall_mod,
            hub::install_from_hub_cmd,
            maps::list_maps,
            maps::get_map,
            maps::save_map,
            maps::delete_map,
            maps::save_map_image,
            maps::list_tile_textures,
            maps::read_tile_texture,
            maps::read_tile_rules,
            loader::loader_status,
            loader::install_or_update_loader,
            launcher::check_launcher_update,
            play::launch_game,
            play::is_game_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
