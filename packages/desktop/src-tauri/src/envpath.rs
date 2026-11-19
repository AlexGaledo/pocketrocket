//! A fresh PATH for the hub on Windows.
//!
//! A process gets its environment once, at start. The app can stay open for days, so a CLI installed in
//! the meantime (its installer adds a folder to the user or machine `Path` in the registry) stays
//! invisible to the hub and the bots it starts, even across "Restart hub". So each time the hub is
//! spawned we read both `Path` values from the registry again and add any folder the inherited PATH
//! lacks. The inherited entries keep their place and order, so nothing that resolves today resolves
//! differently; new folders only go at the end.

use std::ffi::{OsStr, OsString};

/// The PATH to give the hub, or None to leave the inherited one alone (not Windows, or nothing new).
pub fn fresh_path() -> Option<OsString> {
    #[cfg(windows)]
    {
        let current = std::env::var_os("PATH");
        let registry: Vec<OsString> = [win::machine_path(), win::user_path()].into_iter().flatten().collect();
        merge(current.as_deref(), &registry)
    }
    #[cfg(not(windows))]
    None
}

/// Compare folders the way Windows does: case-insensitive, trailing separators ignored.
fn key(dir: &std::path::Path) -> String {
    dir.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
}

/// `current` entries first, untouched, then every folder from `extra` (each a PATH-style list) that is
/// not already there. None when nothing would change or the result can't be joined.
fn merge(current: Option<&OsStr>, extra: &[OsString]) -> Option<OsString> {
    let mut dirs: Vec<std::path::PathBuf> = current.map(|c| std::env::split_paths(c).collect()).unwrap_or_default();
    let mut seen: std::collections::HashSet<String> = dirs.iter().map(|d| key(d)).collect();
    let mut added = false;
    for list in extra {
        for dir in std::env::split_paths(list) {
            if dir.as_os_str().is_empty() || !seen.insert(key(&dir)) {
                continue;
            }
            dirs.push(dir);
            added = true;
        }
    }
    if !added {
        return None;
    }
    std::env::join_paths(dirs).ok()
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_EXPAND_SZ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };

    pub fn machine_path() -> Option<OsString> {
        read(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    }

    pub fn user_path() -> Option<OsString> {
        read(HKEY_CURRENT_USER, "Environment")
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Up to the first NUL.
    fn until_nul(buf: &[u16]) -> &[u16] {
        &buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]
    }

    /// `Path` under `subkey`, with `%VAR%` expanded when it is REG_EXPAND_SZ. Read-only.
    fn read(root: HKEY, subkey: &str) -> Option<OsString> {
        let subkey = wide(subkey);
        let value = wide("Path");
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        let mut buf: Vec<u16> = vec![0; 2048];
        // the value can grow between the two calls; a few tries, then give up
        for _ in 0..4 {
            let mut kind = 0u32;
            let mut bytes = (buf.len() * 2) as u32;
            // SAFETY: both name strings are NUL-terminated; `bytes` is the real byte size of `buf`.
            let rc = unsafe {
                RegGetValueW(root, subkey.as_ptr(), value.as_ptr(), flags, &mut kind, buf.as_mut_ptr().cast(), &mut bytes)
            };
            if rc == ERROR_MORE_DATA {
                buf = vec![0; (bytes as usize).div_ceil(2) + 1];
                continue;
            }
            if rc != ERROR_SUCCESS {
                return None;
            }
            let raw = until_nul(&buf[..(bytes as usize / 2).min(buf.len())]);
            if kind != REG_EXPAND_SZ {
                return Some(OsString::from_wide(raw));
            }
            return Some(expand(raw));
        }
        None
    }

    /// ExpandEnvironmentStringsW against this process's environment; the unexpanded text if it fails.
    fn expand(raw: &[u16]) -> OsString {
        let src: Vec<u16> = raw.iter().copied().chain(std::iter::once(0)).collect();
        let mut out: Vec<u16> = vec![0; src.len().max(260)];
        for _ in 0..4 {
            // SAFETY: `src` is NUL-terminated; `out.len()` is the capacity in characters.
            let n = unsafe { ExpandEnvironmentStringsW(src.as_ptr(), out.as_mut_ptr(), out.len() as u32) } as usize;
            if n == 0 {
                break;
            }
            if n <= out.len() {
                return OsString::from_wide(until_nul(&out[..n]));
            }
            out = vec![0; n];
        }
        OsString::from_wide(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(dirs: &[&str]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn keeps_inherited_order_and_appends_new_folders() {
        let current = list(&["/a", "/b"]);
        let merged = merge(Some(&current), &[list(&["/b", "/c"]), list(&["/d", "/a"])]).unwrap();
        let dirs: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(dirs, ["/a", "/b", "/c", "/d"].map(std::path::PathBuf::from));
    }

    #[test]
    fn nothing_new_means_no_override() {
        let current = list(&["/a", "/b"]);
        assert_eq!(merge(Some(&current), &[list(&["/a/", "/B"])]), None);
        assert_eq!(merge(Some(&current), &[]), None);
    }

    #[test]
    fn works_without_an_inherited_path() {
        let merged = merge(None, &[list(&["/x"])]).unwrap();
        assert_eq!(std::env::split_paths(&merged).collect::<Vec<_>>(), vec![std::path::PathBuf::from("/x")]);
    }
}
