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
/// A song file's bytes, for when the webview can't stream it from disk itself
/// (the player falls back to this; see `src/lib/player.tsx`). Audio files only.
#[tauri::command]
async fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    const AUDIO: [&str; 7] = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];
    let p = std::path::PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !AUDIO.contains(&ext.as_str()) {
        return Err("Not a song file".into());
    }
    let mut bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Couldn't read {path}: {e}"))?;
    cdrip::flac::fix_min_block_size(&mut bytes);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Repairs the header of FLAC files ripped before the fix in `cdrip::flac::fix_min_block_size`
/// (a song with a very short last block wouldn't play). Returns the files it changed.
#[tauri::command]
async fn repair_flac_files(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|p| p.to_ascii_lowercase().ends_with(".flac"))
            .filter(|p| cdrip::flac::repair_file(std::path::Path::new(p)).unwrap_or(false))
            .collect()
    })
    .await
    .unwrap_or_default()
}

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
mod secure;
mod outputs;

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
    pub async fn cd_rip(app: tauri::AppHandle, id: String, plan: cdrip::Plan) -> Result<cdrip::Ripped, String> {
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
                cdrip::rip(&disc, &plan, &music, &report, &CANCEL, &DISCARD)
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

    /// A new cover for a ripped CD: into its FLAC files and the album folder's cover image.
    #[tauri::command]
    pub async fn cd_set_cover(files: Vec<String>, cover: String) -> Result<(), String> {
        joined(spawn_blocking(move || cdrip::set_cover(&files.into_iter().map(std::path::PathBuf::from).collect::<Vec<_>>(), &cover)).await)
    }

    /// A ripped or recorded song must be one of Milk Crate's (in Music › Milk Crate), and a FLAC.
    pub fn own_song(app: &tauri::AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
        let root = app.path().audio_dir().map_err(|e| e.to_string())?.join("Milk Crate").canonicalize().map_err(|_| "Only songs ripped or recorded by Milk Crate can be changed.".to_string())?;
        let p = std::path::Path::new(path).canonicalize().map_err(|_| "That song's file is gone.".to_string())?;
        if p.starts_with(&root) && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("flac")) {
            Ok(p)
        } else {
            Err("Only songs ripped or recorded by Milk Crate can be changed.".into())
        }
    }

    /// Trims a ripped or recorded song: seconds off its start and its end. Returns its new length.
    #[tauri::command]
    pub async fn cd_trim(app: tauri::AppHandle, path: String, cut_start: f64, cut_end: f64) -> Result<f64, String> {
        let p = own_song(&app, &path)?;
        joined(spawn_blocking(move || cdrip::flac::trim(&p, cut_start, cut_end)).await)
    }

    /// New titles, album name or year for songs you ripped (saved into their FLAC files).
    #[tauri::command]
    pub async fn cd_set_tags(edits: Vec<cdrip::TagEdit>) -> Result<(), String> {
        joined(spawn_blocking(move || cdrip::set_tags(&edits)).await)
    }

    #[tauri::command]
    pub async fn cd_eject(id: String) -> Result<(), String> {
        joined(spawn_blocking(move || cdrip::find(&id)?.eject()).await)
    }
}

/// Recording records from a turntable (Your Shelf › Vinyl). The work happens in the vinyl crate;
/// the recording reports with "vinyl-level" events. Recordings wait in the app's data folder
/// (recordings/) until they're saved as songs or thrown away.
mod vinyl_cmd {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use tauri::{async_runtime::spawn_blocking, Emitter, Manager};

    static RECORDER: Mutex<Option<vinyl::Recorder>> = Mutex::new(None);

