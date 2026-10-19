//! Finding a CD's album, track names and cover: MusicBrainz (free, open music
//! database) by disc ID, and the Cover Art Archive for the front cover.

use crate::toc::Toc;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const USER_AGENT: &str = concat!("MilkCrate/", env!("CARGO_PKG_VERSION"), " ( https://github.com/The-Milk-Crate/Milk-Crate )");

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// MusicBrainz release ID (also finds the cover).
    pub release_id: String,
    /// The album across all its pressings (see flac::Tags::release_group_id).
    pub release_group_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub year: Option<String>,
    /// Which disc of a set this CD is, and how many there are.
    pub disc: u32,
    pub discs: u32,
    /// "CD · US · 2019 · label" to tell editions apart.
    pub detail: String,
    pub tracks: Vec<MatchTrack>,
    /// True when the disc ID matched exactly (not just a similar track layout).
    pub exact: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MatchTrack {
    pub title: String,
    pub artist: String,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Looks the CD up. No matches is `Ok(vec![])`; only network trouble is an error.
pub fn lookup(toc: &Toc) -> Result<Vec<Match>, String> {
    let id = toc.disc_id();
    let url = format!(
        "https://musicbrainz.org/ws/2/discid/{id}?toc={}&inc=artist-credits+recordings+labels+release-groups&cdstubs=no&fmt=json",
        toc.query()
    );
    let mut res = agent().get(&url).call().map_err(|e| format!("Couldn't reach MusicBrainz: {e}"))?;
    if res.status() == 404 {
        return Ok(vec![]);
    }
    if !res.status().is_success() {
        return Err(format!("MusicBrainz answered {}", res.status()));
    }
    let text = res.body_mut().read_to_string().map_err(|e| format!("Couldn't read MusicBrainz's answer: {e}"))?;
    let body: Value = serde_json::from_str(&text).map_err(|e| format!("Couldn't read MusicBrainz's answer: {e}"))?;
    Ok(parse(&body, &id, toc.count()))
}

/// The front cover (about 500px), with its MIME type. None when the release has no cover there.
pub fn cover(release_id: &str) -> Option<(String, Vec<u8>)> {
    let url = format!("https://coverartarchive.org/release/{release_id}/front-500");
    let mut res = agent().get(&url).call().ok()?;
    if !res.status().is_success() {
        return None;
    }
    let bytes = res.body_mut().with_config().limit(15 * 1024 * 1024).read_to_vec().ok()?;
    let mime = image_mime(&bytes)?;
    Some((mime.to_string(), bytes))
}

pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else {
        None
    }
}

