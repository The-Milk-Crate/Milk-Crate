//! CD ripping for Milk Crate: find the audio CD, look it up, and save each track as a
//! tagged FLAC (title, artist, album, track number, cover) in Music › Milk Crate › Artist › Album.

pub mod flac;
pub mod mac;
pub mod musicbrainz;
pub mod toc;
pub mod windows;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use toc::Toc;

enum Source {
    Mac(mac::MacDisc),
    #[cfg(windows)]
    Win(windows::WinDisc),
}

pub struct Disc {
    /// Stable for as long as the disc is in: "D:" or the volume path.
    pub id: String,
    pub label: String,
    pub toc: Toc,
    source: Source,
}

/// What the app shows about a disc.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscInfo {
    pub id: String,
    pub label: String,
    pub disc_id: String,
    pub tracks: Vec<TrackInfo>,
    pub seconds: f64,
}

#[derive(Serialize)]
pub struct TrackInfo {
    pub number: u8,
    pub seconds: f64,
}

impl Disc {
    pub fn info(&self) -> DiscInfo {
        let tracks: Vec<TrackInfo> = (self.toc.first..=self.toc.last).map(|n| TrackInfo { number: n, seconds: self.toc.seconds(n) }).collect();
        let seconds = tracks.iter().map(|t| t.seconds).sum();
        DiscInfo { id: self.id.clone(), label: self.label.clone(), disc_id: self.toc.disc_id(), tracks, seconds }
    }

    pub fn read_track(&self, n: u8, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<i32>, String> {
        match &self.source {
            Source::Mac(d) => mac::read_track(d, n, progress, cancel),
            #[cfg(windows)]
            Source::Win(d) => windows::read_track(d, n, progress, cancel),
        }
    }

    pub fn eject(&self) -> Result<(), String> {
        match &self.source {
            Source::Mac(d) => mac::eject(d),
            #[cfg(windows)]
            Source::Win(d) => windows::eject(d),
        }
    }
}

/// Every audio CD in a drive right now.
pub fn discs() -> Vec<Disc> {
    scan().0
}

/// The discs, plus plain-words notes on drives that couldn't be used (no disc, no access…),
/// so the app can say why nothing shows up.
pub fn scan() -> (Vec<Disc>, Vec<String>) {
    let mut out: Vec<Disc> = Vec::new();
    let mut notes = Vec::new();
    #[cfg(windows)]
    {
        let (found, why) = windows::scan();
        notes.extend(why);
        for d in found {
            let label = if d.path.ends_with(':') { format!("CD drive ({})", d.path) } else { "CD drive".to_string() };
            out.push(Disc { id: d.path.clone(), label, toc: d.toc.clone(), source: Source::Win(d) });
        }
    }
    if cfg!(target_os = "macos") {
        let (found, why) = mac::scan_with_notes(Path::new("/Volumes"));
        notes.extend(why);
        out.extend(found.into_iter().map(mac_disc));
        if out.is_empty() && notes.is_empty() {
            notes.extend(mac::drive_note());
        }
    }
    (out, notes)
}

fn mac_disc(d: mac::MacDisc) -> Disc {
    Disc { id: d.volume.to_string_lossy().into_owned(), label: d.label.clone(), toc: d.toc.clone(), source: Source::Mac(d) }
}

#[cfg(test)]
fn mac_discs(root: &Path) -> Vec<Disc> {
    mac::scan(root).into_iter().map(mac_disc).collect()
}

pub fn find(id: &str) -> Result<Disc, String> {
    discs().into_iter().find(|d| d.id == id).ok_or_else(|| "The CD isn't in the drive anymore.".to_string())
}

/// What to save: the album's names (as found or as typed) and which tracks.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub album: String,
    pub album_artist: String,
    pub year: Option<String>,
    pub release_id: Option<String>,
    #[serde(default)]
    pub release_group_id: Option<String>,
    pub disc: u32,
    pub discs: u32,
    pub tracks: Vec<PlanTrack>,
    /// The cover as a data URL ("data:image/jpeg;base64,…"), if there is one.
    pub cover: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTrack {
    pub number: u8,
    pub title: String,
    pub artist: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Track being saved, 1-based position among the tracks being ripped.
    pub at: usize,
    pub of: usize,
    pub number: u8,
    /// This track, 0–1.
    pub track: f32,
    /// The whole rip, 0–1 (by length, so long songs count for more).
    pub overall: f32,
}

/// "data:image/jpeg;base64,…" for showing a cover in the app.
pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn decode_cover(data_url: &str) -> Option<(String, Vec<u8>)> {
    let b64 = data_url.split_once("base64,")?.1;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let mime = musicbrainz::image_mime(&bytes)?;
    Some((mime.to_string(), bytes))
}

/// Rips the planned tracks into `music` (the Music folder). Returns the saved files in track order.
///
/// Reading and saving overlap: while one song is encoded and written (on another thread), the next
/// one is already being read from the disc, so the drive never waits on the encoder.
///
/// Stopping (`cancel`) keeps the songs already saved. Stopping with `discard` also set deletes
/// everything this rip saved (and the album folder, if that leaves it empty).
/// What a rip saved, and the songs it had to skip (couldn't be read: scratches, dirt).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ripped {
    pub files: Vec<PathBuf>,
    pub skipped: Vec<Skipped>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub number: u8,
    pub title: String,
    pub reason: String,
}

