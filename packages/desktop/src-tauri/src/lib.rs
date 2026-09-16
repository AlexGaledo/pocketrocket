//! PocketRocket desktop.
//! Modes:
//!   local  – the app runs its own hub as a child process; every bit of state (SQLite, memories,
//!            workspace, skills) lives in the app's data dir. No network hop, lowest latency.
//!   remote – ssh -L tunnel to a hub on a VPS (screen/desktop features live there).
//!   attach – connect to a hub something else already started on 127.0.0.1:<port>.
//! Config: <app config dir>/config.json (Windows: %APPDATA%\com.pocketrocket.app\config.json).
//!
//! In local mode the hub runs from `resources/hub/hub.mjs` (built by `pnpm hub:bundle`), on the
//! system Node when it is >= 22.13 and otherwise on the Node 24 sidecar installed as `node.exe`
//! next to the app. `cargo tauri dev` copies the same resources, so to iterate on hub sources set
//! `hubDir` in config.json to the repo root (debug builds) or `POCKETROCKET_HUB_DIR` in the
//! environment, and the app runs `packages/hub/src/index.ts` via tsx.

mod proc;
mod scan;
mod ssh;

use proc::{kill_tree, no_window, Tail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub mode: String,
    pub ssh_host: String,
    pub port: u16,
    /// Repo root containing packages/hub, for development only; see [`hub_dir_override`].
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
    /// Seconds since this connection attempt started.
    pub elapsed_secs: u64,
    pub error: Option<String>,
    /// hostKeyChanged | hostKeyUnknown | authFailed | … when the error came from ssh.
    pub error_kind: Option<&'static str>,
    pub child_running: bool,
    pub navigated: bool,
    pub data_dir: String,
    pub mode: String,
    pub ssh_host: String,
    pub port: u16,
    /// Which JS runtime is running the hub: "system node 26.3.0" | "bundled node 24.20.0" | "dev (tsx)".
    pub runtime: String,
    pub log_path: String,
    pub version: String,
    /// There was no config.json at launch: nothing was started, the splash asks where to run.
    pub first_run: bool,
    /// Local mode found the port taken by something that answers /api/health (offer to attach).
    pub port_has_hub: bool,
}

struct Inner {
    config: Config,
    status: Status,
    child: Option<Child>,
    child_kind: &'static str, // "hub" | "ssh" | ""
    generation: u64,
    quitting: bool,
    /// Bearer token handed to the hub and to the web UI; new on every launch.
    token: String,
    connect_started: Instant,
    first_run: bool,
    /// `remote_claude_status` result for this connection generation.
    remote_claude: Option<(u64, RemoteClaude)>,
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

/// The config, and whether this launch had to create it (first run).
fn load_config(app: &AppHandle) -> (Config, bool) {
    let p = config_path(app);
    match std::fs::read_to_string(&p) {
        Ok(s) => (serde_json::from_str(&s).unwrap_or_default(), false),
        Err(_) => {
            let c = Config::default();
            let _ = std::fs::write(&p, serde_json::to_string_pretty(&c).unwrap());
            (c, true)
        }
    }
}

fn validate_config(c: &Config) -> Result<(), String> {
    if !matches!(c.mode.as_str(), "local" | "remote" | "attach") {
        return Err(format!("Unknown mode {}", c.mode));
    }
    if c.port < 1024 {
        return Err("Pick a port between 1024 and 65535.".into());
    }
    if c.mode == "remote" {
        ssh::validate_host(&c.ssh_host)?;
    }
    Ok(())
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

/// One small HTTP/1.0 exchange with 127.0.0.1:<port> (1.0 so the answer is never chunked).
/// Returns the status code and body, capped at 64 KB.
fn local_http(port: u16, method: &str, path: &str, extra_headers: &str, body: &str, read_timeout: Duration) -> Option<(u16, String)> {
    let addr = ("127.0.0.1", port).to_socket_addrs().ok().and_then(|mut a| a.next())?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = s.set_read_timeout(Some(read_timeout));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    use std::io::Write;
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{extra_headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(64 * 1024).read_to_end(&mut buf);
    parse_http_response(&String::from_utf8_lossy(&buf))
}

fn parse_http_response(raw: &str) -> Option<(u16, String)> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let code = head.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    Some((code, body.to_string()))
}

/// Something that talks like a PocketRocket hub answers GET /api/health. Deliberately not `"ok":true`:
/// the hub reports ok=false when Claude Code is missing, and it still serves the UI that says so.
fn hub_responding(port: u16, read_timeout: Duration) -> bool {
    match local_http(port, "GET", "/api/health", "", "", read_timeout) {
        Some((200, body)) => body.contains("\"ok\":"),
        _ => false,
    }
}

fn hub_url(port: u16, token: &str) -> String {
    // desktop=1 always (the web UI uses it for desktop-only affordances, the token prompt included); the
    // hub only accepts the token in the fragment, which never leaves the webview.
    if token.is_empty() {
        format!("http://127.0.0.1:{port}/?desktop=1")
    } else {
        format!("http://127.0.0.1:{port}/?desktop=1#token={token}")
    }
}

fn spawn_tunnel(cfg: &Config, tail: &Tail) -> Result<Child, String> {
    ssh::validate_host(&cfg.ssh_host)?;
    let fwd = format!("{}:127.0.0.1:{}", cfg.port, cfg.port);
    let mut cmd = Command::new(ssh::ssh_exe());
    cmd.args([
        "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15", "-N", "-T", "-L", &fwd, "--", &cfg.ssh_host,
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Can't start ssh ({e}). Install \"OpenSSH Client\" in Windows Settings, System, Optional features."))?;
    proc::job::assign(&child);
    // With -N nothing else reads stderr until ssh exits, and refused forwards keep writing to it: an
    // undrained pipe fills and blocks ssh. Keep the last 4 KB for the error message instead.
    if let Some(err) = child.stderr.take() {
        proc::drain_tail(err, tail.clone());
    }
    Ok(child)
}

/// Read the token the remote hub minted for its current run.
///
/// The hub keeps its token in `<data>/hub-token`, so we read it over the SSH session we are already
/// holding rather than asking the human to paste it. The hub reuses that value across restarts now
/// (it used to re-mint on every start, which is what made the token prompt appear after every deploy);
/// this still runs on each connect so a rotated or first-run token is picked up either way.
/// Tries the paths a deploy can leave behind, newest layout first. Killed after 8 s: ConnectTimeout
/// bounds only the TCP connect, not a login or remote command that hangs.
fn fetch_remote_token(cfg: &Config, cancel: &dyn Fn() -> bool) -> Option<String> {
    let script = "for d in /home/pocketrocket/pocketrocket /root/pocketrocket /root/claudebot; do if [ -r \"$d/data/hub-token\" ]; then cat \"$d/data/hub-token\"; exit 0; fi; done; exit 1";
    ssh::validate_host(&cfg.ssh_host).ok()?;
    let mut cmd = Command::new(ssh::ssh_exe());
    cmd.args([
        "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", "RequestTTY=no", "-o", "LogLevel=ERROR", "--", &cfg.ssh_host, script,
    ]);
    let out = proc::run_capture(cmd, Duration::from_secs(8), 256, cancel).ok()?;
    if !out.status.is_some_and(|s| s.success()) {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // Hex, 32 chars. Anything else means we read the wrong file and must not treat it as a credential.
    let ok = token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());
    if ok { Some(token) } else { None }
}

/// What the remote hub's Claude provider check says (plan comes from the hub's `ProviderCheck.plan`).
#[derive(Clone, Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClaude {
    pub ok: bool,
    pub version: Option<String>,
    pub auth: Option<String>,
    pub account: Option<String>,
    pub plan: Option<String>,
    pub error: Option<String>,
}

fn parse_provider_check(body: &str) -> Option<RemoteClaude> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let o = v.as_object()?;
    let text = |k: &str, max: usize| {
        o.get(k).and_then(|x| x.as_str()).map(|s| s.chars().filter(|c| !c.is_control()).take(max).collect::<String>()).filter(|s| !s.is_empty())
    };
    Some(RemoteClaude {
        ok: o.get("ok").and_then(|x| x.as_bool())?,
        version: text("version", 80),
        auth: text("auth", 20),
        account: text("account", 254),
        plan: text("plan", 40),
        error: text("error", 300),
    })
}

const NODE_BIN: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// node:sqlite is unflagged from here up, so anything older cannot run the hub.
const MIN_NODE: (u32, u32) = (22, 13);

fn parse_node_version(out: &str) -> Option<(u32, u32, String)> {
    let v = out.trim().trim_start_matches('v').trim();
    let mut parts = v.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor, v.to_string()))
}

