//! PocketRocket desktop.
//! Modes:
//!   local  – the app runs its own hub as a child process; every bit of state (SQLite, memories,
//!            workspace, skills) lives in the app's data dir. No network hop, lowest latency.
//!   remote – ssh -L tunnel to a hub on a VPS (screen/desktop features live there).
//!   attach – connect to a hub something else already started on 127.0.0.1:<port>.
//! Config: <app config dir>/config.json (Windows: %APPDATA%\com.pocketrocket.app\config.json).

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, State};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub mode: String,
    pub ssh_host: String,
    pub port: u16,
    /// Repo root containing packages/hub (defaults to where this app was built from).
    #[serde(default)]
    pub hub_dir: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { mode: "local".into(), ssh_host: "".into(), port: 7788, hub_dir: None }
    }
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub attempts: u32,
    pub error: Option<String>,
    pub child_running: bool,
    pub navigated: bool,
    pub data_dir: String,
    pub mode: String,
}

struct Inner {
    config: Config,
    status: Status,
    child: Option<Child>,
    child_kind: &'static str, // "hub" | "ssh" | ""
    generation: u64,
    quitting: bool,
}

#[derive(Clone)]
pub struct AppState(Arc<Mutex<Inner>>);

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir
}
fn config_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("config.json")
}
fn data_dir(app: &AppHandle) -> PathBuf {
    let d = config_dir(app).join("data");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn dir_has_files(d: &std::path::Path) -> bool {
    match std::fs::read_dir(d) {
        Ok(mut it) => it.next().is_some(),
        Err(_) => false,
    }
}

/// Best-effort recursive copy; ignores per-file errors so one locked/unreadable file
/// doesn't abort the whole migration.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(dst);
    for entry in entries.flatten() {
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path);
        } else {
            let _ = std::fs::copy(&path, &dest_path);
        }
    }
}

/// One-time migration from the old Claudebot app data dir (Windows: %APPDATA%\com.claudebot.desktop)
/// into this app's config/data dirs. Only runs if this app has no config.json yet and no data files.
fn migrate_legacy_data(app: &AppHandle) {
    let new_config_path = config_path(app);
    let new_data_dir = data_dir(app);
    if new_config_path.exists() || dir_has_files(&new_data_dir) {
        return;
    }
    let legacy_dir = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|d| d.parent().map(|p| p.join("com.claudebot.desktop")));
    let legacy_dir = match legacy_dir {
        Some(d) if d.exists() => d,
        _ => return,
    };
    let legacy_config = legacy_dir.join("config.json");
    if legacy_config.exists() {
        let _ = std::fs::copy(&legacy_config, &new_config_path);
    }
    let legacy_data = legacy_dir.join("data");
    if legacy_data.exists() {
        copy_dir_recursive(&legacy_data, &new_data_dir);
    }
    eprintln!("migrated legacy Claudebot data");
}

fn load_config(app: &AppHandle) -> Config {
    let p = config_path(app);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => {
            let c = Config::default();
            let _ = std::fs::write(&p, serde_json::to_string_pretty(&c).unwrap());
            c
        }
    }
}
fn save_config_file(app: &AppHandle, c: &Config) {
    let _ = std::fs::write(config_path(app), serde_json::to_string_pretty(c).unwrap());
}

fn port_open(port: u16) -> bool {
    match ("127.0.0.1", port).to_socket_addrs().ok().and_then(|mut a| a.next()) {
        Some(a) => TcpStream::connect_timeout(&a, Duration::from_millis(400)).is_ok(),
        None => false,
    }
}

fn hub_healthy(port: u16) -> bool {
    let addr = match ("127.0.0.1", port).to_socket_addrs().ok().and_then(|mut a| a.next()) {
        Some(a) => a,
        None => return false,
    };
    let mut s = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    use std::io::Write;
    if s.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.contains("\"ok\":true")
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

fn spawn_tunnel(cfg: &Config) -> Result<Child, String> {
    let fwd = format!("{}:127.0.0.1:{}", cfg.port, cfg.port);
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15", "-N", "-L", &fwd, &cfg.ssh_host,
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("cannot start ssh: {e}. Is OpenSSH installed and `ssh {}` configured?", cfg.ssh_host))
}

