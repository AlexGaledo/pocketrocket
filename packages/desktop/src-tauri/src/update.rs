//! A4: the desktop app's own update flow, on top of tauri-plugin-updater (registered in lib.rs, no capability).
//!
//! - Checks once shortly after launch and then every 24 h of wall-clock time while running (the app lives in the
//!   tray, so it can run for weeks), in every mode: local, remote and attach all run this same shell.
//! - An automatic check never opens a dialog. When it finds an update it shows one system notification and turns
//!   the tray's "Check for updates" into "Update to vX.Y.Z…", plus a "What's new in vX.Y.Z" item. The question
//!   (two custom-labelled buttons) is asked only when the person picks that item.
//! - Installing in local mode is idle-only: POST /api/maintenance/hold, poll GET /api/busy until `blocking` is 0
//!   (the person can cancel, which releases the hold), POST /api/maintenance/stop, wait for the hub to exit, then
//!   the hard kill as a fallback, then install and relaunch.
//! - Remote mode never holds or stops the VPS hub: only the desktop shell is replaced. Attach mode, or a hub that
//!   answers 404 on /api/busy (older than 0.3.0), gets a plain "make sure nothing important is running" question.
//! - A Linux .deb install (no APPIMAGE in the environment) is pointed at the releases page: latest.json maps
//!   linux-x86_64 to the AppImage, which must not be written over a packaged install.
//!
//! The webview has no part in any of this: no command, no capability, no event.

use crate::{kill_child, kill_tree, local_http, open_in_browser, save_config_file, tell, AppState, RELEASES_URL};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Endpoint override for testing release candidates (`.../releases/download/vX.Y.Z-rc.1/latest.json`).
pub const ENDPOINT_ENV: &str = "POCKETROCKET_UPDATE_ENDPOINT";
const ENDPOINT_HOST: &str = "github.com";
const ENDPOINT_PATH_PREFIX: &str = "/AlexGaledo/pocketrocket/releases/";

/// The hold asked for before draining (the hub clamps to 1-30), renewed while still waiting.
pub const HOLD_MINUTES: u32 = 10;
const HOLD_RENEW: Duration = Duration::from_secs(5 * 60);
const BUSY_POLL: Duration = Duration::from_secs(2);
/// Failed /api/busy polls in a row before the hub counts as gone (it then gets stopped or killed anyway).
const BUSY_MISSES: u32 = 5;
/// How long a hub gets to exit after POST /api/maintenance/stop before the hard kill.
const STOP_GRACE: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_secs(10 * 60);

pub const MENU_CHECK: &str = "check_updates";
pub const MENU_NOTES: &str = "update_notes";
const CHECK_TEXT: &str = "Check for updates";
const NOT_CONFIGURED_TEXT: &str = "Updates not configured";

// ---------------------------------------------------------------- pure parts (unit tested)

/// `POCKETROCKET_UPDATE_ENDPOINT`: unset or blank means "use tauri.conf.json". Anything set must be https on this
/// repo's GitHub releases path, or it is refused (and the configured endpoint is used). The URL is parsed first,
/// so `..`, `%2e%2e`, userinfo and ports are judged on what would actually be requested. The download is still
/// verified against the pubkey, so this only chooses *which* signed release, never whose.
pub fn endpoint_override(raw: Option<&str>) -> Result<Option<Url>, String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    let bad = || format!("{ENDPOINT_ENV} must be under https://{ENDPOINT_HOST}{ENDPOINT_PATH_PREFIX}; ignoring it");
    if raw.contains(char::is_whitespace) || raw.contains("..") || raw.contains('\\') {
        return Err(bad());
    }
    let url = Url::parse(raw).map_err(|_| bad())?;
    let ok = url.scheme() == "https"
        && url.host_str() == Some(ENDPOINT_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with(ENDPOINT_PATH_PREFIX)
        && url.path().len() > ENDPOINT_PATH_PREFIX.len()
        && !url.path().split('/').any(|seg| seg == ".." || seg == ".");
    if ok { Ok(Some(url)) } else { Err(bad()) }
}

/// A Linux install that did not come from the AppImage (so a .deb): the updater must not touch it.
pub fn is_packaged_linux(linux: bool, appimage: Option<&std::ffi::OsStr>) -> bool {
    linux && appimage.is_none_or(|v| v.is_empty())
}