/// `<exe> -v` -> "24.20.0". None if it cannot run or does not look like Node.
fn node_version(exe: &std::ffi::OsStr) -> Option<(u32, u32, String)> {
    let mut cmd = Command::new(exe);
    cmd.arg("-v").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

/// The Node 24 sidecar: Tauri installs `binaries/node-<triple>.exe` as `node.exe` next to the app exe.
fn sidecar_node(app: &AppHandle) -> Option<PathBuf> {
    sidecar_dirs(app).into_iter().map(|d| d.join(NODE_BIN)).find(|p| p.exists())
}

/// Every directory the sidecar `node.exe` could be sitting in.
fn sidecar_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        dirs.push(dir);
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("binaries"));
        dirs.push(res);
    }
    dirs
}

fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    let c = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    c(a) == c(b)
}

/// The user's own Node on PATH, as an absolute path, or None.
///
/// Deliberately not `Command::new("node")`: on Windows CreateProcess searches the *calling
/// executable's own directory* before PATH, and the sidecar is installed as `node.exe` right next
/// to PocketRocket.exe. A bare "node" therefore always resolved to the sidecar, so the preference
/// for a newer system Node below could never fire and the About box called the sidecar
/// "system node 24.20.0". Skip the directories the sidecar lives in and scan PATH ourselves.
fn system_node(app: &AppHandle) -> Option<PathBuf> {
    let shadowed = sidecar_dirs(app);
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() || shadowed.iter().any(|s| same_dir(s, &dir)) {
            continue;
        }
        let candidate = dir.join(NODE_BIN);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The repo checkout to run the hub from, or None to run the hub that ships with the app.
///
/// `hubDir` names a directory we then execute code out of, so where it may come from matters. The
/// config file sits in the app's config dir, one level above the workspace the bots can write to,
/// and nothing about writing a JSON file there asks the person for approval — so a release build
/// ignores the field and only honours `POCKETROCKET_HUB_DIR`, which takes a deliberate act to set.
/// Debug builds still read the field: there the config file belongs to whoever is developing the app.
fn hub_dir_override(from_config: Option<&str>, from_env: Option<&str>, debug_build: bool) -> Option<String> {
    let clean = |s: &str| Some(s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(dir) = from_env.and_then(clean) {
        return Some(dir);
    }
    let dir = from_config.and_then(clean)?;
    if debug_build {
        return Some(dir);
    }
    eprintln!("ignoring hubDir from config.json: a release build runs its own hub (set POCKETROCKET_HUB_DIR to override)");
    None
}

fn configured_hub_dir(cfg: &Config) -> Option<String> {
    let env = std::env::var("POCKETROCKET_HUB_DIR").ok();
    hub_dir_override(cfg.hub_dir.as_deref(), env.as_deref(), cfg!(debug_assertions))
}

/// Command that runs the hub straight from a repo checkout through tsx (development).
fn dev_hub_command(root: &std::path::Path) -> Result<(Command, PathBuf), String> {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let hub = root.join("packages").join("hub");
    let tsx = hub.join("node_modules").join("tsx").join("dist").join("cli.mjs");
    let entry = hub.join("src").join("index.ts");
    if !entry.exists() {
        return Err(format!(
            "hub not found at {}. Point POCKETROCKET_HUB_DIR (or, in a debug build, hubDir in config.json) at the pocketrocket repo.",
            hub.display()
        ));
    }
    if !tsx.exists() {
        return Err(format!("dependencies missing: run `pnpm install` in {}", root.display()));
    }
    let mut cmd = Command::new("node");
    cmd.arg(strip_verbatim(&tsx)).arg(strip_verbatim(&entry));
    Ok((cmd, hub))
}

/// Command that runs the bundled `resources/hub/hub.mjs`: system Node when it is new enough,
/// the shipped Node 24 sidecar otherwise.
fn bundled_hub_command(app: &AppHandle, hub: &std::path::Path) -> Result<(Command, String), String> {
    let entry = hub.join("hub.mjs");
    let system = system_node(app).and_then(|p| node_version(p.as_os_str()).map(|(maj, min, v)| (p, maj, min, v)));
    let (exe, runtime) = match system {
        Some((p, maj, min, v)) if (maj, min) >= MIN_NODE => (p, format!("system node {v}")),
        _ => {
            let side = sidecar_node(app).ok_or_else(|| {
                format!(
                    "no usable JavaScript runtime. PocketRocket ships its own Node but {NODE_BIN} was not found next to the app; \
                     reinstall PocketRocket, or install Node {}.{}+ and put it on PATH.",
                    MIN_NODE.0, MIN_NODE.1
                )
            })?;
            let v = node_version(side.as_os_str()).map(|(_, _, v)| v).unwrap_or_else(|| "24.x".into());
            (side, format!("bundled node {v}"))
        }
    };
    let mut cmd = Command::new(exe);
    cmd.arg(strip_verbatim(&entry));
    Ok((cmd, runtime))
}

/// Keep hub.log bounded: 2 MB live file, five generations of history.
fn rotate_hub_log(dir: &std::path::Path) {
    let live = dir.join("hub.log");
    let too_big = std::fs::metadata(&live).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false);
    if !too_big {
        return;
    }
    let _ = std::fs::remove_file(dir.join("hub.5.log"));
    for i in (1..5).rev() {
        let _ = std::fs::rename(dir.join(format!("hub.{i}.log")), dir.join(format!("hub.{}.log", i + 1)));
    }
    let _ = std::fs::rename(&live, dir.join("hub.1.log"));
}

/// 32 hex chars. Falls back to a time/pid mix if the OS RNG is unavailable — the hub only ever
/// listens on 127.0.0.1, the token is a second lock on top of that. The fallback is guessable by
/// anything that knows roughly when the app started, so it says so in hub.log rather than passing
/// itself off as a random token.
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if let Err(e) = getrandom::fill(&mut bytes) {
        eprintln!("the OS random number generator is unavailable ({e}); falling back to a guessable hub token");
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
            ^ u128::from(std::process::id());
        bytes.copy_from_slice(&n.to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Start the hub as our own child, data in the app's data dir. Returns the child and a label for
/// the runtime that was picked. Resolution order: configured dev repo, bundled resources, and —
/// debug builds only — the repo this binary was compiled from.
fn spawn_hub(app: &AppHandle, cfg: &Config, token: &str) -> Result<(Child, String), String> {
    let bundled = app.path().resource_dir().ok().map(|r| r.join("hub")).filter(|h| h.join("hub.mjs").exists());

    let (mut cmd, runtime, cwd, web_dist) = if let Some(dir) = configured_hub_dir(cfg) {
        let (cmd, hub) = dev_hub_command(std::path::Path::new(&dir))?;
        (cmd, "dev (tsx)".to_string(), Some(hub), None)
    } else if let Some(hub) = bundled {
        let (cmd, runtime) = bundled_hub_command(app, &hub)?;
        let web = hub.join("web");
        (cmd, runtime, Some(hub), Some(web))
    } else if cfg!(debug_assertions) {
        let (cmd, hub) = dev_hub_command(std::path::Path::new(REPO_ROOT))?;
        (cmd, "dev (tsx)".to_string(), Some(hub), None)
    } else {
        return Err("the bundled hub is missing from this installation (resources/hub/hub.mjs). Reinstall PocketRocket.".into());
    };

    let dir = config_dir(app);
    rotate_hub_log(&dir);
    let log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("hub.log")).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    if let Some(cwd) = cwd.as_ref() {
        cmd.current_dir(strip_verbatim(cwd));
    }
    cmd.env("POCKETROCKET_DATA", strip_verbatim(&data_dir(app)));
    if let Some(web) = web_dist.as_ref() {
        cmd.env("POCKETROCKET_WEB_DIST", strip_verbatim(web));
    }
    cmd.env("PORT", cfg.port.to_string());
    cmd.env("POCKETROCKET_TOKEN", token);
    cmd.env("NODE_NO_WARNINGS", "1");
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
    no_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("cannot start the hub runtime: {e}"))?;
    proc::job::assign(&child);
    Ok((child, runtime))
}

/// Open a file or URL with whatever the OS associates with it. On Windows this is ShellExecuteExW,
/// not `cmd /c start`: cmd would split a URL at `&` (every OAuth URL has one) and expand `%VAR%`,
/// which matters now that URLs come from the web page. Runs on its own thread because the
/// navigation handler calls it from inside a WebView2 event and launching a browser can take a moment.
fn open_external(target: &str) {
    let target = target.to_owned();
    std::thread::spawn(move || {
        if let Err(e) = open::that_detached(&target) {
            eprintln!("cannot open {target}: {e}");
        }
    });
}

/// Send a link the webview must not show itself to the default browser (or mail client).
/// Only http, https and mailto: the page asking is plain http, possibly through an SSH tunnel, so it
/// must never get file:, javascript: or a custom protocol handler launched on this machine.
fn open_in_browser(url: &Url) {
    if may_open_externally(url) {
        open_external(url.as_str());
    } else {
        eprintln!("not opening {}: scheme {} is not allowed", url, url.scheme());
    }
}

fn may_open_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Port of the hub the main webview may show. Outside `AppState`'s mutex on purpose: the navigation
/// handler runs on the UI thread for every navigation and must never wait on that lock.
static HUB_PORT: AtomicU16 = AtomicU16::new(0);

/// What the main webview may load itself: the bundled splash page and the hub's own origin. The hub is
/// always 127.0.0.1:<port> from here, remote mode included (that is where the SSH tunnel listens).
fn stays_in_webview(url: &Url) -> bool {
    let splash = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    let hub = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port_or_known_default() == Some(HUB_PORT.load(Ordering::Relaxed));
    splash || hub
}

const RELEASES_URL: &str = "https://github.com/AlexGaledo/pocketrocket/releases";

/// Windows canonicalize() yields \\?\C:\... which some tools dislike; strip the prefix.
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s)
}

