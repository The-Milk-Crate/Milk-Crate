//! Saving a ripped track as a tagged FLAC file, and where it goes.

use flacenc::component::BitRepr;
use flacenc::error::Verify;
use metaflac::block::PictureType;
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Tags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track: u32,
    pub tracks: u32,
    pub disc: u32,
    pub discs: u32,
    pub year: Option<String>,
    pub release_id: Option<String>,
    pub disc_id: Option<String>,
    /// What it was ripped from: "CD", "Vinyl" (the MEDIA tag).
    pub media: Option<String>,
    /// MusicBrainz's id for the album across all its pressings (CD, vinyl, reissues): how a CD
    /// and a record of the same album are recognized as one album.
    pub release_group_id: Option<String>,
}

/// Encodes 16-bit stereo 44.1 kHz samples (interleaved L, R) to `path`, with tags and cover.
/// Writes to a temporary name first, so a half-written file never shows up as a song.
pub fn write(path: &Path, samples: &[i32], tags: &Tags, cover: Option<(&str, &[u8])>) -> Result<(), String> {
    write_at(path, samples, 44_100, tags, cover)
}

/// Like `write`, at another sample rate (a turntable recorded at 48 kHz, say).
pub fn write_at(path: &Path, samples: &[i32], rate: usize, tags: &Tags, cover: Option<(&str, &[u8])>) -> Result<(), String> {
    let config = flacenc::config::Encoder::default().into_verified().map_err(|e| format!("{e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(samples, 2, 16, rate);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size).map_err(|e| format!("Couldn't encode FLAC: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| format!("Couldn't encode FLAC: {e:?}"))?;

    let mut bytes = sink.as_slice().to_vec();
    fix_min_block_size(&mut bytes);
    let part = path.with_extension("flac.part");
    std::fs::write(&part, &bytes).map_err(|e| format!("Couldn't save {}: {e}", path.display()))?;
    let tagged = (|| {
        let mut tag = metaflac::Tag::read_from_path(&part).map_err(|e| e.to_string())?;
        let mut set = |k: &str, v: &str| {
            if !v.trim().is_empty() {
                tag.set_vorbis(k, vec![v.trim()]);
            }
        };
        set("TITLE", &tags.title);
        set("ARTIST", &tags.artist);
        set("ALBUM", &tags.album);
        set("ALBUMARTIST", &tags.album_artist);
        set("TRACKNUMBER", &tags.track.to_string());
        set("TRACKTOTAL", &tags.tracks.to_string());
        if tags.discs > 1 {
            set("DISCNUMBER", &tags.disc.to_string());
            set("DISCTOTAL", &tags.discs.to_string());
        }
        set("DATE", tags.year.as_deref().unwrap_or(""));
        set("MUSICBRAINZ_ALBUMID", tags.release_id.as_deref().unwrap_or(""));
        set("MUSICBRAINZ_DISCID", tags.disc_id.as_deref().unwrap_or(""));
        set("MUSICBRAINZ_RELEASEGROUPID", tags.release_group_id.as_deref().unwrap_or(""));
        set("MEDIA", tags.media.as_deref().unwrap_or(""));
        set("ENCODER", "Milk Crate");
        if let Some((mime, data)) = cover {
            tag.add_picture(mime, PictureType::CoverFront, data.to_vec());
        }
        tag.write_to_path(&part).map_err(|e| e.to_string())
    })();
    if let Err(e) = tagged {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Couldn't tag {}: {e}", path.display()));
    }
    std::fs::rename(&part, path).map_err(|e| format!("Couldn't save {}: {e}", path.display()))
}

/* ---------- Changing a song's audio after it's saved ---------- */

/// A song's samples (interleaved, 16-bit stereo) and its sample rate.
pub fn read_samples(path: &Path) -> Result<(Vec<i32>, usize), String> {
    let mut r = claxon::FlacReader::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let info = r.streaminfo();
    if info.bits_per_sample != 16 || !(1..=2).contains(&info.channels) {
        return Err("Only songs ripped or recorded by Milk Crate can be trimmed.".into());
    }
    let mono = info.channels == 1;
    let mut out = Vec::with_capacity(info.samples.unwrap_or(0) as usize * 2);
    for s in r.samples() {
        let s = s.map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        out.push(s);
        if mono {
            out.push(s);
        }
    }
    Ok((out, info.sample_rate as usize))
}

/// Puts new audio (16-bit stereo at `rate`) in place of `target`'s, keeping every tag and picture it has.
pub fn replace_audio(target: &Path, samples: &[i32], rate: usize) -> Result<(), String> {
    if samples.len() < rate * 2 {
        return Err("That's less than a second of sound.".into());
    }
    let old = metaflac::Tag::read_from_path(target).map_err(|e| format!("Couldn't open {}: {e}", target.display()))?;
    let tmp = target.with_extension("new.flac");
    write_at(&tmp, samples, rate, &Tags::default(), None)?;
    let done = (|| {
        let mut tag = metaflac::Tag::read_from_path(&tmp).map_err(|e| e.to_string())?;
        tag.remove_blocks(metaflac::BlockType::VorbisComment);
        tag.remove_blocks(metaflac::BlockType::Picture);
        if let Some(vc) = old.vorbis_comments() {
            for (k, v) in &vc.comments {
                tag.set_vorbis(k.clone(), v.clone());
            }
        }
        for p in old.pictures() {
            tag.add_picture(p.mime_type.clone(), p.picture_type, p.data.clone());
        }
        tag.write_to_path(&tmp).map_err(|e| e.to_string())
    })();
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't save {}: {e}", target.display()));
    }
    std::fs::rename(&tmp, target).map_err(|e| format!("Couldn't save {}: {e}", target.display()))
}

/// Cuts `cut_start` seconds off the start of a song and `cut_end` off its end. Returns its new length (seconds).
pub fn trim(path: &Path, cut_start: f64, cut_end: f64) -> Result<f64, String> {
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("flac")) {
        return Err("Only songs ripped or recorded by Milk Crate can be trimmed.".into());
    }
    let (samples, rate) = read_samples(path)?;
    let frames = samples.len() / 2;
    let from = ((cut_start.max(0.0) * rate as f64) as usize).min(frames);
    let to = frames.saturating_sub((cut_end.max(0.0) * rate as f64) as usize).max(from);
    if to - from < rate {
        return Err("That would leave less than a second of the song.".into());
    }
    replace_audio(path, &samples[from * 2..to * 2], rate)?;
    Ok((to - from) as f64 / rate as f64)
}