/// What GET /api/busy said.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Busy {
    /// `blocking`: running turns + live approval cards, the only work a restart would lose.
    Count(u32),
    /// 404: a hub older than the maintenance routes.
    NoRoute,
    /// No answer, an auth failure or an answer that is not the busy shape.
    Unreachable,
}

/// How an install goes, decided from the mode and what the hub said.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Plan {
    /// Linux .deb: no self-install, open the release page instead.
    ReleasesPage,
    /// Remote: replace the desktop shell only; never hold or stop the VPS hub.
    ShellOnly,
    /// Attach, an older hub, or no answer: ask the person to make sure nothing important is running.
    Confirm,
    /// Local hub with the maintenance routes: hold, wait for `blocking` to reach 0, stop cleanly, install.
    Drain { blocking: u32 },
    /// Local mode with no hub running (first run, or it failed to start): nothing to stop.
    NoHub,
}

pub fn plan(mode: &str, packaged_linux: bool, local_hub_up: bool, busy: Option<Busy>) -> Plan {
    if packaged_linux {
        return Plan::ReleasesPage;
    }
    match mode {
        "remote" => Plan::ShellOnly,
        "local" if !local_hub_up => Plan::NoHub,
        "local" => match busy {
            Some(Busy::Count(n)) => Plan::Drain { blocking: n },
            _ => Plan::Confirm,
        },
        _ => Plan::Confirm,
    }
}

/// The maintenance routes the shell uses (hub token as bearer). A trait so the drain loop is testable.
pub trait HubApi {
    fn busy(&self) -> Busy;
    fn hold(&self, minutes: u32) -> bool;
    fn release(&self) -> bool;
    fn stop(&self) -> bool;
}

/// The hub on 127.0.0.1:<port>. The token goes only into the Authorization header, never into a log line.
pub struct LocalHub {
    pub port: u16,
    pub token: String,
}

impl LocalHub {
    fn call(&self, method: &str, path: &str, body: &str) -> Option<(u16, String)> {
        let headers = format!("Authorization: Bearer {}\r\nContent-Type: application/json\r\n", self.token);
        local_http(self.port, method, path, &headers, body, Duration::from_secs(5))
    }
    fn ok(&self, method: &str, path: &str, body: &str) -> bool {
        matches!(self.call(method, path, body), Some((200, _)))
    }
}

pub fn parse_busy(answer: Option<(u16, String)>) -> Busy {
    match answer {
        Some((200, body)) => serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .and_then(|v| v.get("blocking").and_then(serde_json::Value::as_u64))
            .map(|n| Busy::Count(n.min(u32::MAX as u64) as u32))
            .unwrap_or(Busy::Unreachable),
        Some((404, _)) => Busy::NoRoute,
        _ => Busy::Unreachable,
    }
}

impl HubApi for LocalHub {
    fn busy(&self) -> Busy {
        parse_busy(self.call("GET", "/api/busy", ""))
    }
    fn hold(&self, minutes: u32) -> bool {
        self.ok("POST", "/api/maintenance/hold", &format!("{{\"minutes\":{minutes}}}"))
    }
    fn release(&self) -> bool {
        self.ok("POST", "/api/maintenance/release", "{}")
    }
    fn stop(&self) -> bool {
        self.ok("POST", "/api/maintenance/stop", "{}")
    }
}

#[derive(Debug, PartialEq)]
pub enum Drained {
    /// `blocking` reached 0.
    Idle,
    /// The person cancelled; the caller releases the hold.
    Cancelled,
    /// The hub stopped answering; nothing it ran can still be running, so the caller stops or kills it.
    HubGone,
}

/// Poll /api/busy every `poll` until `blocking` is 0. `progress` hears each new non-zero count; the hold is
/// renewed every `renew` so a long turn does not outlast it.
pub fn wait_until_idle(api: &dyn HubApi, cancel: &AtomicBool, poll: Duration, renew: Duration, progress: &mut dyn FnMut(u32)) -> Drained {
    let mut held_at = Instant::now();
    let mut misses = 0u32;
    let mut shown: Option<u32> = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Drained::Cancelled;
        }
        match api.busy() {
            Busy::Count(0) => return Drained::Idle,
            Busy::Count(n) => {
                misses = 0;
                if shown != Some(n) {
                    shown = Some(n);
                    progress(n);
                }
            }
            Busy::NoRoute | Busy::Unreachable => {
                misses += 1;
                if misses >= BUSY_MISSES {
                    return Drained::HubGone;
                }
            }
        }
        if held_at.elapsed() >= renew {
            api.hold(HOLD_MINUTES);
            held_at = Instant::now();
        }
        // sleep in slices so a cancel is picked up quickly
        let until = Instant::now() + poll;
        while Instant::now() < until {
            if cancel.load(Ordering::SeqCst) {
                return Drained::Cancelled;
            }
            std::thread::sleep(poll.min(Duration::from_millis(200)));
        }
    }
}

