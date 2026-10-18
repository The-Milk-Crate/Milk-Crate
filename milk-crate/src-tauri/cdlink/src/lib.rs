//! Milk Crate to Milk Crate, on the same local network: one computer finds the other, and sends it
//! CDs ripped on it (the FLAC files and covers in Music › Milk Crate), straight across, never
//! through any server.
//!
//! - The receiving computer listens only while you have it open to receive, shows a 6-digit code,
//!   and takes files only from a sender that types that code and is signed in to the same Milk
//!   Crate account (your own computers). Five wrong codes and it stops listening.
//! - Finding: a UDP broadcast on port 47820; whoever's receiving answers with its name and port.
//! - Sending: one TCP connection: a JSON line (code, account, the files), the receiver's answer,
//!   then each file's bytes in turn. Files land in the receiver's Music › Milk Crate at the same
//!   Artist › Album (› Disc N) path, names cleaned; only audio and cover pictures are taken.

use serde::{Deserialize, Serialize};
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DISCOVERY_PORT: u16 = 47820;
pub const TRANSFER_PORT: u16 = 47821;
const HELLO: &[u8] = b"MILKCRATE-HELLO-1";
const MAX_FILES: usize = 4000;
const MAX_FILE: u64 = 4 << 30;
const MAX_TOTAL: u64 = 200 << 30;
const MAX_WRONG_CODES: u32 = 5;
const EXTENSIONS: [&str; 9] = ["flac", "mp3", "m4a", "ogg", "opus", "wav", "jpg", "jpeg", "png"];