fn credit(v: &Value) -> String {
    v.as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|p| {
                    let name = p["name"].as_str().or(p["artist"]["name"].as_str()).unwrap_or("");
                    format!("{name}{}", p["joinphrase"].as_str().unwrap_or(""))
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// Turns MusicBrainz's answer into matches: for each release, the disc (medium) that is this CD.
pub fn parse(body: &Value, disc_id: &str, track_count: usize) -> Vec<Match> {
    let mut out = Vec::new();
    for rel in body["releases"].as_array().into_iter().flatten() {
        let media = rel["media"].as_array().cloned().unwrap_or_default();
        let has_id = |m: &Value| m["discs"].as_array().is_some_and(|d| d.iter().any(|x| x["id"] == disc_id));
        let exact = media.iter().position(has_id);
        let pick = exact.or_else(|| {
            media.iter().position(|m| m["track-count"].as_u64() == Some(track_count as u64) || m["tracks"].as_array().map(|t| t.len()) == Some(track_count))
        });
        let Some(i) = pick else { continue };
        let medium = &media[i];
        let artist = credit(&rel["artist-credit"]);
        let tracks: Vec<MatchTrack> = medium["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                let title = t["title"].as_str().or(t["recording"]["title"].as_str()).unwrap_or("").to_string();
                let who = credit(&t["artist-credit"]);
                MatchTrack { title, artist: if who.is_empty() { artist.clone() } else { who } }
            })
            .collect();
        if tracks.len() != track_count {
            continue;
        }
        let year = rel["date"].as_str().filter(|d| d.len() >= 4).map(|d| d[..4].to_string());
        let label = rel["label-info"]
            .as_array()
            .and_then(|l| l.iter().find_map(|x| x["label"]["name"].as_str()))
            .map(str::to_string);
        let format = medium["format"].as_str().map(str::to_string);
        let detail = [format, rel["country"].as_str().map(str::to_string), year.clone(), label]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        out.push(Match {
            release_id: rel["id"].as_str().unwrap_or("").to_string(),
            release_group_id: rel["release-group"]["id"].as_str().map(str::to_string),
            title: rel["title"].as_str().unwrap_or("").to_string(),
            artist,
            year,
            disc: medium["position"].as_u64().unwrap_or(1) as u32,
            discs: media.len().max(1) as u32,
            detail,
            tracks,
            exact: exact.is_some(),
        });
    }
    // Exact disc ID matches first.
    out.sort_by_key(|m| !m.exact);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_matching_disc_of_a_set() {
        let body = json!({
            "releases": [{
                "id": "rel-1", "title": "Big Box", "date": "2019-05-03", "country": "US",
                "artist-credit": [{"name": "Pamelo", "joinphrase": " & "}, {"name": "Friends", "joinphrase": ""}],
                "label-info": [{"label": {"name": "Merge"}}],
                "media": [
                    {"position": 1, "format": "CD", "track-count": 2, "discs": [{"id": "other"}],
                     "tracks": [{"title": "A"}, {"title": "B"}]},
                    {"position": 2, "format": "CD", "track-count": 2, "discs": [{"id": "THEID"}],
                     "tracks": [{"title": "Way Out"}, {"title": "Valentine", "artist-credit": [{"name": "Guest"}]}]}
                ]
            }]
        });
        let m = parse(&body, "THEID", 2);
        assert_eq!(m.len(), 1);
        let m = &m[0];
        assert!(m.exact);
        assert_eq!((m.disc, m.discs), (2, 2));
        assert_eq!(m.artist, "Pamelo & Friends");
        assert_eq!(m.year.as_deref(), Some("2019"));
        assert_eq!(m.detail, "CD · US · 2019 · Merge");
        assert_eq!(m.tracks[0], MatchTrack { title: "Way Out".into(), artist: "Pamelo & Friends".into() });
        assert_eq!(m.tracks[1].artist, "Guest");
    }

    #[test]
    fn near_match_by_track_count_and_wrong_counts_dropped() {
        let body = json!({ "releases": [
            { "id": "a", "title": "Close", "media": [{"position": 1, "track-count": 3, "tracks": [{"title":"1"},{"title":"2"},{"title":"3"}]}] },
            { "id": "b", "title": "Wrong", "media": [{"position": 1, "track-count": 5, "tracks": []}] }
        ]});
        let m = parse(&body, "nope", 3);
        assert_eq!(m.len(), 1);
        assert!(!m[0].exact);
        assert_eq!(m[0].title, "Close");
    }

    #[test]
    fn detects_images() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(image_mime(b"<html>"), None);
    }
}

/* ---------- Records (vinyl) ---------- */

/// A pressing found by searching (records have no disc ID to look up).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pressing {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<String>,
    /// '12" Vinyl · US · 1991 · Epic' to tell pressings apart.
    pub detail: String,
    pub tracks: u32,
    /// A record (any vinyl format), as opposed to a CD or tape of the same album.
    pub vinyl: bool,
}

/// One side of a record: "A", "B"… and its songs in order.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub label: String,
    /// Which record of a set (1 for a single LP).
    pub disc: u32,
    pub tracks: Vec<SideTrack>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideTrack {
    /// "A1", "B3"…
    pub position: String,
    pub title: String,
    pub artist: String,
    /// From MusicBrainz, when it knows.
    pub seconds: Option<f64>,
}

/// A pressing with its sides, for recording it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordInfo {
    pub release_id: String,
    pub release_group_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub year: Option<String>,
    pub discs: u32,
    pub sides: Vec<Side>,
}

fn get_json(url: &str) -> Result<Option<Value>, String> {
    let mut res = agent().get(url).call().map_err(|e| format!("Couldn't reach MusicBrainz: {e}"))?;
    if res.status() == 404 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("MusicBrainz answered {}", res.status()));
    }
    let text = res.body_mut().read_to_string().map_err(|e| format!("Couldn't read MusicBrainz's answer: {e}"))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("Couldn't read MusicBrainz's answer: {e}"))
}