pub fn busy_text(n: u32) -> String {
    if n == 1 { "1 running turn or approval".into() } else { format!("{n} running turns/approvals") }
}

pub fn waiting_text(n: u32) -> String {
    format!("Waiting for {}", busy_text(n))
}

/// The release page of one version, or the releases list when the version string is anything odd.
pub fn notes_url(version: &str) -> String {
    let v = version.trim_start_matches('v');
    let clean = !v.is_empty() && v.len() <= 40 && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'));
    if clean { format!("{RELEASES_URL}/tag/v{v}") } else { RELEASES_URL.to_string() }
}

// ---------------------------------------------------------------- app wiring

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Busy,
    Waiting,
}

struct Ctl {
    phase: Phase,
    pending: Option<Update>,
    notes_shown: bool,
    notified: Option<String>,
}

/// Update state plus the tray items it rewrites. Lock rule as for AppState: never call a menu, window or dialog
/// API while holding `ctl`; those wait on the main thread, whose menu handler takes `ctl`.
pub struct Updates {
    ctl: Mutex<Ctl>,
    cancel: AtomicBool,
    menu: Menu<tauri::Wry>,
    check_item: MenuItem<tauri::Wry>,
    notes_item: MenuItem<tauri::Wry>,
    configured: bool,
}

