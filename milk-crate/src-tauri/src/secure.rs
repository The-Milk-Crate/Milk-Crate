//! Secrets kept safely on this computer (the sign-in session).
//!
//! Each secret is encrypted (ChaCha20-Poly1305) and saved as a file in the app's data folder.
//! The key that unlocks them is kept by the system's own password store: Windows Credential
//! Manager or the macOS Keychain. Copying the files to another computer, or reading them as
//! another user, gets nothing usable.

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const SERVICE: &str = "Milk Crate";
const KEY_NAME: &str = "local-data-key";

static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, KEY_NAME).map_err(|e| e.to_string())
}

/// The key from the system password store, made the first time.
fn key() -> Result<[u8; 32], String> {
    let mut cached = KEY.lock().map_err(|_| "busy".to_string())?;
    if let Some(k) = *cached {
        return Ok(k);
    }
    let e = entry()?;
    let k = match e.get_secret() {
        Ok(bytes) if bytes.len() == 32 => {
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            k
        }
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let fresh: [u8; 32] = ChaCha20Poly1305::generate_key(&mut OsRng).into();
            e.set_secret(&fresh).map_err(|e| e.to_string())?;
            fresh
        }
        Err(err) => return Err(err.to_string()),
    };
    *cached = Some(k);
    Ok(k)
}

fn path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 100 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') || name.starts_with('.') {
        return Err("bad name".into());
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("secure");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.bin")))
}

fn seal(key: &[u8; 32], name: &str, value: &str) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    // The name is bound in, so one secret's file can't be swapped in for another's.
    let ct = cipher
        .encrypt(&nonce, chacha20poly1305::aead::Payload { msg: value.as_bytes(), aad: name.as_bytes() })
        .map_err(|_| "couldn't encrypt".to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; 32], name: &str, data: &[u8]) -> Option<String> {
    if data.len() < 12 {
        return None;
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let pt = cipher
        .decrypt(Nonce::from_slice(&data[..12]), chacha20poly1305::aead::Payload { msg: &data[12..], aad: name.as_bytes() })
        .ok()?;
    String::from_utf8(pt).ok()
}

/// A saved secret, or null when there's none (or it can't be unlocked on this computer).
#[tauri::command]
pub fn secure_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let p = path(&app, &name)?;
    let Ok(data) = std::fs::read(&p) else { return Ok(None) };
    let k = key()?;
    Ok(open(&k, &name, &data))
}

#[tauri::command]
pub fn secure_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    let p = path(&app, &name)?;
    let k = key()?;
    let sealed = seal(&k, &name, &value)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secure_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let p = path(&app, &name)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let k = [7u8; 32];
        let sealed = seal(&k, "session", "hello").unwrap();
        assert_eq!(open(&k, "session", &sealed).as_deref(), Some("hello"));
        assert_eq!(open(&k, "other", &sealed), None, "bound to its name");
        assert_eq!(open(&[8u8; 32], "session", &sealed), None, "wrong key");
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(open(&k, "session", &bad), None, "tampered");
    }
}