/// Start the hub as our own child: node + tsx from the repo, data in the app's data dir.
fn spawn_hub(app: &AppHandle, cfg: &Config) -> Result<Child, String> {
    let root = cfg.hub_dir.clone().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(REPO_ROOT));
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let hub = root.join("packages").join("hub");
    let tsx = hub.join("node_modules").join("tsx").join("dist").join("cli.mjs");
    let entry = hub.join("src").join("index.ts");
    if !entry.exists() {
        return Err(format!("hub not found at {}. Set hubDir in config.json to the pocketrocket repo.", hub.display()));
    }
    if !tsx.exists() {
        return Err(format!("dependencies missing: run `pnpm install` in {}", root.display()));
    }
    let data = data_dir(app);
    let log = std::fs::File::create(config_dir(app).join("hub.log")).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("node");
    cmd.arg(strip_verbatim(&tsx)).arg(strip_verbatim(&entry));
    cmd.current_dir(strip_verbatim(&hub));
    cmd.env("POCKETROCKET_DATA", strip_verbatim(&data));
    cmd.env("PORT", cfg.port.to_string());
    cmd.env("NODE_NO_WARNINGS", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("cannot start node: {e}. Is Node.js on PATH?"))
}

/// Windows canonicalize() yields \\?\C:\... which some tools dislike; strip the prefix.
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

fn kill_child(inner: &mut Inner) {
    if let Some(mut c) = inner.child.take() {
        #[cfg(windows)]
        {
            // take the whole tree: node -> claude.exe turns, ssh
            let _ = Command::new("taskkill").args(["/pid", &c.id().to_string(), "/t", "/f"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = c.kill();
        let _ = c.wait();
    }
    inner.child_kind = "";
    inner.status.child_running = false;
}

fn splash_url() -> &'static str {
    if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }
}

/// (Re)start the connection for the current mode, then watch for the hub and navigate to it.
fn connect(app: AppHandle, state: AppState, show_splash: bool) {
    if show_splash {
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(u) = splash_url().parse() {
                let _ = win.navigate(u);
            }
        }
    }
    let (cfg, gen) = {
        let mut inner = state.0.lock().unwrap();
        kill_child(&mut inner);
        inner.generation += 1;
        inner.status = Status { data_dir: data_dir(&app).to_string_lossy().to_string(), mode: inner.config.mode.clone(), ..Default::default() };
        match inner.config.mode.as_str() {
            "remote" => {
                if !port_open(inner.config.port) {
                    match spawn_tunnel(&inner.config) {
                        Ok(c) => { inner.child = Some(c); inner.child_kind = "ssh"; inner.status.child_running = true; }
                        Err(e) => inner.status.error = Some(e),
                    }
                }
            }
            "local" => {
                if port_open(inner.config.port) {
                    inner.status.error = Some(format!("Port {} is already in use on this PC (another hub, or a VPS tunnel). Close it or change the port.", inner.config.port));
                } else {
                    match spawn_hub(&app, &inner.config) {
                        Ok(c) => { inner.child = Some(c); inner.child_kind = "hub"; inner.status.child_running = true; }
                        Err(e) => inner.status.error = Some(e),
                    }
                }
            }
            _ => {}
        }
        (inner.config.clone(), inner.generation)
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&format!("PocketRocket · {}", match cfg.mode.as_str() { "local" => "this PC".to_string(), "remote" => cfg.ssh_host.clone(), _ => "attached".to_string() }));
    }

    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            {
                let mut inner = state.0.lock().unwrap();
                if inner.quitting || inner.generation != gen { return; }
                if inner.status.error.is_some() && inner.child.is_none() && cfg.mode != "attach" { return; }
                inner.status.attempts += 1;
                if let Some(child) = inner.child.as_mut() {
                    if let Ok(Some(code)) = child.try_wait() {
                        let mut err = String::new();
                        if let Some(mut e) = child.stderr.take() { let _ = e.read_to_string(&mut err); }
                        let kind = inner.child_kind;
                        inner.status.child_running = false;
                        inner.child = None;
                        inner.status.error = Some(if kind == "hub" {
                            format!("The hub exited ({code}). See hub.log in the app data folder.")
                        } else {
                            format!("ssh exited ({code}): {}", err.trim())
                        });
                        return;
                    }
                }
            }
            if hub_healthy(cfg.port) {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(u) = format!("http://127.0.0.1:{}/", cfg.port).parse() { let _ = win.navigate(u); }
                }
                let mut inner = state.0.lock().unwrap();
                inner.status.connected = true;
                inner.status.navigated = true;
                inner.status.error = None;
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                let mut inner = state.0.lock().unwrap();
                inner.status.error = Some(match cfg.mode.as_str() {
                    "remote" => format!("No answer from the hub through the tunnel after 60s. On the VPS: systemctl status pocketrocket. Locally: ssh {}", cfg.ssh_host),
                    "local" => "The hub did not come up within 60s. See hub.log in the app data folder.".to_string(),
                    _ => format!("No hub on 127.0.0.1:{}. Start one with `pnpm start` and retry.", cfg.port),
                });
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        // keep-alive: respawn ssh if it drops; a dead local hub surfaces as an error on next reload
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let mut inner = state.0.lock().unwrap();
            if inner.quitting || inner.generation != gen { return; }
            let dead = match inner.child.as_mut() { Some(c) => matches!(c.try_wait(), Ok(Some(_))), None => false };
            if dead && inner.config.mode == "remote" && !port_open(inner.config.port) {
                inner.child = spawn_tunnel(&inner.config).ok();
                inner.status.child_running = inner.child.is_some();
            }
        }
    });
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config { state.0.lock().unwrap().config.clone() }

