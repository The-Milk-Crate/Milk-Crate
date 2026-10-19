//! Recording records: a turntable plugged in by USB (or into a line in) is a sound input.
//! A side is recorded as it plays into a raw file (16-bit stereo), with a loudness envelope
//! (10 points a second) for finding the quiet gaps between songs. Then each song is cut out
//! and saved as tagged FLAC, like a ripped CD.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Envelope points per second.
pub const ENV_RATE: u32 = 10;
/// Below this loudness (0–1 RMS) counts as quiet: the gap between songs, or the end of a side.
pub const QUIET: f32 = 0.012;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub name: String,
    pub default: bool,
    /// Looks like a turntable or an audio interface (USB audio), not a laptop's built-in mic.
    pub likely: bool,
}

/// The sound inputs on this computer, likely turntables first.
pub fn inputs() -> Vec<Input> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut out: Vec<Input> = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|name| {
            let l = name.to_ascii_lowercase();
            let likely = ["usb", "codec", "turntable", "phono", "line", "audio interface", "scarlett", "behringer", "audio-technica", "at-lp"].iter().any(|k| l.contains(k));
            Input { default: Some(&name) == default.as_ref(), likely, name }
        })
        .collect();
    out.sort_by_key(|i| (!i.likely, !i.default));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// What the recording is doing, about ten times a second.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub seconds: f64,
    /// Loudest sample since the last report, each channel, 0–1.
    pub left: f32,
    pub right: f32,
    /// New envelope points since the last report.
    pub env: Vec<f32>,
    /// How long it's been quiet (seconds): the side has probably ended after a while of this.
    pub quiet_for: f64,
    pub paused: bool,
    /// Some samples hit the top: too loud.
    pub clipped: bool,
    /// Nothing but exact zeros so far: the system isn't letting Milk Crate hear the input
    /// (on a Mac, Microphone access is off), or the input sends nothing at all.
    pub dead: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub path: String,
    pub rate: u32,
    pub seconds: f64,
    /// Loudness, ENV_RATE points a second.
    pub envelope: Vec<f32>,
}

struct Shared {
    /// Sound goes to a writer thread, so the input's own thread never waits on the disk.
    out: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    frames: AtomicU64,
    paused: AtomicBool,
    peaks: Mutex<(f32, f32, bool)>,
    env: Mutex<(Vec<f32>, f64, u32)>, // (points, sum of squares in this window, frames in it)
    error: Mutex<Option<String>>,
    /// Any sample that wasn't exactly zero.
    heard: AtomicBool,
}

pub struct Recorder {
    stop: mpsc::Sender<()>,
    done: mpsc::Receiver<Result<(), String>>,
    shared: Arc<Shared>,
    path: PathBuf,
    rate: u32,
    reporter: Option<std::thread::JoinHandle<()>>,
    reporting: Arc<AtomicBool>,
}

fn find_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        if let Ok(mut it) = host.input_devices() {
            if let Some(d) = it.find(|d| d.name().ok().as_deref() == Some(n)) {
                return Ok(d);
            }
        }
        return Err(format!("Couldn't find \"{n}\". Is the turntable plugged in and switched on?"));
    }
    host.default_input_device().ok_or_else(|| "No sound input found. Plug in the turntable (USB) or an audio interface.".to_string())
}