pub fn rip(disc: &Disc, plan: &Plan, music: &Path, on_progress: &dyn Fn(Progress), cancel: &AtomicBool, discard: &AtomicBool) -> Result<Ripped, String> {
    use std::sync::atomic::Ordering;
    let artist = if plan.album_artist.trim().is_empty() { "Unknown Artist" } else { plan.album_artist.trim() };
    let dir = flac::album_dir(music, artist, &plan.album, plan.disc, plan.discs);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the folder {}: {e}", dir.display()))?;
    let cover = plan.cover.as_deref().and_then(decode_cover);
    let mut cover_file = None;
    if let Some((mime, bytes)) = &cover {
        let path = dir.join(if mime == "image/png" { "cover.png" } else { "cover.jpg" });
        if std::fs::write(&path, bytes).is_ok() {
            cover_file = Some(path);
        }
    }
    let lengths: Vec<f32> = plan.tracks.iter().map(|t| disc.toc.span(t.number).map(|s| s.1 as f32).unwrap_or(1.0)).collect();
    let total: f32 = lengths.iter().sum::<f32>().max(1.0);
    let disc_id = disc.toc.disc_id();
    let cover_ref = cover.as_ref().map(|(m, b)| (m.as_str(), b.as_slice()));

    let (read_result, written) = std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<(PathBuf, Vec<i32>, flac::Tags)>(1);
        let writer = scope.spawn(move || {
            let mut saved = Vec::new();
            for (path, samples, tags) in rx {
                // Stop keeps songs already read; only a discarded rip skips saving them.
                if discard.load(Ordering::Relaxed) {
                    break;
                }
                flac::write(&path, &samples, &tags, cover_ref).map_err(|e| (e, saved.clone()))?;
                saved.push(path);
            }
            Ok::<_, (String, Vec<PathBuf>)>(saved)
        });
        let mut before = 0f32;
        let mut result = Ok(());
        let mut skipped = Vec::new();
        for (i, t) in plan.tracks.iter().enumerate() {
            let base = before;
            let report = |f: f32| on_progress(Progress { at: i + 1, of: plan.tracks.len(), number: t.number, track: f, overall: (base + f * lengths[i]) / total });
            report(0.0);
            let samples = match disc.read_track(t.number, &report, cancel) {
                Ok(s) => s,
                Err(e) if cancel.load(Ordering::Relaxed) => { result = Err(e); break; }
                // A song that can't be read (scratched, dirty): skip it and go on to the next.
                Err(e) => {
                    skipped.push(Skipped { number: t.number, title: t.title.clone(), reason: e });
                    before += lengths[i];
                    report(1.0);
                    continue;
                }
            };
            let tags = flac::Tags {
                title: t.title.clone(),
                artist: if t.artist.trim().is_empty() { artist.to_string() } else { t.artist.clone() },
                album: plan.album.clone(),
                album_artist: artist.to_string(),
                track: t.number as u32,
                tracks: disc.toc.count() as u32,
                disc: plan.disc,
                discs: plan.discs,
                year: plan.year.clone(),
                release_id: plan.release_id.clone(),
                disc_id: Some(disc_id.clone()),
                media: Some("CD".into()),
                release_group_id: plan.release_group_id.clone(),
            };
            // Waits only if the previous song is still being saved. Fails if saving went wrong.
            if tx.send((dir.join(flac::track_file(t.number as u32, &t.title)), samples, tags)).is_err() {
                break;
            }
            before += lengths[i];
        }
        drop(tx);
        let written = writer.join().unwrap_or_else(|_| Err(("Saving stopped unexpectedly".to_string(), vec![])));
        (result.map(|_| skipped), written)
    });

    let (saved, write_error) = match written {
        Ok(saved) => (saved, None),
        Err((e, saved)) => (saved, Some(e)),
    };
    let skipped = read_result.as_ref().map(|s| s.clone()).unwrap_or_default();
    let failed = read_result.err().or(write_error).or_else(|| cancel.load(Ordering::Relaxed).then(|| "Stopped".to_string()));
    match failed {
        None => {
            on_progress(Progress { at: plan.tracks.len(), of: plan.tracks.len(), number: plan.tracks.last().map(|t| t.number).unwrap_or(0), track: 1.0, overall: 1.0 });
            if saved.is_empty() && !skipped.is_empty() {
                remove_rip(&saved, cover_file.as_deref(), &dir, music);
                return Err("Couldn't read any of the songs on this disc. It may be scratched or dirty: try wiping it with a soft cloth, from the middle out.".into());
            }
            Ok(Ripped { files: saved, skipped })
        }
        Some(e) => {
            if discard.load(Ordering::Relaxed) {
                remove_rip(&saved, cover_file.as_deref(), &dir, music);
            }
            Err(e)
        }
    }
}

