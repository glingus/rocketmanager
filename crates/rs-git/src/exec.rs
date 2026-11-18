//! Process execution: isolated environment, timeouts, cancellation, retries and command log.

use crate::error::{classify, GitError};
use crate::redact::redact;
use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// Retry policy for transient failures (index lock, locked files, network).
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Total number of attempts (the spec asks for 3).
    pub attempts: u32,
    /// Wait before the second attempt; doubled for every further attempt.
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            base_delay: Duration::from_millis(500),
        }
    }
}

/// Static configuration of the wrapper.
#[derive(Debug, Clone)]
pub struct GitConfig {
    /// Path of the git binary (MinGit in production, the system git in tests).
    pub git_path: PathBuf,
    /// App-owned global config file (`GIT_CONFIG_GLOBAL`). `None` means "empty config".
    pub global_config: Option<PathBuf>,
    /// Askpass program (hook point for the credential manager). Never receives secrets from us.
    pub askpass: Option<PathBuf>,
    /// Extra environment variables (e.g. variables the askpass program needs).
    pub extra_env: Vec<(String, String)>,
    /// Empty directory used as `core.hooksPath`. Created if missing; defaults to a temp dir.
    pub hooks_dir: Option<PathBuf>,
    /// Timeout of ordinary commands (default 120 s).
    pub default_timeout: Duration,
    /// Timeout of fetch/push/clone (default 600 s).
    pub network_timeout: Duration,
    /// Retry policy for transient errors.
    pub retry: RetryPolicy,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            git_path: PathBuf::from("git"),
            global_config: None,
            askpass: None,
            extra_env: Vec::new(),
            hooks_dir: None,
            default_timeout: Duration::from_secs(120),
            network_timeout: Duration::from_secs(600),
            retry: RetryPolicy::default(),
        }
    }
}

/// Cooperative cancellation flag shared by all commands started from a [`Git`] handle.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    /// Requests cancellation: running commands are killed, new ones fail immediately.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One executed command, recorded for diagnostics and for tests (e.g. "no --force").
#[derive(Debug, Clone)]
pub struct CommandRecord {
    pub seq: u64,
    pub started_at: SystemTime,
    pub cwd: Option<PathBuf>,
    /// Arguments after the fixed `-c` options, with credentials redacted.
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration: Duration,
    /// Redacted error text when the command failed to start, timed out or exited non-zero.
    pub error: Option<String>,
}

impl CommandRecord {
    /// Space-joined command line (redacted).
    pub fn command_line(&self) -> String {
        format!("git {}", self.args.join(" "))
    }
}

const LOG_CAPACITY: usize = 50_000;

/// Shared, bounded, thread-safe log of executed commands.
#[derive(Debug, Clone, Default)]
pub struct CommandLog {
    inner: Arc<Mutex<LogInner>>,
}

#[derive(Debug, Default)]
struct LogInner {
    next_seq: u64,
    entries: VecDeque<CommandRecord>,
}

impl CommandLog {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(&self, mut rec: CommandRecord) {
        if let Ok(mut g) = self.inner.lock() {
            rec.seq = g.next_seq;
            g.next_seq += 1;
            if g.entries.len() >= LOG_CAPACITY {
                g.entries.pop_front();
            }
            g.entries.push_back(rec);
        }
    }

    /// Snapshot of all recorded commands, oldest first.
    pub fn records(&self) -> Vec<CommandRecord> {
        self.inner
            .lock()
            .map(|g| g.entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Records whose arguments satisfy the predicate.
    pub fn find(&self, pred: impl Fn(&CommandRecord) -> bool) -> Vec<CommandRecord> {
        self.records().into_iter().filter(|r| pred(r)).collect()
    }
}

/// Description of one git invocation (builder style).
#[derive(Debug, Clone, Default)]
pub struct Cmd {
    pub(crate) args: Vec<OsString>,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) env: Vec<(OsString, OsString)>,
    pub(crate) timeout: Option<Duration>,
    pub(crate) network: bool,
    pub(crate) retry: bool,
    pub(crate) ok_codes: Vec<i32>,
}

impl Cmd {
    /// New command with the given arguments (without the leading `git`).
    pub fn new<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            args: args.into_iter().map(|a| a.as_ref().to_os_string()).collect(),
            retry: true,
            ..Default::default()
        }
    }
    /// Appends one argument.
    pub fn arg(mut self, a: impl AsRef<OsStr>) -> Self {
        self.args.push(a.as_ref().to_os_string());
        self
    }
    /// Appends several arguments.
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }
    /// Data written to the stdin of the process.
    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }
    /// Extra environment variable for this command only.
    pub fn env(mut self, k: impl AsRef<OsStr>, v: impl AsRef<OsStr>) -> Self {
        self.env
            .push((k.as_ref().to_os_string(), v.as_ref().to_os_string()));
        self
    }
    /// Overrides the timeout.
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }
    /// Marks the command as a network operation (longer timeout).
    pub fn network(mut self) -> Self {
        self.network = true;
        self
    }
    /// Disables automatic retries.
    pub fn no_retry(mut self) -> Self {
        self.retry = false;
        self
    }
    /// Exit codes other than 0 that are not errors (e.g. `merge-tree` returns 1 on conflicts).
    pub fn ok_codes(mut self, codes: &[i32]) -> Self {
        self.ok_codes = codes.to_vec();
        self
    }
}

