//! Milk Crate desktop shell.
//!
//! The UI lives in the React app (../src). This Rust side opens the window,
//! serves the built frontend, and exposes native features through plugins.
//! Add Rust commands here when the app needs things a webview can't do
//! (audio analysis for sonic profiles, a local SQLite library, barcode scanning).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running Milk Crate");
}
