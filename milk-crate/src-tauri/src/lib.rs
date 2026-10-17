//! Milk Crate desktop shell.
//!
//! The UI lives in the React app (../src). This Rust side opens the window,
//! serves the built frontend, and exposes native features through plugins.
//! Add Rust commands here when the app needs things a webview can't do
//! (audio analysis for sonic profiles, a local SQLite library, barcode scanning).

/// Colors the native title bar (Windows 11). `caption`, `text` and `border` are
/// COLORREFs (0x00BBGGRR); 0xFFFFFFFF puts back the system default. Used with the
/// see-through window so the bar matches the app instead of the system accent
/// color. Does nothing on other systems, or on Windows versions without it.
#[tauri::command]
fn set_title_bar_colors(window: tauri::WebviewWindow, caption: u32, text: u32, border: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        for (attribute, color) in [(DWMWA_CAPTION_COLOR, caption), (DWMWA_TEXT_COLOR, text), (DWMWA_BORDER_COLOR, border)] {
            // Failure just means an older Windows: leave the bar as it is.
            unsafe {
                DwmSetWindowAttribute(
                    hwnd.0 as _,
                    attribute as _,
                    &color as *const u32 as *const core::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (window, caption, text, border);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // One Milk Crate at a time: opening a milkcrate:// link (or the app again) brings the running
    // window forward, and the link is passed to it. Must be the first plugin.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![set_title_bar_colors])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running Milk Crate");
}
