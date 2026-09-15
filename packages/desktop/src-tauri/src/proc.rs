//! Child-process plumbing shared by the hub, the SSH tunnel and the scans: no console windows, stderr
//! drained into a bounded ring buffer (an undrained pipe fills up and blocks the child), hard wall-clock
//! timeouts, and a kill-on-close Job Object so a crash of this app never orphans node.exe or ssh.exe.

use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// The last `CAP` bytes written to a pipe. Cheap to clone; every clone sees the same buffer.
#[derive(Clone, Default)]
pub struct Tail(Arc<Mutex<VecDeque<u8>>>);

impl Tail {
    pub const CAP: usize = 4096;

    pub fn push(&self, data: &[u8]) {
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        q.extend(data.iter().copied());
        let excess = q.len().saturating_sub(Self::CAP);
        q.drain(..excess);
    }

    pub fn text(&self) -> String {
        let q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let bytes: Vec<u8> = q.iter().copied().collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// Read `r` to EOF on its own thread, keeping only the tail. `done` flips when the pipe closes.
pub fn drain_tail(mut r: impl Read + Send + 'static, tail: Tail) -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.push(&buf[..n]);
        }
        flag.store(true, Ordering::Relaxed);
    });
    done
}

/// Read `r` to EOF on its own thread, keeping only the first `cap` bytes (the rest is read and dropped so
/// the writer never blocks on a full pipe).
fn drain_head(mut r: impl Read + Send + 'static, cap: usize) -> (Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
    let out = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));
    let (o, flag) = (out.clone(), done.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut v = o.lock().unwrap_or_else(|e| e.into_inner());
            let room = cap.saturating_sub(v.len());
            v.extend_from_slice(&buf[..n.min(room)]);
        }
        flag.store(true, Ordering::Relaxed);
    });
    (out, done)
}

/// Kill a child and everything it started, then reap it.
pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/pid", &child.id().to_string(), "/t", "/f"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut tk);
        let _ = tk.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub struct Captured {
    /// None when the process was killed for running too long or being cancelled.
    pub status: Option<ExitStatus>,
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Run `cmd` with no console window, stdin closed, stdout capped at `out_cap` bytes and stderr at the last
/// 4 KB, killing it (with its process tree) after `timeout` or as soon as `cancel()` returns true.
pub fn run_capture(mut cmd: Command, timeout: Duration, out_cap: usize, cancel: &dyn Fn() -> bool) -> std::io::Result<Captured> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn()?;
    job::assign(&child);
    let (out, out_done) = match child.stdout.take() {
        Some(s) => drain_head(s, out_cap),
        None => (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicBool::new(true))),
    };
    let tail = Tail::default();
    let err_done = match child.stderr.take() {
        Some(s) => drain_tail(s, tail.clone()),
        None => Arc::new(AtomicBool::new(true)),
    };
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if started.elapsed() >= timeout || cancel() {
            timed_out = started.elapsed() >= timeout;
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // A grandchild (ProxyCommand) can hold the pipes open after ssh is gone: wait briefly, never forever.
    let wait_until = Instant::now() + Duration::from_millis(500);
    while !(out_done.load(Ordering::Relaxed) && err_done.load(Ordering::Relaxed)) && Instant::now() < wait_until {
        std::thread::sleep(Duration::from_millis(10));
    }
    let stdout = out.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(Captured { status, timed_out, stdout, stderr: tail.text() })
}

/// One Job Object for every process this app starts. KILL_ON_JOB_CLOSE: when this process ends for any
/// reason, crash included, Windows closes the handle and takes node.exe (and its claude.exe turns) and
/// ssh.exe down with it, so nothing is left holding port 7788 or locking `node.exe` for the installer.
/// BREAKAWAY_OK lets a program that explicitly asks for CREATE_BREAKAWAY_FROM_JOB outlive us.
#[cfg(windows)]
pub mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<usize> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        let h = *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return 0;
            }
            // Deliberately never closed: the handle must live exactly as long as this process.
            h as usize
        });
        (h != 0).then_some(h as HANDLE)
    }

    pub fn assign(child: &Child) {
        if let Some(job) = handle() {
            unsafe {
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            }
        }
    }
}

#[cfg(not(windows))]
pub mod job {
    pub fn assign(_child: &std::process::Child) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_only_the_last_4k() {
        let t = Tail::default();
        t.push(&vec![b'a'; 3000]);
        t.push(&vec![b'b'; 3000]);
        let s = t.text();
        assert_eq!(s.len(), Tail::CAP);
        assert!(s.ends_with(&"b".repeat(3000)));
        assert!(s.starts_with(&"a".repeat(1096)));
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_kills_on_timeout_and_keeps_output() {
        let mut cmd = Command::new("cmd");
        // prints, then sits for ~20 s pinging loopback
        cmd.args(["/c", "echo started & ping -n 20 127.0.0.1 >nul"]);
        let t = Instant::now();
        let c = run_capture(cmd, Duration::from_millis(800), 64, &|| false).unwrap();
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(c.timed_out);
        assert!(c.status.is_none());
        assert!(String::from_utf8_lossy(&c.stdout).contains("started"));
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_honours_cancel() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 20 127.0.0.1 >nul"]);
        let t = Instant::now();
        let c = run_capture(cmd, Duration::from_secs(30), 64, &|| t.elapsed() > Duration::from_millis(300)).unwrap();
        assert!(!c.timed_out);
        assert!(c.status.is_none());
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
