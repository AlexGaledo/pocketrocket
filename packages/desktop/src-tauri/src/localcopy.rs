//! "Open on my PC": a copy of one file from a room's folder on the hub, saved under
//! Documents\PocketRocket\<chat>\ and opened in its default app (an HTML page in the browser, a PDF in the reader).
//!
//! Like the bot pop-outs, the hub page asks with `window.open("<hub>/?localcopy=<roomId>&path=<rel>&folder=<name>")`,
//! which arrives in on_new_window: no IPC command and no capability, so the page can ask for nothing but this.
//! The file is fetched here, over the same loopback port (or SSH tunnel) as the window, with the hub token.
//!
//! What keeps this from being a way to run something on the PC:
//!  - only document, data and image types (`ALLOWED_EXT`): no .exe, .bat, .ps1, .lnk, macro-enabled Office files;
//!  - the path stays inside the chat's folder (no `..`, no drive or absolute path, no `:` streams);
//!  - on Windows the copy gets the internet zone mark, so Office opens it in Protected View and SmartScreen applies.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Url;

/// File types that open in a viewer, never ones that run.
const ALLOWED_EXT: &[&str] = &[
    "html", "htm", "md", "markdown", "txt", "log", "csv", "tsv", "json", "xml", "yaml", "yml",
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "docx", "xlsx", "pptx",
];
/// The hub serves at most 50 MB from this route; a little room for the headers.
const MAX_BYTES: usize = 50 * 1024 * 1024 + 64 * 1024;

#[derive(Debug, PartialEq)]
pub struct Request {
    pub room: String,
    pub path: String,
    pub folder: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A relative path inside the chat's folder, `/`-separated, or None.
fn clean_path(raw: &str) -> Option<String> {
    let raw = raw.replace('\\', "/");
    if raw.is_empty() || raw.len() > 1024 || raw.starts_with('/') || raw.contains('\0') || raw.contains(':') {
        return None;
    }
    let parts: Vec<&str> = raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() || parts.iter().any(|p| *p == ".." || p.ends_with('.') || p.ends_with(' ')) {
        return None;
    }
    Some(parts.join("/"))
}

fn allowed_type(path: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    ALLOWED_EXT.contains(&ext.as_str())
}

/// The chat's folder name on disk: its name with only plain characters kept, or its id.
fn folder_name(name: &str, room: &str) -> String {
    let kept: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' }).take(60).collect();
    let kept = kept.trim_matches(|c: char| c == '.' || c == ' ' || c == '-').to_string();
    if kept.is_empty() { room.to_string() } else { kept }
}

/// The request in a new-window URL from the hub page, or None for anything else.
pub fn request(url: &Url, hub_port: u16) -> Option<Request> {
    let hub = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port_or_known_default() == Some(hub_port);
    if !hub {
        return None;
    }
    let get = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string());
    let room = get("localcopy").filter(|r| valid_id(r))?;
    let path = clean_path(&get("path")?)?;
    if !allowed_type(&path) {
        return None;
    }
    let folder = folder_name(&get("folder").unwrap_or_default(), &room);
    Some(Request { room, path, folder })
}

/// Why a request was refused, for the message the person sees; None when `request` would accept it.
pub fn refusal(url: &Url, hub_port: u16) -> Option<&'static str> {
    let is_ask = url.scheme() == "http" && url.port_or_known_default() == Some(hub_port) && url.query_pairs().any(|(k, _)| k == "localcopy");
    if !is_ask || request(url, hub_port).is_some() {
        return None;
    }
    let path = url.query_pairs().find(|(k, _)| k == "path").map(|(_, v)| v.to_string()).unwrap_or_default();
    Some(if clean_path(&path).is_some() && !allowed_type(&path) { "That kind of file can't be opened on this PC. Download it from Files instead." } else { "That file can't be opened on this PC." })
}