impl Updates {
    pub fn new(app: &AppHandle, menu: Menu<tauri::Wry>, check_item: MenuItem<tauri::Wry>) -> tauri::Result<Self> {
        let notes_item = MenuItem::with_id(app, MENU_NOTES, "What's new", true, None::<&str>)?;
        let configured = pubkey_configured(app);
        if !configured {
            eprintln!("updates: plugins.updater.pubkey is the placeholder, so this build cannot check for updates");
            let _ = check_item.set_text(NOT_CONFIGURED_TEXT);
        }
        Ok(Self {
            ctl: Mutex::new(Ctl { phase: Phase::Idle, pending: None, notes_shown: false, notified: None }),
            cancel: AtomicBool::new(false),
            menu,
            check_item,
            notes_item,
            configured,
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Ctl> {
        self.ctl.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn set_phase(&self, p: Phase) {
        self.lock().phase = p;
    }
    fn set_text(&self, text: &str) {
        let _ = self.check_item.set_text(text);
    }
    /// Show the found update in the tray, or put "Check for updates" back.
    fn show_pending(&self) {
        let (version, notes_shown) = {
            let c = self.lock();
            (c.pending.as_ref().map(|u| u.version.clone()), c.notes_shown)
        };
        match version {
            Some(v) => {
                self.set_text(&format!("Update to v{v}…"));
                let _ = self.notes_item.set_text(format!("What's new in v{v}"));
                if !notes_shown {
                    let pos = self.menu.items().ok().and_then(|items| items.iter().position(|i| i.id() == MENU_CHECK));
                    if let Some(pos) = pos {
                        if self.menu.insert(&self.notes_item, pos + 1).is_ok() {
                            self.lock().notes_shown = true;
                        }
                    }
                }
            }
            None => {
                self.set_text(CHECK_TEXT);
                if notes_shown && self.menu.remove(&self.notes_item).is_ok() {
                    self.lock().notes_shown = false;
                }
            }
        }
    }
}

/// The committed config carries a placeholder until the owner pastes the real minisign key (#117); a build with it
/// cannot verify anything, so it does not check at all.
fn pubkey_configured(app: &AppHandle) -> bool {
    let updater = app.config().plugins.0.get("updater").cloned().unwrap_or_default();
    let conf = serde_json::json!({ "plugins": { "updater": updater } });
    match crate::updater_config::pubkey_is_set(&conf) {
        Ok(set) => set,
        Err(e) => {
            eprintln!("updates: {e}");
            false
        }
    }
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = app.updater_builder();
    match endpoint_override(std::env::var(ENDPOINT_ENV).ok().as_deref()) {
        Ok(Some(url)) => {
            eprintln!("updates: using the endpoint from {ENDPOINT_ENV}: {url}");
            b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
        }
        Ok(None) => {}
        Err(e) => eprintln!("updates: {e}"),
    }
    // Windows: the plugin runs this, then starts the installer and calls process::exit, which skips RunEvent::Exit.
    // By now a local hub was already stopped; this is the backstop for anything still attached (an ssh tunnel).
    let h = app.clone();
    b = b.on_before_exit(move || release_children(&h));
    b.build().map_err(|e| e.to_string())
}

/// Kill whatever this app still runs (a local hub that was not drained, an ssh tunnel) before it is replaced, so
/// the relaunched app does not find its port taken. On Windows the plugin calls this; elsewhere `install` does.
fn release_children(app: &AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        let mut inner = st.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.quitting = true;
        kill_child(&mut inner);
    }
}

fn check_now(app: &AppHandle) -> Result<Option<Update>, String> {
    let up = updater(app)?;
    tauri::async_runtime::block_on(up.check()).map_err(|e| e.to_string())
}

/// Launch-time and daily checks, on their own thread. Wall-clock based, so a laptop that slept through the 24 h
/// still checks soon after it wakes.
pub fn start_background_checks(app: AppHandle) {
    let configured = app.try_state::<Updates>().is_some_and(|u| u.configured);
    if !configured {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        let mut last: Option<SystemTime> = None;
        loop {
            let due = last.is_none_or(|t| t.elapsed().map_or(true, |e| e >= CHECK_EVERY));
            if due {
                last = Some(SystemTime::now());
                run_check(&app, false);
            }
            std::thread::sleep(TICK);
        }
    });
}

/// One check. `manual` is the tray item: it reports "up to date" and errors, and goes on to the question when an
/// update is there. The automatic check is silent except for one notification per new version.
fn run_check(app: &AppHandle, manual: bool) {
    let Some(u) = app.try_state::<Updates>() else { return };
    {
        let mut c = u.lock();
        if c.phase != Phase::Idle {
            return;
        }
        c.phase = Phase::Busy;
    }
    if manual {
        u.set_text("Checking for updates…");
    }
    let result = check_now(app);
    let found = match result {
        Ok(found) => found,
        Err(e) => {
            eprintln!("updates: check failed: {e}");
            u.set_phase(Phase::Idle);
            u.show_pending();
            if manual {
                message(app, "Couldn't check for updates", &format!("{e}\n\nTry again later, or look at {RELEASES_URL}."), MessageDialogKind::Warning);
            }
            return;
        }
    };
    let version = found.as_ref().map(|f| f.version.clone());
    let announce = {
        let mut c = u.lock();
        c.pending = found;
        c.phase = Phase::Idle;
        let new = version.is_some() && c.notified != version;
        if new {
            c.notified = version.clone();
        }
        new
    };
    u.show_pending();
    match version {
        None if manual => message(
            app,
            "You're up to date",
            &format!("Toki {} is the newest version.", env!("CARGO_PKG_VERSION")),
            MessageDialogKind::Info,
        ),
        None => {}
        Some(_) if manual => offer(app),
        Some(v) => {
            let skipped = app.try_state::<AppState>().and_then(|s| s.0.lock().ok().and_then(|i| i.config.skipped_update.clone()));
            if announce && skipped.as_deref() != Some(v.as_str()) {
                tell(app, &format!("Toki {v} is ready"), &format!("Install it from the tray menu: Update to v{v}…"));
            }
        }
    }
}

/// The tray's update item (MENU_CHECK). Runs off the main thread: dialogs block.
pub fn on_menu(app: &AppHandle, id: &str) {
    let Some(u) = app.try_state::<Updates>() else { return };
    if id == MENU_NOTES {
        let v = u.lock().pending.as_ref().map(|p| p.version.clone());
        if let Ok(url) = Url::parse(&v.map(|v| notes_url(&v)).unwrap_or_else(|| RELEASES_URL.to_string())) {
            open_in_browser(&url);
        }
        return;
    }
    if !u.configured {
        if let Ok(url) = Url::parse(RELEASES_URL) {
            open_in_browser(&url);
        }
        return;
    }
    let (phase, has_pending) = {
        let c = u.lock();
        (c.phase, c.pending.is_some())
    };
    let app = app.clone();
    match phase {
        Phase::Busy => {}
        Phase::Waiting => {
            std::thread::spawn(move || {
                let stop = ask(&app, "Cancel the update?", "Toki is waiting for bots to finish before it updates.", "Cancel update", "Keep waiting");
                if stop {
                    if let Some(u) = app.try_state::<Updates>() {
                        u.cancel.store(true, Ordering::SeqCst);
                    }
                }
            });
        }
        Phase::Idle if has_pending => {
            std::thread::spawn(move || offer(&app));
        }
        Phase::Idle => {
            std::thread::spawn(move || run_check(&app, true));
        }
    }
}

fn ask(app: &AppHandle, title: &str, text: &str, yes: &str, no: &str) -> bool {
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .blocking_show()
}

fn message(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title(title).kind(kind).buttons(MessageDialogButtons::Ok).blocking_show();
}

/// Everything the install needs from AppState, read once (the lock is not held past this).
struct Situation {
    mode: String,
    hub_up: bool,
    hub: LocalHub,
}

fn situation(app: &AppHandle) -> Option<Situation> {
    let st = app.try_state::<AppState>()?;
    let inner = st.0.lock().unwrap_or_else(|e| e.into_inner());
    Some(Situation {
        mode: inner.config.mode.clone(),
        hub_up: inner.config.mode == "local" && inner.child_kind == "hub" && inner.status.connected,
        hub: LocalHub { port: inner.config.port, token: inner.token.clone() },
    })
}

/// The question, asked only on demand, then the install. Never from the automatic check.
fn offer(app: &AppHandle) {
    let Some(u) = app.try_state::<Updates>() else { return };
    let update = {
        let mut c = u.lock();
        if c.phase != Phase::Idle {
            return;
        }
        let Some(p) = c.pending.clone() else { return };
        c.phase = Phase::Busy;
        p
    };
    let v = update.version.clone();
    let Some(sit) = situation(app) else {
        u.set_phase(Phase::Idle);
        return;
    };
    let packaged = is_packaged_linux(cfg!(target_os = "linux"), std::env::var_os("APPIMAGE").as_deref());
    let busy = (sit.mode == "local" && sit.hub_up && !sit.hub.token.is_empty()).then(|| sit.hub.busy());
    let plan = plan(&sit.mode, packaged, sit.hub_up, busy);
    let title = format!("Toki {v} is ready");
    let (text, yes) = match plan {
        Plan::ReleasesPage => (
            "This copy was installed from a .deb package, so it can't update itself. Download the new package from the releases page.".to_string(),
            "Open releases page",
        ),
        Plan::ShellOnly => ("Installing restarts this app. The bots on your server keep running.".to_string(), "Install and restart"),
        Plan::Confirm => (
            "Toki can't tell whether bots are busy on this hub. Make sure nothing important is running, then install. \
             Installing restarts the app; running replies will stop."
                .to_string(),
            "Install and restart",
        ),
        Plan::Drain { blocking: 0 } | Plan::NoHub => (
            "Installing restarts the app. Bots pause for about a minute while it does.".to_string(),
            "Install and restart",
        ),
        Plan::Drain { blocking } => (
            format!(
                "Bots have {} right now. Toki waits for them to finish, then installs and restarts. New work waits until it's back.",
                busy_text(blocking)
            ),
            "Install when bots are idle",
        ),
    };
    if !ask(app, &title, &text, yes, "Later") {
        remember_skipped(app, &v);
        u.set_phase(Phase::Idle);
        return;
    }
    if plan == Plan::ReleasesPage {
        if let Ok(url) = Url::parse(&notes_url(&v)) {
            open_in_browser(&url);
        }
        u.set_phase(Phase::Idle);
        return;
    }
    install(app, &u, update, plan, sit.hub);
}

/// "Later" mutes the automatic notification for this version (the tray item stays). Saved to config.json.
fn remember_skipped(app: &AppHandle, version: &str) {
    let Some(st) = app.try_state::<AppState>() else { return };
    let cfg = {
        let mut inner = st.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.config.skipped_update = Some(version.to_string());
        inner.config.clone()
    };
    save_config_file(app, &cfg);
}

fn install(app: &AppHandle, u: &Updates, update: Update, plan: Plan, hub: LocalHub) {
    let v = update.version.clone();
    // Download (and verify) first, while the bots keep working: the hub is stopped only once the bytes are here.
    u.set_text(&format!("Downloading v{v}…"));
    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("updates: download failed: {e}");
            u.set_phase(Phase::Idle);
            u.show_pending();
            message(app, "The update didn't download", &format!("{e}\n\nNothing was changed. Try again later."), MessageDialogKind::Warning);
            return;
        }
    };