/// A new front cover for songs you ripped: written into each FLAC file and as the album folder's
/// cover.jpg (or .png). Only touches .flac files. `data_url`: "data:image/jpeg;base64,…" (JPEG or PNG).
pub fn set_cover(files: &[PathBuf], data_url: &str) -> Result<(), String> {
    let (mime, bytes) = decode_cover(data_url).ok_or("That picture needs to be a JPEG or PNG.")?;
    let mut dirs = Vec::new();
    for f in files.iter().filter(|f| f.extension().is_some_and(|e| e.eq_ignore_ascii_case("flac"))) {
        let mut tag = metaflac::Tag::read_from_path(f).map_err(|e| format!("Couldn't open {}: {e}", f.display()))?;
        tag.add_picture(mime.clone(), metaflac::block::PictureType::CoverFront, bytes.clone());
        tag.write_to_path(f).map_err(|e| format!("Couldn't save the cover into {}: {e}", f.display()))?;
        if let Some(d) = f.parent() {
            if !dirs.contains(&d.to_path_buf()) {
                dirs.push(d.to_path_buf());
            }
        }
    }
    for d in dirs {
        let (keep, drop) = if mime == "image/png" { ("cover.png", "cover.jpg") } else { ("cover.jpg", "cover.png") };
        let _ = std::fs::remove_file(d.join(drop));
        let _ = std::fs::write(d.join(keep), &bytes);
    }
    Ok(())
}

/// A change to a ripped song's details. `None` leaves that detail as it is; an empty year removes it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    pub file: PathBuf,
    pub title: Option<String>,
    pub album: Option<String>,
    pub year: Option<String>,
    /// The album's artist (ALBUMARTIST), and this song's own artist (ARTIST).
    #[serde(default)]
    pub album_artist: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
}

