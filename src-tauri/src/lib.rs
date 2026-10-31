mod commands;
mod dock;
mod docker_logs;
mod models;
mod nginx;
mod occupied_ports;
mod sftp;
mod sftp_archive;
mod sftp_rename;
mod ssh;
mod storage;
mod terminal;
mod tunnel;

use storage::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                if let Some(state) = webview.try_state::<AppState>() {
                    state.terminals.close_all();
                    state.transfers.cancel_all();
                }
            }
        })
        .setup(|app| {
            let state = AppState::load(app.handle())?;
            app.manage(state);
            dock::clear_active_forward_badge(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_chmod,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            sftp::sftp_transfer,
            sftp::sftp_cancel,
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
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_ack,
            commands::terminal_close,
            nginx::list_nginx_sites,
            nginx::read_nginx_site,
            nginx::save_nginx_site,
            nginx::set_nginx_site_enabled,
            nginx::test_nginx_configuration,
            nginx::reload_nginx_configuration,
            nginx::provision_nginx_site,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AppState>().terminals.close_all();
                app.state::<AppState>().transfers.cancel_all();
            }
        });
}