    let mut stopped_hub = false;
    match plan {
        Plan::Drain { .. } => {
            u.cancel.store(false, Ordering::SeqCst);
            u.set_phase(Phase::Waiting);
            if !hub.hold(HOLD_MINUTES) {
                eprintln!("updates: the hub did not accept the maintenance hold; waiting on /api/busy anyway");
            }
            let mut told = false;
            let mut progress = |n: u32| {
                u.set_text(&format!("{}… (click to cancel)", waiting_text(n)));
                if !told {
                    told = true;
                    tell(app, &format!("Updating to {v} when bots are idle"), &format!("{}. New work waits until the update is done.", waiting_text(n)));
                }
            };
            let drained = wait_until_idle(&hub, &u.cancel, BUSY_POLL, HOLD_RENEW, &mut progress);
            if drained == Drained::Cancelled {
                hub.release();
                u.set_phase(Phase::Idle);
                u.show_pending();
                return;
            }
            u.set_phase(Phase::Busy);
            u.set_text(&format!("Installing v{v}…"));
            stop_local_hub(app, Some(&hub));
            stopped_hub = true;
        }
        Plan::NoHub => {
            stop_local_hub(app, None);
            stopped_hub = true;
        }
        Plan::ShellOnly | Plan::Confirm | Plan::ReleasesPage => {}
    }
    u.set_text(&format!("Installing v{v}…"));
    // Windows: runs on_before_exit, starts the installer (passive) and exits; the installer relaunches the app.
    match update.install(bytes) {
        Ok(()) => {
            // macOS / Linux: the bundle is replaced in place and nothing has exited yet.
            release_children(app);
            app.restart()
        }
        Err(e) => {
            eprintln!("updates: install failed: {e}");
            if stopped_hub {
                // bring the hub back exactly as a Retry would
                if let Some(st) = app.try_state::<AppState>() {
                    crate::connect(app.clone(), st.inner().clone(), true);
                }
            }
            u.set_phase(Phase::Idle);
            u.show_pending();
            message(app, "The update didn't install", &format!("{e}\n\nToki is still on {}.", env!("CARGO_PKG_VERSION")), MessageDialogKind::Warning);
        }
    }
}