fn kill_child(inner: &mut Inner) {
    if let Some(mut c) = inner.child.take() {
        // take the whole tree: node -> claude.exe turns, ssh
        kill_tree(&mut c);
    }
    inner.child_kind = "";
    inner.status.child_running = false;
}

fn splash_url() -> &'static str {
    if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }
}

/// Never call this (or anything else that talks to the window or menu) while holding the state lock: those
/// calls wait for the main thread, and the main thread's menu handlers take the lock.
fn navigate(app: &AppHandle, url: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(u) = url.parse() {
            let _ = win.navigate(u);
        }
    }
}

fn show_splash(app: &AppHandle) {
    navigate(app, splash_url());
}

fn window_title(cfg: &Config) -> String {
    match cfg.mode.as_str() {
        "local" => "PocketRocket · this PC".to_string(),
        "remote" if !cfg.ssh_host.trim().is_empty() => format!("PocketRocket · {}", cfg.ssh_host.trim()),
        "attach" => "PocketRocket · attached".to_string(),
        _ => "PocketRocket".to_string(),
    }
}

fn base_status(app: &AppHandle, cfg: &Config, first_run: bool) -> Status {
    Status {
        data_dir: data_dir(app).to_string_lossy().to_string(),
        mode: cfg.mode.clone(),
        ssh_host: cfg.ssh_host.clone(),
        port: cfg.port,
        log_path: config_dir(app).join("hub.log").to_string_lossy().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        first_run,
        ..Default::default()
    }
}

