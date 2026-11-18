//! The [`Engine`]: manages the linked projects and exposes the asynchronous command API.

use crate::config::{EngineConfig, Identity};
use crate::error::{CoreError, Result};
use crate::events::EngineEvent;
use crate::failpoints::Failpoints;
use crate::project::{self, ProjectInner, Shared};
use crate::types::*;
use crate::util::iso_from_ms;
use crate::watcher::{start_watcher, ProjectWatcher};
use rs_git::{CancelToken, CommandLog, Git, GitConfig};
use rs_store::{now_ms, ProjectRecord, PublishPolicy, Store};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

type Job = Box<dyn FnOnce(&ProjectInner) + Send + 'static>;

/// One linked project: its state, its work queue and its background tasks.
struct ProjectHandle {
    inner: Arc<ProjectInner>,
    tx: mpsc::UnboundedSender<Job>,
    cancel: CancelToken,
    ticker: Mutex<Option<JoinHandle<()>>>,
    watcher: Mutex<Option<ProjectWatcher>>,
}

impl Drop for ProjectHandle {
    fn drop(&mut self) {
        if let Ok(mut t) = self.ticker.lock() {
            if let Some(h) = t.take() {
                h.abort();
            }
        }
        self.cancel.cancel();
    }
}

impl ProjectHandle {
    /// Queues `f` on the project's worker and waits for its result. Operations of one project run
    /// strictly one at a time, in submission order.
    async fn run<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&ProjectInner) -> Result<T> + Send + 'static,
    {
        let (otx, orx) = oneshot::channel();
        let job: Job = Box::new(move |inner| {
            let _ = otx.send(f(inner));
        });
        self.tx
            .send(job)
            .map_err(|_| CoreError::Internal("il progetto non è più attivo".into()))?;
        orx.await
            .map_err(|_| CoreError::Internal("operazione interrotta in modo imprevisto".into()))?
    }
}

/// The synchronisation engine. Cheap to clone (shared state behind `Arc`).
///
/// See the crate documentation for the typical usage.
#[derive(Clone)]
pub struct Engine {
    shared: Arc<Shared>,
    projects: Arc<Mutex<HashMap<String, Arc<ProjectHandle>>>>,
    started: Arc<AtomicBool>,
    startup_reports: Arc<Mutex<Vec<RecoveryReport>>>,
}

fn status_or_error(inner: &ProjectInner) -> ProjectStatus {
    match inner.status_now() {
        Ok(s) => s,
        Err(e) => {
            let app = e.to_app_error();
            ProjectStatus {
                project_id: inner.id.clone(),
                state: SyncState::Error,
                folder: Some(inner.folder.to_string_lossy().into_owned()),
                head_version: None,
                remote_version: None,
                behind_by: 0,
                changed_files: vec![],
                pending_versions: vec![],
                blocked_by_editor: vec![],
                open_conflict_ids: vec![],
                stale_save_suspected: vec![],
                last_fetch_at: None,
                last_publish_at: None,
                auto_publish_at: None,
                repo_size_bytes: None,
                error: Some(app),
            }
        }
    }
}

impl Engine {
    /// Creates the engine: opens the database, validates git and loads the linked projects.
    /// Nothing runs yet: call [`Engine::start`] (or use [`Engine::open`]) after subscribing to the events.
    pub async fn new(config: EngineConfig) -> Result<Engine> {
        std::fs::create_dir_all(&config.data_dir)?;
        let gitconfig = config.data_dir.join("gitconfig");
        if !gitconfig.exists() {
            std::fs::write(
                &gitconfig,
                "# Configurazione di Git usata da Rocket Sync (non modificare)\n[safe]\n\tdirectory = *\n[core]\n\tautocrlf = false\n",
            )?;
        }
        let git = Git::new(GitConfig {
            git_path: config.git.git_path.clone(),
            global_config: Some(gitconfig),
            askpass: config.git.askpass.clone(),
            extra_env: config.git.extra_env.clone(),
            retry: config.git.retry.clone(),
            ..GitConfig::default()
        });
        git.ensure_min_version()?;
        let store = Store::open(&config.data_dir.join("rocketsync.db"))?;
        let (events, _) = broadcast::channel(512);
        let shared = Arc::new(Shared {
            config,
            store,
            git,
            identity: RwLock::new(None),
            events,
        });
        let engine = Engine {
            shared: shared.clone(),
            projects: Arc::new(Mutex::new(HashMap::new())),
            started: Arc::new(AtomicBool::new(false)),
            startup_reports: Arc::new(Mutex::new(Vec::new())),
        };
        for rec in shared.store.list_projects()? {
            let handle = engine.build_handle(&rec);
            engine.projects_lock().insert(rec.project_id.clone(), handle);
        }
        Ok(engine)
    }

