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

fn decode_cover(data_url: &str) -> Option<(String, Vec<u8>)> {
    let b64 = data_url.split_once("base64,")?.1;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let mime = musicbrainz::image_mime(&bytes)?;
    Some((mime.to_string(), bytes))
}

/// Rips the planned tracks into `music` (the Music folder). Returns the saved files in track order.
pub fn rip(disc: &Disc, plan: &Plan, music: &Path, on_progress: &dyn Fn(Progress), cancel: &AtomicBool) -> Result<Vec<PathBuf>, String> {
    let artist = if plan.album_artist.trim().is_empty() { "Unknown Artist" } else { plan.album_artist.trim() };
    let dir = flac::album_dir(music, artist, &plan.album, plan.disc, plan.discs);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the folder {}: {e}", dir.display()))?;
    let cover = plan.cover.as_deref().and_then(decode_cover);
    if let Some((mime, bytes)) = &cover {
        let name = if mime == "image/png" { "cover.png" } else { "cover.jpg" };
        let _ = std::fs::write(dir.join(name), bytes);
    }
    let lengths: Vec<f32> = plan.tracks.iter().map(|t| disc.toc.span(t.number).map(|s| s.1 as f32).unwrap_or(1.0)).collect();
    let total: f32 = lengths.iter().sum::<f32>().max(1.0);
    let mut before = 0f32;
    let mut saved = Vec::new();
    for (i, t) in plan.tracks.iter().enumerate() {
        let base = before;
        let report = |f: f32| on_progress(Progress { at: i + 1, of: plan.tracks.len(), number: t.number, track: f, overall: (base + f * lengths[i]) / total });
        report(0.0);
        let samples = disc.read_track(t.number, &report, cancel)?;
        let path = dir.join(flac::track_file(t.number as u32, &t.title));
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
            disc_id: Some(disc.toc.disc_id()),
        };
        flac::write(&path, &samples, &tags, cover.as_ref().map(|(m, b)| (m.as_str(), b.as_slice())))?;
        before += lengths[i];
        report(1.0);
        saved.push(path);
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

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
        let files = rip(&disc, &plan, &music, &|p| seen.lock().unwrap().push(p.overall), &AtomicBool::new(false)).unwrap();
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
    fn stops_when_cancelled() {
        let root = std::env::temp_dir().join(format!("cdrip-cancel-{}", std::process::id()));
        let vol = root.join("CD");
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::write(vol.join(".TOC.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Sessions</key><array><dict><key>Leadout Block</key><integer>100</integer><key>Track Array</key><array><dict><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict></array></dict></array></dict></plist>"#).unwrap();
        let mut f = b"FORM\0\0\0\x30AIFFSSND\0\0\0\x28\0\0\0\0\0\0\0\0".to_vec();
        f.extend([0u8; 32]);
        std::fs::write(vol.join("1 Audio Track.aiff"), f).unwrap();
        let disc = mac_discs(&root).pop().unwrap();
        let plan = Plan { album: "A".into(), album_artist: "B".into(), year: None, release_id: None, disc: 1, discs: 1, tracks: vec![PlanTrack { number: 1, title: "x".into(), artist: "".into() }], cover: None };
        let err = rip(&disc, &plan, &root.join("Music"), &|_| {}, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err, "Stopped");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
