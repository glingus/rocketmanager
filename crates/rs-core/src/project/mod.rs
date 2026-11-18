//! Synchronisation logic of one project. Everything here is blocking and runs on the project's
//! worker (`Engine` serialises the calls: never two operations at once on the same repository).

mod conflict;
mod history;
mod integrate;
mod link;
mod materialize;
mod publish;
mod recovery;
mod restore;
mod snapshot;
mod status;
mod tick;

pub(crate) use link::{check_folder, link_folder};

use crate::config::{EngineConfig, Identity};
use crate::error::{AppError, CoreError, Result};
use crate::events::EngineEvent;
use crate::tracker::FileTracker;
use crate::types::ProjectStatus;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use rs_git::{Cmd, Git, Repo};
use rs_store::{now_ms, Store};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio::sync::{broadcast, Notify};

pub(crate) const MAIN_REF: &str = "refs/heads/main";
pub(crate) const ORIGIN_REF: &str = "refs/remotes/origin/main";
pub(crate) const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub(crate) const WARN_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// State shared by all projects of an engine.
pub(crate) struct Shared {
    pub config: EngineConfig,
    pub store: Store,
    pub git: Git,
    pub identity: RwLock<Option<Identity>>,
    pub events: broadcast::Sender<EngineEvent>,
}

impl Shared {
    pub(crate) fn emit(&self, e: EngineEvent) {
        // No subscriber is not an error.
        let _ = self.events.send(e);
    }

    pub(crate) fn identity(&self) -> Result<Identity> {
        self.identity
            .read()
            .map_err(|_| CoreError::Internal("identità non disponibile".into()))?
            .clone()
            .ok_or(CoreError::AuthRequired)
    }
}

/// Kind of long operation in progress (drives `publishing` / `updating`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Busy {
    Publishing,
    Updating,
}

pub(crate) struct Runtime {
    pub busy: Option<Busy>,
    pub offline: bool,
    pub last_fetch_at: Option<i64>,
    pub last_publish_at: Option<i64>,
    pub last_error: Option<AppError>,
    pub last_status: Option<ProjectStatus>,
    pub next_fetch: Instant,
    pub auto_publish_backoff: Option<Instant>,
    pub remote_notified: bool,
    pub repo_size: Option<(Instant, u64)>,
    pub retrying: bool,
    /// File states already written to the store: (stable, valid, size, mtime_ms).
    pub persisted_states: HashMap<String, (bool, Option<bool>, i64, i64)>,
    /// `content_equal` verdicts against HEAD: path -> (metadata, head blob, equal).
    pub equal_cache: HashMap<String, (crate::tracker::Meta, String, bool)>,
}

/// Journal context of the running top-level operation.
pub(crate) struct OpCtx {
    pub id: String,
}

pub(crate) struct ProjectInner {
    pub shared: Arc<Shared>,
    pub id: String,
    pub folder: PathBuf,
    #[allow(dead_code)] // kept for diagnostics
    pub remote_url: String,
    #[allow(dead_code)]
    pub repo_full_name: String,
    pub repo: Repo,
    pub rt: Mutex<Runtime>,
    pub tracker: Mutex<FileTracker>,
    pub ignore: Mutex<Gitignore>,
    pub dirty: AtomicBool,
    pub wake: Arc<Notify>,
    pub version_cache: Mutex<HashMap<String, Option<i64>>>,
}

