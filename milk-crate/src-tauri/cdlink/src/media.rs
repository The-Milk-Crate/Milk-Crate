//! A tiny web server on this computer only (127.0.0.1), for the app's own player: it streams song
//! files from disk with proper byte ranges and audio types. macOS's web view doesn't reliably play
//! audio from the app's built-in file protocol, but it plays from http just fine.
//! Every request needs the secret token in its path, and only audio files are served.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const AUDIO: [(&str, &str); 8] = [
    ("flac", "audio/flac"), ("mp3", "audio/mpeg"), ("m4a", "audio/mp4"), ("aac", "audio/aac"),
    ("ogg", "audio/ogg"), ("opus", "audio/ogg"), ("wav", "audio/wav"), ("aiff", "audio/aiff"),
];

/// Starts the server. Returns its base URL ("http://127.0.0.1:PORT/TOKEN/"); add the file's
/// percent-encoded full path after it.
pub fn start() -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let token = super::new_token();
    let t = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let t = t.clone();
            std::thread::spawn(move || {
                let _ = serve(stream, &t);
            });
        }
    });
    Ok(format!("http://127.0.0.1:{port}/{token}/"))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The file a request path names, if the token matches and it's an audio file.
pub fn file_for(request_path: &str, token: &str) -> Option<(PathBuf, &'static str)> {
    let rest = request_path.strip_prefix('/')?.strip_prefix(token)?.strip_prefix('/')?;
    let rest = rest.split(['?', '#']).next()?;
    let path = PathBuf::from(percent_decode(rest)?);
    if !path.is_absolute() {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = AUDIO.iter().find(|(e, _)| *e == ext)?.1;
    Some((path, mime))
}

/// "bytes=START-END" → (start, end inclusive), within `len`.
pub fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let r = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len.checked_sub(1)?)
    } else {
        let s: u64 = a.parse().ok()?;
        let e: u64 = if b.is_empty() { len.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(len.checked_sub(1)?) };
        (s, e)
    };
    (start <= end && end < len).then_some((start, end))
}

fn serve(stream: TcpStream, token: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("").to_string());
        let mut range = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_string());
                }
            }
        }
        let cors = "Access-Control-Allow-Origin: *\r\n";
        if method == "OPTIONS" {
            write!(out, "HTTP/1.1 204 No Content\r\n{cors}Access-Control-Allow-Headers: Range\r\nContent-Length: 0\r\n\r\n")?;
            continue;
        }
        let Some((file, mime)) = file_for(&path, token).filter(|_| method == "GET" || method == "HEAD") else {
            write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        };
        let Ok(mut f) = std::fs::File::open(&file) else {
            write!(out, "HTTP/1.1 404 Not Found\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        };
        let len = f.metadata()?.len();
        let (status, start, end) = match range.as_deref().map(|r| parse_range(r, len)) {
            Some(Some((s, e))) => ("206 Partial Content", s, e),
            Some(None) => {
                write!(out, "HTTP/1.1 416 Range Not Satisfiable\r\n{cors}Content-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n")?;
                continue;
            }
            None => ("200 OK", 0, len.saturating_sub(1)),
        };
        let count = if len == 0 { 0 } else { end - start + 1 };
        let content_range = if status.starts_with("206") { format!("Content-Range: bytes {start}-{end}/{len}\r\n") } else { String::new() };
        write!(out, "HTTP/1.1 {status}\r\n{cors}Content-Type: {mime}\r\nAccept-Ranges: bytes\r\n{content_range}Content-Length: {count}\r\nCache-Control: no-store\r\n\r\n")?;
        if method == "HEAD" || count == 0 {
            continue;
        }
        f.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut (&mut f).take(count), &mut out)?;
        out.flush()?;
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
    }

    #[test]
    fn only_audio_with_the_token() {
        let p = if cfg!(windows) { "/tok/C%3A%5CMusic%5Ca%20b.flac" } else { "/tok/%2FUsers%2Fb%2FMusic%2Fa%20b.flac" };
        let (f, m) = file_for(p, "tok").unwrap();
        assert!(f.to_string_lossy().ends_with("a b.flac"));
        assert_eq!(m, "audio/flac");
        assert!(file_for(p, "other").is_none());
        assert!(file_for("/tok/%2Fetc%2Fpasswd", "tok").is_none());
        assert!(file_for("/tok/relative.flac", "tok").is_none());
    }

    #[test]
    fn serves_with_ranges() {
        let dir = std::env::temp_dir().join(format!("cdlink-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.flac");
        std::fs::write(&f, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let base = start().unwrap();
        let enc: String = f.to_string_lossy().bytes().map(|b| if b.is_ascii_alphanumeric() || b == b'.' { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let url = format!("{base}{enc}");
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut s = TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: x\r\nRange: bytes=10-19\r\n\r\n").unwrap();
        let mut r = BufReader::new(s);
        let mut status = String::new();
        r.read_line(&mut status).unwrap();
        assert!(status.contains("206"), "{status}");
        let mut len = 0;
        loop {
            let mut h = String::new();
            r.read_line(&mut h).unwrap();
            if h == "\r\n" { break; }
            if let Some(v) = h.strip_prefix("Content-Length: ") { len = v.trim().parse().unwrap(); }
            if h.starts_with("Content-Type") { assert!(h.contains("audio/flac")); }
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body).unwrap();
        assert_eq!(body, (10..20u8).collect::<Vec<_>>());
        std::fs::remove_dir_all(&dir).ok();
    }
}