/// Take the hub child out of the connection (a new generation, so the monitor does not report it as crashed),
/// ask it to stop cleanly, give it STOP_GRACE to exit, then the hard kill of its whole tree.
fn stop_local_hub(app: &AppHandle, hub: Option<&LocalHub>) {
    let Some(st) = app.try_state::<AppState>() else { return };
    let child = {
        let mut inner = st.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.generation += 1;
        inner.status.connected = false;
        inner.status.child_running = false;
        inner.child_kind = "";
        inner.child.take()
    };
    let Some(mut child) = child else { return };
    if let Some(h) = hub {
        if !h.stop() {
            eprintln!("updates: the hub did not accept the maintenance stop; killing it");
        }
    }
    let until = Instant::now() + if hub.is_some() { STOP_GRACE } else { Duration::ZERO };
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        if Instant::now() >= until {
            kill_tree(&mut child);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    #[test]
    fn endpoint_override_accepts_only_this_repos_release_path() {
        assert_eq!(endpoint_override(None), Ok(None));
        assert_eq!(endpoint_override(Some("  ")), Ok(None));
        for good in [
            "https://github.com/AlexGaledo/pocketrocket/releases/download/v0.3.1-rc.1/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases/latest/download/latest.json",
            " https://github.com/AlexGaledo/pocketrocket/releases/download/v0.3.0/latest.json ",
        ] {
            assert!(matches!(endpoint_override(Some(good)), Ok(Some(_))), "{good}");
        }
        for bad in [
            "http://github.com/AlexGaledo/pocketrocket/releases/download/v1/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases/",
            "https://github.com/AlexGaledo/pocketrocket/tags/latest.json",
            "https://github.com/someone/pocketrocket/releases/latest.json",
            "https://github.com.evil.com/AlexGaledo/pocketrocket/releases/latest.json",
            "https://evil.com/AlexGaledo/pocketrocket/releases/latest.json",
            "https://user@github.com/AlexGaledo/pocketrocket/releases/latest.json",
            "https://github.com:8443/AlexGaledo/pocketrocket/releases/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases/../../x/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases/%2e%2e/%2e%2e/x/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases/latest.json?x=1",
            "https://github.com/AlexGaledo/pocketrocket/releases/latest.json#x",
            "https://github.com/AlexGaledo/pocketrocket/releases/a b/latest.json",
            "https://github.com/AlexGaledo/pocketrocket/releases\\..\\x",
            "file:///C:/latest.json",
            "not a url",
        ] {
            assert!(endpoint_override(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn mode_decision_table() {
        use Busy::*;
        // Linux .deb wins over everything: never self-install a packaged copy.
        assert_eq!(plan("local", true, true, Some(Count(0))), Plan::ReleasesPage);
        assert_eq!(plan("remote", true, false, None), Plan::ReleasesPage);
        // Remote never touches the VPS hub, whatever it would say.
        assert_eq!(plan("remote", false, false, None), Plan::ShellOnly);
        assert_eq!(plan("remote", false, true, Some(Count(3))), Plan::ShellOnly);
        // Attach: someone else's hub, just ask.
        assert_eq!(plan("attach", false, false, None), Plan::Confirm);
        assert_eq!(plan("attach", false, true, Some(Count(0))), Plan::Confirm);
        // Local with our hub up: drain when the routes exist, ask when they don't or the hub won't say.
        assert_eq!(plan("local", false, true, Some(Count(0))), Plan::Drain { blocking: 0 });
        assert_eq!(plan("local", false, true, Some(Count(2))), Plan::Drain { blocking: 2 });
        assert_eq!(plan("local", false, true, Some(NoRoute)), Plan::Confirm);
        assert_eq!(plan("local", false, true, Some(Unreachable)), Plan::Confirm);
        assert_eq!(plan("local", false, true, None), Plan::Confirm);
        // Local with no hub running: nothing to drain.
        assert_eq!(plan("local", false, false, None), Plan::NoHub);
        assert_eq!(plan("weird", false, true, Some(Count(0))), Plan::Confirm);
    }

    #[test]
    fn packaged_linux_is_a_linux_build_without_appimage() {
        use std::ffi::OsStr;
        assert!(is_packaged_linux(true, None));
        assert!(is_packaged_linux(true, Some(OsStr::new(""))));
        assert!(!is_packaged_linux(true, Some(OsStr::new("/home/a/PocketRocket.AppImage"))));
        assert!(!is_packaged_linux(false, None));
    }

    #[test]
    fn busy_answers_parse() {
        assert_eq!(parse_busy(Some((200, r#"{"blocking":2,"pendingLanes":1,"parkedCards":0,"waitingRuns":0,"heldUntil":null}"#.into()))), Busy::Count(2));
        assert_eq!(parse_busy(Some((200, r#"{"blocking":0}"#.into()))), Busy::Count(0));
        assert_eq!(parse_busy(Some((404, r#"{"error":"Not found"}"#.into()))), Busy::NoRoute);
        assert_eq!(parse_busy(Some((401, "{}".into()))), Busy::Unreachable);
        assert_eq!(parse_busy(Some((200, "<html>".into()))), Busy::Unreachable);
        assert_eq!(parse_busy(Some((200, r#"{"blocking":-1}"#.into()))), Busy::Unreachable);
        assert_eq!(parse_busy(None), Busy::Unreachable);
    }

    #[test]
    fn notes_url_only_for_clean_versions() {
        assert_eq!(notes_url("0.3.1"), format!("{RELEASES_URL}/tag/v0.3.1"));
        assert_eq!(notes_url("v0.4.0-rc.1"), format!("{RELEASES_URL}/tag/v0.4.0-rc.1"));
        assert_eq!(notes_url("1/../../x"), RELEASES_URL);
        assert_eq!(notes_url(""), RELEASES_URL);
    }

    /// A one-request-per-connection HTTP mock of the hub's maintenance routes. `/api/busy` answers the next count
    /// from `busy` (repeating the last one); every request line and its Authorization header are recorded.
    struct MockHub {
        port: u16,
        log: Arc<Mutex<Vec<String>>>,
    }

    fn mock_hub(busy: Vec<u32>, busy_status: u16) -> MockHub {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let rec = log.clone();
        std::thread::spawn(move || {
            let mut i = 0usize;
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let authed = req.contains("Authorization: Bearer 0123456789abcdef0123456789abcdef\r\n");
                let body_part = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                rec.lock().unwrap().push(format!("{line} auth={authed} body={body_part}"));
                let (code, body) = if line.starts_with("GET /api/busy ") {
                    if busy_status != 200 {
                        (busy_status, r#"{"error":"Not found"}"#.to_string())
                    } else {
                        let n = busy.get(i).or(busy.last()).copied().unwrap_or(0);
                        i += 1;
                        (200, format!(r#"{{"blocking":{n},"pendingLanes":0,"parkedCards":0,"waitingRuns":0,"heldUntil":null}}"#))
                    }
                } else {
                    (200, r#"{"ok":true}"#.to_string())
                };
                let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}");
            }
        });
        MockHub { port, log }
    }

    fn hub(port: u16) -> LocalHub {
        LocalHub { port, token: "0123456789abcdef0123456789abcdef".into() }
    }

    #[test]
    fn busy_poll_waits_for_zero_and_reports_each_new_count() {
        let m = mock_hub(vec![3, 3, 1, 0], 200);
        let h = hub(m.port);
        assert!(h.hold(HOLD_MINUTES));
        let mut seen = Vec::new();
        let r = wait_until_idle(&h, &AtomicBool::new(false), Duration::from_millis(1), Duration::from_secs(600), &mut |n| seen.push(n));
        assert_eq!(r, Drained::Idle);
        assert_eq!(seen, vec![3, 1]);
        let log = m.log.lock().unwrap().clone();
        assert_eq!(log[0], format!("POST /api/maintenance/hold HTTP/1.0 auth=true body={{\"minutes\":{HOLD_MINUTES}}}"));
        assert_eq!(log.iter().filter(|l| l.starts_with("GET /api/busy HTTP/1.0 auth=true")).count(), 4);
    }

    #[test]
    fn busy_poll_renews_the_hold_while_waiting() {
        let m = mock_hub(vec![1, 1, 1, 0], 200);
        let r = wait_until_idle(&hub(m.port), &AtomicBool::new(false), Duration::from_millis(1), Duration::ZERO, &mut |_| {});
        assert_eq!(r, Drained::Idle);
        let holds = m.log.lock().unwrap().iter().filter(|l| l.starts_with("POST /api/maintenance/hold")).count();
        assert_eq!(holds, 3);
    }

    #[test]
    fn busy_poll_can_be_cancelled() {
        let m = mock_hub(vec![2], 200);
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            c2.store(true, Ordering::SeqCst);
        });
        let r = wait_until_idle(&hub(m.port), &cancel, Duration::from_millis(20), Duration::from_secs(600), &mut |_| {});
        assert_eq!(r, Drained::Cancelled);
        let h = hub(m.port);
        assert!(h.release());
        assert!(m.log.lock().unwrap().iter().any(|l| l.starts_with("POST /api/maintenance/release HTTP/1.0 auth=true")));
    }

    #[test]
    fn busy_poll_gives_up_on_a_hub_that_stopped_answering() {
        // an older hub (404) as the plan probe sees it, and a hub that is gone mid-wait
        let m = mock_hub(vec![], 404);
        assert_eq!(hub(m.port).busy(), Busy::NoRoute);
        let dead = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // listener dropped: refused
        let r = wait_until_idle(&hub(dead), &AtomicBool::new(false), Duration::from_millis(1), Duration::from_secs(600), &mut |_| {});
        assert_eq!(r, Drained::HubGone);
    }

    #[test]
    fn stop_is_posted_with_the_token() {
        let m = mock_hub(vec![0], 200);
        assert!(hub(m.port).stop());
        assert!(m.log.lock().unwrap()[0].starts_with("POST /api/maintenance/stop HTTP/1.0 auth=true"));
    }

    #[test]
    fn waiting_copy() {
        assert_eq!(waiting_text(1), "Waiting for 1 running turn or approval");
        assert_eq!(waiting_text(4), "Waiting for 4 running turns/approvals");
    }
}