/// The encoder counts a song's short last block in STREAMINFO's "minimum block size". When that
/// block is under 16 samples the header looks invalid to some decoders (Windows' WebView2 among
/// them: the song sat at 0:00 in Milk Crate while other players were fine). The spec leaves the
/// last block out of the minimum, so it's set to the maximum (every other block's size).
/// Returns true if it changed anything.
pub fn fix_min_block_size(head: &mut [u8]) -> bool {
    // "fLaC", then the STREAMINFO block header (4 bytes), then min (2 bytes) and max (2 bytes).
    if head.len() < 12 || &head[..4] != b"fLaC" || head[4] & 0x7f != 0 {
        return false;
    }
    let min = u16::from_be_bytes([head[8], head[9]]);
    let max = u16::from_be_bytes([head[10], head[11]]);
    if min >= 16 || max < 16 {
        return false;
    }
    head[8] = head[10];
    head[9] = head[11];
    true
}

/// Repairs a FLAC file saved before `fix_min_block_size` existed, in place (two bytes of its header).
/// Returns true if the file was changed.
pub fn repair_file(path: &Path) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let mut head = [0u8; 12];
    if f.read(&mut head)? < 12 || !fix_min_block_size(&mut head) {
        return Ok(false);
    }
    f.seek(SeekFrom::Start(8))?;
    f.write_all(&head[8..10])?;
    Ok(true)
}

/// A name that's safe as a file or folder on Windows and Mac.
pub fn safe_name(s: &str, fallback: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    let mut out: String = trimmed.chars().take(120).collect();
    // Names Windows keeps for itself.
    let upper = out.to_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem) || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit()) {
        out.insert(0, '_');
    }
    if out.is_empty() { fallback.to_string() } else { out }
}

/// Music › Milk Crate › Artist › Album (Disc 2 for a multi-disc set).
pub fn album_dir(music: &Path, artist: &str, album: &str, disc: u32, discs: u32) -> PathBuf {
    let mut dir = music.join("Milk Crate").join(safe_name(artist, "Unknown Artist")).join(safe_name(album, "Unknown Album"));
    if discs > 1 {
        dir = dir.join(format!("Disc {disc}"));
    }
    dir
}

