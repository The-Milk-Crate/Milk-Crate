//! A CD's table of contents and its MusicBrainz disc ID.
//!
//! Offsets here are absolute sector numbers the way MusicBrainz counts them: the
//! first track usually starts at 150 (the 2-second lead-in). One sector is 1/75 s,
//! 2,352 bytes of 16-bit stereo 44.1 kHz audio.

use base64::Engine;
use serde::Serialize;
use sha1::{Digest, Sha1};

pub const SECTOR_BYTES: usize = 2352;
pub const SECTORS_PER_SECOND: u32 = 75;
/// On an enhanced CD (audio, then a data session) the data session starts this
/// many sectors after the audio's real end.
pub const DATA_SESSION_GAP: u32 = 11_400;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Toc {
    /// First and last audio track numbers.
    pub first: u8,
    pub last: u8,
    /// Start of each audio track first..=last (absolute sectors, lead-in included).
    pub offsets: Vec<u32>,
    /// Where the audio ends (absolute sectors).
    pub leadout: u32,
}

/// One entry from a drive's raw table of contents.
#[derive(Clone, Copy, Debug)]
pub struct RawTrack {
    pub number: u8,
    /// Absolute sectors (lead-in included).
    pub start: u32,
    pub data: bool,
}

impl Toc {
    /// Builds the audio part of a TOC. A data track after the audio (enhanced CD)
    /// is left out, and the audio is taken to end where MusicBrainz says it does.
    pub fn from_raw(tracks: &[RawTrack], leadout: u32) -> Option<Toc> {
        let audio: Vec<&RawTrack> = tracks.iter().filter(|t| !t.data).collect();
        let first = audio.first()?;
        let last = audio.last()?;
        // A data track right after the last audio one: audio ends a session gap before it.
        let after = tracks.iter().find(|t| t.number == last.number + 1 && t.data);
        let end = match after {
            Some(d) => d.start.saturating_sub(DATA_SESSION_GAP),
            None => leadout,
        };
        Some(Toc {
            first: first.number,
            last: last.number,
            offsets: audio.iter().map(|t| t.start).collect(),
            leadout: end,
        })
    }

    pub fn count(&self) -> usize {
        self.offsets.len()
    }

    /// Start and length in sectors of track `n` (absolute start, lead-in included).
    pub fn span(&self, n: u8) -> Option<(u32, u32)> {
        let i = n.checked_sub(self.first)? as usize;
        let start = *self.offsets.get(i)?;
        let end = self.offsets.get(i + 1).copied().unwrap_or(self.leadout);
        Some((start, end.saturating_sub(start)))
    }

    pub fn seconds(&self, n: u8) -> f64 {
        self.span(n).map(|(_, len)| len as f64 / SECTORS_PER_SECOND as f64).unwrap_or(0.0)
    }

    /// The MusicBrainz disc ID (https://musicbrainz.org/doc/Disc_ID_Calculation).
    pub fn disc_id(&self) -> String {
        let mut s = format!("{:02X}{:02X}{:08X}", self.first, self.last, self.leadout);
        for i in 0..99 {
            s.push_str(&format!("{:08X}", self.offsets.get(i).copied().unwrap_or(0)));
        }
        let hash = Sha1::digest(s.as_bytes());
        base64::engine::general_purpose::STANDARD
            .encode(hash)
            .replace('+', ".")
            .replace('/', "_")
            .replace('=', "-")
    }

    /// The `toc` lookup parameter, for finding near matches when the exact disc ID isn't known.
    pub fn query(&self) -> String {
        let mut parts = vec![self.first.to_string(), self.last.to_string(), self.leadout.to_string()];
        parts.extend(self.offsets.iter().map(|o| o.to_string()));
        parts.join("+")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Toc {
        Toc { first: 1, last: 6, offsets: vec![150, 15363, 32314, 46592, 63414, 80489], leadout: 95462 }
    }

    #[test]
    fn disc_id_matches_musicbrainz_example() {
        // The worked example from libdiscid / python-discid.
        assert_eq!(sample().disc_id(), "49HHV7Eb8UKF3aQiNmu1GR8vKTY-");
    }

    #[test]
    fn query_and_spans() {
        let t = sample();
        assert_eq!(t.query(), "1+6+95462+150+15363+32314+46592+63414+80489");
        assert_eq!(t.span(1), Some((150, 15213)));
        assert_eq!(t.span(6), Some((80489, 95462 - 80489)));
        assert_eq!(t.span(7), None);
        assert!((t.seconds(1) - 202.84).abs() < 0.01);
    }

    #[test]
    fn enhanced_cd_leaves_out_the_data_track() {
        let raw = [
            RawTrack { number: 1, start: 150, data: false },
            RawTrack { number: 2, start: 20000, data: false },
            RawTrack { number: 3, start: 60000, data: true },
        ];
        let t = Toc::from_raw(&raw, 90000).unwrap();
        assert_eq!((t.first, t.last), (1, 2));
        assert_eq!(t.leadout, 60000 - DATA_SESSION_GAP);
        assert_eq!(t.offsets, vec![150, 20000]);
    }
}