/// Result of a successful command.
#[derive(Debug, Clone)]
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    /// Redacted stderr.
    pub stderr: String,
}

impl Output {
    /// Stdout as (lossy) UTF-8.
    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    /// Trimmed stdout as UTF-8.
    pub fn stdout_trimmed(&self) -> String {
        self.stdout_string().trim().to_string()
    }
}

/// Handle to the git binary with its isolated environment. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Git {
    pub(crate) cfg: Arc<GitConfig>,
    pub(crate) log: CommandLog,
    pub(crate) cancel: CancelToken,
    hooks_dir: Arc<PathBuf>,
}

impl Git {
    /// Creates a handle. Does not run git: call [`Git::ensure_min_version`] to validate the binary.
    pub fn new(cfg: GitConfig) -> Self {
        let hooks = cfg.hooks_dir.clone().unwrap_or_else(|| {
            cfg.global_config
                .as_ref()
                .and_then(|p| p.parent().map(|d| d.join("empty-hooks")))
                .unwrap_or_else(|| std::env::temp_dir().join("rocketsync-empty-hooks"))
        });
        let _ = std::fs::create_dir_all(&hooks);
        Self {
            cfg: Arc::new(cfg),
            log: CommandLog::new(),
            cancel: CancelToken::new(),
            hooks_dir: Arc::new(hooks),
        }
    }

    /// The static configuration.
    pub fn config(&self) -> &GitConfig {
        &self.cfg
    }

    /// Log of every command executed through this handle and its clones.
    pub fn command_log(&self) -> &CommandLog {
        &self.log
    }

    /// A handle that shares configuration and log but has its own cancellation token.
    pub fn with_cancel_token(&self, cancel: CancelToken) -> Self {
        let mut g = self.clone();
        g.cancel = cancel;
        g
    }

    /// The cancellation token of this handle.
    pub fn cancel_token(&self) -> &CancelToken {
        &self.cancel
    }

    fn base_args(&self) -> Vec<OsString> {
        let mut v: Vec<OsString> = Vec::new();
        for opt in [
            "core.autocrlf=false",
            "core.longpaths=true",
            "core.quotepath=false",
            "credential.helper=",
            "advice.detachedHead=false",
            "gc.auto=0",
            "maintenance.auto=false",
            "core.fsmonitor=false",
            "core.untrackedCache=false",
        ] {
            v.push("-c".into());
            v.push(opt.into());
        }
        v.push("-c".into());
        let mut hp = OsString::from("core.hooksPath=");
        hp.push(self.hooks_dir.as_os_str());
        v.push(hp);
        v
    }

