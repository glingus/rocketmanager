//! Configuration of the engine.

use crate::failpoints::Failpoints;
use crate::hooks::{DefaultInspector, EditorDetector, FileInspector, NullEditorDetector};
use rs_git::RetryPolicy;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Identity written in the commits: display name and GitHub noreply address (never the real email).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Display name of the user.
    pub name: String,
    /// `<id>+<login>@users.noreply.github.com`.
    pub email: String,
}

/// All time constants of the engine. [`Timing::default`] has the values of the spec; tests use
/// [`Timing::fast`].
#[derive(Debug, Clone)]
pub struct Timing {
    /// No events on a file for this long before it is considered stable (spec: 2 s).
    pub debounce: Duration,
    /// Distance between the two metadata reads of the stability check (spec: 500 ms).
    pub stability_gap: Duration,
    /// How long `publish` waits for files to become stable before failing with `fileNotStable`.
    pub stability_wait: Duration,
    /// Invalid files are re-validated at this interval...
    pub revalidate_interval: Duration,
    /// ...and marked unreadable after this long (spec: 30 s).
    pub invalid_giveup: Duration,
    /// Periodic fetch (spec: 60 s).
    pub fetch_interval: Duration,
    /// Granularity of the background loop.
    pub tick: Duration,
    /// Wait after a failed automatic publication before trying again.
    pub auto_publish_retry: Duration,
    /// A leftover `index.lock` older than this is removed at startup (spec: 60 s).
    pub stale_lock_age: Duration,
    /// Safety copies are kept this long (spec: 30 days) ...
    pub snapshot_retention: Duration,
    /// ... and at most this many per project (spec: 50).
    pub snapshot_max: usize,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_secs(2),
            stability_gap: Duration::from_millis(500),
            stability_wait: Duration::from_secs(10),
            revalidate_interval: Duration::from_secs(2),
            invalid_giveup: Duration::from_secs(30),
            fetch_interval: Duration::from_secs(60),
            tick: Duration::from_millis(500),
            auto_publish_retry: Duration::from_secs(60),
            stale_lock_age: Duration::from_secs(60),
            snapshot_retention: Duration::from_secs(30 * 24 * 3600),
            snapshot_max: 50,
        }
    }
}

impl Timing {
    /// Very short intervals for tests.
    pub fn fast() -> Self {
        Self {
            debounce: Duration::from_millis(60),
            stability_gap: Duration::from_millis(20),
            stability_wait: Duration::from_secs(3),
            revalidate_interval: Duration::from_millis(40),
            invalid_giveup: Duration::from_millis(400),
            fetch_interval: Duration::from_secs(3600),
            tick: Duration::from_millis(40),
            auto_publish_retry: Duration::from_millis(200),
            stale_lock_age: Duration::from_secs(60),
            snapshot_retention: Duration::from_secs(30 * 24 * 3600),
            snapshot_max: 50,
        }
    }
}

/// How to run git.
#[derive(Debug, Clone)]
pub struct GitSettings {
    /// Path of the git binary (MinGit in production).
    pub git_path: PathBuf,
    /// Askpass program (hook point for the credential manager).
    pub askpass: Option<PathBuf>,
    /// Extra environment variables for git (e.g. for the askpass program).
    pub extra_env: Vec<(String, String)>,
    /// Retry policy for transient errors.
    pub retry: RetryPolicy,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            git_path: PathBuf::from("git"),
            askpass: None,
            extra_env: Vec::new(),
            retry: RetryPolicy::default(),
        }
    }
}

/// Configuration of [`crate::Engine`].
#[derive(Clone)]
pub struct EngineConfig {
    /// App data directory: holds `rocketsync.db` and the git config file.
    pub data_dir: PathBuf,
    pub git: GitSettings,
    /// Validation/changelog per file type.
    pub inspector: Arc<dyn FileInspector>,
    /// Detection of the files open in OpenRocket.
    pub detector: Arc<dyn EditorDetector>,
    /// App version, written in the `Rocket-Sync-Client` trailer.
    pub client_version: String,
    pub timing: Timing,
    /// Run the background loop (periodic fetch, automatic publication, state refresh).
    pub background: bool,
    /// Watch the project folders with the OS file watcher.
    pub watch: bool,
    /// Fault-injection points (tests).
    pub failpoints: Failpoints,
}

impl EngineConfig {
    /// Configuration with default hooks (`DefaultInspector`, `NullEditorDetector`).
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            git: GitSettings::default(),
            inspector: Arc::new(DefaultInspector),
            detector: Arc::new(NullEditorDetector),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            timing: Timing::default(),
            background: true,
            watch: true,
            failpoints: Failpoints::new(),
        }
    }
}