fn encode(q: &str) -> String {
    q.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Search for a record by artist and album ("pearl jam ten"), or by the barcode on its sleeve.
/// Records first, then other pressings of the same albums.
pub fn search_pressings(query: &str) -> Result<Vec<Pressing>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let digits: String = q.chars().filter(|c| !c.is_whitespace()).collect();
    let url = if digits.len() >= 8 && digits.chars().all(|c| c.is_ascii_digit()) {
        format!("https://musicbrainz.org/ws/2/release?query=barcode:{digits}&limit=25&fmt=json")
    } else {
        format!("https://musicbrainz.org/ws/2/release?query={}&dismax=true&limit=50&fmt=json", encode(q))
    };
    Ok(get_json(&url)?.map(|b| parse_pressings(&b)).unwrap_or_default())
}

pub fn parse_pressings(body: &Value) -> Vec<Pressing> {
    let mut out: Vec<Pressing> = body["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|rel| {
            let formats: Vec<String> = rel["media"].as_array().into_iter().flatten().filter_map(|m| m["format"].as_str().map(str::to_string)).collect();
            let vinyl = formats.iter().any(|f| is_vinyl(f));
            let year = rel["date"].as_str().filter(|d| d.len() >= 4).map(|d| d[..4].to_string());
            let label = rel["label-info"].as_array().and_then(|l| l.iter().find_map(|x| x["label"]["name"].as_str())).map(str::to_string);
            let count = formats.len();
            let format = formats.first().map(|f| if count > 1 { format!("{count}×{f}") } else { f.clone() });
            let detail = [format, rel["country"].as_str().map(str::to_string), year.clone(), label].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            Pressing {
                release_id: rel["id"].as_str().unwrap_or("").to_string(),
                title: rel["title"].as_str().unwrap_or("").to_string(),
                artist: credit(&rel["artist-credit"]),
                year,
                detail,
                tracks: rel["track-count"].as_u64().unwrap_or(0) as u32,
                vinyl,
            }
        })
        .filter(|p| !p.release_id.is_empty())
        .collect();
    out.sort_by_key(|p| !p.vinyl); // stable: MusicBrainz's order within each group
    out
}

fn is_vinyl(format: &str) -> bool {
    let f = format.to_ascii_lowercase();
    f.contains("vinyl") || f.contains('"') || f.contains("lp") || f.contains("shellac")
}

/// A pressing's sides and songs. Vinyl tracks are numbered A1, A2… B1…; anything else is
/// split down the middle of each record (the closest guess).
pub fn record_info(release_id: &str) -> Result<Option<RecordInfo>, String> {
    if !release_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("That isn't a MusicBrainz release.".into());
    }
    let url = format!("https://musicbrainz.org/ws/2/release/{release_id}?inc=artist-credits+recordings+release-groups&fmt=json");
    Ok(get_json(&url)?.map(|b| parse_record(&b)))
}

