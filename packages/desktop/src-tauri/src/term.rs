//! A real terminal (ConPTY on Windows) running `ssh -tt <host>`, for the "Server terminal" window.
//!
//! Only the window labelled `terminal` may call these commands; the hub page and the splash cannot.
//! The host comes from the saved connection config and goes through `ssh::validate_host`, never from the page.

use crate::ssh;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, Window};

pub const LABEL: &str = "terminal";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Term(Mutex<Option<Session>>);

impl Term {
    pub fn close(&self) {
        if let Some(mut s) = self.0.lock().unwrap().take() {
            let _ = s.child.kill();
        }
    }
}

fn only_terminal(w: &Window) -> Result<(), String> {
    if w.label() == LABEL { Ok(()) } else { Err("not allowed from this window".into()) }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(2, 500), cols: cols.clamp(10, 1000), pixel_width: 0, pixel_height: 0 }
}

/// Start (or restart) the ssh session. Output arrives as `term-data` events, the end as `term-exit`.
#[tauri::command]
pub fn term_open(window: Window, app: AppHandle, term: State<'_, Term>, host: String, cols: u16, rows: u16) -> Result<u64, String> {
    only_terminal(&window)?;
    ssh::validate_host(&host)?;
    term.close();

    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(ssh::ssh_exe());
    // -tt: remote pty even though the local side is a pty too. ServerAlive so a dead link ends the session.
    cmd.args(["-tt", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15", "--", host.as_str()]);
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!("Can't start ssh ({e}). Install \"OpenSSH Client\" in Windows Settings, System, Optional features.")
    })?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    *term.0.lock().unwrap() = Some(Session { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Bytes can split a UTF-8 character; carry the tail over to the next read.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                        pending.drain(..valid);
                        let _ = app.emit_to(LABEL, "term-data", (id, text));
                    }
                    if pending.len() > 8 { pending.clear(); }
                }
            }
        }
        let _ = app.emit_to(LABEL, "term-exit", id);
    });
    Ok(id)
}

#[tauri::command]
pub fn term_write(window: Window, term: State<'_, Term>, data: String) -> Result<(), String> {
    only_terminal(&window)?;
    if let Some(s) = term.0.lock().unwrap().as_mut() {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn term_resize(window: Window, term: State<'_, Term>, cols: u16, rows: u16) -> Result<(), String> {
    only_terminal(&window)?;
    if let Some(s) = term.0.lock().unwrap().as_ref() {
        s.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_close(window: Window, term: State<'_, Term>) -> Result<(), String> {
    only_terminal(&window)?;
    term.close();
    Ok(())
}

/// The saved connection's ssh host, so the page never chooses what gets executed.
#[tauri::command]
pub fn term_host(window: Window, state: State<'_, crate::AppState>) -> Result<String, String> {
    only_terminal(&window)?;
    Ok(state.0.lock().unwrap().config.ssh_host.clone())
}

/// Open a link clicked in the terminal in the default browser. http(s) only, parsed here in Rust.
#[tauri::command]
pub fn term_open_url(window: Window, url: String) -> Result<(), String> {
    only_terminal(&window)?;
    let u = tauri::Url::parse(url.trim()).map_err(|e| e.to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("only http and https links can be opened".into());
    }
    crate::open_in_browser(&u);
    Ok(())
}

/// Copy selected terminal text to the system clipboard. The webview's own clipboard API is often refused.
#[tauri::command]
pub fn term_copy(window: Window, text: String) -> Result<(), String> {
    only_terminal(&window)?;
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| e.to_string())
}

/// Text from the system clipboard, for paste.
#[tauri::command]
pub fn term_paste(window: Window) -> Result<String, String> {
    only_terminal(&window)?;
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}