impl Recorder {
    /// Starts recording `device` (by name; None = the system's default input) into `path`.
    /// `on_level` hears how it's going about ten times a second, from another thread.
    pub fn start(device: Option<&str>, path: PathBuf, on_level: impl Fn(Level) + Send + 'static) -> Result<Recorder, String> {
        let file = File::create(&path).map_err(|e| format!("Couldn't start the recording file: {e}"))?;
        let (to_disk, from_input) = mpsc::channel::<Vec<u8>>();
        let writer = std::thread::spawn(move || -> Result<(), String> {
            let mut w = BufWriter::with_capacity(1 << 20, file);
            for chunk in from_input {
                w.write_all(&chunk).map_err(|e| format!("Couldn't save the recording: {e}"))?;
            }
            w.flush().map_err(|e| format!("Couldn't save the recording: {e}"))
        });
        let shared = Arc::new(Shared {
            out: Mutex::new(Some(to_disk)),
            frames: AtomicU64::new(0),
            paused: AtomicBool::new(false),
            peaks: Mutex::new((0.0, 0.0, false)),
            env: Mutex::new((Vec::new(), 0.0, 0)),
            error: Mutex::new(None),
            heard: AtomicBool::new(false),
        });
        let device_name = device.map(str::to_string);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let sh = shared.clone();
        // The stream lives on its own thread (it can't be moved between threads on every system).
        std::thread::spawn(move || {
            let run = || -> Result<(cpal::Stream, u32), String> {
                let dev = find_device(device_name.as_deref())?;
                let cfg = dev.default_input_config().map_err(|e| format!("That input can't record: {e}"))?;
                let rate = cfg.sample_rate().0;
                let channels = cfg.channels() as usize;
                let window = (rate / ENV_RATE).max(1);
                let format = cfg.sample_format();
                let config: cpal::StreamConfig = cfg.into();
                let sh2 = sh.clone();
                let err_sh = sh.clone();
                let on_err = move |e: cpal::StreamError| {
                    *err_sh.error.lock().unwrap() = Some(format!("The recording stopped: {e}"));
                };
                macro_rules! stream {
                    ($t:ty, $conv:expr) => {
                        dev.build_input_stream(
                            &config,
                            move |data: &[$t], _: &cpal::InputCallbackInfo| {
                                let conv = $conv;
                                take(&sh2, data.chunks(channels).map(|f| {
                                    let l = conv(f[0]);
                                    let r = if channels > 1 { conv(f[1]) } else { l };
                                    (l, r)
                                }), window);
                            },
                            on_err,
                            None,
                        )
                    };
                }
                let stream = match format {
                    cpal::SampleFormat::F32 => stream!(f32, |s: f32| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
                    cpal::SampleFormat::I16 => stream!(i16, |s: i16| s),
                    cpal::SampleFormat::I32 => stream!(i32, |s: i32| (s >> 16) as i16),
                    cpal::SampleFormat::U16 => stream!(u16, |s: u16| (s as i32 - 32768) as i16),
                    cpal::SampleFormat::I8 => stream!(i8, |s: i8| (s as i16) << 8),
                    cpal::SampleFormat::U8 => stream!(u8, |s: u8| ((s as i16) - 128) << 8),
                    other => return Err(format!("That input sends sound in a format Milk Crate can't record yet ({other:?}).")),
                }
                .map_err(|e| format!("Couldn't open the input: {e}"))?;
                stream.play().map_err(|e| format!("Couldn't start recording: {e}"))?;
                Ok((stream, rate))
            };
            match run() {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    let _ = stop_rx.recv();
                    drop(stream);
                    sh.out.lock().unwrap().take(); // the writer finishes what it has, then stops
                    let flushed = writer.join().unwrap_or_else(|_| Err("Saving the recording stopped unexpectedly.".into()));
                    let _ = done_tx.send(flushed);
                }
                Err(e) => {
                    sh.out.lock().unwrap().take();
                    let _ = writer.join();
                    let _ = ready_tx.send(Err(e));
                }
            }
        });
        let rate = match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            Err(_) => {
                let _ = std::fs::remove_file(&path);
                return Err("The input didn't answer. Unplug the turntable, plug it back in, and try again.".into());
            }
        };

        // Reports.
        let reporting = Arc::new(AtomicBool::new(true));
        let (rep, sh) = (reporting.clone(), shared.clone());
        let reporter = std::thread::spawn(move || {
            let mut sent = 0usize;
            let mut quiet_since: Option<f64> = None;
            while rep.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(100));
                let (left, right, clipped) = std::mem::replace(&mut *sh.peaks.lock().unwrap(), (0.0, 0.0, false));
                let env: Vec<f32> = {
                    let e = sh.env.lock().unwrap();
                    let new = e.0[sent.min(e.0.len())..].to_vec();
                    sent = e.0.len();
                    new
                };
                let seconds = sh.frames.load(Ordering::Relaxed) as f64 / rate as f64;
                let paused = sh.paused.load(Ordering::Relaxed);
                if let Some(&last) = env.last() {
                    if last < QUIET {
                        quiet_since.get_or_insert(seconds);
                    } else {
                        quiet_since = None;
                    }
                }
                let quiet_for = quiet_since.map(|s| (seconds - s).max(0.0)).unwrap_or(0.0);
                let dead = seconds > 2.0 && !sh.heard.load(Ordering::Relaxed);
                on_level(Level { seconds, left, right, env, quiet_for, paused, clipped, dead });
            }
        });
        Ok(Recorder { stop: stop_tx, done: done_rx, shared, path, rate, reporter: Some(reporter), reporting })
    }

    /// Samples a second (the input's own rate: 44.1 or 48 kHz usually).
    pub fn rate(&self) -> u32 {
        self.rate
    }

    pub fn set_paused(&self, paused: bool) {
        self.shared.paused.store(paused, Ordering::Relaxed);
    }

    /// Stops, and returns what was recorded.
    pub fn stop(mut self) -> Result<Recording, String> {
        self.reporting.store(false, Ordering::Relaxed);
        if let Some(r) = self.reporter.take() {
            let _ = r.join();
        }
        let _ = self.stop.send(());
        self.done.recv_timeout(Duration::from_secs(10)).map_err(|_| "The recording didn't stop cleanly.".to_string())??;
        if let Some(e) = self.shared.error.lock().unwrap().take() {
            return Err(e);
        }
        let frames = self.shared.frames.load(Ordering::Relaxed);
        let envelope = self.shared.env.lock().unwrap().0.clone();
        Ok(Recording { path: self.path.to_string_lossy().into_owned(), rate: self.rate, seconds: frames as f64 / self.rate as f64, envelope })
    }
}