/// Held by a connection worker while it kills the previous child and starts the next one, so two quick
/// reconnects never race for the port. Never held together with the state lock's blocking work.
static CONNECT_SERIAL: Mutex<()> = Mutex::new(());

fn is_stale(state: &AppState, gen: u64) -> bool {
    let inner = state.0.lock().unwrap();
    inner.quitting || inner.generation != gen
}

/// (Re)start the connection for the current mode, then watch for the hub and navigate to it.
///
/// Returns at once: only bookkeeping happens under the state lock, and the slow parts (killing the old
/// child, spawning, the token ssh, health checks) run on the worker thread started here, so commands and
/// menu handlers calling this never freeze the window.
fn connect(app: AppHandle, state: AppState, splash: bool) {
    if splash {
        show_splash(&app);
    }
    let (cfg, first_run) = {
        let inner = state.0.lock().unwrap();
        (inner.config.clone(), inner.first_run)
    };
    let status = base_status(&app, &cfg, first_run);
    let (gen, old) = {
        let mut inner = state.0.lock().unwrap();
        let old = inner.child.take();
        inner.child_kind = "";
        inner.generation += 1;
        inner.token.clear();
        inner.remote_claude = None;
        inner.connect_started = Instant::now();
        inner.config = cfg.clone();
        inner.status = status;
        HUB_PORT.store(cfg.port, Ordering::Relaxed);
        (inner.generation, old)
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&window_title(&cfg));
    }
    std::thread::spawn(move || run_connection(app, state, cfg, gen, old));
}

