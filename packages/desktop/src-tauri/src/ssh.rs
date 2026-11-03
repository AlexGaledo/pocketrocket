//! Which ssh to run, which host strings we are willing to pass it, and what its errors mean in words.

use std::path::PathBuf;

/// Windows' own OpenSSH when it is installed (it is the one the "OpenSSH Authentication Agent" service and
/// our ssh-add advice belong to), otherwise whatever `ssh` is on PATH.
pub fn ssh_exe() -> PathBuf {
    tool("ssh")
}

/// `ssh`, `ssh-keyscan` or `ssh-keygen`, from the same place as [`ssh_exe`].
pub fn tool(name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root).join("System32").join("OpenSSH").join(format!("{name}.exe"));
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from(name)
}

/// A host we hand to ssh. It always goes after `--`, but a leading `-` is refused anyway so the value can
/// never be read as an option by anything, and whitespace would only ever be a mistake.
pub fn validate_host(host: &str) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("Enter the SSH host: a Host alias from ~/.ssh/config, or user@server.".into());
    }
    if host.starts_with('-') {
        return Err("An SSH host can't start with \"-\".".into());
    }
    if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An SSH host can't contain spaces.".into());
    }
    if host.len() > 255 {
        return Err("That SSH host is too long.".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshFailure {
    /// known_hosts has a different key for this server. Never overridden by this app.
    HostKeyChanged,
    /// No key on file for this server and BatchMode refuses to ask.
    HostKeyUnknown,
    /// "Permission denied (publickey…)": no usable key / agent.
    AuthFailed,
    Resolve,
    Timeout,
    Refused,
    /// -L could not bind the local port.
    ForwardFailed,
    Other,
}

pub fn classify_failure(stderr: &str) -> SshFailure {
    let s = stderr.to_ascii_lowercase();
    if s.contains("remote host identification has changed") || (s.contains("host key for") && s.contains("has changed")) {
        SshFailure::HostKeyChanged
    } else if s.contains("host key verification failed") {
        SshFailure::HostKeyUnknown
    } else if s.contains("permission denied") || s.contains("too many authentication failures") {
        SshFailure::AuthFailed
    } else if s.contains("could not resolve hostname") || s.contains("no such host is known") || s.contains("name or service not known") {
        SshFailure::Resolve
    } else if s.contains("timed out") {
        SshFailure::Timeout
    } else if s.contains("connection refused") {
        SshFailure::Refused
    } else if s.contains("cannot listen to port") || s.contains("could not request local forwarding") || s.contains("address already in use") {
        SshFailure::ForwardFailed
    } else {
        SshFailure::Other
    }
}

/// Last few meaningful lines of ssh's stderr, for the cases we have no better words for.
pub fn last_lines(stderr: &str, n: usize) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// A sentence a person can act on, for an ssh that failed with `stderr`.
pub fn explain(stderr: &str, host: &str, port: u16) -> String {
    match classify_failure(stderr) {
        SshFailure::HostKeyChanged => format!(
            "The host key of {host} has CHANGED since this PC last connected. That can mean someone is intercepting the \
             connection, so PocketRocket will not connect. If you rebuilt the server yourself, confirm the new fingerprint \
             with your hosting provider, then run `ssh {host}` in a terminal: it names the old known_hosts entry to remove."
        ),
        SshFailure::HostKeyUnknown => format!(
            "This PC doesn't trust {host}'s host key yet. Run `ssh {host}` once in a terminal, check the fingerprint and \
             answer yes, then retry."
        ),
        SshFailure::AuthFailed => format!(
            "{host} refused your SSH key (Permission denied). PocketRocket only uses key logins, never passwords: start the \
             \"OpenSSH Authentication Agent\" service (Services, startup type Automatic), run `ssh-add` in a terminal, then retry."
        ),
        SshFailure::Resolve => format!("Can't find the server \"{host}\". Check the name, or its Host entry in ~/.ssh/config."),
        SshFailure::Timeout => format!("Connecting to {host} timed out. Is the server up, and is its SSH port reachable from this network?"),
        SshFailure::Refused => format!("{host} refused the SSH connection. Check the SSH port and that sshd is running on the server."),
        SshFailure::ForwardFailed => format!(
            "SSH connected but couldn't open the tunnel on port {port}: something on this PC is already using it. Close it or pick another port."
        ),
        SshFailure::Other => {
            let tail = last_lines(stderr, 3);
            if tail.is_empty() {
                format!("ssh to {host} stopped without saying why. Try `ssh {host}` in a terminal.")
            } else {
                format!("ssh to {host} failed: {tail}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_that_could_be_options_or_typos_are_refused() {
        assert!(validate_host("my-server").is_ok());
        assert!(validate_host("root@203.0.113.7").is_ok());
        assert!(validate_host("").is_err());
        assert!(validate_host("   ").is_err());
        assert!(validate_host("-oProxyCommand=calc").is_err());
        assert!(validate_host("my server").is_err());
    }

    #[test]
    fn ssh_errors_are_classified() {
        let changed = "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n\
            @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n\
            Host key for 203.0.113.7 has changed and you have requested strict checking.\r\nHost key verification failed.\r\n";
        assert_eq!(classify_failure(changed), SshFailure::HostKeyChanged);
        let unknown = "No ED25519 host key is known for 203.0.113.7 and you have requested strict checking.\r\nHost key verification failed.\r\n";
        assert_eq!(classify_failure(unknown), SshFailure::HostKeyUnknown);
        assert_eq!(classify_failure("root@203.0.113.7: Permission denied (publickey).\r\n"), SshFailure::AuthFailed);
        assert_eq!(classify_failure("ssh: Could not resolve hostname nope: No such host is known. \r\n"), SshFailure::Resolve);
        assert_eq!(classify_failure("ssh: connect to host 203.0.113.7 port 22: Connection timed out\r\n"), SshFailure::Timeout);
        assert_eq!(classify_failure("ssh: connect to host 203.0.113.7 port 22: Connection refused\r\n"), SshFailure::Refused);
        assert_eq!(classify_failure("bind [127.0.0.1]:7788: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 7788\r\nCould not request local forwarding.\r\n"), SshFailure::ForwardFailed);
        assert_eq!(classify_failure("kex_exchange_identification: read: Connection reset\r\n"), SshFailure::Other);
    }

    #[test]
    fn explanations_name_the_fix() {
        assert!(explain("Host key verification failed.", "vps", 7788).contains("ssh vps"));
        assert!(explain("Permission denied (publickey).", "vps", 7788).contains("ssh-add"));
        assert!(explain("weird\nthing happened\n", "vps", 7788).contains("thing happened"));
    }
}
