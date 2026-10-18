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

/// CD ripping (Your Computer › Rip a CD). The work happens in the cdrip crate; these run it off the
/// main thread and report progress to the app with "cd-rip-progress" events.
mod cd {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{async_runtime::spawn_blocking, Emitter, Manager};

    static CANCEL: AtomicBool = AtomicBool::new(false);
    /// Set with CANCEL when the listener chose to throw the rip away: its files get deleted.
    static DISCARD: AtomicBool = AtomicBool::new(false);

    fn joined<T>(r: Result<Result<T, String>, tauri::Error>) -> Result<T, String> {
        r.map_err(|e| e.to_string())?
    }

    #[derive(serde::Serialize)]
    pub struct Scan {
        discs: Vec<cdrip::DiscInfo>,
        /// Why drives were skipped ("CD drive (E:): no disc in it…"), shown when no CD is found.
        notes: Vec<String>,
    }

    /// Audio CDs in the drives right now.
    #[tauri::command]
    pub async fn cd_discs() -> Result<Scan, String> {
        spawn_blocking(|| {
            let (discs, notes) = cdrip::scan();
            Scan { discs: discs.iter().map(|d| d.info()).collect(), notes }
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// Albums on MusicBrainz that match the disc (best first). Empty when it isn't known.
    #[tauri::command]
    pub async fn cd_lookup(id: String) -> Result<Vec<cdrip::musicbrainz::Match>, String> {
        joined(spawn_blocking(move || cdrip::musicbrainz::lookup(&cdrip::find(&id)?.toc)).await)
    }

    /// The album's front cover as a data URL, if the Cover Art Archive has one.
    #[tauri::command]
    pub async fn cd_cover(release_id: String) -> Option<String> {
        spawn_blocking(move || cdrip::musicbrainz::cover(&release_id).map(|(m, b)| cdrip::data_url(&m, &b))).await.ok().flatten()
    }

    /// Rips into Music › Milk Crate › Artist › Album. Returns the saved files in track order.
    #[tauri::command]
    pub async fn cd_rip(app: tauri::AppHandle, id: String, plan: cdrip::Plan) -> Result<Vec<String>, String> {
        CANCEL.store(false, Ordering::Relaxed);
        DISCARD.store(false, Ordering::Relaxed);
        let music = app.path().audio_dir().map_err(|e| format!("Couldn't find your Music folder: {e}"))?;
        joined(
            spawn_blocking(move || {
                let disc = cdrip::find(&id)?;
                // At most about 100 updates per rip, plus one per track.
                let last = Mutex::new((0usize, -1f32));
                let report = |p: cdrip::Progress| {
                    let mut l = last.lock().unwrap();
                    if p.at != l.0 || p.overall - l.1 >= 0.01 || p.track >= 1.0 {
                        *l = (p.at, p.overall);
                        let _ = app.emit("cd-rip-progress", p);
                    }
                };
                let files = cdrip::rip(&disc, &plan, &music, &report, &CANCEL, &DISCARD)?;
                Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
            })
            .await,
        )
    }

    /// Stops the rip. `discard`: also delete the songs it already saved.
    #[tauri::command]
    pub fn cd_cancel(discard: Option<bool>) {
        if discard.unwrap_or(false) {
            DISCARD.store(true, Ordering::Relaxed);
        }
        CANCEL.store(true, Ordering::Relaxed);
    }

    #[tauri::command]
    pub async fn cd_eject(id: String) -> Result<(), String> {
        joined(spawn_blocking(move || cdrip::find(&id)?.eject()).await)
    }
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
        .invoke_handler(tauri::generate_handler![
            set_title_bar_colors,
            cd::cd_discs,
            cd::cd_lookup,
            cd::cd_cover,
            cd::cd_rip,
            cd::cd_cancel,
            cd::cd_eject
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running Milk Crate");
}