fn run_connection(app: AppHandle, state: AppState, cfg: Config, gen: u64, old: Option<Child>) {
    let serial = CONNECT_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut c) = old {
        kill_tree(&mut c);
    }
    if is_stale(&state, gen) {
        return;
    }
    let tail = Tail::default();
    let mut spawned: Option<(Child, &'static str, String)> = None;
    let mut token = String::new();
    let mut error: Option<String> = None;
    let mut error_kind: Option<&'static str> = None;
    let mut port_has_hub = false;
    match cfg.mode.as_str() {
        "remote" => {
            if let Err(e) = ssh::validate_host(&cfg.ssh_host) {
                // Nothing to connect to: leave the person on the settings page with the reason.
                error = Some(e);
                error_kind = Some("needsHost");
            } else {
                if !port_open(cfg.port) {
                    match spawn_tunnel(&cfg, &tail) {
                        Ok(c) => spawned = Some((c, "ssh", String::new())),
                        Err(e) => error = Some(e),
                    }
                }
                if error.is_none() {
                    // Same SSH access the tunnel uses; without this the UI shows a token prompt after every
                    // remote hub restart. Failing is fine — the prompt is still there as the fallback.
                    token = fetch_remote_token(&cfg, &|| is_stale(&state, gen)).unwrap_or_default();
                }
            }
        }
        "local" => {
            if port_open(cfg.port) {
                port_has_hub = hub_responding(cfg.port, Duration::from_millis(1500));
                error = Some(if port_has_hub {
                    format!(
                        "Port {} is already used by another PocketRocket hub (one started with pnpm start, or a VPS tunnel). \
                         Attach to it, or pick another port.",
                        cfg.port
                    )
                } else {
                    format!("Port {} is already in use on this PC by another program. Close it or pick another port.", cfg.port)
                });
            } else {
                let t = random_token();
                match spawn_hub(&app, &cfg, &t) {
                    Ok((c, runtime)) => {
                        spawned = Some((c, "hub", runtime));
                        token = t;
                    }
                    Err(e) => error = Some(e),
                }
            }
        }
        _ => {}
    }
    {
        let mut inner = state.0.lock().unwrap();
        if inner.quitting || inner.generation != gen {
            drop(inner);
            if let Some((mut c, _, _)) = spawned {
                kill_tree(&mut c);
            }
            return;
        }
        // local: the token we handed the hub we spawned. remote: the one we just read over SSH.
        // attach: someone else's hub on this machine, so we have nothing and the UI asks.
        inner.token = token.clone();
        if let Some((c, kind, runtime)) = spawned {
            inner.child = Some(c);
            inner.child_kind = kind;
            inner.status.child_running = true;
            inner.status.runtime = runtime;
        }
        inner.status.error = error.clone();
        inner.status.error_kind = error_kind;
        inner.status.port_has_hub = port_has_hub;
    }
    drop(serial);
    // Every caller of connect() is already on the splash (or just sent it there), so the error shows as is.
    if error.is_some() && cfg.mode != "attach" && state.0.lock().unwrap().child.is_none() {
        return;
    }

    let started = Instant::now();
    loop {
        {
            let mut inner = state.0.lock().unwrap();
            if inner.quitting || inner.generation != gen {
                return;
            }
            inner.status.attempts += 1;
            let kind = inner.child_kind;
            let exited = inner.child.as_mut().and_then(|c| c.try_wait().ok().flatten());
            if let Some(code) = exited {
                inner.child = None;
                inner.child_kind = "";
                inner.status.child_running = false;
                if kind == "hub" {
                    inner.status.error = Some(format!("The hub exited ({code}). View → Open hub log shows why."));
                } else {
                    let err = tail.text();
                    inner.status.error = Some(ssh::explain(&err, &cfg.ssh_host, cfg.port));
                    inner.status.error_kind = Some(ssh_kind(&err));
                }
                return;
            }
        }
        if hub_responding(cfg.port, Duration::from_millis(1500)) {
            navigate(&app, &hub_url(cfg.port, &token));
            let mut inner = state.0.lock().unwrap();
            if inner.generation != gen {
                return;
            }
            inner.status.connected = true;
            inner.status.navigated = true;
            inner.status.error = None;
            inner.status.error_kind = None;
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            let mut inner = state.0.lock().unwrap();
            if inner.generation != gen {
                return;
            }
            inner.status.error = Some(match cfg.mode.as_str() {
                "remote" => format!("No answer from the hub through the tunnel after 60s. On the server: systemctl status pocketrocket. From a terminal: ssh {}", cfg.ssh_host),
                "local" => "The hub did not come up within 60s. View → Open hub log shows why.".to_string(),
                _ => format!("No hub on 127.0.0.1:{}. Start one with `pnpm start` and retry.", cfg.port),
            });
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    monitor(app, state, cfg, gen, tail);
}

fn ssh_kind(stderr: &str) -> &'static str {
    match ssh::classify_failure(stderr) {
        ssh::SshFailure::HostKeyChanged => "hostKeyChanged",
        ssh::SshFailure::HostKeyUnknown => "hostKeyUnknown",
        ssh::SshFailure::AuthFailed => "authFailed",
        ssh::SshFailure::ForwardFailed => "portInUse",
        _ => "ssh",
    }
}

/// The connection is gone: say why, stop claiming to be connected, and put the settings page up.
fn lose(app: &AppHandle, state: &AppState, gen: u64, msg: String, kind: Option<&'static str>) {
    {
        let mut inner = state.0.lock().unwrap();
        if inner.quitting || inner.generation != gen {
            return;
        }
        inner.status.connected = false;
        inner.status.navigated = false;
        inner.status.error = Some(msg);
        inner.status.error_kind = kind;
    }
    show_splash(app);
}

/// Consecutive failed health checks before the connection counts as lost (checks are 3 s apart).
const HEALTH_STRIKES: u32 = 3;

/// After connecting: notice a hub or tunnel that died or stopped answering. An ssh tunnel that drops is
/// restarted (also one we skipped because the port was already open, once that port closes); a tunnel that
/// dies again within 30 s of a restart, a hub process that exits, or HEALTH_STRIKES failed checks in a row
/// end the connection with an error on the splash.
fn monitor(app: AppHandle, state: AppState, cfg: Config, gen: u64, mut tail: Tail) {
    let host = cfg.ssh_host.clone();
    let mut strikes = 0u32;
    let mut last_restart: Option<Instant> = None;
    loop {
        std::thread::sleep(Duration::from_secs(3));
        let (exited, has_child) = {
            let mut inner = state.0.lock().unwrap();
            if inner.quitting || inner.generation != gen {
                return;
            }
            let kind = inner.child_kind;
            let exited = inner.child.as_mut().and_then(|c| c.try_wait().ok().flatten()).map(|code| (code, kind));
            if exited.is_some() {
                inner.child = None;
                inner.child_kind = "";
                inner.status.child_running = false;
            }
            (exited, inner.child.is_some())
        };
        if let Some((code, kind)) = exited {
            if kind == "hub" {
                let msg = format!("The hub stopped unexpectedly ({code}). View → Open hub log shows why; Restart hub starts it again.");
                return lose(&app, &state, gen, msg, None);
            }
            if last_restart.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                let err = tail.text();
                let msg = format!("Lost the tunnel to {host}. {}", ssh::explain(&err, &host, cfg.port));
                return lose(&app, &state, gen, msg, Some(ssh_kind(&err)));
            }
        }
        if cfg.mode == "remote" && !has_child && !port_open(cfg.port) {
            tail = Tail::default();
            match spawn_tunnel(&cfg, &tail) {
                Ok(mut c) => {
                    let mut inner = state.0.lock().unwrap();
                    if inner.quitting || inner.generation != gen {
                        drop(inner);
                        kill_tree(&mut c);
                        return;
                    }
                    inner.child = Some(c);
                    inner.child_kind = "ssh";
                    inner.status.child_running = true;
                    last_restart = Some(Instant::now());
                    strikes = 0;
                }
                Err(e) => return lose(&app, &state, gen, format!("Lost the tunnel to {host} and couldn't reopen it: {e}"), None),
            }
        }
        // give a freshly restarted tunnel time to log in before judging the hub behind it
        if last_restart.is_some_and(|t| t.elapsed() < Duration::from_secs(20)) {
            continue;
        }
        if hub_responding(cfg.port, Duration::from_secs(3)) {
            strikes = 0;
            continue;
        }
        strikes += 1;
        if strikes >= HEALTH_STRIKES {
            let msg = match cfg.mode.as_str() {
                "local" => "The hub on this PC stopped answering. View → Open hub log shows why; Restart hub starts it again.".to_string(),
                "remote" => format!("Lost contact with the hub on {host}. If the server is up, check it with: ssh {host} systemctl status pocketrocket"),
                _ => format!("The hub on 127.0.0.1:{} stopped answering.", cfg.port),
            };
            return lose(&app, &state, gen, msg, None);
        }
    }
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config { state.0.lock().unwrap().config.clone() }

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    let inner = state.0.lock().unwrap();
    let mut s = inner.status.clone();
    s.elapsed_secs = inner.connect_started.elapsed().as_secs();
    s
}

