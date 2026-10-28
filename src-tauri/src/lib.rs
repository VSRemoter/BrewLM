mod blobs;
mod server;
mod sync;

use server::SharingState;
use tauri::{Emitter, Manager, menu::{Menu, MenuItem}, tray::TrayIconBuilder};

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

/// macOS menu bar: Tauri's default, except ⌘W closes the notebook tab (the
/// webview gets a "menu" event) and closing the window moves to ⇧⌘W.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{PredefinedMenuItem, Submenu};
    let name = app.package_info().name.clone();
    let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window =
        MenuItem::with_id(app, "close-window", "Close Window", true, Some("CmdOrCtrl+Shift+W"))?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close_tab, &close_window])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

fn cleanup_sharing(app: &tauri::AppHandle) {
    if let Some(session) = app.state::<SharingState>().0.lock().unwrap().take() {
        session.stop();
    }
}

/// Relaunch after an update was installed (the updater plugin only swaps the
/// files). Stops sharing first so the cloudflared sidecar isn't orphaned.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    cleanup_sharing(&app);
    app.restart();
}

/// Dev builds only: BREWLM_PROFILE=<name> runs a separate copy of the app with
/// its own data folder (identifier `com.brewlm.app.<name>`), for testing Sync
/// between two copies on one machine.
fn dev_profile() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("BREWLM_PROFILE")
        .ok()
        .filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let profile = dev_profile();
    if let Some(p) = &profile {
        context.config_mut().identifier = format!("com.brewlm.app.{p}");
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| match event.id().as_ref() {
        "close-tab" => {
            let _ = app.emit("menu", "close-tab");
        }
        // Same as the red button: hide; sharing keeps running.
        "close-window" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        _ => {}
    });
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SharingState(std::sync::Mutex::new(None)))
        // Media files (see blobs.rs); file reads run off the webview's thread.
        .register_asynchronous_uri_scheme_protocol("brewblob", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(blobs::serve(&app, &request)));
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            restart_app,
            server::start_sharing,
            server::stop_sharing,
            server::share_status,
            blobs::blob_put,
            blobs::blob_gc,
            blobs::blob_missing,
            blobs::backup_export,
            blobs::backup_restore_zip,
            blobs::snapshot_before_media_move,
            blobs::prune_media_snapshot,
            sync::sync_apply,
            sync::sync_mark_pushed,
            sync::sync_config,
            sync::sync_log,
        ])
        .setup(move |app| {
            if let (Some(p), Some(w)) = (&profile, app.get_webview_window("main")) {
                let _ = w.set_title(&format!("BrewLM ({p})"));
            }
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
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // macOS: clicking the dock icon re-shows the window.
        // (Reopen is a macOS-only RunEvent variant — gate it or Linux/Windows break.)
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
        tauri::RunEvent::ExitRequested { .. } => cleanup_sharing(app_handle),
        _ => {}
    });
}