    /// `new` followed by `start`. Events emitted by the recovery are not seen by subscribers that
    /// attach later: use [`Engine::startup_reports`] or the two-step form to receive them.
    pub async fn open(config: EngineConfig) -> Result<Engine> {
        let e = Engine::new(config).await?;
        e.start().await?;
        Ok(e)
    }

    /// Runs the startup recovery of every project (`§9`), then starts the file watchers and the
    /// background loops. Returns what the recovery did (also emitted as `RecoveryPerformed`).
    pub async fn start(&self) -> Result<Vec<RecoveryReport>> {
        let handles: Vec<Arc<ProjectHandle>> = self.projects_lock().values().cloned().collect();
        let mut all = Vec::new();
        for h in handles {
            let reports = match h.run(|i| i.recover()).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(project = %h.inner.id, error = %e, "recovery failed");
                    h.inner.note_error(&e);
                    Vec::new()
                }
            };
            all.extend(reports);
            self.activate(&h);
        }
        let _ = self.shared.store.journal_prune(now_ms() - 14 * 24 * 3600 * 1000);
        self.started.store(true, Ordering::SeqCst);
        if let Ok(mut g) = self.startup_reports.lock() {
            g.extend(all.iter().cloned());
        }
        Ok(all)
    }

    fn projects_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<ProjectHandle>>> {
        self.projects.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn build_handle(&self, rec: &ProjectRecord) -> Arc<ProjectHandle> {
        let cancel = CancelToken::new();
        let git = self.shared.git.with_cancel_token(cancel.clone());
        let folder = PathBuf::from(&rec.folder);
        let repo = git.repo(&folder);
        let wake = Arc::new(Notify::new());
        let inner = Arc::new(ProjectInner::new(
            self.shared.clone(),
            rec.project_id.clone(),
            folder,
            rec.remote_url.clone(),
            rec.repo_full_name.clone(),
            repo,
            wake,
        ));
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        let worker_inner = inner.clone();
        tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                let i = worker_inner.clone();
                // A panic inside a job must not kill the queue.
                let _ = tokio::task::spawn_blocking(move || job(&i)).await;
            }
        });
        Arc::new(ProjectHandle {
            inner,
            tx,
            cancel,
            ticker: Mutex::new(None),
            watcher: Mutex::new(None),
        })
    }

    /// Starts the watcher and the background loop of a project.
    fn activate(&self, h: &Arc<ProjectHandle>) {
        let cfg = &self.shared.config;
        if cfg.watch {
            match start_watcher(&h.inner) {
                Ok(w) => {
                    if let Ok(mut g) = h.watcher.lock() {
                        *g = Some(w);
                    }
                }
                Err(e) => tracing::warn!(project = %h.inner.id, error = %e, "file watcher not started"),
            }
        }
        let tx = h.tx.clone();
        let wake = h.inner.wake.clone();
        let tick = cfg.timing.tick;
        let queued = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(tick) => {}
                    _ = wake.notified() => { tokio::time::sleep(Duration::from_millis(15)).await; }
                }
                if tx.is_closed() {
                    break;
                }
                if !queued.swap(true, Ordering::SeqCst) {
                    let q = queued.clone();
                    let job: Job = Box::new(move |inner| {
                        inner.tick();
                        q.store(false, Ordering::SeqCst);
                    });
                    if tx.send(job).is_err() {
                        break;
                    }
                }
            }
        });
        if let Ok(mut g) = h.ticker.lock() {
            if let Some(old) = g.replace(task) {
                old.abort();
            }
        }
    }

    fn handle(&self, project_id: &str) -> Result<Arc<ProjectHandle>> {
        self.projects_lock()
            .get(project_id)
            .cloned()
            .ok_or_else(|| CoreError::NotLinked(project_id.to_string()))
    }

    // ---- session ------------------------------------------------------------------------

    /// Receiver of the engine events. Lagging receivers lose the oldest events.
    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.shared.events.subscribe()
    }

    /// Sets (or clears) the identity written in the commits (display name + GitHub noreply address).
    pub fn set_identity(&self, identity: Option<Identity>) {
        if let Ok(mut g) = self.shared.identity.write() {
            *g = identity;
        }
    }

    /// Every git command executed so far (arguments redacted).
    pub fn command_log(&self) -> &CommandLog {
        self.shared.git.command_log()
    }

    /// Fault-injection registry (tests).
    pub fn failpoints(&self) -> &Failpoints {
        &self.shared.config.failpoints
    }

    /// What the startup recovery did.
    pub fn startup_reports(&self) -> Vec<RecoveryReport> {
        self.startup_reports.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Stops the background loops and cancels running git commands.
    pub async fn shutdown(&self) {
        let handles: Vec<Arc<ProjectHandle>> = self.projects_lock().drain().map(|(_, h)| h).collect();
        for h in handles {
            if let Ok(mut t) = h.ticker.lock() {
                if let Some(t) = t.take() {
                    t.abort();
                }
            }
            if let Ok(mut w) = h.watcher.lock() {
                *w = None;
            }
            h.cancel.cancel();
        }
    }

    // ---- projects -----------------------------------------------------------------------

    /// Checks a candidate folder.
    pub fn check_folder(&self, path: &Path) -> FolderCheck {
        project::check_folder(path)
    }

    /// Linked projects.
    pub fn list_projects(&self) -> Result<Vec<LocalProject>> {
        Ok(self
            .shared
            .store
            .list_projects()?
            .into_iter()
            .map(|p| LocalProject {
                project_id: p.project_id,
                folder: p.folder,
                repo_full_name: p.repo_full_name,
                linked_at: iso_from_ms(p.linked_at),
            })
            .collect())
    }

    /// Clones (or adopts) the remote into the folder and starts managing it (`§7.1`).
    pub async fn link_project(&self, req: LinkRequest) -> Result<ProjectStatus> {
        if self.projects_lock().contains_key(&req.project_id) {
            return Err(CoreError::InvalidArgument("il progetto è già collegato".into()));
        }
        let shared = self.shared.clone();
        let req2 = req.clone();
        let linked = tokio::task::spawn_blocking(move || {
            let pid = req2.project_id.clone();
            let sh = shared.clone();
            let progress = move |step: &str, percent: Option<f32>, msg: &str| {
                sh.emit(EngineEvent::OperationProgress {
                    project_id: pid.clone(),
                    op: "link".into(),
                    step: step.to_string(),
                    percent,
                    message: msg.to_string(),
                });
            };
            project::link_folder(&shared.git, &req2, &progress)
        })
        .await
        .map_err(|_| CoreError::Internal("collegamento interrotto in modo imprevisto".into()))??;

        let rec = ProjectRecord {
            project_id: req.project_id.clone(),
            repo_full_name: req.repo_full_name.clone(),
            remote_url: linked.remote_url,
            folder: req.folder.clone(),
            linked_at: now_ms(),
        };
        self.shared.store.upsert_project(&rec)?;
        let handle = self.build_handle(&rec);
        self.projects_lock().insert(rec.project_id.clone(), handle.clone());
        self.activate(&handle);
        handle.run(|i| Ok(status_or_error(i))).await
    }

    /// Stops managing a project. The folder and the repository stay on disk.
    pub async fn unlink_project(&self, project_id: &str) -> Result<()> {
        let removed = self.projects_lock().remove(project_id);
        if removed.is_none() {
            return Err(CoreError::NotLinked(project_id.to_string()));
        }
        drop(removed);
        self.shared.store.delete_project(project_id)?;
        Ok(())
    }

    /// Current status. While an operation is running the last known status is returned.
    pub async fn status(&self, project_id: &str) -> Result<ProjectStatus> {
        let h = self.handle(project_id)?;
        let busy_status = h.inner.rt(|r| if r.busy.is_some() { r.last_status.clone() } else { None });
        if let Some(mut s) = busy_status {
            s.state = match h.inner.rt(|r| r.busy) {
                Some(project::Busy::Publishing) => SyncState::Publishing,
                _ => SyncState::Updating,
            };
            return Ok(s);
        }
        h.run(|i| Ok(status_or_error(i))).await
    }

    /// Tells the engine that the server has news (real-time notification): triggers a fetch soon.
    pub fn notify_remote_changed(&self, project_id: &str) -> Result<()> {
        let h = self.handle(project_id)?;
        h.inner.rt(|r| r.remote_notified = true);
        h.inner.wake.notify_one();
        Ok(())
    }

    // ---- synchronisation ----------------------------------------------------------------

    /// Publishes the unpublished changes (all, or the given paths) and sends every pending version.
    pub async fn publish(&self, project_id: &str, req: PublishRequest) -> Result<ProjectStatus> {
        self.handle(project_id)?.run(move |i| i.publish(&req)).await
    }

    /// Fetch + update + sending of the pending versions.
    pub async fn sync_now(&self, project_id: &str) -> Result<ProjectStatus> {
        self.handle(project_id)?.run(|i| i.sync_now()).await
    }

    /// Fetch and update. With `force` the update is applied even if OpenRocket may have the files open
    /// (the stale-editor guard is armed).
    pub async fn update_now(&self, project_id: &str, force: bool) -> Result<ProjectStatus> {
        self.handle(project_id)?.run(move |i| i.update_now(force)).await
    }

    /// Discards the local changes of `paths` after a safety copy.
    pub async fn discard_changes(&self, project_id: &str, paths: Vec<String>) -> Result<ProjectStatus> {
        self.handle(project_id)?.run(move |i| i.discard_changes(&paths)).await
    }

    /// Answer to a suspected stale save: `reopened = true` means "I reopened the file before editing it".
    pub async fn answer_stale_save(&self, project_id: &str, path: String, reopened: bool) -> Result<ProjectStatus> {
        self.handle(project_id)?
            .run(move |i| i.answer_stale_save(&path, reopened))
            .await
    }

    /// Publication policy of a project.
    pub fn get_publish_policy(&self, project_id: &str) -> Result<PublishPolicy> {
        self.handle(project_id)?;
        Ok(self.shared.store.get_publish_policy(project_id)?)
    }

    /// Changes the publication policy of a project.
    pub fn set_publish_policy(&self, project_id: &str, policy: PublishPolicy) -> Result<()> {
        let h = self.handle(project_id)?;
        self.shared.store.set_publish_policy(project_id, &policy)?;
        h.inner.mark_dirty();
        h.inner.wake.notify_one();
        Ok(())
    }

    // ---- history ------------------------------------------------------------------------

    /// Versions, newest first (pending ones first).
    pub async fn list_versions(
        &self,
        project_id: &str,
        limit: Option<usize>,
        before_sha: Option<String>,
    ) -> Result<Vec<VersionInfo>> {
        self.handle(project_id)?
            .run(move |i| i.list_versions(limit, before_sha.as_deref()))
            .await
    }

    pub async fn get_version(&self, project_id: &str, sha: String) -> Result<VersionInfo> {
        self.handle(project_id)?.run(move |i| i.get_version(&sha)).await
    }

    /// File-level comparison of two versions (with the bytes of both parts).
    pub async fn compare_versions(&self, project_id: &str, from_sha: String, to_sha: String) -> Result<Comparison> {
        self.handle(project_id)?
            .run(move |i| i.compare_versions(&from_sha, &to_sha))
            .await
    }

    /// Content of a file in a version.
    pub async fn read_file_at(&self, project_id: &str, sha: String, path: String) -> Result<Option<Vec<u8>>> {
        self.handle(project_id)?.run(move |i| i.read_file_at(&sha, &path)).await
    }

    /// Writes the files of a version into `dest_dir` without touching the working folder.
    pub async fn export_version(
        &self,
        project_id: &str,
        sha: String,
        paths: Option<Vec<String>>,
        dest_dir: PathBuf,
    ) -> Result<Vec<String>> {
        self.handle(project_id)?
            .run(move |i| i.export_version(&sha, paths.as_deref(), &dest_dir))
            .await
    }

    /// Temporary copy of one file of a version (to open in OpenRocket).
    pub async fn export_version_copy(&self, project_id: &str, sha: String, path: String) -> Result<PathBuf> {
        self.handle(project_id)?
            .run(move |i| i.export_version_copy(&sha, &path))
            .await
    }

    /// Restores a version (or some of its files) as a new version (`§7.6`).
    pub async fn restore_version(
        &self,
        project_id: &str,
        sha: String,
        paths: Option<Vec<String>>,
    ) -> Result<ProjectStatus> {
        self.handle(project_id)?
            .run(move |i| i.restore_version(&sha, paths.as_deref()))
            .await
    }

    // ---- conflicts and safety copies ----------------------------------------------------

    pub async fn list_conflicts(&self, project_id: &str, include_resolved: bool) -> Result<Vec<Conflict>> {
        self.handle(project_id)?
            .run(move |i| i.list_conflicts(include_resolved))
            .await
    }

    pub async fn get_conflict(&self, project_id: &str, conflict_id: String) -> Result<Conflict> {
        self.handle(project_id)?.run(move |i| i.get_conflict(&conflict_id)).await
    }

    /// Bytes of one side of a conflicting file (for the semantic three-way diff of the shell).
    pub async fn read_conflict_side(
        &self,
        project_id: &str,
        conflict_id: String,
        path: String,
        side: ConflictSide,
    ) -> Result<Option<Vec<u8>>> {
        self.handle(project_id)?
            .run(move |i| i.conflict_side_bytes(&conflict_id, &path, side))
            .await
    }

    /// Writes one side of a conflicting file in `.rocketsync/local/conflitti/<id>/` to open it in OpenRocket.
    pub async fn export_conflict_copy(
        &self,
        project_id: &str,
        conflict_id: String,
        path: String,
        side: ConflictSide,
    ) -> Result<PathBuf> {
        self.handle(project_id)?
            .run(move |i| i.export_conflict_copy(&conflict_id, &path, side))
            .await
    }

    /// Resolves a conflict (`mine` / `theirs` / `both` / `manual` for every file).
    pub async fn resolve_conflict(
        &self,
        project_id: &str,
        conflict_id: String,
        resolutions: Vec<FileResolution>,
    ) -> Result<ProjectStatus> {
        self.handle(project_id)?
            .run(move |i| i.resolve_conflict(&conflict_id, &resolutions))
            .await
    }

    pub async fn list_snapshots(&self, project_id: &str) -> Result<Vec<Snapshot>> {
        self.handle(project_id)?.run(|i| i.list_snapshots()).await
    }

    pub async fn export_snapshot(&self, project_id: &str, snapshot_id: String, dest_dir: PathBuf) -> Result<Vec<String>> {
        self.handle(project_id)?
            .run(move |i| i.export_snapshot(&snapshot_id, &dest_dir))
            .await
    }

    /// Recent journal entries of a project (diagnostics).
    pub fn journal(&self, project_id: &str, limit: u32) -> Result<Vec<rs_store::JournalEntry>> {
        self.handle(project_id)?;
        Ok(self.shared.store.journal_recent(project_id, limit)?)
    }
}