/// GET the file's bytes from the hub. Plain HTTP/1.1 to 127.0.0.1 (the hub, or the local end of its SSH tunnel).
fn fetch(port: u16, token: &str, req: &Request) -> Result<Vec<u8>, String> {
    let mut target = Url::parse("http://127.0.0.1/").unwrap();
    target.set_path(&format!("/api/rooms/{}/files/raw", req.room));
    target.query_pairs_mut().append_pair("path", &req.path).append_pair("download", "1");
    let path_and_query = format!("{}?{}", target.path(), target.query().unwrap_or(""));

    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|_| "PocketRocket isn't connected.".to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(60)));
    let head = format!("GET {path_and_query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
    s.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.take(MAX_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() > MAX_BYTES {
        return Err("The file is too big to copy (max 50 MB).".into());
    }
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("The hub sent a broken answer.")?;
    let headers = String::from_utf8_lossy(&buf[..split]).to_string();
    let status: u16 = headers.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    match status {
        200 => {}
        404 => return Err("That file is gone. It may have been moved or deleted.".into()),
        413 => return Err("The file is too big to copy (max 50 MB).".into()),
        _ => return Err(format!("The hub couldn't send the file ({status}).")),
    }
    let body = buf.split_off(split + 4);
    let want = headers.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok()).flatten()
    });
    if want.is_some_and(|n| n != body.len()) {
        return Err("The download was cut off. Try again.".into());
    }
    Ok(body)
}

/// Where the copy goes: <documents>\PocketRocket\<chat>\<path>.
pub fn destination(documents: &Path, req: &Request) -> PathBuf {
    let mut p = documents.join("PocketRocket").join(&req.folder);
    for part in req.path.split('/') {
        p.push(part);
    }
    p
}

/// Fetch, save (replacing an older copy) and open. Returns where it was saved.
pub fn save_and_open(documents: &Path, port: u16, token: &str, req: &Request) -> Result<PathBuf, String> {
    let bytes = fetch(port, token, req)?;
    let dest = destination(documents, req);
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the folder: {e}"))?;
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("Couldn't save it (is it open in another app?): {e}"))?;
    #[cfg(windows)]
    {
        // Mark of the Web: the copy came from a server, so Windows treats it like any download.
        let mut ads = dest.clone().into_os_string();
        ads.push(":Zone.Identifier");
        let _ = std::fs::write(PathBuf::from(ads), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    open::that_detached(&dest).map_err(|e| format!("Saved to {}, but couldn't open it: {e}", dest.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn accepts_a_document_in_the_chat_folder() {
        let r = request(&u("http://127.0.0.1:7788/?localcopy=room_1&path=reports%2Fq3.html&folder=Data%20team"), 7788).unwrap();
        assert_eq!(r, Request { room: "room_1".into(), path: "reports/q3.html".into(), folder: "Data team".into() });
        assert_eq!(destination(Path::new("D"), &r), Path::new("D").join("PocketRocket").join("Data team").join("reports").join("q3.html"));
    }

    #[test]
    fn refuses_other_hosts_ports_and_paths() {
        assert!(request(&u("http://127.0.0.1:7789/?localcopy=r&path=a.md"), 7788).is_none());
        assert!(request(&u("http://evil.example:7788/?localcopy=r&path=a.md"), 7788).is_none());
        assert!(request(&u("http://127.0.0.1:7788/?localcopy=..%2Fx&path=a.md"), 7788).is_none());
        for bad in ["..%2Fa.md", "%2Fetc%2Fa.md", "C%3A%2Fa.md", "a.md%3AZone.Identifier", "a%2F..%2F..%2Fb.md", "a.md.", ""] {
            assert!(request(&u(&format!("http://127.0.0.1:7788/?localcopy=r&path={bad}")), 7788).is_none(), "{bad}");
        }
    }

    #[test]
    fn refuses_files_that_run() {
        for ext in ["exe", "bat", "cmd", "ps1", "lnk", "vbs", "js", "hta", "docm", "xlsm", "msi", "scr"] {
            let url = u(&format!("http://127.0.0.1:7788/?localcopy=r&path=x.{ext}"));
            assert!(request(&url, 7788).is_none(), "{ext}");
            assert!(refusal(&url, 7788).unwrap().contains("kind of file"));
        }
        assert!(request(&u("http://127.0.0.1:7788/?localcopy=r&path=Notes.PDF"), 7788).is_some());
        assert!(refusal(&u("http://127.0.0.1:7788/?popout=b"), 7788).is_none());
    }

    #[test]
    fn folder_name_keeps_plain_characters() {
        assert_eq!(folder_name("Q3 / plans: <draft>", "r1"), "Q3 - plans- -draft");
        assert_eq!(folder_name("..", "r1"), "r1");
        assert_eq!(folder_name("", "r1"), "r1");
    }
}