    fn recordings(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("recordings");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// Only recordings Milk Crate made (a path from the app can't point anywhere else).
    fn own_recording(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
        let dir = recordings(app)?.canonicalize().map_err(|e| e.to_string())?;
        let p = Path::new(path).canonicalize().map_err(|_| "That recording is gone.".to_string())?;
        if p.parent() == Some(dir.as_path()) && p.extension().is_some_and(|e| e == "pcm") {
            Ok(p)
        } else {
            Err("That isn't one of Milk Crate's recordings.".into())
        }
    }

    #[tauri::command]
    pub async fn vinyl_inputs() -> Vec<vinyl::Input> {
        spawn_blocking(vinyl::inputs).await.unwrap_or_default()
    }

    #[derive(serde::Serialize)]
    pub struct Started {
        rate: u32,
    }

    #[tauri::command]
    pub async fn vinyl_start(app: tauri::AppHandle, device: Option<String>) -> Result<Started, String> {
        if RECORDER.lock().unwrap().is_some() {
            return Err("Already recording.".into());
        }
        let dir = recordings(&app)?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = dir.join(format!("side-{stamp}.pcm"));
        let emit = app.clone();
        let rec = spawn_blocking(move || vinyl::Recorder::start(device.as_deref(), path, move |l| { let _ = emit.emit("vinyl-level", l); }))
            .await
            .map_err(|e| e.to_string())??;
        let rate = rec.rate();
        *RECORDER.lock().unwrap() = Some(rec);
        Ok(Started { rate })
    }

    #[tauri::command]
    pub fn vinyl_pause(paused: bool) {
        if let Some(r) = RECORDER.lock().unwrap().as_ref() {
            r.set_paused(paused);
        }
    }

    #[tauri::command]
    pub async fn vinyl_stop() -> Result<vinyl::Recording, String> {
        let rec = RECORDER.lock().unwrap().take().ok_or("Not recording.")?;
        spawn_blocking(move || rec.stop()).await.map_err(|e| e.to_string())?
    }

    /// Throws a recording away (or the one going on, when `path` is empty).
    #[tauri::command]
    pub async fn vinyl_discard(app: tauri::AppHandle, path: String) -> Result<(), String> {
        if path.is_empty() {
            let going = RECORDER.lock().unwrap().take();
            if let Some(rec) = going {
                if let Ok(done) = spawn_blocking(move || rec.stop()).await.map_err(|e| e.to_string())? {
                    let _ = std::fs::remove_file(done.path);
                }
            }
            return Ok(());
        }
        let p = own_recording(&app, &path)?;
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }

    /// A few seconds of a recording as WAV bytes, to listen to where a song starts.
    #[tauri::command]
    pub async fn vinyl_snippet(app: tauri::AppHandle, path: String, rate: u32, start: f64, seconds: f64) -> Result<tauri::ipc::Response, String> {
        let p = own_recording(&app, &path)?;
        let wav = spawn_blocking(move || vinyl::snippet_wav(&p, rate, start, seconds)).await.map_err(|e| e.to_string())??;
        Ok(tauri::ipc::Response::new(wav))
    }

    /// Saves a side's songs into Music › Milk Crate › Artist › Album (Vinyl). Returns the files.
    #[tauri::command]
    pub async fn vinyl_save(app: tauri::AppHandle, path: String, rate: u32, plan: vinyl::SavePlan, cover: Option<String>) -> Result<Vec<String>, String> {
        let p = own_recording(&app, &path)?;
        let music = app.path().audio_dir().map_err(|e| format!("Couldn't find your Music folder: {e}"))?;
        spawn_blocking(move || {
            let pic = cover.as_deref().and_then(cdrip::decode_cover);
            let dir = vinyl::album_folder(&music, &plan.album_artist, &plan.album);
            let files = vinyl::save(&p, rate, &plan, &dir, pic.as_ref().map(|(m, b)| (m.as_str(), b.as_slice())))?;
            Ok(files.into_iter().map(|f| f.to_string_lossy().into_owned()).collect())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Records one song of a record again: part of a recording replaces that song's file
    /// (which keeps its name, tags and cover). Returns its new length.
    #[tauri::command]
    pub async fn vinyl_replace(app: tauri::AppHandle, path: String, rate: u32, start: f64, end: f64, target: String) -> Result<f64, String> {
        let p = own_recording(&app, &path)?;
        let t = crate::cd::own_song(&app, &target)?;
        spawn_blocking(move || vinyl::replace_song(&p, rate, start, end, &t)).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn vinyl_search(query: String) -> Result<Vec<cdrip::musicbrainz::Pressing>, String> {
        spawn_blocking(move || cdrip::musicbrainz::search_pressings(&query)).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn vinyl_record_info(release_id: String) -> Result<Option<cdrip::musicbrainz::RecordInfo>, String> {
        spawn_blocking(move || cdrip::musicbrainz::record_info(&release_id)).await.map_err(|e| e.to_string())?
    }
}

/// Milk Crate to Milk Crate on the same network (Your Computer › Send or receive CDs).
/// The work happens in the cdlink crate. The receiver reports with "link-receive" events,
/// the sender with "link-send-progress".
mod link {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tauri::{async_runtime::spawn_blocking, Emitter, Manager};

    static RECEIVER: Mutex<Option<cdlink::Receiver>> = Mutex::new(None);
    static CANCEL: AtomicBool = AtomicBool::new(false);

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Receiving {
        code: String,
        name: String,
    }

    /// Starts waiting for your other computer (signed in to `account`; `key` is that account's secret
    /// link key from the server, so only your own computers can send). Returns the code to type there.
    #[tauri::command]
    pub fn link_receive_start(app: tauri::AppHandle, account: String, key: String) -> Result<Receiving, String> {
        if key.len() < 32 {
            return Err("Sign in again, then try.".into());
        }
        let music = app.path().audio_dir().map_err(|e| format!("Couldn't find your Music folder: {e}"))?;
        let name = cdlink::computer_name();
        let emit = app.clone();
        let rx = cdlink::Receiver::start(name.clone(), cdlink::account_tag(&account), key, music.join("Milk Crate"), move |e| {
            let _ = emit.emit("link-receive", e);
        })
        .map_err(|e| format!("Couldn't start listening: {e}"))?;
        let code = rx.code.clone();
        *RECEIVER.lock().unwrap() = Some(rx);
        Ok(Receiving { code, name })
    }

    #[tauri::command]
    pub fn link_receive_stop() {
        RECEIVER.lock().unwrap().take();
    }

    /// Computers on the network waiting to receive.
    #[tauri::command]
    pub async fn link_find(account: String) -> Vec<cdlink::Peer> {
        spawn_blocking(move || cdlink::discover(&cdlink::account_tag(&account), std::time::Duration::from_millis(1600))).await.unwrap_or_default()
    }

    /// Sends songs (and their albums' covers) to a computer that's receiving. Returns how many files went.
    #[tauri::command]
    pub async fn link_send(app: tauri::AppHandle, addr: String, code: String, key: String, songs: Vec<String>) -> Result<cdlink::Sent, String> {
        CANCEL.store(false, Ordering::Relaxed);
        spawn_blocking(move || {
            let files = cdlink::with_covers(&songs.into_iter().map(PathBuf::from).collect::<Vec<_>>());
            cdlink::send(&addr, &code, &key, &cdlink::computer_name(), &files, &|p| {
                let _ = app.emit("link-send-progress", p);
            }, &CANCEL)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Which of these songs (and covers) the other computer already has, so they aren't sent twice.
    /// Returns the songs it has.
    #[tauri::command]
    pub async fn link_check(addr: String, code: String, key: String, songs: Vec<String>) -> Result<Vec<String>, String> {
        spawn_blocking(move || {
            let paths: Vec<PathBuf> = songs.iter().map(PathBuf::from).collect();
            let has = cdlink::check(&addr, &code, &key, &cdlink::computer_name(), &paths)?;
            Ok(songs.into_iter().zip(has).filter(|(_, h)| *h).map(|(s, _)| s).collect())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub fn link_send_cancel() {
        CANCEL.store(true, Ordering::Relaxed);
    }
}

/// Where the player can stream a song file from (see cdlink::media). macOS's web view doesn't
/// reliably play audio from the built-in file protocol, so the app uses this there.
#[tauri::command]
fn media_base() -> Result<String, String> {
    static BASE: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    BASE.get_or_init(|| cdlink::media::start().map_err(|e| e.to_string())).clone()
}

/// Milk Crate's own pages: the built app, or the dev server while developing.
fn app_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")) || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))),
        "about" => url.as_str() == "about:blank",
        _ => false,
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
        // The window only ever shows Milk Crate itself: a link or redirect to anywhere else is
        // refused, so a page can never be swapped for another site (or a sign-in leaked in its address).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("stay-in-app")
                .on_navigation(|_, url| app_page(url))
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            set_title_bar_colors,
            read_audio_file,
            repair_flac_files,
            cd::cd_discs,
            cd::cd_lookup,
            cd::cd_cover,
            cd::cd_rip,
            cd::cd_cancel,
            cd::cd_eject,
            cd::cd_set_cover,
            cd::cd_set_tags,
            cd::cd_trim,
            link::link_receive_start,
            link::link_receive_stop,
            link::link_find,
            link::link_send,
            link::link_send_cancel,
            link::link_check,
            media_base,
            secure::secure_get,
            secure::secure_set,
            secure::secure_remove,
            vinyl_cmd::vinyl_inputs,
            vinyl_cmd::vinyl_start,
            vinyl_cmd::vinyl_pause,
            vinyl_cmd::vinyl_stop,
            vinyl_cmd::vinyl_discard,
            vinyl_cmd::vinyl_snippet,
            vinyl_cmd::vinyl_save,
            vinyl_cmd::vinyl_search,
            vinyl_cmd::vinyl_record_info,
            vinyl_cmd::vinyl_replace,
            outputs::audio_outputs,
            outputs::set_audio_output
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running Milk Crate");
}
