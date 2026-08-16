mod server;

use server::SharingState;
use tauri::{Manager, menu::{Menu, MenuItem}, tray::TrayIconBuilder};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn cleanup_sharing(app: &tauri::AppHandle) {
    if let Some(session) = app.state::<SharingState>().0.lock().unwrap().take() {
        session.stop();
    }
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

            // System tray: closing the window hides it instead of quitting so
            // a paired phone keeps working while the app is backgrounded.
            let open = MenuItem::with_id(app, "open", "Open BrewLM", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit BrewLM", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("BrewLM");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main_window(app),
                "quit" => {
                    cleanup_sharing(app);
                    app.exit(0);
                }
                _ => {}
            })
            .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Red button / window close → hide to tray; sharing keeps running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // macOS: clicking the dock icon re-shows the window.
        tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
        tauri::RunEvent::ExitRequested { .. } => cleanup_sharing(app_handle),
        _ => {}
    });
}
