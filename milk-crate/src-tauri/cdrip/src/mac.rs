//! Audio CDs on a Mac: macOS mounts the disc under /Volumes as one AIFF file per
//! track ("1 Audio Track.aiff"…) plus a hidden .TOC.plist with the table of contents.
//! Only plain file reads are needed, so this also runs (and is tested) elsewhere.

use crate::toc::{RawTrack, Toc};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct MacDisc {
    pub volume: PathBuf,
    pub label: String,
    pub toc: Toc,
    /// Track number → its AIFF file.
    pub files: Vec<(u8, PathBuf)>,
}

/// Every audio CD mounted under `root` (normally /Volumes).
pub fn scan(root: &Path) -> Vec<MacDisc> {
    scan_with_notes(root).0
}

/// Audio CDs under `root`, plus notes on CD-looking volumes that couldn't be used and why.
pub fn scan_with_notes(root: &Path) -> (Vec<MacDisc>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return (out, notes) };
    for e in entries.flatten() {
        let volume = e.path();
        let label = volume.file_name().and_then(|n| n.to_str()).unwrap_or("Audio CD").to_string();
        let listing = match std::fs::read_dir(&volume) {
            Ok(l) => l,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::PermissionDenied && volume.join(".TOC.plist").exists() {
                    notes.push(format!("{label}: macOS is keeping Milk Crate out of the CD. Open System Settings › Privacy & Security › Files and Folders, and turn on Removable Volumes for Milk Crate."));
                }
                continue;
            }
        };
        let mut files: Vec<(u8, PathBuf)> = listing
            .flatten()
            .filter_map(|f| {
                let p = f.path();
                let name = p.file_name()?.to_str()?.to_string();
                if !name.to_lowercase().ends_with(".aiff") || name.starts_with('.') {
                    return None;
                }
                let n: u8 = name.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
                Some((n, p))
            })
            .collect();
        files.sort_by_key(|(n, _)| *n);
        let toc = match plist::Value::from_file(volume.join(".TOC.plist")) {
            Ok(v) => parse_toc(&v),
            // No readable table of contents: work it out from the track files (exact lengths; the
            // gaps between songs are unknown, so a lookup may only find near matches).
            Err(_) if !files.is_empty() => toc_from_files(&files),
            Err(_) => continue,
        };
        let Some(toc) = toc else {
            notes.push(format!("{label}: couldn't read the CD's track list"));
            continue;
        };
        if files.is_empty() {
            notes.push(format!("{label}: the disc in it has no music tracks (it's a data disc)"));
            continue;
        }
        out.push(MacDisc { volume, label, toc, files });
    }
    (out, notes)
}

/// A table of contents from the track files' lengths alone.
fn toc_from_files(files: &[(u8, PathBuf)]) -> Option<Toc> {
    let mut tracks = Vec::new();
    let mut at = 150u32;
    for (n, p) in files {
        tracks.push(RawTrack { number: *n, start: at, data: false });
        at += aiff_frames(p)?.div_ceil(588); // 588 stereo frames per CD sector
    }
    Toc::from_raw(&tracks, at)
}

/// Number of stereo sample frames in an AIFF file (from its COMM chunk).
fn aiff_frames(path: &Path) -> Option<u32> {
    let mut f = File::open(path).ok()?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).ok()?;
    loop {
        let mut ch = [0u8; 8];
        f.read_exact(&mut ch).ok()?;
        let size = u32::from_be_bytes([ch[4], ch[5], ch[6], ch[7]]) as i64;
        if &ch[0..4] == b"COMM" {
            let mut c = [0u8; 6];
            f.read_exact(&mut c).ok()?;
            return Some(u32::from_be_bytes([c[2], c[3], c[4], c[5]]));
        }
        f.seek(SeekFrom::Current(size + (size & 1))).ok()?;
    }
}

