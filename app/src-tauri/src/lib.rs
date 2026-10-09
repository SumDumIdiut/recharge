mod commands;
mod vdf;

use commands::{backgrounds, games, hub, launcher, live, loader, maps, migrate, mods, play, repos, settings, skins, steam, updater};

#[cfg(target_os = "linux")]
fn apply_nvidia_webkit_workarounds() {
    // GPU rasterisation for the map editor's canvas. WebKitGTK only composites
    // through the GPU when it is told to, and it defaults to software on many
    // setups - the editor redraws every frame while panning, so that is the
    // difference between smooth and crawling on a big map.
    //
    // Both are set only if unset, so a user can override either from the
    // environment (setting WEBKIT_COMPOSITING_MODE=0 turns this back off).
    if std::env::var_os("WEBKIT_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_COMPOSITING_MODE", "1");
    }
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "0");
    }
    // The canvas is opaque and mostly flat colour; hinting that lets the
    // compositor skip work it would otherwise do per frame.
    if std::env::var_os("WEBKIT_DISABLE_ACCELERATED_2D_CANVAS").is_none() {
        std::env::set_var("WEBKIT_DISABLE_ACCELERATED_2D_CANVAS", "0");
    }

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
            live::init(app.handle());
            updater::init(app.handle());
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
            mods::export_example_mod,
            repos::pull_mod_repo,
            live::live_status,
            live::live_get_channel,
            live::live_set_channel,
            live::live_ack,
            live::live_stash,
            live::live_take_stash,
            games::list_library_games,
            games::install_library_game,
            games::uninstall_library_game,
            games::play_library_game,
            hub::install_from_hub_cmd,
            hub::download_skin_template_cmd,
            hub::submit_skin_cmd,
            hub::submit_map_cmd,
            hub::submit_installed_map_cmd,
            hub::submit_mod_cmd,
            hub::delete_hub_submission_cmd,
            hub::fetch_hub_map_json,
            hub::fetch_hub_playlists_cmd,
            maps::list_maps,
            maps::read_map,
            maps::save_map,
            maps::map_history,
            maps::read_map_version,
            maps::export_map_zip,
            maps::read_map_asset,
            maps::store_map_asset,
            maps::find_map_asset,
            maps::uninstall_map,
            maps::set_map_hub_name,
            maps::read_map_thumb,
            maps::write_map_thumb,
            maps::test_launch_map,
            skins::list_installed_skins,
            skins::read_skin_thumbnail,
            skins::set_active_skin,
            skins::delete_skin,
            loader::loader_status,
            loader::install_or_update_loader,
            loader::uninstall_loader,
            updater::launcher_info,
            updater::launcher_uninstall,
            updater::launcher_check_now,
            updater::launcher_set_channel,
            updater::launcher_restart,
            updater::launcher_update_failure,
            updater::launcher_open_log,
            migrate::migrate_info,
            migrate::migrate_to_launcher,
            launcher::check_launcher_update,
            launcher::install_launcher_update,
            play::launch_game,
            play::is_game_running,
            play::restore_vanilla_build,
            backgrounds::list_background_images,
            backgrounds::upload_background_image,
            backgrounds::delete_background_image,
            backgrounds::read_background_image,
            backgrounds::get_backgrounds_config,
            backgrounds::save_playlist,
            backgrounds::delete_playlist,
            backgrounds::set_active_playlist,
            backgrounds::pick_random_background,
            backgrounds::pick_background,
            backgrounds::set_playlist_interval,
            backgrounds::publish_playlist,
            backgrounds::unpublish_playlist,
            backgrounds::download_hub_playlist,
            backgrounds::download_hub_background,
            backgrounds::publish_background_image,
            backgrounds::unpublish_background_image,
            hub::fetch_hub_backgrounds_cmd,
            hub::fetch_changelog_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