#[tauri::command]
async fn save_config(app: AppHandle, state: State<'_, AppState>, mut config: Config) -> Result<(), String> {
    config.ssh_host = config.ssh_host.trim().to_string();
    validate_config(&config)?;
    save_config_file(&app, &config);
    let mode = config.mode.clone();
    {
        let mut inner = state.0.lock().unwrap();
        inner.config = config;
        inner.first_run = false;
    }
    sync_mode_menu(&app, &mode);
    connect(app.clone(), state.inner().clone(), false);
    Ok(())
}

#[tauri::command]
async fn retry(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.0.lock().unwrap().first_run = false;
    connect(app.clone(), state.inner().clone(), false);
    Ok(())
}

/// Back from the settings page to the hub this app is connected to, with the current token.
#[tauri::command]
async fn open_hub(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (connected, port, token) = {
        let inner = state.0.lock().unwrap();
        (inner.status.connected, inner.config.port, inner.token.clone())
    };
    if !connected {
        return Err("Not connected to a hub.".into());
    }
    navigate(&app, &hub_url(port, &token));
    Ok(())
}

fn open_log_file(app: &AppHandle) {
    let log = config_dir(app).join("hub.log");
    if !log.exists() {
        let _ = std::fs::write(&log, "no hub log yet\n");
    }
    open_external(&strip_verbatim(&log));
}

fn open_data_folder(app: &AppHandle) {
    let d = data_dir(app);
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg(strip_verbatim(&d)).spawn();
    }
    #[cfg(not(windows))]
    {
        open_external(&d.to_string_lossy());
    }
}

#[tauri::command]
async fn open_log(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.0.lock().unwrap().config.mode == "remote" {
        return Err("In server mode the hub log is on the server: ssh <host> journalctl -u pocketrocket".into());
    }
    open_log_file(&app);
    Ok(())
}

/// The Claude account on the remote hub, asked through the tunnel. None when not connected to a server.
#[tauri::command]
async fn remote_claude_status(state: State<'_, AppState>, refresh: Option<bool>) -> Result<Option<RemoteClaude>, String> {
    let (connected, mode, port, token, gen, cached) = {
        let inner = state.0.lock().unwrap();
        (inner.status.connected, inner.config.mode.clone(), inner.config.port, inner.token.clone(), inner.generation, inner.remote_claude.clone())
    };
    if !connected || mode != "remote" || token.is_empty() {
        return Ok(None);
    }
    if let Some((g, c)) = cached {
        if g == gen && !refresh.unwrap_or(false) {
            return Ok(Some(c));
        }
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let headers = format!("Authorization: Bearer {token}\r\nContent-Type: application/json\r\n");
        // the check runs `claude --version` and `claude auth status` on the server: allow it a while
        local_http(port, "POST", "/api/providers/claude/check", &headers, "{}", Duration::from_secs(12))
    })
    .await
    .map_err(|e| e.to_string())?;
    let check = match result {
        Some((200, body)) => parse_provider_check(&body).ok_or("The hub sent an unexpected answer.")?,
        Some((code, _)) => return Err(format!("The hub answered {code}.")),
        None => return Err("The hub didn't answer.".into()),
    };
    let mut inner = state.0.lock().unwrap();
    if inner.generation == gen {
        inner.remote_claude = Some((gen, check.clone()));
    }
    Ok(Some(check))
}

/// Keep the three `mode_*` radio checkmarks in the Connection menu matching `mode`, and the local-only
/// View items honest about where the data and log are.
fn sync_mode_menu(app: &AppHandle, mode: &str) {
    let Some(menu) = app.menu() else { return };
    for (id, m) in [("mode_local", "local"), ("mode_remote", "remote"), ("mode_attach", "attach")] {
        if let Some(item) = menu.get(id) {
            if let Some(check) = item.as_check_menuitem() {
                let _ = check.set_checked(m == mode);
            }
        }
    }
    let local_only = mode != "remote";
    for (id, text, remote_text) in [
        ("open_data", "Open data folder", "Open data folder (on the server in server mode)"),
        ("open_log", "Open hub log", "Open hub log (on the server in server mode)"),
    ] {
        if let Some(item) = menu.get(id) {
            if let Some(mi) = item.as_menuitem() {
                let _ = mi.set_enabled(local_only);
                let _ = mi.set_text(if local_only { text } else { remote_text });
            }
        }
    }
}