/// From the input's thread: write the frames, keep the peaks and the envelope.
fn take(sh: &Shared, frames: impl Iterator<Item = (i16, i16)>, window: u32) {
    if sh.paused.load(Ordering::Relaxed) {
        return;
    }
    let mut buf = Vec::with_capacity(4096);
    let (mut pl, mut pr, mut clip) = (0f32, 0f32, false);
    let mut env = sh.env.lock().unwrap();
    let mut n = 0u64;
    for (l, r) in frames {
        buf.extend_from_slice(&l.to_le_bytes());
        buf.extend_from_slice(&r.to_le_bytes());
        let (fl, fr) = (l as f32 / 32768.0, r as f32 / 32768.0);
        pl = pl.max(fl.abs());
        pr = pr.max(fr.abs());
        clip |= l == i16::MAX || l == i16::MIN || r == i16::MAX || r == i16::MIN;
        if l != 0 || r != 0 {
            sh.heard.store(true, Ordering::Relaxed);
        }
        let m = (fl + fr) / 2.0;
        env.1 += (m * m) as f64;
        env.2 += 1;
        if env.2 >= window {
            let rms = (env.1 / env.2 as f64).sqrt() as f32;
            env.0.push(rms);
            env.1 = 0.0;
            env.2 = 0;
        }
        n += 1;
    }
    drop(env);
    if let Some(tx) = sh.out.lock().unwrap().as_ref() {
        let _ = tx.send(buf);
    }
    sh.frames.fetch_add(n, Ordering::Relaxed);
    let mut p = sh.peaks.lock().unwrap();
    p.0 = p.0.max(pl);
    p.1 = p.1.max(pr);
    p.2 |= clip;
}

/* ---------- After recording ---------- */

/// Reads `secs` seconds from `start` (seconds) of a recording, as interleaved samples.
pub fn read_span(path: &Path, rate: u32, start: f64, secs: f64) -> Result<Vec<i32>, String> {
    let mut f = File::open(path).map_err(|e| format!("Couldn't open the recording: {e}"))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0) / 4;
    let from = ((start.max(0.0) * rate as f64) as u64).min(total);
    let to = (((start + secs).max(0.0) * rate as f64) as u64).min(total);
    f.seek(SeekFrom::Start(from * 4)).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; ((to - from) * 4) as usize];
    f.read_exact(&mut bytes).map_err(|e| format!("Couldn't read the recording: {e}"))?;
    Ok(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as i32).collect())
}

/// A few seconds of a recording as a WAV file (to listen to where a song starts).
pub fn snippet_wav(path: &Path, rate: u32, start: f64, secs: f64) -> Result<Vec<u8>, String> {
    let samples = read_span(path, rate, start, secs.min(30.0))?;
    let data_len = (samples.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data_len as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 4).to_le_bytes());
    w.extend_from_slice(&4u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        w.extend_from_slice(&(s as i16).to_le_bytes());
    }
    Ok(w)
}

/// One song cut out of a side.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    pub start: f64,
    pub end: f64,
    pub title: String,
    pub artist: String,
    /// Its number on the whole album (1, 2…), and on which record of a set.
    pub track: u32,
    pub disc: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePlan {
    pub album: String,
    pub album_artist: String,
    pub year: Option<String>,
    pub release_id: Option<String>,
    pub release_group_id: Option<String>,
    pub tracks: u32,
    pub discs: u32,
    pub songs: Vec<Cut>,
}