/// Saves new titles, album names and years into ripped songs' FLAC files (the files keep their
/// names and places). Only touches .flac files; checks everything before changing anything.
pub fn set_tags(edits: &[TagEdit]) -> Result<(), String> {
    for e in edits {
        if !e.file.extension().is_some_and(|x| x.eq_ignore_ascii_case("flac")) {
            return Err(format!("Only songs from CDs you ripped can be changed ({}).", e.file.display()));
        }
        if let Some(y) = &e.year {
            let y = y.trim();
            if !y.is_empty() && !(y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit())) {
                return Err("The year needs to be four digits, like 1995.".into());
            }
        }
        for v in [&e.title, &e.album].into_iter().flatten() {
            if v.trim().is_empty() || v.chars().count() > 300 {
                return Err("Titles can't be empty or longer than 300 characters.".into());
            }
        }
        for v in [&e.album_artist, &e.artist].into_iter().flatten() {
            if v.trim().is_empty() || v.chars().count() > 300 {
                return Err("The artist can't be empty or longer than 300 characters.".into());
            }
        }
    }
    for e in edits {
        let mut tag = metaflac::Tag::read_from_path(&e.file).map_err(|err| format!("Couldn't open {}: {err}", e.file.display()))?;
        if let Some(t) = &e.title {
            tag.set_vorbis("TITLE", vec![t.trim()]);
        }
        if let Some(a) = &e.album {
            tag.set_vorbis("ALBUM", vec![a.trim()]);
        }
        if let Some(a) = &e.album_artist {
            tag.set_vorbis("ALBUMARTIST", vec![a.trim()]);
        }
        if let Some(a) = &e.artist {
            tag.set_vorbis("ARTIST", vec![a.trim()]);
        }
        if let Some(y) = &e.year {
            if y.trim().is_empty() {
                tag.remove_vorbis("DATE");
            } else {
                tag.set_vorbis("DATE", vec![y.trim()]);
            }
        }
        tag.write_to_path(&e.file).map_err(|err| format!("Couldn't save {}: {err}", e.file.display()))?;
    }
    Ok(())
}