/// Whether macOS sees a CD drive, and what's in it (from `drutil status`), for when no disc shows up.
pub fn drive_note() -> Option<String> {
    let out = std::process::Command::new("drutil").arg("status").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if text.trim().is_empty() {
        return Some("macOS doesn't see a CD drive. Check it's plugged in (some USB drives need both plugs, or a powered port).".into());
    }
    let kind = text.lines().find_map(|l| l.trim().strip_prefix("Type:")).map(|t| t.trim().to_string());
    Some(match kind.as_deref() {
        Some(t) if t.contains("No Media") => "The CD drive is connected, but there's no disc in it.".into(),
        Some(t) if t.contains("CD-ROM") || t.contains("CD-R") => format!("The CD drive has a disc in it ({t}), but macOS hasn't opened it as an audio CD yet. Give it a few seconds, or check it shows up in Finder."),
        Some(t) => format!("The CD drive has a {t} in it, not an audio CD."),
        None => "The CD drive is connected.".into(),
    })
}

/// Reads .TOC.plist. Its "Start Block"s don't count the 2-second lead-in, so 150 is added.
pub fn parse_toc(v: &plist::Value) -> Option<Toc> {
    let sessions = v.as_dictionary()?.get("Sessions")?.as_array()?;
    let int = |d: &plist::Dictionary, k: &str| d.get(k).and_then(|x| x.as_signed_integer().or_else(|| x.as_unsigned_integer().map(|u| u as i64)));
    let mut tracks = Vec::new();
    let mut leadout = None;
    for s in sessions {
        let s = s.as_dictionary()?;
        if leadout.is_none() {
            leadout = int(s, "Leadout Block");
        }
        for t in s.get("Track Array")?.as_array()? {
            let t = t.as_dictionary()?;
            tracks.push(RawTrack {
                number: int(t, "Point")? as u8,
                start: int(t, "Start Block")? as u32 + 150,
                data: t.get("Data").and_then(|x| x.as_boolean()).unwrap_or(false),
            });
        }
    }
    tracks.sort_by_key(|t| t.number);
    Toc::from_raw(&tracks, leadout? as u32 + 150)
}

/// Reads one track's audio (interleaved 16-bit stereo, as i32 for the encoder).
pub fn read_track(disc: &MacDisc, n: u8, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<i32>, String> {
    let path = &disc.files.iter().find(|(x, _)| *x == n).ok_or(format!("Track {n} isn't on the disc"))?.1;
    read_aiff(path, progress, cancel)
}

/// Plays-straight-through AIFF reader: finds the SSND chunk and reads big-endian 16-bit PCM.
pub fn read_aiff(path: &Path, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<i32>, String> {
    let err = |e: std::io::Error| format!("Couldn't read {}: {e}", path.display());
    let mut f = File::open(path).map_err(err)?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).map_err(err)?;
    if &head[0..4] != b"FORM" || (&head[8..12] != b"AIFF" && &head[8..12] != b"AIFC") {
        return Err(format!("{} isn't an AIFF file", path.display()));
    }
    let mut channels = 2u16;
    let mut bits = 16u16;
    loop {
        let mut ch = [0u8; 8];
        f.read_exact(&mut ch).map_err(|_| format!("{} has no audio in it", path.display()))?;
        let size = u32::from_be_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
        match &ch[0..4] {
            b"COMM" => {
                let mut c = vec![0u8; size as usize];
                f.read_exact(&mut c).map_err(err)?;
                channels = u16::from_be_bytes([c[0], c[1]]);
                bits = u16::from_be_bytes([c[6], c[7]]);
            }
            b"SSND" => {
                let mut o = [0u8; 8];
                f.read_exact(&mut o).map_err(err)?;
                let offset = u32::from_be_bytes([o[0], o[1], o[2], o[3]]) as u64;
                f.seek(SeekFrom::Current(offset as i64)).map_err(err)?;
                if channels != 2 || bits != 16 {
                    return Err(format!("{} isn't CD audio ({channels} channels, {bits}-bit)", path.display()));
                }
                let total = size.saturating_sub(8 + offset) as usize;
                let mut samples = Vec::with_capacity(total / 2);
                let mut buf = vec![0u8; 2352 * 32];
                let mut done = 0usize;
                while done < total {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Stopped".into());
                    }
                    let want = buf.len().min(total - done);
                    f.read_exact(&mut buf[..want]).map_err(err)?;
                    samples.extend(buf[..want].chunks_exact(2).map(|b| i16::from_be_bytes([b[0], b[1]]) as i32));
                    done += want;
                    progress(done as f32 / total as f32);
                }
                return Ok(samples);
            }
            _ => {
                // Chunks are padded to an even length.
                f.seek(SeekFrom::Current((size + (size & 1)) as i64)).map_err(err)?;
            }
        }
    }
}

