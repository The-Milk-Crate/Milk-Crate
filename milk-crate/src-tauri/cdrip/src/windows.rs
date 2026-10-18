//! Audio CDs on Windows: the drive's table of contents and raw audio sectors,
//! read through the CD-ROM driver (\\.\D:).

use crate::toc::{RawTrack, Toc};

/// Parses a CDROM_TOC (IOCTL_CDROM_READ_TOC, addresses in MSF). Platform-neutral so it can be tested.
pub fn parse_cdrom_toc(buf: &[u8]) -> Option<Toc> {
    if buf.len() < 4 {
        return None;
    }
    let (first, last) = (buf[2], buf[3]);
    if first == 0 || last < first {
        return None;
    }
    let mut tracks = Vec::new();
    let mut leadout = None;
    // TRACK_DATA: Reserved, Control (low 4 bits) / Adr, TrackNumber, Reserved1, Address[4] = 0, M, S, F.
    for entry in buf[4..].chunks_exact(8).take((last - first) as usize + 2) {
        let control = entry[1] & 0x0F;
        let number = entry[2];
        let start = (entry[5] as u32 * 60 + entry[6] as u32) * 75 + entry[7] as u32;
        if number == 0xAA {
            leadout = Some(start);
            break;
        }
        tracks.push(RawTrack { number, start, data: control & 0x04 != 0 });
    }
    Toc::from_raw(&tracks, leadout?)
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::parse_cdrom_toc;
    use crate::toc::{Toc, SECTOR_BYTES};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const OPEN_EXISTING: u32 = 3;
    const DRIVE_CDROM: u32 = 5;
    const IOCTL_CDROM_READ_TOC: u32 = 0x0002_4000;
    const IOCTL_CDROM_RAW_READ: u32 = 0x0002_403E;
    const IOCTL_STORAGE_EJECT_MEDIA: u32 = 0x002D_4808;
    const CDDA: u32 = 2;
    /// Sectors per read (the driver's limit is about 64 KB).
    const CHUNK: u32 = 20;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, security: *const c_void, disposition: u32, flags: u32, template: *mut c_void) -> *mut c_void;
        fn DeviceIoControl(device: *mut c_void, code: u32, input: *const c_void, input_len: u32, output: *mut c_void, output_len: u32, returned: *mut u32, overlapped: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
    }

    #[repr(C)]
    struct RawReadInfo {
        disk_offset: i64,
        sector_count: u32,
        track_mode: u32,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Drive(*mut c_void);
    impl Drive {
        fn open(letter: char) -> Option<Drive> {
            let path = wide(&format!(r"\\.\{letter}:"));
            let h = unsafe { CreateFileW(path.as_ptr(), GENERIC_READ, FILE_SHARE_READ_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut()) };
            if h.is_null() || h as isize == -1 { None } else { Some(Drive(h)) }
        }
        fn ioctl(&self, code: u32, input: &[u8], output: &mut [u8]) -> Option<usize> {
            let mut got = 0u32;
            let ok = unsafe {
                DeviceIoControl(
                    self.0,
                    code,
                    if input.is_empty() { std::ptr::null() } else { input.as_ptr() as *const c_void },
                    input.len() as u32,
                    if output.is_empty() { std::ptr::null_mut() } else { output.as_mut_ptr() as *mut c_void },
                    output.len() as u32,
                    &mut got,
                    std::ptr::null_mut(),
                )
            };
            (ok != 0).then_some(got as usize)
        }
    }
    impl Drop for Drive {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct WinDisc {
        pub letter: char,
        pub toc: Toc,
    }

    /// Every CD drive with an audio CD in it.
    pub fn scan() -> Vec<WinDisc> {
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let root = wide(&format!("{letter}:\\"));
            if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_CDROM {
                continue;
            }
            let Some(drive) = Drive::open(letter) else { continue };
            let mut buf = vec![0u8; 804]; // sizeof(CDROM_TOC)
            if drive.ioctl(IOCTL_CDROM_READ_TOC, &[], &mut buf).is_none() {
                continue; // empty drive
            }
            if let Some(toc) = parse_cdrom_toc(&buf) {
                out.push(WinDisc { letter, toc });
            }
        }
        out
    }

    /// Reads one track's audio (interleaved 16-bit stereo, as i32 for the encoder).
    pub fn read_track(disc: &WinDisc, n: u8, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<i32>, String> {
        let (start, len) = disc.toc.span(n).ok_or(format!("Track {n} isn't on the disc"))?;
        let drive = Drive::open(disc.letter).ok_or("Couldn't open the CD drive")?;
        let lba = start - 150;
        let mut samples = Vec::with_capacity(len as usize * SECTOR_BYTES / 2);
        let mut buf = vec![0u8; CHUNK as usize * SECTOR_BYTES];
        let mut done = 0u32;
        while done < len {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped".into());
            }
            let count = CHUNK.min(len - done);
            let info = RawReadInfo { disk_offset: (lba + done) as i64 * 2048, sector_count: count, track_mode: CDDA };
            let input = unsafe { std::slice::from_raw_parts(&info as *const RawReadInfo as *const u8, std::mem::size_of::<RawReadInfo>()) };
            let want = count as usize * SECTOR_BYTES;
            // Scratches: try a few times before giving up.
            let mut got = None;
            for _ in 0..5 {
                got = drive.ioctl(IOCTL_CDROM_RAW_READ, input, &mut buf[..want]);
                if got == Some(want) {
                    break;
                }
            }
            if got != Some(want) {
                return Err(format!("Couldn't read track {n} at {}:{:02}. The disc may be scratched or dirty.", done / 75 / 60, done / 75 % 60));
            }
            samples.extend(buf[..want].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as i32));
            done += count;
            progress(done as f32 / len as f32);
        }
        Ok(samples)
    }

    pub fn eject(disc: &WinDisc) -> Result<(), String> {
        let drive = Drive::open(disc.letter).ok_or("Couldn't open the CD drive")?;
        drive.ioctl(IOCTL_STORAGE_EJECT_MEDIA, &[], &mut []).map(|_| ()).ok_or_else(|| "The drive didn't eject".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(control: u8, n: u8, m: u8, s: u8, f: u8) -> [u8; 8] {
        [0, control | 0x10, n, 0, 0, m, s, f]
    }

    #[test]
    fn reads_a_drive_toc() {
        let mut buf = vec![0, 0, 1, 3];
        buf.extend(entry(0, 1, 0, 2, 0)); // 150
        buf.extend(entry(0, 2, 3, 22, 63)); // (3*60+22)*75+63 = 15213
        buf.extend(entry(4, 3, 20, 0, 0)); // data track at 90000
        buf.extend(entry(4, 0xAA, 25, 0, 0));
        buf.resize(804, 0);
        let toc = parse_cdrom_toc(&buf).unwrap();
        assert_eq!((toc.first, toc.last), (1, 2));
        assert_eq!(toc.offsets, vec![150, 15213]);
        assert_eq!(toc.leadout, 90000 - crate::toc::DATA_SESSION_GAP);
    }

    #[test]
    fn plain_audio_cd_uses_the_leadout() {
        let mut buf = vec![0, 0, 1, 1];
        buf.extend(entry(0, 1, 0, 2, 0));
        buf.extend(entry(0, 0xAA, 4, 0, 0));
        let toc = parse_cdrom_toc(&buf).unwrap();
        assert_eq!(toc.leadout, 18000);
        assert!(parse_cdrom_toc(&[0, 0, 0, 0]).is_none());
    }
}
