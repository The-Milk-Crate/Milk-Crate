//! Where the sound plays (speakers, headphones, Bluetooth…), on a Mac. The Mac's web view can't
//! send sound to a chosen device by itself, so picking one switches the Mac's sound output, the
//! same as choosing it in Control Center. (On Windows the app picks its own device; see
//! src/lib/outputs.ts.)

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub id: String,
    pub name: String,
    pub current: bool,
    /// "bluetooth", "usb", "builtin", "hdmi", "airplay" or "other".
    pub kind: String,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Output;
    use std::ffi::c_void;
    use std::os::raw::c_char;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }
    const SYSTEM: u32 = 1;
    const DEVICES: u32 = fourcc(b"dev#");
    const DEFAULT_OUTPUT: u32 = fourcc(b"dOut");
    const STREAMS: u32 = fourcc(b"stm#");
    const NAME: u32 = fourcc(b"lnam");
    const TRANSPORT: u32 = fourcc(b"tran");
    const GLOBAL: u32 = fourcc(b"glob");
    const OUTPUT: u32 = fourcc(b"outp");
    const MAIN: u32 = 0;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyDataSize(id: u32, addr: *const Address, qs: u32, q: *const c_void, size: *mut u32) -> i32;
        fn AudioObjectGetPropertyData(id: u32, addr: *const Address, qs: u32, q: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
        fn AudioObjectSetPropertyData(id: u32, addr: *const Address, qs: u32, q: *const c_void, size: u32, data: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(s: *const c_void, buf: *mut c_char, len: isize, encoding: u32) -> u8;
        fn CFRelease(r: *const c_void);
    }

    fn get_u32(id: u32, selector: u32, scope: u32) -> Option<u32> {
        let addr = Address { selector, scope, element: MAIN };
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe { AudioObjectGetPropertyData(id, &addr, 0, std::ptr::null(), &mut size, &mut v as *mut u32 as *mut c_void) };
        (st == 0).then_some(v)
    }

    fn name(id: u32) -> String {
        let addr = Address { selector: NAME, scope: GLOBAL, element: MAIN };
        let mut s: *const c_void = std::ptr::null();
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let st = unsafe { AudioObjectGetPropertyData(id, &addr, 0, std::ptr::null(), &mut size, &mut s as *mut *const c_void as *mut c_void) };
        if st != 0 || s.is_null() {
            return format!("Device {id}");
        }
        let mut buf = vec![0 as c_char; 512];
        let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) };
        unsafe { CFRelease(s) };
        if ok == 0 {
            return format!("Device {id}");
        }
        let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn has_output(id: u32) -> bool {
        let addr = Address { selector: STREAMS, scope: OUTPUT, element: MAIN };
        let mut size: u32 = 0;
        let st = unsafe { AudioObjectGetPropertyDataSize(id, &addr, 0, std::ptr::null(), &mut size) };
        st == 0 && size > 0
    }

    fn kind(id: u32) -> &'static str {
        match get_u32(id, TRANSPORT, GLOBAL) {
            Some(t) if t == fourcc(b"blue") || t == fourcc(b"blea") => "bluetooth",
            Some(t) if t == fourcc(b"usb ") => "usb",
            Some(t) if t == fourcc(b"bltn") => "builtin",
            Some(t) if t == fourcc(b"hdmi") || t == fourcc(b"dprt") => "hdmi",
            Some(t) if t == fourcc(b"airp") => "airplay",
            _ => "other",
        }
    }

    pub fn list() -> Vec<Output> {
        let addr = Address { selector: DEVICES, scope: GLOBAL, element: MAIN };
        let mut size: u32 = 0;
        if unsafe { AudioObjectGetPropertyDataSize(SYSTEM, &addr, 0, std::ptr::null(), &mut size) } != 0 {
            return vec![];
        }
        let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        if unsafe { AudioObjectGetPropertyData(SYSTEM, &addr, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) } != 0 {
            return vec![];
        }
        let current = get_u32(SYSTEM, DEFAULT_OUTPUT, GLOBAL);
        ids.into_iter()
            .filter(|&id| has_output(id))
            .map(|id| Output { id: id.to_string(), name: name(id), current: Some(id) == current, kind: kind(id).into() })
            .collect()
    }

    pub fn set(id: &str) -> Result<(), String> {
        let id: u32 = id.parse().map_err(|_| "That isn't a sound output.".to_string())?;
        if !list().iter().any(|o| o.id == id.to_string()) {
            return Err("That sound output isn't connected anymore.".into());
        }
        let addr = Address { selector: DEFAULT_OUTPUT, scope: GLOBAL, element: MAIN };
        let st = unsafe { AudioObjectSetPropertyData(SYSTEM, &addr, 0, std::ptr::null(), std::mem::size_of::<u32>() as u32, &id as *const u32 as *const c_void) };
        if st == 0 { Ok(()) } else { Err(format!("macOS wouldn't switch to that output ({st}).")) }
    }
}

/// The sound outputs (Mac only; elsewhere the app lists them itself).
#[tauri::command]
pub fn audio_outputs() -> Vec<Output> {
    #[cfg(target_os = "macos")]
    return mac::list();
    #[cfg(not(target_os = "macos"))]
    return vec![];
}

#[tauri::command]
pub fn set_audio_output(id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return mac::set(&id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("Pick the output in Milk Crate's list instead.".into())
    }
}