pub fn parse_record(rel: &Value) -> RecordInfo {
    let artist = credit(&rel["artist-credit"]);
    let media = rel["media"].as_array().cloned().unwrap_or_default();
    let mut sides: Vec<Side> = Vec::new();
    for (mi, m) in media.iter().enumerate() {
        let disc = m["position"].as_u64().unwrap_or(mi as u64 + 1) as u32;
        let tracks: Vec<(String, SideTrack)> = m["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                let number = t["number"].as_str().unwrap_or("").trim().to_string();
                let letter: String = number.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase();
                let who = credit(&t["artist-credit"]);
                let ms = t["length"].as_f64().or(t["recording"]["length"].as_f64());
                (letter, SideTrack {
                    position: number,
                    title: t["title"].as_str().or(t["recording"]["title"].as_str()).unwrap_or("").to_string(),
                    artist: if who.is_empty() { artist.clone() } else { who },
                    seconds: ms.map(|v| v / 1000.0),
                })
            })
            .collect();
        if !tracks.is_empty() && tracks.iter().all(|(l, _)| !l.is_empty()) {
            for (letter, t) in tracks {
                match sides.last_mut() {
                    Some(s) if s.label == letter && s.disc == disc => s.tracks.push(t),
                    _ => sides.push(Side { label: letter, disc, tracks: vec![t] }),
                }
            }
        } else if !tracks.is_empty() {
            // No side letters: two sides per record, split where the time is closest to half.
            let total: f64 = tracks.iter().map(|(_, t)| t.seconds.unwrap_or(0.0)).sum();
            let mut acc = 0.0;
            let mut cut = tracks.len().div_ceil(2);
            if total > 0.0 {
                let mut best = f64::MAX;
                for (i, (_, t)) in tracks.iter().enumerate() {
                    acc += t.seconds.unwrap_or(0.0);
                    let d = (acc - total / 2.0).abs();
                    if d < best && i + 1 < tracks.len() {
                        best = d;
                        cut = i + 1;
                    }
                }
            }
            let base = (b'A' + (sides.len() as u8).min(24)) as char;
            let next = (base as u8 + 1) as char;
            let (a, b): (Vec<_>, Vec<_>) = tracks.into_iter().enumerate().partition(|(i, _)| *i < cut);
            sides.push(Side { label: base.to_string(), disc, tracks: a.into_iter().map(|(_, (_, t))| t).collect() });
            if !b.is_empty() {
                sides.push(Side { label: next.to_string(), disc, tracks: b.into_iter().map(|(_, (_, t))| t).collect() });
            }
        }
    }
    RecordInfo {
        release_id: rel["id"].as_str().unwrap_or("").to_string(),
        release_group_id: rel["release-group"]["id"].as_str().map(str::to_string),
        title: rel["title"].as_str().unwrap_or("").to_string(),
        artist,
        year: rel["date"].as_str().filter(|d| d.len() >= 4).map(|d| d[..4].to_string()),
        discs: media.len().max(1) as u32,
        sides,
    }
}

#[cfg(test)]
mod record_tests {
    use super::*;

    #[test]
    fn reads_sides_from_vinyl_positions() {
        let rel = serde_json::json!({
            "id": "r1", "title": "Ten", "date": "1991-08-27", "release-group": {"id": "g1"},
            "artist-credit": [{"name": "Pearl Jam", "joinphrase": ""}],
            "media": [{"position": 1, "format": "12\" Vinyl", "tracks": [
                {"number": "A1", "title": "Once", "length": 231000},
                {"number": "A2", "title": "Even Flow", "length": 293000},
                {"number": "B1", "title": "Oceans", "length": 161000}
            ]}]
        });
        let r = parse_record(&rel);
        assert_eq!(r.release_group_id.as_deref(), Some("g1"));
        assert_eq!(r.sides.len(), 2);
        assert_eq!(r.sides[0].label, "A");
        assert_eq!(r.sides[0].tracks.len(), 2);
        assert_eq!(r.sides[1].tracks[0].title, "Oceans");
        assert_eq!(r.sides[0].tracks[1].seconds, Some(293.0));
    }

    #[test]
    fn guesses_sides_without_letters() {
        let rel = serde_json::json!({
            "id": "r2", "title": "X", "artist-credit": [{"name": "Band"}],
            "media": [{"position": 1, "tracks": [
                {"number": "1", "title": "a", "length": 300000}, {"number": "2", "title": "b", "length": 300000},
                {"number": "3", "title": "c", "length": 300000}, {"number": "4", "title": "d", "length": 300000}
            ]}]
        });
        let r = parse_record(&rel);
        assert_eq!(r.sides.iter().map(|s| s.tracks.len()).collect::<Vec<_>>(), vec![2, 2]);
        assert_eq!(r.sides[1].label, "B");
    }

    #[test]
    fn records_come_first() {
        let body = serde_json::json!({"releases": [
            {"id": "cd", "title": "Ten", "media": [{"format": "CD"}], "artist-credit": [{"name": "Pearl Jam"}]},
            {"id": "lp", "title": "Ten", "media": [{"format": "12\" Vinyl"}], "artist-credit": [{"name": "Pearl Jam"}]}
        ]});
        let p = parse_pressings(&body);
        assert_eq!(p[0].release_id, "lp");
        assert!(p[0].vinyl && !p[1].vinyl);
    }
}
