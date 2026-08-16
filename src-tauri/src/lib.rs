mod server;

use server::SharingState;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SharingState(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            greet,
            server::start_sharing,
            server::stop_sharing,
            server::share_status,
        ])
        .setup(|app| {
            // BREWLM_SHARE_AUTO=1 starts sharing on launch (scripted testing).
            server::autostart_if_requested(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Don't leave an orphaned cloudflared behind.
            if let Some(session) = app_handle
                .state::<SharingState>()
                .0
                .lock()
                .unwrap()
                .take()
            {
                session.stop();
            }
        }
    });
}