/// A computer that's ready to receive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub name: String,
    pub addr: String,
    /// Signed in to the same Milk Crate account as you (only those can receive from you).
    pub same_account: bool,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    name: String,
    port: u16,
    account: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileEntry {
    /// Where it goes under Music › Milk Crate ("Artist/Album/01 Song.flac").
    pub rel: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
struct Offer {
    v: u32,
    code: String,
    account: String,
    from: String,
    files: Vec<FileEntry>,
}

#[derive(Serialize, Deserialize, Default)]
struct Reply {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// What the receiving side hears about, for the app to show.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReceiveEvent {
    /// Someone's sending: how much.
    Incoming { from: String, files: usize, bytes: u64 },
    Progress { done: u64, total: u64, file: String },
    /// Saved (full paths), ready to add to Your Computer.
    Done { from: String, files: Vec<String> },
    Failed { error: String },
    /// Too many wrong codes: no longer listening.
    Locked,
}

/// What the sending side hears about.
#[derive(Debug, Clone, Serialize)]
pub struct SendProgress {
    pub done: u64,
    pub total: u64,
    pub file: String,
}

/// This computer's name, as people know it ("Bowen's PC").
pub fn computer_name() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(n) = std::env::var(var) {
            if !n.trim().is_empty() {
                return n.trim().to_string();
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(o) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let n = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !n.is_empty() {
            return n;
        }
    }
    if let Ok(o) = std::process::Command::new("hostname").output() {
        let n = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !n.is_empty() {
            return n;
        }
    }
    "Another computer".into()
}

/// A short stand-in for the account id, so the id itself isn't broadcast.
pub fn account_tag(account_id: &str) -> String {
    // FNV-1a, 64-bit: stable across computers and versions (std's hasher isn't).
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("milkcrate:{account_id}").bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn new_code() -> String {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("{:06}", h.finish() % 1_000_000)
}

/// A name that's safe as a file or folder on Windows and Mac.
fn clean(s: &str) -> Option<String> {
    let t: String = s.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches(['.', ' ']).trim().chars().take(120).collect::<String>();
    if t.is_empty() || t == "." || t == ".." {
        return None;
    }
    let stem = t.to_uppercase();
    let stem = stem.split('.').next().unwrap_or("");
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem) || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")));
    Some(if reserved { format!("_{t}") } else { t })
}

/// Where a sent file may go under `root` (Music › Milk Crate), or None if it's not one we take.
pub fn safe_target(root: &Path, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.len() > 5 || parts.iter().any(|p| *p == "." || *p == "..") {
        return None;
    }
    let ext = Path::new(parts[parts.len() - 1]).extension()?.to_str()?.to_ascii_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let mut out = root.to_path_buf();
    for p in parts {
        out.push(clean(p)?);
    }
    Some(out)
}

/// The path a file is sent under: after "Milk Crate" in its own path, else "From another computer/<folder>/<file>".
pub fn rel_for(path: &Path) -> String {
    let parts: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    if let Some(i) = parts.iter().rposition(|p| p == "Milk Crate") {
        if i + 1 < parts.len() {
            return parts[i + 1..].join("/");
        }
    }
    let file = parts.last().cloned().unwrap_or_default();
    let folder = parts.len().checked_sub(2).map(|i| parts[i].clone()).unwrap_or_default();
    format!("From another computer/{folder}/{file}")
}

/// The files to send for these songs: the songs, plus each album folder's cover picture.
pub fn with_covers(songs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for s in songs {
        if !out.contains(s) {
            out.push(s.clone());
        }
        if let Some(dir) = s.parent() {
            for c in ["cover.jpg", "cover.png"] {
                let p = dir.join(c);
                if p.is_file() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/* ---------- Receiving ---------- */

/// Listening for a sender. Dropping it (or `stop`) stops listening.
pub struct Receiver {
    pub code: String,
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Receiver {
    /// Starts listening: answers "who's there" broadcasts and takes one transfer at a time into `root`
    /// (Music › Milk Crate). `account` is this computer's account_tag.
    pub fn start(name: String, account: String, root: PathBuf, on_event: impl Fn(ReceiveEvent) + Send + Sync + 'static) -> std::io::Result<Receiver> {
        let listener = TcpListener::bind(("0.0.0.0", TRANSFER_PORT)).or_else(|_| TcpListener::bind(("0.0.0.0", 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let code = new_code();
        let stop = Arc::new(AtomicBool::new(false));
        let on_event = Arc::new(on_event);

        // Answer "who's there?" from senders on the network.
        if let Ok(udp) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) {
            let _ = udp.set_read_timeout(Some(Duration::from_millis(400)));
            let (stop, answer) = (stop.clone(), serde_json::to_vec(&Answer { name: name.clone(), port, account: account.clone() }).unwrap_or_default());
            std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                while !stop.load(Ordering::Relaxed) {
                    if let Ok((n, from)) = udp.recv_from(&mut buf) {
                        if &buf[..n] == HELLO {
                            let _ = udp.send_to(&answer, from);
                        }
                    }
                }
            });
        }

        let (stop2, code2) = (stop.clone(), code.clone());
        std::thread::spawn(move || {
            let mut wrong = 0u32;
            while !stop2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        match receive_one(stream, &code2, &account, &root, &stop2, &*on_event) {
                            Ok(()) => {}
                            Err(Refused::WrongCode) => {
                                wrong += 1;
                                if wrong >= MAX_WRONG_CODES {
                                    stop2.store(true, Ordering::Relaxed);
                                    on_event(ReceiveEvent::Locked);
                                }
                            }
                            Err(Refused::Other(e)) => on_event(ReceiveEvent::Failed { error: e }),
                            Err(Refused::Quiet) => {}
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                    Err(_) => std::thread::sleep(Duration::from_millis(300)),
                }
            }
        });
        Ok(Receiver { code, port, stop })
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.stop();
    }
}

enum Refused {
    WrongCode,
    Quiet,
    Other(String),
}

fn reply(stream: &mut TcpStream, r: &Reply) {
    let mut line = serde_json::to_vec(r).unwrap_or_default();
    line.push(b'\n');
    let _ = stream.write_all(&line);
}

fn receive_one(mut stream: TcpStream, code: &str, account: &str, root: &Path, stop: &AtomicBool, on_event: &dyn Fn(ReceiveEvent)) -> Result<(), Refused> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| Refused::Other(e.to_string()))?);
    let mut line = Vec::new();
    (&mut reader).take(1 << 20).read_until(b'\n', &mut line).map_err(|_| Refused::Quiet)?;
    let offer: Offer = serde_json::from_slice(&line).map_err(|_| Refused::Quiet)?;
    let no = |stream: &mut TcpStream, e: &str| reply(stream, &Reply { ok: false, error: Some(e.into()) });
    if offer.code.trim() != code {
        no(&mut stream, "That code doesn't match. Check the code on the other computer.");
        return Err(Refused::WrongCode);
    }
    if offer.account != account {
        no(&mut stream, "Both computers need to be signed in to the same Milk Crate account.");
        return Err(Refused::Quiet);
    }
    let total: u64 = offer.files.iter().map(|f| f.size).sum();
    if offer.files.is_empty() || offer.files.len() > MAX_FILES || total > MAX_TOTAL || offer.files.iter().any(|f| f.size > MAX_FILE) {
        no(&mut stream, "That's more than can be sent at once.");
        return Err(Refused::Quiet);
    }
    let targets: Option<Vec<PathBuf>> = offer.files.iter().map(|f| safe_target(root, &f.rel)).collect();
    let Some(targets) = targets else {
        no(&mut stream, "Some of those files aren't songs or covers.");
        return Err(Refused::Quiet);
    };
    reply(&mut stream, &Reply { ok: true, error: None });
    on_event(ReceiveEvent::Incoming { from: offer.from.clone(), files: offer.files.len(), bytes: total });

    let mut done = 0u64;
    let mut saved = Vec::new();
    let mut last = Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    for (f, target) in offer.files.iter().zip(&targets) {
        if stop.load(Ordering::Relaxed) {
            return Err(Refused::Other("Stopped receiving.".into()));
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Refused::Other(format!("Couldn't make {}: {e}", dir.display())))?;
        }
        let part = target.with_extension(format!("{}.part", target.extension().and_then(|e| e.to_str()).unwrap_or("")));
        let mut out = std::fs::File::create(&part).map_err(|e| Refused::Other(format!("Couldn't save {}: {e}", target.display())))?;
        let mut left = f.size;
        while left > 0 {
            let want = buf.len().min(left as usize);
            let n = reader.read(&mut buf[..want]).map_err(|e| Refused::Other(format!("The other computer stopped sending: {e}")))?;
            if n == 0 {
                let _ = std::fs::remove_file(&part);
                return Err(Refused::Other("The other computer stopped sending.".into()));
            }
            out.write_all(&buf[..n]).map_err(|e| Refused::Other(format!("Couldn't save {}: {e}", target.display())))?;
            left -= n as u64;
            done += n as u64;
            if last.elapsed() > Duration::from_millis(150) {
                last = Instant::now();
                on_event(ReceiveEvent::Progress { done, total, file: f.rel.clone() });
            }
        }
        drop(out);
        std::fs::rename(&part, target).map_err(|e| Refused::Other(format!("Couldn't save {}: {e}", target.display())))?;
        saved.push(target.to_string_lossy().to_string());
    }
    reply(&mut stream, &Reply { ok: true, error: None });
    on_event(ReceiveEvent::Progress { done: total, total, file: String::new() });
    on_event(ReceiveEvent::Done { from: offer.from, files: saved });
    Ok(())
}

/* ---------- Finding and sending ---------- */

/// Computers on the network that are ready to receive (listens for `wait`).
pub fn discover(account: &str, wait: Duration) -> Vec<Peer> {
    let Ok(udp) = UdpSocket::bind(("0.0.0.0", 0)) else { return vec![] };
    let _ = udp.set_broadcast(true);
    let _ = udp.set_read_timeout(Some(Duration::from_millis(200)));
    let targets: [SocketAddr; 2] = [([255, 255, 255, 255], DISCOVERY_PORT).into(), ([127, 0, 0, 1], DISCOVERY_PORT).into()];
    let mut peers: Vec<Peer> = Vec::new();
    let start = Instant::now();
    let mut sent_at = None::<Instant>;
    let mut buf = [0u8; 2048];
    while start.elapsed() < wait {
        // Ask a few times: a broadcast can get lost.
        if sent_at.is_none_or(|t| t.elapsed() > Duration::from_millis(500)) {
            for t in targets {
                let _ = udp.send_to(HELLO, t);
            }
            sent_at = Some(Instant::now());
        }
        if let Ok((n, from)) = udp.recv_from(&mut buf) {
            if let Ok(a) = serde_json::from_slice::<Answer>(&buf[..n]) {
                let addr = SocketAddr::new(from.ip(), a.port).to_string();
                // The same computer answers on loopback and its network address: keep one.
                if !peers.iter().any(|p| p.addr == addr || (p.name == a.name && from.ip().is_loopback())) {
                    peers.retain(|p| !(p.name == a.name && p.addr.starts_with("127.")));
                    peers.push(Peer { name: a.name, addr, same_account: a.account == account });
                }
            }
        }
    }
    peers
}

/// Sends these files to a computer that's receiving. `code` is the 6 digits it shows.
/// Returns how many files were sent.
pub fn send(addr: &str, code: &str, account: &str, from: &str, paths: &[PathBuf], on_progress: &dyn Fn(SendProgress), cancel: &AtomicBool) -> Result<usize, String> {
    let files: Vec<(PathBuf, FileEntry)> = paths
        .iter()
        .map(|p| {
            let size = std::fs::metadata(p).map_err(|e| format!("Couldn't read {}: {e}", p.display()))?.len();
            Ok((p.clone(), FileEntry { rel: rel_for(p), size }))
        })
        .collect::<Result<_, String>>()?;
    let total: u64 = files.iter().map(|(_, f)| f.size).sum();
    let addr: SocketAddr = addr.parse().map_err(|_| "That computer's address doesn't look right.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|_| "Couldn't reach that computer. Is it still waiting to receive?".to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let offer = Offer { v: 1, code: code.trim().into(), account: account.into(), from: from.into(), files: files.iter().map(|(_, f)| f.clone()).collect() };
    let mut line = serde_json::to_vec(&offer).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let read_reply = |reader: &mut BufReader<TcpStream>| -> Result<Reply, String> {
        let mut l = String::new();
        reader.read_line(&mut l).map_err(|_| "The other computer didn't answer.".to_string())?;
        serde_json::from_str(&l).map_err(|_| "The other computer didn't answer.".to_string())
    };
    let r = read_reply(&mut reader)?;
    if !r.ok {
        return Err(r.error.unwrap_or_else(|| "The other computer said no.".into()));
    }
    let mut done = 0u64;
    let mut last = Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    for (path, f) in &files {
        let mut file = std::fs::File::open(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        let mut left = f.size;
        while left > 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped".into());
            }
            let want = buf.len().min(left as usize);
            let n = file.read(&mut buf[..want]).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
            if n == 0 {
                return Err(format!("{} changed while sending.", path.display()));
            }
            stream.write_all(&buf[..n]).map_err(|_| "The connection to the other computer dropped.".to_string())?;
            left -= n as u64;
            done += n as u64;
            if last.elapsed() > Duration::from_millis(150) {
                last = Instant::now();
                on_progress(SendProgress { done, total, file: f.rel.clone() });
            }
        }
    }
    let r = read_reply(&mut reader)?;
    if !r.ok {
        return Err(r.error.unwrap_or_else(|| "The other computer couldn't save them.".into()));
    }
    on_progress(SendProgress { done: total, total, file: String::new() });
    Ok(files.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn targets_stay_inside_and_are_songs_or_covers() {
        let root = Path::new("/m/Milk Crate");
        assert_eq!(safe_target(root, "R.E.M/Monster/01 What's the Frequency, Kenneth_.flac"), Some(root.join("R.E.M/Monster/01 What's the Frequency, Kenneth_.flac")));
        assert_eq!(safe_target(root, "A/B/Disc 2/cover.jpg"), Some(root.join("A/B/Disc 2/cover.jpg")));
        assert_eq!(safe_target(root, "../../etc/passwd.flac"), None);
        assert_eq!(safe_target(root, "A/../../x.flac"), None);
        assert_eq!(safe_target(root, "A/B/run.exe"), None);
        assert_eq!(safe_target(root, "A/B/C/D/E/F/x.flac"), None);
        assert_eq!(safe_target(root, "A:/B/x.flac"), Some(root.join("A_/B/x.flac")));
        assert_eq!(safe_target(root, "CON/x.flac"), Some(root.join("_CON/x.flac")));
    }

    #[test]
    fn rel_paths_follow_milk_crate() {
        assert_eq!(rel_for(Path::new("/Users/b/Music/Milk Crate/Pearl Jam/Vs/01 Go.flac")), "Pearl Jam/Vs/01 Go.flac");
        assert_eq!(rel_for(Path::new("/x/y/Album/song.flac")), "From another computer/Album/song.flac");
    }

    #[test]
    fn account_tags_are_stable() {
        assert_eq!(account_tag("abc"), account_tag("abc"));
        assert_ne!(account_tag("abc"), account_tag("abd"));
    }

    #[test]
    fn sends_across_and_checks_code_and_account() {
        let dir = std::env::temp_dir().join(format!("cdlink-test-{}", std::process::id()));
        let src = dir.join("src/Music/Milk Crate/Band/Record");
        std::fs::create_dir_all(&src).unwrap();
        let song = src.join("01 One.flac");
        let big: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&song, &big).unwrap();
        std::fs::write(src.join("cover.jpg"), b"jpeg").unwrap();
        let dest = dir.join("dest/Milk Crate");

        let events = Arc::new(Mutex::new(Vec::<ReceiveEvent>::new()));
        let ev = events.clone();
        let acct = account_tag("me");
        let rx = Receiver::start("Test PC".into(), acct.clone(), dest.clone(), move |e| ev.lock().unwrap().push(e)).unwrap();
        let addr = format!("127.0.0.1:{}", rx.port);
        let files = with_covers(&[song.clone()]);
        let never = AtomicBool::new(false);

        let err = send(&addr, "000000x", &acct, "Laptop", &files, &|_| {}, &never).unwrap_err();
        assert!(err.contains("code"), "{err}");
        let err = send(&addr, &rx.code, &account_tag("someone else"), "Laptop", &files, &|_| {}, &never).unwrap_err();
        assert!(err.contains("same Milk Crate account"), "{err}");

        let sent = send(&addr, &rx.code, &acct, "Laptop", &files, &|_| {}, &never).unwrap();
        assert_eq!(sent, 2);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(std::fs::read(dest.join("Band/Record/01 One.flac")).unwrap(), big);
        assert_eq!(std::fs::read(dest.join("Band/Record/cover.jpg")).unwrap(), b"jpeg");
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| matches!(e, ReceiveEvent::Done { files, .. } if files.len() == 2)));
        drop(rx);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn five_wrong_codes_lock_it() {
        let dir = std::env::temp_dir().join(format!("cdlink-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.flac");
        std::fs::write(&f, b"x").unwrap();
        let locked = Arc::new(AtomicBool::new(false));
        let l = locked.clone();
        let acct = account_tag("me");
        let rx = Receiver::start("T".into(), acct.clone(), dir.join("out"), move |e| if matches!(e, ReceiveEvent::Locked) { l.store(true, Ordering::Relaxed) }).unwrap();
        let addr = format!("127.0.0.1:{}", rx.port);
        let wrong = if rx.code == "111111" { "222222" } else { "111111" };
        for _ in 0..5 {
            let _ = send(&addr, wrong, &acct, "x", &[f.clone()], &|_| {}, &AtomicBool::new(false));
        }
        std::thread::sleep(Duration::from_millis(500));
        assert!(locked.load(Ordering::Relaxed));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_a_receiver() {
        let dir = std::env::temp_dir().join(format!("cdlink-find-{}", std::process::id()));
        let acct = account_tag("me");
        let rx = Receiver::start("Finder Test".into(), acct.clone(), dir, |_| {}).unwrap();
        let peers = discover(&acct, Duration::from_millis(1200));
        drop(rx);
        assert!(peers.iter().any(|p| p.name == "Finder Test" && p.same_account), "{peers:?}");
    }
}
