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
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_CDROM: u32 = 5;
    const FILE_DEVICE_CD_ROM: u32 = 2;
    const IOCTL_CDROM_READ_TOC: u32 = 0x0002_4000;
    const IOCTL_CDROM_RAW_READ: u32 = 0x0002_403E;
    const IOCTL_STORAGE_EJECT_MEDIA: u32 = 0x002D_4808;
    const IOCTL_STORAGE_GET_DEVICE_NUMBER: u32 = 0x002D_1080;
    const IOCTL_STORAGE_CHECK_VERIFY: u32 = 0x002D_4800;
    const IOCTL_CDROM_SET_SPEED: u32 = 0x0002_4060;
    const CDDA: u32 = 2;
    /// Sectors per read, biggest first. Drives that refuse a big read get the next size down.
    const CHUNKS: [u32; 3] = [64, 26, 13];
    /// The biggest read this drive has managed (0 = not tried yet).
    static CHUNK_OK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(name: *const u16, access: u32, share: u32, security: *const c_void, disposition: u32, flags: u32, template: *mut c_void) -> *mut c_void;
        fn DeviceIoControl(device: *mut c_void, code: u32, input: *const c_void, input_len: u32, output: *mut c_void, output_len: u32, returned: *mut u32, overlapped: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetLastError() -> u32;
    }

    #[repr(C)]
    struct SetSpeed {
        request_type: u32, // CdromSetSpeed
        read_speed: u16,   // KB/s; 0xFFFF = as fast as the drive goes
        write_speed: u16,
        rotation: u32,     // CdromDefaultRotation
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

    /// Plain words for the Windows errors a CD drive gives.
    fn why(code: u32) -> String {
        match code {
            2 | 3 => "Windows can't see the drive right now".into(),
            5 => "Windows denied access to the drive (error 5). Another program may be using it".into(),
            21 => "no disc in it, or it's still spinning up".into(),
            32 => "another program is using it".into(),
            1117 => "the drive stopped responding (try unplugging and plugging it back in)".into(),
            _ => format!("Windows error {code}"),
        }
    }

    struct Drive(*mut c_void);
    impl Drive {
        /// `path` is "D:" or a device name like "CdRom0".
        fn open(path: &str) -> Result<Drive, u32> {
            let p = wide(&format!(r"\\.\{path}"));
            let h = unsafe { CreateFileW(p.as_ptr(), GENERIC_READ, FILE_SHARE_READ_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut()) };
            if h.is_null() || h as isize == -1 { Err(unsafe { GetLastError() }) } else { Ok(Drive(h)) }
        }
        fn ioctl(&self, code: u32, input: &[u8], output: &mut [u8]) -> Result<usize, u32> {
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
            if ok != 0 { Ok(got as usize) } else { Err(unsafe { GetLastError() }) }
        }
        /// (device type, number) of the drive, to match drive letters to \\.\CdRomN devices.
        fn device_number(&self) -> Option<(u32, u32)> {
            let mut buf = [0u8; 12];
            self.ioctl(IOCTL_STORAGE_GET_DEVICE_NUMBER, &[], &mut buf).ok()?;
            Some((u32::from_le_bytes(buf[0..4].try_into().ok()?), u32::from_le_bytes(buf[4..8].try_into().ok()?)))
        }
        fn read_toc(&self) -> Result<Option<Toc>, u32> {
            // Wakes a USB drive and checks there's a disc before asking for the contents.
            let _ = self.ioctl(IOCTL_STORAGE_CHECK_VERIFY, &[], &mut []);
            let mut buf = vec![0u8; 804]; // sizeof(CDROM_TOC)
            let mut last = 0;
            for attempt in 0..3 {
                match self.ioctl(IOCTL_CDROM_READ_TOC, &[], &mut buf) {
                    Ok(_) => return Ok(parse_cdrom_toc(&buf)),
                    Err(e) => last = e,
                }
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
            Err(last)
        }
    }
    impl Drop for Drive {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct WinDisc {
        /// "D:" or "CdRom1" (a drive with no letter).
        pub path: String,
        pub toc: Toc,
    }

    /// Every CD drive with an audio CD in it, plus a note on each drive that was skipped and why.
    pub fn scan() -> (Vec<WinDisc>, Vec<String>) {
        let mask = unsafe { GetLogicalDrives() };
        let mut discs = Vec::new();
        let mut notes = Vec::new();
        let mut seen_cd_numbers = Vec::new();
        // Opens a drive and reads its disc. `surely_cd`: Windows already says it's a CD drive. Notes are
        // only kept for CD drives (a USB stick doesn't answer the CD questions, which is expected).
        // Returns the drive's CD device number, if it is one.
        let try_drive = |path: String, name: String, surely_cd: bool, discs: &mut Vec<WinDisc>, notes: &mut Vec<String>| -> Option<u32> {
            let drive = match Drive::open(&path) {
                Ok(d) => d,
                Err(e) => {
                    if surely_cd { notes.push(format!("{name}: couldn't open it ({})", why(e))); }
                    return None;
                }
            };
            let number = match drive.device_number() {
                Some((FILE_DEVICE_CD_ROM, n)) => Some(n),
                _ => None,
            };
            if !surely_cd && number.is_none() {
                return None;
            }
            match drive.read_toc() {
                Ok(Some(toc)) => discs.push(WinDisc { path: path.clone(), toc }),
                Ok(None) => notes.push(format!("{name}: the disc in it has no music tracks (it's a data disc)")),
                Err(e) => notes.push(format!("{name}: {}", why(e))),
            }
            number
        };
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let kind = unsafe { GetDriveTypeW(wide(&format!("{letter}:\\")).as_ptr()) };
            // Some USB CD drives show up as "removable", so those are asked too.
            if kind != DRIVE_CDROM && kind != DRIVE_REMOVABLE {
                continue;
            }
            if let Some(n) = try_drive(format!("{letter}:"), format!("CD drive ({letter}:)"), kind == DRIVE_CDROM, &mut discs, &mut notes) {
                seen_cd_numbers.push(n);
            }
        }
        // CD drives without a drive letter (it happens with some USB drives).
        for n in 0..10u32 {
            if seen_cd_numbers.contains(&n) {
                continue;
            }
            let path = format!("CdRom{n}");
            if Drive::open(&path).is_err() {
                continue;
            }
            try_drive(path, format!("CD drive {} (no drive letter)", n + 1), true, &mut discs, &mut notes);
        }
        if discs.is_empty() && notes.is_empty() {
            notes.push("Windows doesn't list any CD drives. Check the drive shows up in File Explorer under This PC.".into());
        }
        (discs, notes)
    }

    fn as_bytes<T>(v: &T) -> &[u8] {
        unsafe { std::slice::from_raw_parts(v as *const T as *const u8, std::mem::size_of::<T>()) }
    }

    /// Reads `count` sectors at `lba` into `out`, trying a few times (scratches, a drive catching up).
    fn read_sectors(drive: &Drive, lba: u32, count: u32, out: &mut [u8], tries: u32) -> bool {
        let info = RawReadInfo { disk_offset: lba as i64 * 2048, sector_count: count, track_mode: CDDA };
        let want = count as usize * SECTOR_BYTES;
        (0..tries).any(|_| drive.ioctl(IOCTL_CDROM_RAW_READ, as_bytes(&info), &mut out[..want]) == Ok(want))
    }

    /// Reads one track's audio (interleaved 16-bit stereo, as i32 for the encoder).
    pub fn read_track(disc: &WinDisc, n: u8, progress: &dyn Fn(f32), cancel: &AtomicBool) -> Result<Vec<i32>, String> {
        let (start, len) = disc.toc.span(n).ok_or(format!("Track {n} isn't on the disc"))?;
        let drive = Drive::open(&disc.path).map_err(|e| format!("Couldn't open the CD drive: {}", why(e)))?;
        // Windows often slows drives down for audio; ask for full speed (drives that can't, ignore it).
        let speed = SetSpeed { request_type: 0, read_speed: 0xFFFF, write_speed: 0xFFFF, rotation: 0 };
        let _ = drive.ioctl(IOCTL_CDROM_SET_SPEED, as_bytes(&speed), &mut []);
        let lba = start - 150;
        let mut samples = Vec::with_capacity(len as usize * SECTOR_BYTES / 2);
        let mut buf = vec![0u8; CHUNKS[0] as usize * SECTOR_BYTES];
        let mut done = 0u32;
        // Find the biggest read this drive accepts (once per run).
        let mut chunk = CHUNK_OK.load(Ordering::Relaxed);
        if chunk == 0 {
            chunk = *CHUNKS.iter().find(|&&c| read_sectors(&drive, lba, c.min(len), &mut buf, 2)).unwrap_or(&1);
            CHUNK_OK.store(chunk, Ordering::Relaxed);
        }
        while done < len {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped".into());
            }
            let count = chunk.min(len - done);
            let want = count as usize * SECTOR_BYTES;
            if !read_sectors(&drive, lba + done, count, &mut buf, 3) {
                // A rough patch: go over it one sector at a time, a few tries each.
                for k in 0..count {
                    let at = k as usize * SECTOR_BYTES;
                    let mut one = [0u8; SECTOR_BYTES];
                    if !read_sectors(&drive, lba + done + k, 1, &mut one, 6) {
                        let t = done + k;
                        return Err(format!("Couldn't read track {n} at {}:{:02}. The disc may be scratched or dirty.", t / 75 / 60, t / 75 % 60));
                    }
                    buf[at..at + SECTOR_BYTES].copy_from_slice(&one);
                }
            }
            samples.extend(buf[..want].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as i32));
            done += count;
            progress(done as f32 / len as f32);
        }
        Ok(samples)
    }

    pub fn eject(disc: &WinDisc) -> Result<(), String> {
        let drive = Drive::open(&disc.path).map_err(|e| format!("Couldn't open the CD drive: {}", why(e)))?;
        drive.ioctl(IOCTL_STORAGE_EJECT_MEDIA, &[], &mut []).map(|_| ()).map_err(|_| "The drive didn't eject".to_string())
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
