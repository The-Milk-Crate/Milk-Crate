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
        "https://musicbrainz.org/ws/2/discid/{id}?toc={}&inc=artist-credits+recordings+labels&cdstubs=no&fmt=json",
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