#[tauri::command]
fn get_status(state: State<AppState>) -> Status { state.0.lock().unwrap().status.clone() }

#[tauri::command]
fn save_config(app: AppHandle, state: State<AppState>, config: Config) -> Result<(), String> {
    save_config_file(&app, &config);
    state.0.lock().unwrap().config = config;
    connect(app.clone(), state.inner().clone(), false);
    Ok(())
}

#[tauri::command]
fn retry(app: AppHandle, state: State<AppState>) { connect(app.clone(), state.inner().clone(), false); }

fn set_mode(app: &AppHandle, state: &AppState, mode: &str) {
    {
        let mut inner = state.0.lock().unwrap();
        inner.config.mode = mode.into();
        save_config_file(app, &inner.config);
    }
    connect(app.clone(), state.clone(), true);
}

pub fn run() {
    let state = AppState(Arc::new(Mutex::new(Inner {
        config: Config::default(), status: Status::default(), child: None, child_kind: "", generation: 0, quitting: false,
    })));
    let menu_state = state.clone();

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![get_config, get_status, save_config, retry])
        .setup(move |app| {
            let handle = app.handle().clone();
            migrate_legacy_data(&handle);
            let cfg = load_config(&handle);
            state.0.lock().unwrap().config = cfg;

            let m_local = MenuItem::with_id(app, "mode_local", "Local: this PC (own database)", true, None::<&str>)?;
            let m_remote = MenuItem::with_id(app, "mode_remote", "VPS: over SSH tunnel", true, None::<&str>)?;
            let m_attach = MenuItem::with_id(app, "mode_attach", "Attach to a running local hub", true, None::<&str>)?;
            let m_reload = MenuItem::with_id(app, "reload", "Reload", true, Some("F5"))?;
            let m_data = MenuItem::with_id(app, "open_data", "Open data folder", true, None::<&str>)?;
            let m_settings = MenuItem::with_id(app, "settings", "Connection settings", true, None::<&str>)?;
            let conn = Submenu::with_items(app, "Connection", true, &[&m_local, &m_remote, &m_attach, &PredefinedMenuItem::separator(app)?, &m_settings])?;
            let view = Submenu::with_items(app, "View", true, &[&m_reload, &m_data, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, Some("Quit"))?])?;
            let menu = Menu::with_items(app, &[&conn, &view])?;
            app.set_menu(menu)?;

            connect(handle, state.clone(), false);
            Ok(())
        })
        .on_menu_event(move |app, event| {
            let st = menu_state.clone();
            match event.id().as_ref() {
                "mode_local" => set_mode(app, &st, "local"),
                "mode_remote" => set_mode(app, &st, "remote"),
                "mode_attach" => set_mode(app, &st, "attach"),
                "reload" => { if let Some(w) = app.get_webview_window("main") { let _ = w.eval("location.reload()"); } }
                "open_data" => {
                    let d = data_dir(app);
                    #[cfg(windows)] { let _ = Command::new("explorer").arg(strip_verbatim(&d)).spawn(); }
                    #[cfg(target_os = "macos")] { let _ = Command::new("open").arg(&d).spawn(); }
                    #[cfg(all(unix, not(target_os = "macos")))] { let _ = Command::new("xdg-open").arg(&d).spawn(); }
                }
                "settings" => { if let Some(w) = app.get_webview_window("main") { if let Ok(u) = splash_url().parse() { let _ = w.navigate(u); } } }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building PocketRocket")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(st) = app.try_state::<AppState>() {
                    let mut inner = st.0.lock().unwrap();
                    inner.quitting = true;
                    kill_child(&mut inner);
                }
            }
        });
}
