//! First-run discovery: which servers in ~/.ssh/config already run PocketRocket, and whether Claude Code is
//! signed in on this PC.
//!
//! Safety rules this module is built around:
//! - Listing hosts is local and offline. `ssh -G` is only used to resolve aliases when no ssh config the
//!   parser can see has a `Match exec` (which would run a local command during parsing).
//! - Nothing connects until the person ticks hosts and presses Scan: ProxyCommand/ProxyJump run local
//!   commands, so scanning on launch would execute config the person never looked at.
//! - A scan is one ssh per host with BatchMode (never a password prompt), no forwarding, no local command,
//!   a constant read-only script and an 8 s wall clock. Its output is untrusted: capped, known keys only.
//! - An unknown host key is only accepted after the person saw its fingerprint and confirmed, and then only
//!   with StrictHostKeyChecking=accept-new (never `no`, so a changed key can never be overridden).

use crate::proc::run_capture;
use crate::ssh;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const SCAN_EVENT: &str = "ssh-scan-result";
const MAX_INCLUDE_DEPTH: usize = 16;
const MAX_HOSTS: usize = 100;
const SCAN_CONCURRENCY: usize = 6;
const SCAN_WALL_CLOCK: Duration = Duration::from_secs(8);
const SCAN_OUTPUT_CAP: usize = 4096;

// ---------------------------------------------------------------------------------------------------------
// ~/.ssh/config parsing

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedHost {
    pub name: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub proxy: bool,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub hosts: Vec<ParsedHost>,
    /// Some file has `Match … exec …`: resolving aliases with `ssh -G` would run a local command.
    pub match_exec: bool,
}

struct Ctx<'a> {
    home: &'a Path,
    /// Base for relative Include paths (~/.ssh for the user config).
    base: &'a Path,
}

/// OpenSSH-style argument splitting: whitespace separated, single or double quotes, `#` at the start of a
/// token ends the line.
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_tok = false;
    let mut quote: Option<char> = None;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && matches!(chars.peek(), Some(&n) if n == q || n == '\\') {
                cur.push(chars.next().unwrap_or(c));
            } else {
                cur.push(c);
            }
            continue;
        }
        if c.is_whitespace() {
            if in_tok {
                out.push(std::mem::take(&mut cur));
                in_tok = false;
            }
        } else if c == '#' && !in_tok {
            break;
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            in_tok = true;
        } else {
            cur.push(c);
            in_tok = true;
        }
    }
    if in_tok {
        out.push(cur);
    }
    out
}

/// `Keyword value`, `Keyword=value` and `Keyword = value`; keyword lower-cased.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let end = t.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(t.len());
    let kw = t[..end].to_ascii_lowercase();
    let mut rest = t[end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    Some((kw, split_args(rest)))
}

/// A concrete alias worth offering: no patterns or negations, nothing that could look like an option.
pub fn usable_alias(name: &str) -> bool {
    !name.contains(['*', '?', '!']) && ssh::validate_host(name).is_ok()
}