/// "01 Song Title.flac"
pub fn track_file(n: u32, title: &str) -> String {
    format!("{n:02} {}.flac", safe_name(title, &format!("Track {n:02}")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn short_last_block_is_left_out_of_the_minimum() {
        let mut h = *b"fLaC\x00\x00\x00\x22\x00\x04\x10\x00";
        assert!(super::fix_min_block_size(&mut h));
        assert_eq!(&h[8..12], &[0x10, 0x00, 0x10, 0x00]);
        assert!(!super::fix_min_block_size(&mut h), "already fine");
        let mut not_flac = *b"RIFF\x00\x00\x00\x22\x00\x04\x10\x00";
        assert!(!super::fix_min_block_size(&mut not_flac));
    }

    #[test]
    fn written_files_have_a_valid_minimum() {
        // 4096 * 3 + 4 samples per channel: the last block is 4 samples long.
        let n = 4096 * 3 + 4;
        let samples: Vec<i32> = (0..n * 2).map(|i| ((i as f64 * 0.01).sin() * 8000.0) as i32).collect();
        let dir = std::env::temp_dir().join(format!("cdrip-minblk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.flac");
        super::write(&path, &samples, &super::Tags { title: "t".into(), track: 1, tracks: 1, disc: 1, discs: 1, ..Default::default() }, None).unwrap();
        let b = std::fs::read(&path).unwrap();
        assert!(u16::from_be_bytes([b[8], b[9]]) >= 16);
        std::fs::remove_dir_all(&dir).ok();
    }

    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("AC/DC: Live?", "x"), "AC_DC_ Live_");
        assert_eq!(safe_name("  Trailing dots... ", "x"), "Trailing dots");
        assert_eq!(safe_name("con", "x"), "_con");
        assert_eq!(safe_name("   ", "Unknown"), "Unknown");
        assert_eq!(track_file(3, "Wash Your Tongue"), "03 Wash Your Tongue.flac");
        assert_eq!(track_file(12, ""), "12 Track 12.flac");
        let d = album_dir(Path::new("/m"), "Pamelo", "Cavities", 2, 2);
        assert_eq!(d, Path::new("/m/Milk Crate/Pamelo/Cavities/Disc 2"));
    }

    #[test]
    fn trims_and_keeps_tags() {
        let dir = std::env::temp_dir().join(format!("cdrip-trim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("01 Song.flac");
        let samples: Vec<i32> = (0..44_100 * 2 * 5).map(|i| ((i as f32 * 0.01).sin() * 5000.0) as i32).collect();
        let tags = super::Tags { title: "Song".into(), artist: "Band".into(), track: 1, tracks: 1, disc: 1, discs: 1, media: Some("Vinyl".into()), ..Default::default() };
        super::write(&f, &samples, &tags, Some(("image/png", b"\x89PNGfake"))).unwrap();
        let secs = super::trim(&f, 1.0, 1.5).unwrap();
        assert!((secs - 2.5).abs() < 0.01, "{secs}");
        let (back, rate) = super::read_samples(&f).unwrap();
        assert_eq!(rate, 44_100);
        assert_eq!(back.len(), (44_100.0 * 2.5) as usize * 2);
        let t = metaflac::Tag::read_from_path(&f).unwrap();
        assert_eq!(t.get_vorbis("TITLE").and_then(|mut v| v.next()), Some("Song"));
        assert_eq!(t.get_vorbis("MEDIA").and_then(|mut v| v.next()), Some("Vinyl"));
        assert_eq!(t.pictures().count(), 1);
        assert!(super::trim(&f, 2.0, 0.6).is_err(), "can't leave under a second");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_a_tagged_flac_that_reads_back() {
        let dir = std::env::temp_dir().join(format!("cdrip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("01 Test.flac");
        // One second of a 440 Hz tone, stereo.
        let samples: Vec<i32> = (0..44_100)
            .flat_map(|i| {
                let v = ((i as f64 * 440.0 * std::f64::consts::TAU / 44_100.0).sin() * 12_000.0) as i32;
                [v, -v]
            })
            .collect();
        let tags = Tags { title: "Test".into(), artist: "Pamelo".into(), album: "Cavities".into(), album_artist: "Pamelo".into(), track: 1, tracks: 9, disc: 1, discs: 1, year: Some("2024".into()), release_id: Some("rel".into()), disc_id: Some("id".into()), ..Default::default() };
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        write(&path, &samples, &tags, Some(("image/jpeg", &jpeg))).unwrap();
        assert!(!path.with_extension("flac.part").exists());
        let tag = metaflac::Tag::read_from_path(&path).unwrap();
        let vc = tag.vorbis_comments().unwrap();
        assert_eq!(vc.title().unwrap()[0], "Test");
        assert_eq!(vc.album().unwrap()[0], "Cavities");
        assert_eq!(vc.track(), Some(1));
        assert!(vc.get("DISCNUMBER").is_none());
        let pic = tag.pictures().next().unwrap();
        assert_eq!(pic.mime_type, "image/jpeg");
        assert_eq!(pic.data, jpeg);
        let info = tag.get_streaminfo().unwrap();
        assert_eq!((info.num_channels, info.sample_rate, info.total_samples), (2, 44_100, 44_100));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