    fn configure_env(&self, c: &mut Command) {
        for k in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_COMMON_DIR",
            "GIT_NAMESPACE",
            "GIT_PREFIX",
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_AUTHOR_DATE",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
            "GIT_COMMITTER_DATE",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
            "GIT_EXTERNAL_DIFF",
            "GIT_SSH_COMMAND",
            "GIT_PAGER",
        ] {
            c.env_remove(k);
        }
        c.env("GIT_CONFIG_NOSYSTEM", "1");
        let null_dev = if cfg!(windows) { "NUL" } else { "/dev/null" };
        match &self.cfg.global_config {
            Some(p) => c.env("GIT_CONFIG_GLOBAL", p),
            None => c.env("GIT_CONFIG_GLOBAL", null_dev),
        };
        c.env("GIT_TERMINAL_PROMPT", "0");
        c.env("GCM_INTERACTIVE", "never");
        c.env("LC_ALL", "C");
        c.env("LANG", "C");
        c.env("GIT_OPTIONAL_LOCKS", "0");
        match &self.cfg.askpass {
            Some(p) => {
                c.env("GIT_ASKPASS", p);
                c.env("SSH_ASKPASS", p);
            }
            None => {
                // Never let git block waiting for a password.
                c.env_remove("GIT_ASKPASS");
                c.env_remove("SSH_ASKPASS");
            }
        }
        for (k, v) in &self.cfg.extra_env {
            c.env(k, v);
        }
    }

    /// Runs git in `cwd` (or the current directory), failing on non-zero exit.
    pub fn run(&self, cwd: Option<&Path>, cmd: Cmd) -> Result<Output, GitError> {
        let attempts = if cmd.retry {
            self.cfg.retry.attempts.max(1)
        } else {
            1
        };
        let mut delay = self.cfg.retry.base_delay;
        let mut last: Option<GitError> = None;
        for attempt in 1..=attempts {
            if self.cancel.is_cancelled() {
                return Err(GitError::Cancelled);
            }
            match self.run_once(cwd, &cmd) {
                Ok(o) => return Ok(o),
                Err(e) => {
                    if e.is_transient() && attempt < attempts {
                        tracing::debug!(attempt, error = %e, "transient git error, retrying");
                        self.sleep_cancellable(delay);
                        delay = delay.saturating_mul(2);
                        last = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last.unwrap_or(GitError::Cancelled))
    }

    fn sleep_cancellable(&self, d: Duration) {
        let end = Instant::now() + d;
        while Instant::now() < end {
            if self.cancel.is_cancelled() {
                return;
            }
            thread::sleep(Duration::from_millis(5).min(d));
        }
    }

    fn run_once(&self, cwd: Option<&Path>, cmd: &Cmd) -> Result<Output, GitError> {
        let started = Instant::now();
        let started_at = SystemTime::now();
        let logged_args: Vec<String> = cmd
            .args
            .iter()
            .map(|a| redact(&a.to_string_lossy()))
            .collect();
        let result = self.spawn_and_wait(cwd, cmd);
        let duration = started.elapsed();
        let (exit_code, error) = match &result {
            Ok(o) => (Some(o.code), None),
            Err((code, e)) => (*code, Some(e.to_string())),
        };
        self.log.push(CommandRecord {
            seq: 0,
            started_at,
            cwd: cwd.map(|p| p.to_path_buf()),
            args: logged_args,
            exit_code,
            duration,
            error,
        });
        result.map_err(|(_, e)| e)
    }

    #[allow(clippy::type_complexity)]
    fn spawn_and_wait(
        &self,
        cwd: Option<&Path>,
        cmd: &Cmd,
    ) -> Result<Output, (Option<i32>, GitError)> {
        let mut c = Command::new(&self.cfg.git_path);
        c.args(self.base_args());
        c.args(&cmd.args);
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        self.configure_env(&mut c);
        for (k, v) in &cmd.env {
            c.env(k, v);
        }
        c.stdin(if cmd.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        c.stdout(Stdio::piped());
        c.stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = c.spawn().map_err(|e| {
            (
                None,
                GitError::GitMissing(format!("{}: {e}", self.cfg.git_path.display())),
            )
        })?;

        let stdin_thread = child.stdin.take().map(|mut si| {
            let data = cmd.stdin.clone().unwrap_or_default();
            thread::spawn(move || {
                // A closed pipe (git exited early) is reported through the exit status.
                let _ = si.write_all(&data);
            })
        });
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();
        let out_t = thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_end(&mut buf);
            }
            buf
        });
        let err_t = thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(e) = err.as_mut() {
                let _ = e.read_to_end(&mut buf);
            }
            buf
        });

        let timeout = cmd.timeout.unwrap_or(if cmd.network {
            self.cfg.network_timeout
        } else {
            self.cfg.default_timeout
        });
        let deadline = Instant::now() + timeout;
        let mut poll = Duration::from_millis(1);
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Ok(None) => {}
                Err(e) => break Err(GitError::io(e)),
            }
            if self.cancel.is_cancelled() {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GitError::Cancelled);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GitError::Timeout {
                    command: redact(&cmd_summary(&cmd.args)),
                    seconds: timeout.as_secs(),
                });
            }
            thread::sleep(poll);
            poll = (poll * 2).min(Duration::from_millis(20));
        };
        if let Some(t) = stdin_thread {
            let _ = t.join();
        }
        let stdout = out_t.join().unwrap_or_default();
        let stderr_bytes = err_t.join().unwrap_or_default();
        let status = status.map_err(|e| (None, e))?;
        let code = status.code().unwrap_or(-1);
        let stderr_raw = String::from_utf8_lossy(&stderr_bytes).into_owned();
        if code == 0 || cmd.ok_codes.contains(&code) {
            Ok(Output {
                code,
                stdout,
                stderr: redact(&stderr_raw),
            })
        } else {
            Err((Some(code), classify(&stderr_raw, Some(code))))
        }
    }
}

fn cmd_summary(args: &[OsString]) -> String {
    args.iter()
        .take(4)
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}