pub(crate) fn build_ignore(folder: &std::path::Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(folder);
    let gi = folder.join(".gitignore");
    if gi.is_file() {
        let _ = b.add(gi);
    }
    for p in [
        ".rocketsync/local/",
        "*.tmp",
        "ORSave*.tmp",
        "*.ork-bak",
        "~$*",
        "*.swp",
        "*.bak",
        "Thumbs.db",
        "desktop.ini",
        ".DS_Store",
    ] {
        let _ = b.add_line(None, p);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

impl ProjectInner {
    pub(crate) fn new(
        shared: Arc<Shared>,
        id: String,
        folder: PathBuf,
        remote_url: String,
        repo_full_name: String,
        repo: Repo,
        wake: Arc<Notify>,
    ) -> Self {
        let last_publish = shared
            .store
            .get_setting(&id, "lastPublishAt")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok());
        let last_fetch = shared
            .store
            .get_setting(&id, "lastFetchAt")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok());
        let tracker = FileTracker::new(shared.config.timing.clone());
        let ignore = build_ignore(&folder);
        Self {
            id,
            folder,
            remote_url,
            repo_full_name,
            repo,
            rt: Mutex::new(Runtime {
                busy: None,
                offline: false,
                last_fetch_at: last_fetch,
                last_publish_at: last_publish,
                last_error: None,
                last_status: None,
                next_fetch: Instant::now(),
                auto_publish_backoff: None,
                remote_notified: false,
                repo_size: None,
                retrying: false,
                persisted_states: HashMap::new(),
                equal_cache: HashMap::new(),
            }),
            tracker: Mutex::new(tracker),
            ignore: Mutex::new(ignore),
            dirty: AtomicBool::new(true),
            wake,
            version_cache: Mutex::new(HashMap::new()),
            shared,
        }
    }

    // ---- small shared helpers ------------------------------------------------------------

    pub(crate) fn emit(&self, e: EngineEvent) {
        self.shared.emit(e);
    }

    pub(crate) fn rt<R>(&self, f: impl FnOnce(&mut Runtime) -> R) -> R {
        let mut g = self.rt.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g)
    }

    pub(crate) fn mark_dirty(&self) {
        self.dirty.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn failpoint(&self, name: &str) -> Result<()> {
        self.shared.config.failpoints.hit(name)
    }

    /// Tip of the local `main`.
    pub(crate) fn head(&self) -> Result<String> {
        self.repo
            .resolve(MAIN_REF)?
            .ok_or_else(|| CoreError::NotLinked("il branch main locale non esiste".into()))
    }

    /// Tip of `origin/main` as of the last fetch.
    pub(crate) fn origin(&self) -> Result<Option<String>> {
        Ok(self.repo.resolve(ORIGIN_REF)?)
    }

    /// Published version number at (or below, following first parents) `commit`.
    pub(crate) fn version_of(&self, commit: &str) -> Result<Option<i64>> {
        if let Some(v) = self
            .version_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(commit)
        {
            return Ok(*v);
        }
        let o = self.repo.run(Cmd::new([
            "log",
            "--first-parent",
            "-z",
            "-n",
            "2000",
            "--format=%H%x1f%(trailers:key=Rocket-Sync-Version,valueonly,separator=%x2c)",
            commit,
            "--",
        ]))?;
        let mut found = None;
        for rec in o.stdout.split(|b| *b == 0) {
            let s = String::from_utf8_lossy(rec);
            let s = s.trim_start_matches('\n');
            if let Some((_, val)) = s.split_once('\x1f') {
                if let Some(n) = val
                    .split(',')
                    .filter_map(|x| x.trim().parse::<i64>().ok())
                    .next()
                {
                    found = Some(n);
                    break;
                }
            }
        }
        self.version_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(commit.to_string(), found);
        Ok(found)
    }

    pub(crate) fn has_open_conflict(&self) -> Result<bool> {
        Ok(self
            .shared
            .store
            .list_conflicts(&self.id, false)?
            .iter()
            .any(|c| c.status == rs_store::ConflictStatus::Open))
    }

    pub(crate) fn open_conflict_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .shared
            .store
            .list_conflicts(&self.id, false)?
            .iter()
            .filter(|c| c.status == rs_store::ConflictStatus::Open)
            .map(|c| c.id.clone())
            .collect())
    }

    // ---- journalled operations -----------------------------------------------------------

    /// Runs `f` as a journalled, serialised operation: sets the busy state, records the journal,
    /// translates failures into the project's error state, refreshes and emits the status.
    pub(crate) fn run_op<T>(
        &self,
        kind: &'static str,
        busy: Busy,
        payload: Value,
        f: impl FnOnce(&OpCtx) -> Result<T>,
    ) -> Result<T> {
        let op = OpCtx {
            id: format!("op-{}-{}", now_ms(), crate::util::random_id(6)),
        };
        self.rt(|r| r.busy = Some(busy));
        if let Err(e) = self
            .shared
            .store
            .journal_begin(&op.id, &self.id, kind, "start", &payload)
        {
            self.rt(|r| r.busy = None);
            return Err(e.into());
        }
        self.emit_status_quiet();
        let result = f(&op);
        self.rt(|r| r.busy = None);
        match &result {
            Ok(_) => {
                let _ = self.shared.store.journal_finish(&op.id, "ok", None);
                self.clear_error();
            }
            Err(CoreError::InjectedCrash(_)) => {
                // Simulated crash: leave the journal exactly as it is.
            }
            Err(e) => {
                let _ = self
                    .shared
                    .store
                    .journal_finish(&op.id, "failed", Some(&e.to_string()));
                self.note_error(e);
            }
        }
        self.mark_dirty();
        let _ = self.refresh_status();
        result
    }

    pub(crate) fn step(&self, op: &OpCtx, step: &str, payload: Option<&Value>) -> Result<()> {
        self.shared.store.journal_step(&op.id, step, payload)?;
        Ok(())
    }

    pub(crate) fn progress(&self, op: &str, step: &str, percent: Option<f32>, message: &str) {
        self.emit(EngineEvent::OperationProgress {
            project_id: self.id.clone(),
            op: op.to_string(),
            step: step.to_string(),
            percent,
            message: message.to_string(),
        });
    }

    pub(crate) fn clear_error(&self) {
        self.rt(|r| r.last_error = None);
    }

    /// Records a failure as the project's error state when it is not a transient/user-level one.
    pub(crate) fn note_error(&self, e: &CoreError) {
        let user_level = matches!(
            e,
            CoreError::FileNotStable(_)
                | CoreError::FileInvalid { .. }
                | CoreError::FileTooLarge { .. }
                | CoreError::BlockedByEditor(_)
                | CoreError::ConflictOpen
                | CoreError::LocalChangesPresent(_)
                | CoreError::NotFound(_)
                | CoreError::InvalidPath(_)
                | CoreError::NothingToPublish
                | CoreError::InvalidArgument(_)
                | CoreError::StaleSavePending(_)
                | CoreError::AuthRequired
                | CoreError::InjectedCrash(_)
        ) || e.is_network()
            || matches!(e, CoreError::Git(g) if matches!(g.kind(), rs_git::GitErrorKind::NonFastForward | rs_git::GitErrorKind::LockHeld | rs_git::GitErrorKind::Cancelled));
        if e.is_network() {
            self.rt(|r| r.offline = true);
        }
        if user_level {
            return;
        }
        let app = e.to_app_error();
        self.rt(|r| r.last_error = Some(app.clone()));
        self.emit(EngineEvent::SyncError {
            project_id: self.id.clone(),
            error: app,
        });
    }
}