/// Where a record's songs go: Music › Milk Crate › Artist › Album (Vinyl), next to (not in) a
/// ripped CD of the same album.
pub fn album_folder(music: &Path, artist: &str, album: &str) -> PathBuf {
    cdrip::flac::album_dir(music, artist, &format!("{} (Vinyl)", album.trim()), 1, 1)
}

/// Saves each song as tagged FLAC (with the cover, a JPEG or PNG) in `dir`. Returns the files.
pub fn save(recording: &Path, rate: u32, plan: &SavePlan, dir: &Path, cover: Option<(&str, &[u8])>) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the album folder: {e}"))?;
    let mut saved = Vec::new();
    for c in &plan.songs {
        if c.end <= c.start {
            return Err(format!("\"{}\" has no length. Check where it starts and ends.", c.title));
        }
        let samples = read_span(recording, rate, c.start, c.end - c.start)?;
        let tags = cdrip::flac::Tags {
            title: c.title.clone(),
            artist: if c.artist.trim().is_empty() { plan.album_artist.clone() } else { c.artist.clone() },
            album: plan.album.clone(),
            album_artist: plan.album_artist.clone(),
            track: c.track,
            tracks: plan.tracks,
            disc: c.disc,
            discs: plan.discs,
            year: plan.year.clone(),
            release_id: plan.release_id.clone(),
            disc_id: None,
            media: Some("Vinyl".into()),
            release_group_id: plan.release_group_id.clone(),
        };
        let name = if plan.discs > 1 { format!("{}-{}", c.disc, cdrip::flac::track_file(c.track, &c.title)) } else { cdrip::flac::track_file(c.track, &c.title) };
        let path = dir.join(name);
        cdrip::flac::write_at(&path, &samples, rate as usize, &tags, cover)?;
        saved.push(path);
    }
    if let Some((mime, bytes)) = cover {
        let _ = std::fs::write(dir.join(if mime == "image/png" { "cover.png" } else { "cover.jpg" }), bytes);
    }
    Ok(saved)
}

/// Records one song again: `start`–`end` (seconds) of a recording replaces the song in `target`,
/// which keeps its name, tags and cover. Returns the song's new length (seconds).
pub fn replace_song(recording: &Path, rate: u32, start: f64, end: f64, target: &Path) -> Result<f64, String> {
    if end - start < 1.0 {
        return Err("Pick where the song starts and ends (at least a second).".into());
    }
    let samples = read_span(recording, rate, start, end - start)?;
    cdrip::flac::replace_audio(target, &samples, rate as usize)?;
    Ok((samples.len() / 2) as f64 / rate as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_recording(path: &Path, rate: u32, secs: f64) {
        let n = (rate as f64 * secs) as usize;
        let mut b = Vec::with_capacity(n * 4);
        for i in 0..n {
            let s = ((i as f32 * 0.05).sin() * 8000.0) as i16;
            b.extend_from_slice(&s.to_le_bytes());
            b.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn cuts_songs_into_tagged_flac() {
        let dir = std::env::temp_dir().join(format!("vinyl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = dir.join("side.pcm");
        fake_recording(&rec, 48_000, 3.0);
        let plan = SavePlan {
            album: "Ten".into(), album_artist: "Pearl Jam".into(), year: Some("1991".into()), release_id: None, release_group_id: Some("g".into()),
            tracks: 2, discs: 1,
            songs: vec![
                Cut { start: 0.0, end: 1.5, title: "Once".into(), artist: "".into(), track: 1, disc: 1 },
                Cut { start: 1.5, end: 3.0, title: "Even Flow".into(), artist: "".into(), track: 2, disc: 1 },
            ],
        };
        let out = album_folder(&dir, "Pearl Jam", "Ten");
        let files = save(&rec, 48_000, &plan, &out, None).unwrap();
        assert_eq!(files.len(), 2);
        assert!(out.ends_with("Ten (Vinyl)"), "{}", out.display());
        let tag = cdrip_tag(&files[1]);
        assert_eq!(tag.0.as_deref(), Some("Even Flow"));
        assert_eq!(tag.1.as_deref(), Some("Vinyl"));
        let wav = snippet_wav(&rec, 48_000, 1.0, 1.0).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(wav.len(), 44 + 48_000 * 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn cdrip_tag(p: &Path) -> (Option<String>, Option<String>) {
        let bytes = std::fs::read(p).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let find = |k: &str| text.find(&format!("{k}=")).map(|i| text[i + k.len() + 1..].chars().take_while(|c| !c.is_control()).collect::<String>());
        (find("TITLE"), find("MEDIA"))
    }
}
