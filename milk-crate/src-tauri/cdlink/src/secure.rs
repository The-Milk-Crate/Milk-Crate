//! The encrypted connection between two computers.
//!
//! Both sides know the 6-digit code (and the account). They run SPAKE2, a password-authenticated key
//! exchange: each sends one short message, and both end up with the same secret key only if they
//! used the same code. The code itself is never sent, and someone listening on the network can't
//! test guesses against what they overheard; each guess needs a live try, and the receiver stops
//! after five wrong ones. From that key come two ChaCha20-Poly1305 keys, one per direction; every
//! message after that is encrypted and tamper-proof (numbered, so none can be replayed or reordered).

use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;

pub const VERSION: u32 = 3;
/// Sent instead of a frame when the other side's first message couldn't be read: the code (or
/// account) didn't match.
const NO_MATCH: u32 = u32::MAX;
const MAX_FRAME: usize = 2 << 20;

#[derive(serde::Serialize, serde::Deserialize)]
struct Hello {
    v: u32,
    spake: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn password(code: &str, account: &str) -> Password {
    Password::new(format!("milkcrate:{}:{account}", code.trim()).as_bytes())
}

/// One direction's key and message counter.
struct Half {
    cipher: ChaCha20Poly1305,
    n: u64,
}

impl Half {
    fn nonce(&mut self) -> Nonce {
        let mut b = [0u8; 12];
        b[4..].copy_from_slice(&self.n.to_le_bytes());
        self.n += 1;
        *Nonce::from_slice(&b)
    }
}

/// An encrypted connection.
pub struct Channel {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    out: Half,
    inn: Half,
}

pub enum Failure {
    /// The code (or account) didn't match.
    NoMatch,
    /// The other side runs an older Milk Crate.
    OldVersion,
    #[allow(dead_code)]
    Io(String),
}

fn halves(key: &[u8], sender: bool) -> (Half, Half) {
    let hk = Hkdf::<Sha256>::new(Some(b"milkcrate link v3"), key);
    let mut s2r = [0u8; 32];
    let mut r2s = [0u8; 32];
    hk.expand(b"sender to receiver", &mut s2r).expect("32 bytes");
    hk.expand(b"receiver to sender", &mut r2s).expect("32 bytes");
    let mk = |k: &[u8; 32]| Half { cipher: ChaCha20Poly1305::new(Key::from_slice(k)), n: 0 };
    if sender { (mk(&s2r), mk(&r2s)) } else { (mk(&r2s), mk(&s2r)) }
}

fn read_hello(reader: &mut BufReader<TcpStream>) -> Result<Hello, Failure> {
    let mut line = Vec::new();
    reader.by_ref().take(4096).read_until(b'\n', &mut line).map_err(|e| Failure::Io(e.to_string()))?;
    let hello: Hello = serde_json::from_slice(&line).map_err(|_| Failure::OldVersion)?;
    if hello.v != VERSION {
        return Err(Failure::OldVersion);
    }
    Ok(hello)
}

fn write_hello(stream: &mut TcpStream, msg: &[u8]) -> Result<(), Failure> {
    let mut line = serde_json::to_vec(&Hello { v: VERSION, spake: b64().encode(msg) }).map_err(|e| Failure::Io(e.to_string()))?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| Failure::Io(e.to_string()))
}

impl Channel {
    /// The sending side's half of the handshake.
    pub fn open(mut stream: TcpStream, code: &str, account: &str) -> Result<Channel, Failure> {
        let (state, msg) = Spake2::<Ed25519Group>::start_a(&password(code, account), &Identity::new(b"milkcrate sender"), &Identity::new(b"milkcrate receiver"));
        write_hello(&mut stream, &msg)?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| Failure::Io(e.to_string()))?);
        let hello = read_hello(&mut reader)?;
        let theirs = b64().decode(hello.spake).map_err(|_| Failure::OldVersion)?;
        let key = state.finish(&theirs).map_err(|_| Failure::NoMatch)?;
        let (out, inn) = halves(&key, true);
        Ok(Channel { stream, reader, out, inn })
    }

    /// The receiving side's half of the handshake.
    pub fn accept(mut stream: TcpStream, code: &str, account: &str) -> Result<Channel, Failure> {
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| Failure::Io(e.to_string()))?);
        let hello = match read_hello(&mut reader) {
            Ok(h) => h,
            Err(Failure::OldVersion) => {
                // An older sender reads a plain line back: tell it why.
                let _ = stream.write_all(b"{\"ok\":false,\"error\":\"Update Milk Crate on both computers, then try again.\"}\n");
                return Err(Failure::OldVersion);
            }
            Err(e) => return Err(e),
        };
        let theirs = b64().decode(hello.spake).map_err(|_| Failure::OldVersion)?;
        let (state, msg) = Spake2::<Ed25519Group>::start_b(&password(code, account), &Identity::new(b"milkcrate sender"), &Identity::new(b"milkcrate receiver"));
        write_hello(&mut stream, &msg)?;
        let key = state.finish(&theirs).map_err(|_| Failure::NoMatch)?;
        let (out, inn) = halves(&key, false);
        Ok(Channel { stream, reader, out, inn })
    }

    pub fn send(&mut self, plain: &[u8]) -> Result<(), String> {
        let nonce = self.out.nonce();
        let ct = self.out.cipher.encrypt(&nonce, plain).map_err(|_| "Couldn't encrypt.".to_string())?;
        let mut frame = Vec::with_capacity(4 + ct.len());
        frame.extend_from_slice(&(ct.len() as u32).to_be_bytes());
        frame.extend_from_slice(&ct);
        self.stream.write_all(&frame).map_err(|_| "The connection to the other computer dropped.".to_string())
    }

    pub fn recv(&mut self) -> Result<Vec<u8>, Failure> {
        let mut len = [0u8; 4];
        self.reader.read_exact(&mut len).map_err(|e| Failure::Io(e.to_string()))?;
        let len = u32::from_be_bytes(len);
        if len == NO_MATCH {
            return Err(Failure::NoMatch);
        }
        if len as usize > MAX_FRAME + 16 {
            return Err(Failure::Io("Too big".into()));
        }
        let mut ct = vec![0u8; len as usize];
        self.reader.read_exact(&mut ct).map_err(|e| Failure::Io(e.to_string()))?;
        let nonce = self.inn.nonce();
        // Can't be read: the keys differ (wrong code or account), or it was tampered with.
        self.inn.cipher.decrypt(&nonce, ct.as_slice()).map_err(|_| Failure::NoMatch)
    }

    /// Tells the sender its first message couldn't be read (the code didn't match).
    pub fn refuse(&mut self) {
        let _ = self.stream.write_all(&NO_MATCH.to_be_bytes());
    }

    pub fn set_timeout(&self, secs: u64) {
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(secs)));
    }
}

/// The largest piece of a file sent in one message.
pub const CHUNK: usize = 256 * 1024;