/// Deletes what a rip saved, then the album folders it leaves empty (up to Music › Milk Crate).
fn remove_rip(saved: &[PathBuf], cover: Option<&Path>, dir: &Path, music: &Path) {
    for f in saved {
        let _ = std::fs::remove_file(f);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().ends_with(".flac.part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    // The cover goes too, unless songs from an earlier rip are still there.
    let songs_left = std::fs::read_dir(dir).map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".flac"))).unwrap_or(false);
    if let (Some(c), false) = (cover, songs_left) {
        let _ = std::fs::remove_file(c);
    }
    let stop = music.join("Milk Crate");
    let mut d = Some(dir);
    while let Some(p) = d {
        if p == stop || !p.starts_with(&stop) || std::fs::remove_dir(p).is_err() {
            break;
        }
        d = p.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn edits_tags_in_place() {
        let dir = std::env::temp_dir().join(format!("cdrip-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("01 One.flac");
        let tags = flac::Tags { title: "One".into(), artist: "Band".into(), album: "Old".into(), album_artist: "Band".into(), track: 1, tracks: 1, disc: 1, discs: 1, year: Some("1999".into()), release_id: None, disc_id: None, ..Default::default() };
        flac::write(&f, &vec![0i32; 44100 * 2], &tags, None).unwrap();
        let bad = set_tags(&[TagEdit { file: f.clone(), title: None, album: None, year: Some("99".into()), album_artist: None, artist: None }]);
        assert!(bad.is_err());
        set_tags(&[TagEdit { file: f.clone(), title: Some("Uno".into()), album: Some("New".into()), year: Some("2001".into()), album_artist: Some("The Band".into()), artist: Some("The Band".into()) }]).unwrap();
        let t = metaflac::Tag::read_from_path(&f).unwrap();
        let get = |k: &str| t.get_vorbis(k).and_then(|mut v| v.next()).map(String::from);
        assert_eq!(get("TITLE").as_deref(), Some("Uno"));
        assert_eq!(get("ALBUM").as_deref(), Some("New"));
        assert_eq!(get("DATE").as_deref(), Some("2001"));
        assert_eq!(get("ARTIST").as_deref(), Some("The Band"));
        assert_eq!(get("ALBUMARTIST").as_deref(), Some("The Band"));
        set_tags(&[TagEdit { file: f.clone(), title: None, album: None, year: Some("".into()), album_artist: None, artist: None }]).unwrap();
        assert!(metaflac::Tag::read_from_path(&f).unwrap().get_vorbis("DATE").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rips_a_whole_disc_into_named_tagged_files() {
        // A fake Mac CD: two tracks.
        let root = std::env::temp_dir().join(format!("cdrip-rip-{}", std::process::id()));
        let vol = root.join("vols").join("Audio CD");
        std::fs::create_dir_all(&vol).unwrap();
        let toc = r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Sessions</key><array><dict>
<key>Leadout Block</key><integer>300</integer><key>Track Array</key><array>
<dict><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict>
<dict><key>Point</key><integer>2</integer><key>Start Block</key><integer>100</integer></dict>
</array></dict></array></dict></plist>"#;
        std::fs::write(vol.join(".TOC.plist"), toc).unwrap();
        let tone: Vec<i16> = (0..44_100).map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16).collect();
        let aiff = |s: &[i16]| {
            let data: Vec<u8> = s.iter().flat_map(|v| v.to_be_bytes()).collect();
            let mut body = b"AIFFCOMM".to_vec();
            body.extend(18u32.to_be_bytes());
            body.extend(2u16.to_be_bytes());
            body.extend(((s.len() / 2) as u32).to_be_bytes());
            body.extend(16u16.to_be_bytes());
            body.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
            body.extend(b"SSND");
            body.extend(((data.len() + 8) as u32).to_be_bytes());
            body.extend([0u8; 8]);
            body.extend(data);
            let mut f = b"FORM".to_vec();
            f.extend((body.len() as u32).to_be_bytes());
            f.extend(body);
            f
        };
        std::fs::write(vol.join("1 Audio Track.aiff"), aiff(&tone)).unwrap();
        std::fs::write(vol.join("2 Audio Track.aiff"), aiff(&tone[..20_000])).unwrap();

        let disc = mac_discs(&root.join("vols")).pop().unwrap();
        let info = disc.info();
        assert_eq!(info.tracks.len(), 2);
        assert_eq!(info.label, "Audio CD");

        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0, 9]);
        let plan = Plan {
            album: "Cavities".into(),
            album_artist: "Pamelo".into(),
            year: Some("2024".into()),
            release_id: None,
            release_group_id: None,
            disc: 1,
            discs: 1,
            tracks: vec![
                PlanTrack { number: 1, title: "Wash Your Tongue".into(), artist: "".into() },
                PlanTrack { number: 2, title: "Cupid's Dart / Pulp".into(), artist: "Pamelo feat. Guest".into() },
            ],
            cover: Some(format!("data:image/jpeg;base64,{jpeg}")),
        };
        let seen = Mutex::new(Vec::new());
        let music = root.join("Music");
        let files = rip(&disc, &plan, &music, &|p| seen.lock().unwrap().push(p.overall), &AtomicBool::new(false), &AtomicBool::new(false)).unwrap().files;
        let album = music.join("Milk Crate/Pamelo/Cavities");
        assert_eq!(files, vec![album.join("01 Wash Your Tongue.flac"), album.join("02 Cupid's Dart _ Pulp.flac")]);
        assert!(album.join("cover.jpg").exists());
        let t2 = metaflac::Tag::read_from_path(&files[1]).unwrap();
        let vc = t2.vorbis_comments().unwrap();
        assert_eq!(vc.title().unwrap()[0], "Cupid's Dart / Pulp");
        assert_eq!(vc.artist().unwrap()[0], "Pamelo feat. Guest");
        assert_eq!(vc.album_artist().unwrap()[0], "Pamelo");
        assert_eq!(vc.track(), Some(2));
        assert_eq!(t2.get_streaminfo().unwrap().total_samples, 10_000);
        let p = seen.lock().unwrap();
        assert!(p.windows(2).all(|w| w[1] >= w[0] - 1e-6), "progress only goes up");
        assert!((p.last().unwrap() - 1.0).abs() < 1e-3);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn discarding_a_stopped_rip_deletes_its_files() {
        let root = std::env::temp_dir().join(format!("cdrip-discard-{}", std::process::id()));
        let vol = root.join("vols").join("CD");
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::write(vol.join(".TOC.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Sessions</key><array><dict><key>Leadout Block</key><integer>200</integer><key>Track Array</key><array><dict><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict><dict><key>Point</key><integer>2</integer><key>Start Block</key><integer>100</integer></dict></array></dict></array></dict></plist>"#).unwrap();
        let aiff = |n: usize| {
            let data = vec![0u8; n * 4];
            let mut body = b"AIFFCOMM".to_vec();
            body.extend(18u32.to_be_bytes());
            body.extend(2u16.to_be_bytes());
            body.extend((n as u32).to_be_bytes());
            body.extend(16u16.to_be_bytes());
            body.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
            body.extend(b"SSND");
            body.extend(((data.len() + 8) as u32).to_be_bytes());
            body.extend([0u8; 8]);
            body.extend(data);
            let mut f = b"FORM".to_vec();
            f.extend((body.len() as u32).to_be_bytes());
            f.extend(body);
            f
        };
        std::fs::write(vol.join("1 Audio Track.aiff"), aiff(5000)).unwrap();
        std::fs::write(vol.join("2 Audio Track.aiff"), aiff(5000)).unwrap();
        let disc = mac_discs(&root.join("vols")).pop().unwrap();
        let music = root.join("Music");
        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0, 9]);
        let plan = Plan { album: "Cavities".into(), album_artist: "Pamelo".into(), year: None, release_id: None, release_group_id: None, disc: 1, discs: 1,
            tracks: vec![PlanTrack { number: 1, title: "A".into(), artist: "".into() }, PlanTrack { number: 2, title: "B".into(), artist: "".into() }],
            cover: Some(format!("data:image/jpeg;base64,{jpeg}")) };
        // "Proceed" while song 2 is being read: song 1 may already be saved.
        let (cancel, discard) = (AtomicBool::new(false), AtomicBool::new(false));
        let err = rip(&disc, &plan, &music, &|p| if p.at == 2 && p.track > 0.0 { discard.store(true, std::sync::atomic::Ordering::Relaxed); cancel.store(true, std::sync::atomic::Ordering::Relaxed); }, &cancel, &discard).unwrap_err();
        assert_eq!(err, "Stopped");
        assert!(!music.join("Milk Crate/Pamelo").exists(), "the album folder is gone");
        assert!(music.join("Milk Crate").exists());

        // An earlier rip's songs in the same folder stay, and so does the cover.
        let album = music.join("Milk Crate/Pamelo/Cavities");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::write(album.join("09 Older.flac"), b"x").unwrap();
        let (cancel, discard) = (AtomicBool::new(false), AtomicBool::new(false));
        rip(&disc, &plan, &music, &|p| if p.at == 2 && p.track > 0.0 { discard.store(true, std::sync::atomic::Ordering::Relaxed); cancel.store(true, std::sync::atomic::Ordering::Relaxed); }, &cancel, &discard).unwrap_err();
        assert!(album.join("09 Older.flac").exists());
        assert!(album.join("cover.jpg").exists());
        assert!(!album.join("01 A.flac").exists());

        // Plain Stop (no discard) keeps what's saved.
        let (cancel, discard) = (AtomicBool::new(false), AtomicBool::new(false));
        let stop = std::cell::Cell::new(false);
        rip(&disc, &plan, &music, &|p| if p.at == 2 && p.track > 0.0 { stop.set(true); cancel.store(true, std::sync::atomic::Ordering::Relaxed); }, &cancel, &discard).unwrap_err();
        assert!(stop.get());
        assert!(album.join("01 A.flac").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skips_a_song_it_cant_read_and_keeps_going() {
        let root = std::env::temp_dir().join(format!("cdrip-skip-{}", std::process::id()));
        let vol = root.join("vols").join("CD");
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::write(vol.join(".TOC.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Sessions</key><array><dict><key>Leadout Block</key><integer>300</integer><key>Track Array</key><array><dict><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict><dict><key>Point</key><integer>2</integer><key>Start Block</key><integer>100</integer></dict><dict><key>Point</key><integer>3</integer><key>Start Block</key><integer>200</integer></dict></array></dict></array></dict></plist>"#).unwrap();
        let aiff = |n: usize| {
            let data = vec![0u8; n * 4];
            let mut body = b"AIFFCOMM".to_vec();
            body.extend(18u32.to_be_bytes());
            body.extend(2u16.to_be_bytes());
            body.extend((n as u32).to_be_bytes());
            body.extend(16u16.to_be_bytes());
            body.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
            body.extend(b"SSND");
            body.extend(((data.len() + 8) as u32).to_be_bytes());
            body.extend([0u8; 8]);
            body.extend(data);
            let mut f = b"FORM".to_vec();
            f.extend((body.len() as u32).to_be_bytes());
            f.extend(body);
            f
        };
        std::fs::write(vol.join("1 Audio Track.aiff"), aiff(1000)).unwrap();
        std::fs::write(vol.join("2 Audio Track.aiff"), b"FORM\0\0\0\x04AIFF").unwrap(); // unreadable
        std::fs::write(vol.join("3 Audio Track.aiff"), aiff(1000)).unwrap();
        let disc = mac_discs(&root.join("vols")).pop().unwrap();
        let t = |n: u8, title: &str| PlanTrack { number: n, title: title.into(), artist: "".into() };
        let plan = Plan { album: "A".into(), album_artist: "B".into(), year: None, release_id: None, release_group_id: None, disc: 1, discs: 1, tracks: vec![t(1, "One"), t(2, "Two"), t(3, "Three")], cover: None };
        let seen = Mutex::new(Vec::new());
        let r = rip(&disc, &plan, &root.join("Music"), &|p| seen.lock().unwrap().push(p.overall), &AtomicBool::new(false), &AtomicBool::new(false)).unwrap();
        assert_eq!(r.files.len(), 2);
        assert!(r.files[1].ends_with("03 Three.flac"));
        assert_eq!(r.skipped.len(), 1);
        assert_eq!((r.skipped[0].number, r.skipped[0].title.as_str()), (2, "Two"));
        assert!((seen.lock().unwrap().last().unwrap() - 1.0).abs() < 1e-3);

        // Nothing readable at all: an error, and nothing left behind.
        let plan = Plan { tracks: vec![t(2, "Two")], ..plan };
        let err = rip(&disc, &plan, &root.join("Music2"), &|_| {}, &AtomicBool::new(false), &AtomicBool::new(false)).unwrap_err();
        assert!(err.starts_with("Couldn't read any"));
        assert!(!root.join("Music2/Milk Crate/B").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sets_a_new_cover_on_ripped_files() {
        let dir = std::env::temp_dir().join(format!("cdrip-cover-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("01 A.flac");
        let tags = flac::Tags { title: "A".into(), ..Default::default() };
        flac::write(&f, &[0i32; 2000], &tags, Some(("image/jpeg", &[0xFF, 0xD8, 0xFF, 1]))).unwrap();
        std::fs::write(dir.join("cover.jpg"), [0xFF, 0xD8, 0xFF, 1]).unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let url = data_url("image/png", &png);
        set_cover(&[f.clone(), dir.join("notes.txt")], &url).unwrap();
        let tag = metaflac::Tag::read_from_path(&f).unwrap();
        let pics: Vec<_> = tag.pictures().collect();
        assert_eq!(pics.len(), 1, "the old cover is replaced, not added to");
        assert_eq!(pics[0].mime_type, "image/png");
        assert_eq!(pics[0].data, png);
        assert!(dir.join("cover.png").exists() && !dir.join("cover.jpg").exists());
        assert!(set_cover(&[f], "data:text/plain;base64,aGk=").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stops_when_cancelled() {
        let root = std::env::temp_dir().join(format!("cdrip-cancel-{}", std::process::id()));
        let vol = root.join("CD");
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::write(vol.join(".TOC.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Sessions</key><array><dict><key>Leadout Block</key><integer>100</integer><key>Track Array</key><array><dict><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict></array></dict></array></dict></plist>"#).unwrap();
        let mut f = b"FORM\0\0\0\x30AIFFSSND\0\0\0\x28\0\0\0\0\0\0\0\0".to_vec();
        f.extend([0u8; 32]);
        std::fs::write(vol.join("1 Audio Track.aiff"), f).unwrap();
        let disc = mac_discs(&root).pop().unwrap();
        let plan = Plan { album: "A".into(), album_artist: "B".into(), year: None, release_id: None, release_group_id: None, disc: 1, discs: 1, tracks: vec![PlanTrack { number: 1, title: "x".into(), artist: "".into() }], cover: None };
        let err = rip(&disc, &plan, &root.join("Music"), &|_| {}, &AtomicBool::new(true), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err, "Stopped");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