fn wildcard(pat: &str, name: &str) -> bool {
    if name.starts_with('.') && !pat.starts_with('.') {
        return false;
    }
    let norm = |s: &str| -> Vec<char> { if cfg!(windows) { s.to_lowercase().chars().collect() } else { s.chars().collect() } };
    let (p, n) = (norm(pat), norm(name));
    let (mut pi, mut ni, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Expand `*` and `?` in any path component, sorted like glob(3).
fn glob_paths(p: &Path) -> Vec<PathBuf> {
    if !p.to_string_lossy().contains(['*', '?']) {
        return vec![p.to_path_buf()];
    }
    let mut cur = vec![PathBuf::new()];
    for comp in p.components() {
        let text = comp.as_os_str().to_string_lossy().into_owned();
        if matches!(comp, Component::Normal(_)) && text.contains(['*', '?']) {
            let mut next = Vec::new();
            for base in &cur {
                let Ok(rd) = std::fs::read_dir(base) else { continue };
                let mut names: Vec<String> =
                    rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| wildcard(&text, n)).collect();
                names.sort();
                next.extend(names.into_iter().map(|n| base.join(n)));
            }
            cur = next;
        } else {
            for b in &mut cur {
                b.push(comp.as_os_str());
            }
        }
    }
    cur
}

fn include_paths(arg: &str, ctx: &Ctx) -> Vec<PathBuf> {
    let path = if arg == "~" {
        ctx.home.to_path_buf()
    } else if let Some(rest) = arg.strip_prefix("~/").or_else(|| arg.strip_prefix("~\\")) {
        ctx.home.join(rest)
    } else {
        let pb = PathBuf::from(arg);
        if pb.is_absolute() || arg.starts_with('/') || arg.starts_with('\\') {
            pb
        } else {
            ctx.base.join(pb)
        }
    };
    glob_paths(&path)
}

fn parse_file(path: &Path, ctx: &Ctx, depth: usize, out: &mut Parsed, block: &mut Vec<usize>) {
    if depth > MAX_INCLUDE_DEPTH {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let Some((kw, args)) = split_line(line) else { continue };
        match kw.as_str() {
            "host" => {
                block.clear();
                for name in args.into_iter().filter(|a| usable_alias(a)) {
                    let idx = match out.hosts.iter().position(|h| h.name == name) {
                        Some(i) => i,
                        None => {
                            if out.hosts.len() >= MAX_HOSTS {
                                continue;
                            }
                            out.hosts.push(ParsedHost { name, ..Default::default() });
                            out.hosts.len() - 1
                        }
                    };
                    if !block.contains(&idx) {
                        block.push(idx);
                    }
                }
            }
            "match" => {
                block.clear();
                if args.iter().any(|a| {
                    let a = a.to_ascii_lowercase();
                    a == "exec" || a.starts_with("exec=") || a == "!exec"
                }) {
                    out.match_exec = true;
                }
            }
            "include" => {
                for arg in &args {
                    for p in include_paths(arg, ctx) {
                        // Included lines before their own Host/Match belong to the enclosing block, and that
                        // block is back in force when the include returns (readconf.c restores it too).
                        let mut inner = block.clone();
                        parse_file(&p, ctx, depth + 1, out, &mut inner);
                    }
                }
            }
            "hostname" | "user" | "port" | "proxyjump" | "proxycommand" => {
                let Some(v) = args.first() else { continue };
                for &i in block.iter() {
                    let h = &mut out.hosts[i];
                    // First obtained value wins, as in ssh.
                    match kw.as_str() {
                        "hostname" if h.hostname.is_none() => h.hostname = Some(v.clone()),
                        "user" if h.user.is_none() => h.user = Some(v.clone()),
                        "port" if h.port.is_none() => h.port = v.parse().ok(),
                        "proxyjump" | "proxycommand" if !v.eq_ignore_ascii_case("none") => h.proxy = true,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

/// Parse one config file (and everything it includes). `base` resolves relative Include paths.
pub fn parse_config(path: &Path, home: &Path, base: &Path) -> Parsed {
    let mut out = Parsed::default();
    parse_file(path, &Ctx { home, base }, 0, &mut out, &mut Vec::new());
    out
}

pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn system_ssh_config() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into())).join("ssh").join("ssh_config")
    } else {
        PathBuf::from("/etc/ssh/ssh_config")
    }
}

// ---------------------------------------------------------------------------------------------------------
// ssh -G

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub proxy: bool,
    pub host_key_alias: Option<String>,
    pub known_hosts: Vec<String>,
}

pub fn parse_ssh_g(out: &str) -> Resolved {
    let mut r = Resolved::default();
    for line in out.lines() {
        let Some((k, v)) = line.trim().split_once(' ') else { continue };
        let v = v.trim();
        match k.to_ascii_lowercase().as_str() {
            "hostname" => r.hostname = Some(v.to_string()),
            "user" => r.user = Some(v.to_string()),
            "port" => r.port = v.parse().ok(),
            "proxyjump" | "proxycommand" if !v.eq_ignore_ascii_case("none") => r.proxy = true,
            "hostkeyalias" if !v.eq_ignore_ascii_case("none") => r.host_key_alias = Some(v.to_string()),
            "userknownhostsfile" => r.known_hosts = split_args(v),
            _ => {}
        }
    }
    r
}

fn ssh_g(alias: &str) -> Option<Resolved> {
    let mut cmd = Command::new(ssh::ssh_exe());
    cmd.arg("-G").arg("--").arg(alias);
    let c = run_capture(cmd, Duration::from_secs(5), 64 * 1024, &|| false).ok()?;
    if !c.status.is_some_and(|s| s.success()) {
        return None;
    }
    Some(parse_ssh_g(&String::from_utf8_lossy(&c.stdout)))
}

/// Run `f` over `items` on at most `workers` threads.
fn parallel<T: Send + 'static, R: Send + 'static>(items: Vec<T>, workers: usize, f: impl Fn(T) -> R + Send + Sync + 'static) -> Vec<R> {
    let n = items.len();
    let queue = Arc::new(Mutex::new(items.into_iter().enumerate().collect::<VecDeque<_>>()));
    let results = Arc::new(Mutex::new(Vec::with_capacity(n)));
    let f = Arc::new(f);
    let handles: Vec<_> = (0..workers.min(n).max(1))
        .map(|_| {
            let (queue, results, f) = (queue.clone(), results.clone(), f.clone());
            std::thread::spawn(move || loop {
                let next = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
                let Some((i, item)) = next else { break };
                let r = f(item);
                results.lock().unwrap_or_else(|e| e.into_inner()).push((i, r));
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    let mut v = std::mem::take(&mut *results.lock().unwrap_or_else(|e| e.into_inner()));
    v.sort_by_key(|(i, _)| *i);
    v.into_iter().map(|(_, r)| r).collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// The alias to scan and to save as sshHost.
    pub alias: String,
    /// Other aliases that reach the same user@host:port.
    pub also: Vec<String>,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    /// Goes through ProxyJump/ProxyCommand.
    pub proxy: bool,
}

pub fn group_hosts(entries: Vec<(String, Resolved)>) -> Vec<SshHost> {
    let mut out: Vec<SshHost> = Vec::new();
    for (alias, r) in entries {
        let hostname = r.hostname.clone().unwrap_or_else(|| alias.clone());
        let port = r.port.unwrap_or(22);
        let found = out.iter_mut().find(|h| h.hostname.eq_ignore_ascii_case(&hostname) && h.port == port && h.user == r.user);
        match found {
            Some(h) => h.also.push(alias),
            None => out.push(SshHost { alias, also: Vec::new(), hostname, user: r.user, port, proxy: r.proxy }),
        }
    }
    out
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostList {
    pub hosts: Vec<SshHost>,
    pub config_path: String,
    pub config_found: bool,
    /// Aliases were resolved with `ssh -G` (false when a `Match exec` made that unsafe, or ssh is missing).
    pub resolved: bool,
}

pub fn list_hosts() -> HostList {
    let Some(home) = home_dir() else {
        return HostList { hosts: Vec::new(), config_path: String::new(), config_found: false, resolved: false };
    };
    let ssh_dir = home.join(".ssh");
    let config = ssh_dir.join("config");
    let parsed = parse_config(&config, &home, &ssh_dir);
    let system = system_ssh_config();
    let system_exec = parse_config(&system, &home, system.parent().unwrap_or(Path::new("/"))).match_exec;
    let safe_to_resolve = !parsed.match_exec && !system_exec;

    let fallback = |h: &ParsedHost| Resolved { hostname: h.hostname.clone(), user: h.user.clone(), port: h.port, proxy: h.proxy, ..Default::default() };
    let mut resolved_any = false;
    let entries: Vec<(String, Resolved)> = if safe_to_resolve && !parsed.hosts.is_empty() {
        let hosts = parsed.hosts.clone();
        let res = parallel(hosts.clone(), 8, |h: ParsedHost| ssh_g(&h.name));
        hosts
            .iter()
            .zip(res)
            .map(|(h, r)| {
                resolved_any |= r.is_some();
                (h.name.clone(), r.unwrap_or_else(|| fallback(h)))
            })
            .collect()
    } else {
        parsed.hosts.iter().map(|h| (h.name.clone(), fallback(h))).collect()
    };
    HostList {
        hosts: group_hosts(entries),
        config_path: config.to_string_lossy().into_owned(),
        config_found: config.is_file(),
        resolved: resolved_any,
    }
}

// ---------------------------------------------------------------------------------------------------------
// Remote scan

/// Runs through the remote login shell as `sh -c '<this>'`, so it must stay one line with no single quote,
/// `!` (csh history) or backslash outside double quotes. Read-only: it starts, stops and writes nothing.
/// The sudo line only runs as root, so a normal user never trips a "not in sudoers" incident report.
pub const SCAN_SCRIPT: &str = concat!(
    "echo pr_scan=1; ",
    "u=$(id -u 2>/dev/null); echo uid=$u; ",
    "echo active=$(systemctl is-active pocketrocket 2>/dev/null); ",
    "for s in pocketrocket claudebot; do if systemctl cat $s.service >/dev/null 2>&1 || [ -f /etc/systemd/system/$s.service ]; then echo unit_$s=1; fi; done; ",
    "for d in /home/pocketrocket/pocketrocket /root/pocketrocket /root/claudebot; do if [ -d $d/packages/hub ]; then echo dir=$d; break; fi; done; ",
    "h=$(curl -fsS -m 3 http://127.0.0.1:7788/api/health 2>/dev/null || wget -q -T 3 -O - http://127.0.0.1:7788/api/health 2>/dev/null); ",
    "printf \"health=%s\\n\" \"$(printf %s \"$h\" | tr -d \"\\r\\n\" | head -c 1000)\"; ",
    "c=; if [ \"$u\" = 0 ]; then c=$(timeout 3 sudo -n -u pocketrocket -H /home/pocketrocket/.local/bin/claude auth status 2>/dev/null); ",
    "elif [ \"$(id -un 2>/dev/null)\" = pocketrocket ]; then c=$(timeout 3 /home/pocketrocket/.local/bin/claude auth status 2>/dev/null); fi; ",
    "printf \"claude=%s\\n\" \"$(printf %s \"$c\" | tr -d \"\\r\\n\" | head -c 1000)\"; ",
    "exit 0"
);

pub fn scan_args(alias: &str, accept_new: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", "RequestTTY=no", "-o", "LogLevel=ERROR",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if accept_new {
        a.extend(["-o".to_string(), "StrictHostKeyChecking=accept-new".to_string()]);
    }
    a.extend(["--".to_string(), alias.to_string(), format!("sh -c '{SCAN_SCRIPT}'")]);
    a
}

#[derive(Debug, Default, PartialEq)]
pub struct Facts {
    pub ran: bool,
    pub uid: Option<String>,
    pub active: Option<String>,
    pub unit_pocketrocket: bool,
    pub unit_claudebot: bool,
    pub dir: Option<String>,
    pub health: Option<String>,
    pub claude: Option<String>,
}

const KNOWN_DIRS: [&str; 3] = ["/home/pocketrocket/pocketrocket", "/root/pocketrocket", "/root/claudebot"];

fn clean(v: &str, max: usize) -> String {
    v.chars().filter(|c| !c.is_control()).take(max).collect()
}

fn only(v: &str, max: usize, ok: impl Fn(char) -> bool) -> Option<String> {
    (!v.is_empty() && v.len() <= max && v.chars().all(ok)).then(|| v.to_string())
}

/// Known keys only, first value wins, everything length-capped. The output comes from a server.
pub fn parse_facts(stdout: &[u8]) -> Facts {
    let text = String::from_utf8_lossy(&stdout[..stdout.len().min(SCAN_OUTPUT_CAP)]);
    let mut f = Facts::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k.trim() {
            "pr_scan" => f.ran |= v == "1",
            "uid" if f.uid.is_none() => f.uid = only(v, 10, |c| c.is_ascii_digit()),
            "active" if f.active.is_none() => f.active = only(v, 20, |c| c.is_ascii_lowercase() || c == '-'),
            "unit_pocketrocket" => f.unit_pocketrocket |= v == "1",
            "unit_claudebot" => f.unit_claudebot |= v == "1",
            "dir" if f.dir.is_none() => f.dir = KNOWN_DIRS.iter().find(|d| **d == v).map(|d| d.to_string()),
            "health" if f.health.is_none() && !v.is_empty() => f.health = Some(clean(v, 1000)),
            "claude" if f.claude.is_none() && !v.is_empty() => f.claude = Some(clean(v, 1000)),
            _ => {}
        }
    }
    f
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub logged_in: Option<bool>,
    pub email: Option<String>,
    /// `subscriptionType` from `claude auth status` ("max", "pro", …).
    pub plan: Option<String>,
}

/// `claude auth status` JSON. None when it isn't that.
pub fn parse_auth_status(json: &str) -> Option<ClaudeAccount> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let obj = v.as_object()?;
    let logged_in = obj.get("loggedIn").and_then(|x| x.as_bool());
    let email = obj.get("email").and_then(|x| x.as_str()).map(|s| clean(s, 254)).filter(|s| !s.is_empty());
    let plan = obj
        .get("subscriptionType")
        .and_then(|x| x.as_str())
        .and_then(|s| only(s, 32, |c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    if logged_in.is_none() && email.is_none() {
        return None;
    }
    Some(ClaudeAccount { logged_in, email, plan })
}

/// The hub's GET /api/health body -> its version ("" when it has none). None when it isn't a hub answer.
pub fn health_version(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let obj = v.as_object()?;
    if !obj.contains_key("ok") && !obj.contains_key("version") {
        return None;
    }
    Some(
        obj.get("version")
            .and_then(|x| x.as_str())
            .and_then(|s| only(s, 32, |c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
            .unwrap_or_default(),
    )
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub alias: String,
    /// running | stopped | legacy | none | hostKeyUnknown | hostKeyChanged | needsKey | unreachable
    pub kind: String,
    pub detail: String,
    pub version: Option<String>,
    pub version_matches: Option<bool>,
    pub service: Option<String>,
    pub install_dir: Option<String>,
    pub root: Option<bool>,
    pub claude: Option<ClaudeAccount>,
}

pub fn classify(alias: &str, exit_code: Option<i32>, timed_out: bool, stdout: &[u8], stderr: &str) -> ScanResult {
    let f = parse_facts(stdout);
    let mut r = ScanResult { alias: alias.to_string(), ..Default::default() };
    let set = |r: &mut ScanResult, kind: &str, detail: String| {
        r.kind = kind.to_string();
        r.detail = detail;
    };
    if f.ran {
        r.root = f.uid.as_deref().map(|u| u == "0");
        r.service = f.active.clone();
        r.install_dir = f.dir.clone();
        r.claude = f.claude.as_deref().and_then(parse_auth_status);
        let mine = env!("CARGO_PKG_VERSION");
        if let Some(v) = f.health.as_deref().and_then(health_version) {
            r.version_matches = (!v.is_empty()).then(|| v == mine);
            let detail = if v.is_empty() {
                "PocketRocket hub is running.".to_string()
            } else if v == mine {
                format!("PocketRocket {v} is running.")
            } else {
                format!("PocketRocket {v} is running (this app is {mine}).")
            };
            r.version = (!v.is_empty()).then_some(v);
            set(&mut r, "running", detail);
        } else if f.unit_pocketrocket || f.dir.as_deref().is_some_and(|d| d.ends_with("/pocketrocket")) {
            let state = f.active.as_deref().unwrap_or("unknown");
            set(&mut r, "stopped", format!(
                "PocketRocket is installed but its hub isn't answering on 127.0.0.1:7788 (service: {state}). On the server: systemctl status pocketrocket"
            ));
        } else if f.unit_claudebot || f.dir.as_deref() == Some("/root/claudebot") {
            set(&mut r, "legacy", "An old Claudebot install. Deploy PocketRocket to it (scripts/deploy.sh) to migrate it.".into());
        } else if timed_out {
            set(&mut r, "unreachable", "The server answered but the check didn't finish within 8 seconds. Try again.".into());
        } else {
            set(&mut r, "none", "Reachable, no PocketRocket here yet. Deploy it with scripts/deploy.sh.".into());
        }
        return r;
    }
    if timed_out {
        set(&mut r, "unreachable", format!("No answer from {alias} within 8 seconds."));
        return r;
    }
    match ssh::classify_failure(stderr) {
        ssh::SshFailure::HostKeyChanged => set(&mut r, "hostKeyChanged", format!(
            "{alias}'s host key has CHANGED. This can mean the connection is being intercepted. PocketRocket won't connect or \
             replace the key. If you rebuilt the server, verify the new key with your provider and fix known_hosts yourself."
        )),
        ssh::SshFailure::HostKeyUnknown => set(&mut r, "hostKeyUnknown", "This PC hasn't seen this server's host key before.".into()),
        ssh::SshFailure::AuthFailed => set(&mut r, "needsKey", format!(
            "{alias} refused your SSH key. Start the \"OpenSSH Authentication Agent\" service and run `ssh-add` in a terminal. Passwords aren't supported."
        )),
        // ssh exits 255 for its own errors; any other code means we were logged in but the script couldn't run.
        _ if exit_code.is_some_and(|c| c != 255) => {
            set(&mut r, "none", "Reachable, but the check couldn't run there (not a Linux shell?).".into())
        }
        _ => set(&mut r, "unreachable", ssh::explain(stderr, alias, 7788)),
    }
    r
}

/// Fingerprints (SHA256:…) the person was shown for an alias; accept-new is only allowed after this.
fn shown_fingerprints() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static M: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sha256_tokens(text: &str) -> Vec<String> {
    text.split_whitespace().filter(|t| t.starts_with("SHA256:")).map(|t| clean(t, 80)).collect()
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

/// After an accept-new scan: the key ssh stored must be one the person confirmed. Some(problem) if not.
fn verify_accepted_key(alias: &str) -> Option<String> {
    let expected = shown_fingerprints().lock().unwrap_or_else(|e| e.into_inner()).get(alias).cloned()?;
    let info = ssh_g(alias)?;
    let hostname = info.hostname.clone().unwrap_or_else(|| alias.to_string());
    let port = info.port.unwrap_or(22);
    let spec = info.host_key_alias.clone().unwrap_or_else(|| if port == 22 { hostname.clone() } else { format!("[{hostname}]:{port}") });
    let mut stored = Vec::new();
    for file in &info.known_hosts {
        let path = expand_home(file);
        if !path.is_file() {
            continue;
        }
        let mut cmd = Command::new(ssh::tool("ssh-keygen"));
        cmd.arg("-l").arg("-F").arg(&spec).arg("-f").arg(&path);
        if let Ok(c) = run_capture(cmd, Duration::from_secs(5), 64 * 1024, &|| false) {
            stored.extend(sha256_tokens(&String::from_utf8_lossy(&c.stdout)));
        }
    }
    if stored.is_empty() || stored.iter().any(|s| expected.contains(s)) {
        None
    } else {
        Some(format!(
            "The key {alias} presented doesn't match the fingerprint you confirmed, so PocketRocket won't use it. \
             Remove the new entry with `ssh-keygen -R {spec}` and check the server."
        ))
    }
}

pub fn scan_one(alias: &str, accept_new: bool) -> ScanResult {
    let mut cmd = Command::new(ssh::ssh_exe());
    cmd.args(scan_args(alias, accept_new));
    let mut r = match run_capture(cmd, SCAN_WALL_CLOCK, SCAN_OUTPUT_CAP, &|| false) {
        Ok(c) => classify(alias, c.status.and_then(|s| s.code()), c.timed_out, &c.stdout, &c.stderr),
        Err(e) => ScanResult {
            alias: alias.to_string(),
            kind: "unreachable".into(),
            detail: format!("Can't run ssh ({e}). Install \"OpenSSH Client\" in Settings, Optional features."),
            ..Default::default()
        },
    };
    if accept_new && !matches!(r.kind.as_str(), "hostKeyUnknown" | "hostKeyChanged" | "needsKey" | "unreachable") {
        if let Some(problem) = verify_accepted_key(alias) {
            r = ScanResult { alias: alias.to_string(), kind: "hostKeyChanged".into(), detail: problem, ..Default::default() };
        }
    }
    r
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostFingerprint {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    /// `ssh-keygen -l` lines: "256 SHA256:… host (ED25519)".
    pub lines: Vec<String>,
}

pub fn fingerprint(alias: &str) -> Result<HostFingerprint, String> {
    let info = ssh_g(alias).ok_or_else(|| format!("Couldn't read the ssh settings for {alias}."))?;
    if info.proxy {
        return Err(format!(
            "{alias} is reached through a jump host, so its key can't be checked from here. Run `ssh {alias}` once in a terminal instead."
        ));
    }
    let hostname = info.hostname.clone().unwrap_or_else(|| alias.to_string());
    let port = info.port.unwrap_or(22);
    let mut scan = Command::new(ssh::tool("ssh-keyscan"));
    scan.args(["-T", "5", "-p", &port.to_string(), "--", &hostname]);
    let keys = run_capture(scan, SCAN_WALL_CLOCK, 32 * 1024, &|| false).map_err(|e| format!("Can't run ssh-keyscan: {e}"))?;
    let keys = String::from_utf8_lossy(&keys.stdout).into_owned();
    if !keys.lines().any(|l| !l.trim().is_empty() && !l.starts_with('#')) {
        return Err(format!("{hostname} didn't send a host key. Is the server up?"));
    }
    let mut rnd = [0u8; 8];
    let _ = getrandom::fill(&mut rnd);
    let tmp = std::env::temp_dir().join(format!("pocketrocket-keyscan-{}-{}.txt", std::process::id(), u64::from_le_bytes(rnd)));
    std::fs::write(&tmp, &keys).map_err(|e| e.to_string())?;
    let mut keygen = Command::new(ssh::tool("ssh-keygen"));
    keygen.arg("-l").arg("-f").arg(&tmp);
    let listed = run_capture(keygen, Duration::from_secs(5), 32 * 1024, &|| false);
    let _ = std::fs::remove_file(&tmp);
    let listed = String::from_utf8_lossy(&listed.map_err(|e| format!("Can't run ssh-keygen: {e}"))?.stdout).into_owned();
    let lines: Vec<String> = listed.lines().map(|l| clean(l.trim(), 200)).filter(|l| l.contains("SHA256:")).collect();
    if lines.is_empty() {
        return Err("Couldn't compute the host key fingerprint.".into());
    }
    shown_fingerprints().lock().unwrap_or_else(|e| e.into_inner()).insert(alias.to_string(), sha256_tokens(&lines.join(" ")));
    Ok(HostFingerprint { alias: alias.to_string(), hostname, port, lines })
}

// ---------------------------------------------------------------------------------------------------------
// Local Claude Code

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalClaude {
    pub installed: bool,
    pub version: Option<String>,
    pub logged_in: Option<bool>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

fn claude_exe() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAUDE_EXE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    home_dir().map(|h| h.join(".local").join("bin").join(name))
}

pub fn local_claude() -> LocalClaude {
    let Some(exe) = claude_exe().filter(|p| p.is_file()) else { return LocalClaude::default() };
    let run = |args: &'static [&'static str]| {
        let exe = exe.clone();
        std::thread::spawn(move || {
            let mut cmd = Command::new(exe);
            cmd.args(args);
            run_capture(cmd, Duration::from_secs(5), 16 * 1024, &|| false).ok().map(|c| String::from_utf8_lossy(&c.stdout).into_owned())
        })
    };
    let (version, status) = (run(&["--version"]), run(&["auth", "status"]));
    let version = version.join().ok().flatten().and_then(|v| v.lines().next().map(|l| clean(l.trim(), 60))).filter(|v| !v.is_empty());
    let account = status.join().ok().flatten().and_then(|s| parse_auth_status(&s)).unwrap_or_default();
    LocalClaude { installed: true, version, logged_in: account.logged_in, email: account.email, plan: account.plan }
}

// ---------------------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn list_ssh_hosts() -> Result<HostList, String> {
    tauri::async_runtime::spawn_blocking(list_hosts).await.map_err(|e| e.to_string())
}

/// Scan the hosts the person ticked. Emits `ssh-scan-result` per host as each finishes, returns them all.
/// `acceptNew` (one host only, after `ssh_host_fingerprint`) trusts a not-yet-known host key.
#[tauri::command]
pub async fn scan_ssh_hosts(app: AppHandle, aliases: Vec<String>, accept_new: Option<bool>) -> Result<Vec<ScanResult>, String> {
    if aliases.is_empty() || aliases.len() > MAX_HOSTS {
        return Err("Pick between 1 and 100 hosts.".into());
    }
    if let Some(bad) = aliases.iter().find(|a| !usable_alias(a)) {
        return Err(format!("Not a host alias: {bad}"));
    }
    let accept_new = accept_new.unwrap_or(false);
    if accept_new
        && (aliases.len() != 1 || !shown_fingerprints().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&aliases[0]))
    {
        return Err("Check the host's fingerprint first.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        parallel(aliases, SCAN_CONCURRENCY, move |alias: String| {
            let r = scan_one(&alias, accept_new);
            let _ = app.emit(SCAN_EVENT, &r);
            r
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_host_fingerprint(alias: String) -> Result<HostFingerprint, String> {
    if !usable_alias(&alias) {
        return Err(format!("Not a host alias: {alias}"));
    }
    tauri::async_runtime::spawn_blocking(move || fingerprint(&alias)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_local_claude() -> Result<LocalClaude, String> {
    tauri::async_runtime::spawn_blocking(local_claude).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(name: &str) -> Self {
            let mut rnd = [0u8; 8];
            let _ = getrandom::fill(&mut rnd);
            let dir = std::env::temp_dir().join(format!("pr-scan-{name}-{}", u64::from_le_bytes(rnd)));
            std::fs::create_dir_all(dir.join(".ssh")).unwrap();
            Fixture(dir)
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn parse(&self) -> Parsed {
            let ssh = self.0.join(".ssh");
            parse_config(&ssh.join("config"), &self.0, &ssh)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn names(p: &Parsed) -> Vec<&str> {
        p.hosts.iter().map(|h| h.name.as_str()).collect()
    }

    #[test]
    fn host_lines_in_every_spelling() {
        let f = Fixture::new("spelling");
        f.write(
            ".ssh/config",
            "# comment\n\
             Host vps\n  HostName 203.0.113.7\n  User root\n  Port 2222\n\
             host=eq-form\n\
             HOST  = spaced   other  # trailing comment\n\
             Host \"quoted name\" plain\n\
             Host *.example.com !bad gw? -oProxyCommand=calc *\n\
               HostName ignored\n\
             Host vps\n  HostName second-wins-not\n",
        );
        let p = f.parse();
        assert_eq!(names(&p), vec!["vps", "eq-form", "spaced", "other", "plain"]);
        let vps = &p.hosts[0];
        assert_eq!(vps.hostname.as_deref(), Some("203.0.113.7"));
        assert_eq!(vps.user.as_deref(), Some("root"));
        assert_eq!(vps.port, Some(2222));
        assert!(!p.match_exec);
    }

    #[test]
    fn includes_relative_globbed_nested_and_inside_blocks() {
        let f = Fixture::new("include");
        f.write(".ssh/config", "Include conf.d/*.conf\nHost top\n  Include ~/.ssh/extra/inner\n  HostName top.example\nMatch host foo\n  Include late\n");
        f.write(".ssh/conf.d/a.conf", "Host alpha\n  HostName a.example\n");
        f.write(".ssh/conf.d/b.conf", "Host beta\nInclude conf.d/nested/*\n");
        f.write(".ssh/conf.d/.hidden.conf", "Host hidden\n");
        f.write(".ssh/conf.d/c.txt", "Host notmatched\n");
        f.write(".ssh/conf.d/nested/n1", "Host gamma\n");
        f.write(".ssh/extra/inner", "  User admin\n");
        f.write(".ssh/late", "Host delta\n");
        let p = f.parse();
        assert_eq!(names(&p), vec!["alpha", "beta", "gamma", "top", "delta"]);
        let top = p.hosts.iter().find(|h| h.name == "top").unwrap();
        // the included file's leading lines apply to the enclosing Host block, which stays open afterwards
        assert_eq!(top.user.as_deref(), Some("admin"));
        assert_eq!(top.hostname.as_deref(), Some("top.example"));
    }

    #[test]
    fn include_recursion_is_bounded() {
        let f = Fixture::new("loop");
        f.write(".ssh/config", "Host loop\nInclude config\n");
        let p = f.parse();
        assert_eq!(names(&p), vec!["loop"]);
    }

    #[test]
    fn match_exec_is_detected_anywhere() {
        let f = Fixture::new("exec");
        f.write(".ssh/config", "Host a\nInclude more\n");
        f.write(".ssh/more", "Match host a EXEC \"calc.exe\"\n  User x\n");
        assert!(f.parse().match_exec);
        let g = Fixture::new("noexec");
        g.write(".ssh/config", "Match host a user b\nHost exec\n");
        let p = g.parse();
        assert!(!p.match_exec);
        assert_eq!(names(&p), vec!["exec"]);
    }

    #[test]
    fn missing_config_is_empty() {
        let f = Fixture::new("missing");
        assert!(f.parse().hosts.is_empty());
    }

    #[test]
    fn ssh_g_output_and_grouping() {
        let r = parse_ssh_g("user root\nhostname 203.0.113.7\nport 22\nproxycommand none\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n");
        assert_eq!(r.hostname.as_deref(), Some("203.0.113.7"));
        assert_eq!(r.port, Some(22));
        assert!(!r.proxy);
        assert_eq!(r.known_hosts, vec!["~/.ssh/known_hosts", "~/.ssh/known_hosts2"]);
        assert!(parse_ssh_g("proxyjump bastion\n").proxy);

        let other = Resolved { hostname: Some("198.51.100.1".into()), user: Some("root".into()), port: Some(22), ..Default::default() };
        let g = group_hosts(vec![("vps".into(), r.clone()), ("other".into(), other), ("vps-ip".into(), r)]);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].alias, "vps");
        assert_eq!(g[0].also, vec!["vps-ip"]);
    }

    #[test]
    fn scan_script_survives_any_login_shell() {
        assert!(!SCAN_SCRIPT.contains('\''));
        assert!(!SCAN_SCRIPT.contains('!'));
        assert!(!SCAN_SCRIPT.contains('\n'));
        let args = scan_args("vps", false);
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash + 1], "vps");
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ClearAllForwardings=yes".to_string()));
        assert!(args.contains(&"PermitLocalCommand=no".to_string()));
        assert!(!args.iter().any(|a| a.contains("StrictHostKeyChecking")));
        let trusted = scan_args("vps", true);
        assert!(trusted.contains(&"StrictHostKeyChecking=accept-new".to_string()));
        assert!(!trusted.iter().any(|a| a.eq_ignore_ascii_case("StrictHostKeyChecking=no")));
    }

    /// `sh -n` parses without running anything. Skipped where no sh is on PATH.
    #[test]
    fn scan_script_is_valid_sh() {
        let Ok(out) = Command::new("sh").arg("-n").arg("-c").arg(SCAN_SCRIPT).output() else { return };
        assert!(out.status.success(), "sh -n: {}", String::from_utf8_lossy(&out.stderr));
    }

    const MINE: &str = env!("CARGO_PKG_VERSION");

    #[test]
    fn classifies_a_running_hub() {
        let out = format!(
            "pr_scan=1\nuid=0\nactive=active\nunit_pocketrocket=1\ndir=/home/pocketrocket/pocketrocket\n\
             health={{\"ok\":true,\"version\":\"{MINE}\",\"provider\":\"claude\"}}\n\
             claude={{\"loggedIn\":true,\"email\":\"a@b.com\",\"subscriptionType\":\"max\"}}\n"
        );
        let r = classify("vps", Some(0), false, out.as_bytes(), "");
        assert_eq!(r.kind, "running");
        assert_eq!(r.version.as_deref(), Some(MINE));
        assert_eq!(r.version_matches, Some(true));
        assert_eq!(r.root, Some(true));
        assert_eq!(r.claude, Some(ClaudeAccount { logged_in: Some(true), email: Some("a@b.com".into()), plan: Some("max".into()) }));

        let old = classify("vps", Some(0), false, b"pr_scan=1\nhealth={\"ok\":false,\"version\":\"0.0.1\"}\nclaude=\n", "");
        assert_eq!(old.kind, "running");
        assert_eq!(old.version_matches, Some(false));
        assert_eq!(old.claude, None);
    }

    #[test]
    fn classifies_installed_legacy_and_empty_servers() {
        let stopped = classify("vps", Some(0), false, b"pr_scan=1\nuid=1000\nactive=failed\nunit_pocketrocket=1\nhealth=\nclaude=\n", "");
        assert_eq!(stopped.kind, "stopped");
        assert!(stopped.detail.contains("failed"));
        assert_eq!(stopped.root, Some(false));
        let dir_only = classify("vps", Some(0), false, b"pr_scan=1\ndir=/root/pocketrocket\n", "");
        assert_eq!(dir_only.kind, "stopped");
        let legacy = classify("vps", Some(0), false, b"pr_scan=1\nactive=inactive\nunit_claudebot=1\ndir=/root/claudebot\n", "");
        assert_eq!(legacy.kind, "legacy");
        let none = classify("vps", Some(0), false, b"pr_scan=1\nuid=1000\nactive=inactive\nhealth=\nclaude=\n", "");
        assert_eq!(none.kind, "none");
    }

    #[test]
    fn classifies_ssh_failures() {
        let unknown = classify("vps", Some(255), false, b"", "No ED25519 host key is known for 203.0.113.7 and you have requested strict checking.\r\nHost key verification failed.\r\n");
        assert_eq!(unknown.kind, "hostKeyUnknown");
        let changed = classify("vps", Some(255), false, b"", "@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\nHost key verification failed.\r\n");
        assert_eq!(changed.kind, "hostKeyChanged");
        let key = classify("vps", Some(255), false, b"", "root@203.0.113.7: Permission denied (publickey).\r\n");
        assert_eq!(key.kind, "needsKey");
        let gone = classify("vps", Some(255), false, b"", "ssh: connect to host 203.0.113.7 port 22: Connection timed out\r\n");
        assert_eq!(gone.kind, "unreachable");
        let slow = classify("vps", None, true, b"", "");
        assert_eq!(slow.kind, "unreachable");
        let windows_server = classify("vps", Some(1), false, b"", "'sh' is not recognized as an internal or external command\r\n");
        assert_eq!(windows_server.kind, "none");
    }

    #[test]
    fn server_output_is_untrusted() {
        let hostile = "junk\nPR_SCAN=1\npr_scan=1\nuid=0; rm -rf /\ndir=/etc\nactive=<script>\n\
                       health={\"ok\":true,\"version\":\"<img src=x onerror=alert(1)>\"}\nextra=1\n";
        let f = parse_facts(hostile.as_bytes());
        assert!(f.ran);
        assert_eq!(f.uid, None);
        assert_eq!(f.dir, None);
        assert_eq!(f.active, None);
        assert_eq!(health_version(f.health.as_deref().unwrap()), Some(String::new()));
        // anything past 4 KB is ignored, including a marker
        let mut long = "x".repeat(5000);
        long.push_str("\npr_scan=1\n");
        assert!(!parse_facts(long.as_bytes()).ran);
        assert_eq!(parse_auth_status("{\"loggedIn\":true,\"subscriptionType\":\"max; evil\"}").unwrap().plan, None);
        assert_eq!(health_version("not json"), None);
        assert_eq!(health_version("{\"hello\":1}"), None);
    }

    #[test]
    fn wildcards() {
        assert!(wildcard("*.conf", "a.conf"));
        assert!(!wildcard("*.conf", ".a.conf"));
        assert!(wildcard("?", "x"));
        assert!(!wildcard("?", "xy"));
        assert!(wildcard("a*b*c", "aXXbYc"));
        assert!(!wildcard("a*b", "aXXc"));
    }
}