fn set_mode(app: &AppHandle, state: &AppState, mode: &str) {
    {
        let mut inner = state.0.lock().unwrap();
        inner.config.mode = mode.into();
        inner.first_run = false;
        save_config_file(app, &inner.config);
    }
    sync_mode_menu(app, mode);
    // Through the splash: with no server configured yet the worker stops there and asks for one.
    connect(app.clone(), state.clone(), true);
}

/// Mode switch from the menu. Switching away from a live hub stops what runs there (a local hub is shut
/// down with its turns), so ask first.
fn request_mode(app: &AppHandle, state: &AppState, mode: &str) {
    let (connected, current) = {
        let inner = state.0.lock().unwrap();
        (inner.status.connected, inner.config.mode.clone())
    };
    if current == mode {
        // clicking the checked item unchecks it; put the mark back
        sync_mode_menu(app, &current);
        return;
    }
    if !connected {
        return set_mode(app, state, mode);
    }
    let what = if current == "local" {
        "This shuts down the hub on this PC. Bots that are working right now will stop."
    } else {
        "This disconnects from the current hub. Bots on a server keep running there."
    };
    let (app2, state2, mode2) = (app.clone(), state.clone(), mode.to_string());
    app.dialog()
        .message(what)
        .title("Switch where PocketRocket runs?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Switch".into(), "Cancel".into()))
        .show(move |ok| {
            if ok {
                set_mode(&app2, &state2, &mode2);
            } else {
                sync_mode_menu(&app2, &current);
            }
        });
}