pub fn eject(disc: &MacDisc) -> Result<(), String> {
    let out = std::process::Command::new("diskutil").arg("eject").arg(&disc.volume).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aiff(samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_be_bytes()).collect();
        let mut comm = Vec::new();
        comm.extend(2u16.to_be_bytes());
        comm.extend(((samples.len() / 2) as u32).to_be_bytes());
        comm.extend(16u16.to_be_bytes());
        comm.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]); // 44100 as an 80-bit float
        let mut body = Vec::new();
        body.extend(b"AIFF");
        body.extend(b"COMM");
        body.extend((comm.len() as u32).to_be_bytes());
        body.extend(&comm);
        body.extend(b"SSND");
        body.extend(((data.len() + 8) as u32).to_be_bytes());
        body.extend([0u8; 8]);
        body.extend(&data);
        let mut f = b"FORM".to_vec();
        f.extend((body.len() as u32).to_be_bytes());
        f.extend(body);
        f
    }

    #[test]
    fn finds_a_mounted_cd_and_reads_its_tracks() {
        let root = std::env::temp_dir().join(format!("cdrip-vol-{}", std::process::id()));
        let vol = root.join("Audio CD");
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::create_dir_all(root.join("Macintosh HD")).unwrap();
        let toc = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Sessions</key><array><dict>
<key>First Track</key><integer>1</integer><key>Last Track</key><integer>2</integer>
<key>Leadout Block</key><integer>95312</integer><key>Session Number</key><integer>1</integer>
<key>Track Array</key><array>
<dict><key>Data</key><false/><key>Point</key><integer>1</integer><key>Start Block</key><integer>0</integer></dict>
<dict><key>Data</key><false/><key>Point</key><integer>2</integer><key>Start Block</key><integer>15213</integer></dict>
</array></dict></array></dict></plist>"#;
        std::fs::write(vol.join(".TOC.plist"), toc).unwrap();
        std::fs::write(vol.join("1 Audio Track.aiff"), aiff(&[1, -1, 300, -300])).unwrap();
        std::fs::write(vol.join("2 Audio Track.aiff"), aiff(&[5, 6])).unwrap();
        let discs = scan(&root);
        assert_eq!(discs.len(), 1);
        let d = &discs[0];
        assert_eq!(d.label, "Audio CD");
        assert_eq!(d.toc.offsets, vec![150, 15363]);
        assert_eq!(d.toc.leadout, 95462);
        assert_eq!(d.files.len(), 2);
        let cancel = AtomicBool::new(false);
        assert_eq!(read_track(d, 1, &|_| {}, &cancel).unwrap(), vec![1, -1, 300, -300]);
        assert_eq!(read_track(d, 2, &|_| {}, &cancel).unwrap(), vec![5, 6]);
        // Without a readable .TOC.plist, the track list comes from the files.
        std::fs::remove_file(vol.join(".TOC.plist")).unwrap();
        let d = scan(&root).pop().unwrap();
        assert_eq!(d.toc.offsets, vec![150, 151]);
        assert_eq!(d.toc.leadout, 152);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
