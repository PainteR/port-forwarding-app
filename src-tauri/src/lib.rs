mod commands;
mod dock;
mod docker_logs;
mod models;
mod occupied_ports;
mod ssh;
mod storage;
mod tunnel;

use storage::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            let state = AppState::load(app.handle())?;
            app.manage(state);
            dock::clear_active_forward_badge(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::delete_forward,
            commands::delete_secret,
            commands::delete_server,
            commands::list_docker_cache,
            commands::list_forward_statuses,
            commands::list_forwards,
            commands::list_secrets,
            commands::list_servers,
            commands::refresh_docker_containers,
            commands::refresh_occupied_ports,
            commands::save_forward,
            commands::save_secret,
            commands::save_server,
            commands::start_container_logs,
            commands::start_forward,
            commands::stop_container_logs,
            commands::stop_forward,
            commands::test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