pub fn run() {
    let state = AppState(Arc::new(Mutex::new(Inner {
        config: Config::default(), status: Status::default(), child: None, child_kind: "", generation: 0, quitting: false,
        token: String::new(), connect_started: Instant::now(), first_run: false, remote_claude: None,
    })));
    let menu_state = state.clone();

    tauri::Builder::default()
        // First, so a second launch hands over before building anything: it focuses this window instead
        // of starting another hub that would fight over port 7788.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // Rust-side confirm dialogs only; no capability grants the pages dialog access.
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_status,
            save_config,
            retry,
            open_hub,
            open_log,
            remote_claude_status,
            scan::list_ssh_hosts,
            scan::scan_ssh_hosts,
            scan::ssh_host_fingerprint,
            scan::scan_local_claude
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            migrate_legacy_data(&handle);
            let (cfg, first_run) = load_config(&handle);
            let initial_mode = cfg.mode.clone();
            {
                let status = base_status(&handle, &cfg, first_run);
                let mut inner = state.0.lock().unwrap();
                inner.config = cfg;
                inner.first_run = first_run;
                inner.status = status;
            }

            // The main window is built here rather than from tauri.conf.json ("create": false) so it can
            // get these two handlers. The UI opens outside links with window.open / target="_blank", and
            // in a webview that is either nothing or a WebView2 popup (where Google refuses OAuth).
            // Plain navigations off the hub go the same way. All of it happens in Rust: the page gets no
            // new JS-callable capability.
            let win_cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("window \"main\" is missing from tauri.conf.json")?;
            WebviewWindowBuilder::from_config(app.handle(), &win_cfg)?
                .on_navigation(|url| {
                    if stays_in_webview(url) {
                        return true;
                    }
                    open_in_browser(url);
                    false
                })
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;

            let m_local = CheckMenuItem::with_id(app, "mode_local", "Local: this PC (own database)", true, initial_mode == "local", None::<&str>)?;
            let m_remote = CheckMenuItem::with_id(app, "mode_remote", "VPS: over SSH tunnel", true, initial_mode == "remote", None::<&str>)?;
            let m_attach = CheckMenuItem::with_id(app, "mode_attach", "Attach to a running local hub", true, initial_mode == "attach", None::<&str>)?;
            let m_reload = MenuItem::with_id(app, "reload", "Reload", true, Some("F5"))?;
            let m_data = MenuItem::with_id(app, "open_data", "Open data folder", true, None::<&str>)?;
            let m_log = MenuItem::with_id(app, "open_log", "Open hub log", true, None::<&str>)?;
            let m_settings = MenuItem::with_id(app, "settings", "Connection settings", true, None::<&str>)?;
            let m_updates = MenuItem::with_id(app, "check_updates", "Check for updates", true, None::<&str>)?;
            let m_about = MenuItem::with_id(app, "about", "About PocketRocket", true, None::<&str>)?;
            let conn = Submenu::with_items(app, "Connection", true, &[&m_local, &m_remote, &m_attach, &PredefinedMenuItem::separator(app)?, &m_settings])?;
            let view = Submenu::with_items(app, "View", true, &[&m_reload, &m_data, &m_log, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, Some("Quit"))?])?;
            let help = Submenu::with_items(app, "Help", true, &[&m_updates, &m_about])?;
            let menu = Menu::with_items(app, &[&conn, &view, &help])?;
            app.set_menu(menu)?;
            sync_mode_menu(&handle, &initial_mode);

            // First run: start nothing until the person has picked where to run (the splash asks).
            if !first_run {
                connect(handle, state.clone(), false);
            }
            Ok(())
        })
        .on_menu_event(move |app, event| {
            let st = menu_state.clone();
            match event.id().as_ref() {
                "mode_local" => request_mode(app, &st, "local"),
                "mode_remote" => request_mode(app, &st, "remote"),
                "mode_attach" => request_mode(app, &st, "attach"),
                "reload" => {
                    // A reload of a dead hub is a blank error page: reconnect through the splash instead.
                    let (app, st) = (app.clone(), st.clone());
                    std::thread::spawn(move || {
                        let (connected, first_run, port) = {
                            let inner = st.0.lock().unwrap();
                            (inner.status.connected, inner.first_run, inner.config.port)
                        };
                        if first_run || (connected && hub_responding(port, Duration::from_millis(1500))) {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.eval("location.reload()");
                            }
                        } else {
                            connect(app, st, true);
                        }
                    });
                }
                "open_data" => open_data_folder(app),
                "open_log" => open_log_file(app),
                "settings" => show_splash(app),
                "check_updates" => { if let Ok(u) = Url::parse(RELEASES_URL) { open_in_browser(&u); } }
                "about" => {
                    let (runtime, data, log) = {
                        let inner = st.0.lock().unwrap();
                        (inner.status.runtime.clone(), inner.status.data_dir.clone(), inner.status.log_path.clone())
                    };
                    let body = format!(
                        "PocketRocket {}\\n\\nRuntime: {}\\nData folder: {}\\nHub log: {}\\n\\n{}",
                        env!("CARGO_PKG_VERSION"),
                        if runtime.is_empty() { "not started".into() } else { runtime },
                        data.replace('\\', "\\\\"),
                        log.replace('\\', "\\\\"),
                        RELEASES_URL,
                    );
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval(format!("window.alert('{}')", body.replace('\'', "\\'")));
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_splash_and_hub_stay_in_the_webview() {
        HUB_PORT.store(7788, Ordering::Relaxed);
        assert!(stays_in_webview(&u("http://tauri.localhost/index.html")));
        assert!(stays_in_webview(&u("tauri://localhost/index.html")));
        assert!(stays_in_webview(&u("http://127.0.0.1:7788/?desktop=1#token=abc")));
        assert!(stays_in_webview(&u("http://localhost:7788/settings")));

        assert!(!stays_in_webview(&u("http://127.0.0.1:3000/")));
        assert!(!stays_in_webview(&u("https://127.0.0.1:7788/")));
        assert!(!stays_in_webview(&u("http://127.0.0.1.evil.com:7788/")));
        assert!(!stays_in_webview(&u("https://github.com/AlexGaledo/pocketrocket")));
        assert!(!stays_in_webview(&u("https://accounts.google.com/o/oauth2/auth?a=1&b=2")));
        assert!(!stays_in_webview(&u("file:///C:/Windows/win.ini")));
        assert!(!stays_in_webview(&u("about:blank")));
    }

    #[test]
    fn hub_url_always_says_desktop() {
        assert_eq!(hub_url(7788, ""), "http://127.0.0.1:7788/?desktop=1");
        assert_eq!(hub_url(7788, "abc"), "http://127.0.0.1:7788/?desktop=1#token=abc");
    }

    #[test]
    fn titles_never_end_in_a_dangling_separator() {
        let mut c = Config { mode: "remote".into(), ..Default::default() };
        assert_eq!(window_title(&c), "PocketRocket");
        c.ssh_host = "vps".into();
        assert_eq!(window_title(&c), "PocketRocket · vps");
        c.mode = "local".into();
        assert_eq!(window_title(&c), "PocketRocket · this PC");
    }

    #[test]
    fn config_validation() {
        let ok = Config::default();
        assert!(validate_config(&ok).is_ok());
        assert!(validate_config(&Config { port: 80, ..Default::default() }).is_err());
        assert!(validate_config(&Config { mode: "remote".into(), ..Default::default() }).is_err());
        assert!(validate_config(&Config { mode: "remote".into(), ssh_host: "-oProxyCommand=x".into(), ..Default::default() }).is_err());
        assert!(validate_config(&Config { mode: "remote".into(), ssh_host: "vps".into(), ..Default::default() }).is_ok());
        assert!(validate_config(&Config { mode: "nope".into(), ..Default::default() }).is_err());
    }

    #[test]
    fn a_release_build_runs_the_hub_from_config_json_nowhere() {
        // Debug builds are the development workflow, so the config file still points the app at a checkout.
        assert_eq!(hub_dir_override(Some("C:\\repo"), None, true).as_deref(), Some("C:\\repo"));
        // A release build ignores it: writing that file is not an act anyone approves.
        assert_eq!(hub_dir_override(Some("C:\\evil"), None, false), None);
        // The environment variable is deliberate enough to be honoured either way, and wins.
        assert_eq!(hub_dir_override(Some("C:\\evil"), Some("C:\\repo"), false).as_deref(), Some("C:\\repo"));
        assert_eq!(hub_dir_override(None, Some("C:\\repo"), false).as_deref(), Some("C:\\repo"));
        // Blank is not a directory.
        assert_eq!(hub_dir_override(Some("  "), Some(""), true), None);
        assert_eq!(hub_dir_override(None, None, true), None);
    }

    #[test]
    fn http_and_provider_check_parsing() {
        assert_eq!(parse_http_response("HTTP/1.1 200 OK\r\nX: y\r\n\r\n{\"ok\":true}"), Some((200, "{\"ok\":true}".into())));
        assert_eq!(parse_http_response("garbage"), None);
        let c = parse_provider_check("{\"ok\":true,\"version\":\"2.1.0 (Claude Code)\",\"auth\":\"subscription\",\"account\":\"a@b.com\",\"plan\":\"max\"}").unwrap();
        assert!(c.ok);
        assert_eq!(c.plan.as_deref(), Some("max"));
        assert_eq!(c.account.as_deref(), Some("a@b.com"));
        // older hubs have no plan field
        let old = parse_provider_check("{\"ok\":false,\"auth\":\"none\",\"error\":\"not signed in\"}").unwrap();
        assert_eq!(old.plan, None);
        assert_eq!(old.error.as_deref(), Some("not signed in"));
        assert_eq!(parse_provider_check("{\"error\":\"Unauthorized\"}"), None);
    }

    #[test]
    fn only_web_and_mail_links_reach_the_os() {
        assert!(may_open_externally(&u("https://github.com/AlexGaledo/pocketrocket/releases")));
        assert!(may_open_externally(&u("http://example.com/")));
        assert!(may_open_externally(&u("mailto:someone@example.com")));

        assert!(!may_open_externally(&u("file:///C:/Windows/System32/calc.exe")));
        assert!(!may_open_externally(&u("javascript:alert(1)")));
        assert!(!may_open_externally(&u("ms-settings:privacy")));
        assert!(!may_open_externally(&u("about:blank")));
        assert!(!may_open_externally(&u("data:text/html,hi")));
    }
}
