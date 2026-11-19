//! The logic layer between the Tauri commands and `rs-core`: every command of the IPC contract
//! (`docs/contratto-ipc.md` §5) is a method here. It has no dependency on a window, so it is
//! tested against a real [`Engine`](rs_core::Engine) and a local bare remote.

use crate::auth::{AuthService, AuthStatus};
use crate::config::AppConfig;
use crate::diagnostics;
use crate::enrich;
use crate::logging;
use crate::openrocket::{self, OpenRocketInfo};
use crate::paths;
use crate::platform::{Platform, UpdateInfo};
use crate::secrets::SecretStore;
use crate::settings::AppSettings;
use rs_core::{
    AppError, Comparison, Conflict, ConflictSide, Engine, ErrorCode, FileResolution, FolderCheck,
    LinkRequest, LocalProject, ProjectStatus, PublishPolicy, PublishRequest, Snapshot, SyncState,
    VersionInfo,
};
use rs_store::Store;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

/// Result type of every command.
pub type CmdResult<T> = Result<T, AppError>;

pub(crate) fn app_error(code: ErrorCode, message: impl Into<String>) -> AppError {
    AppError {
        code,
        message: message.into(),
        detail: None,
        retryable: false,
    }
}

/// `get_app_info` result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub git_version: Option<String>,
    pub open_rocket: OpenRocketInfo,
}

/// Everything a [`Shell`] is made of.
pub struct ShellParts {
    /// The engine, or the reason why it could not start (e.g. `gitMissing`).
    pub engine: Result<Engine, AppError>,
    pub auth: Arc<AuthService>,
    pub secrets: Arc<dyn SecretStore>,
    pub store: Store,
    pub platform: Arc<dyn Platform>,
    pub data_dir: PathBuf,
    pub config: AppConfig,
    pub git_version: Option<String>,
    pub settings: Arc<RwLock<AppSettings>>,
    /// Base URL of the Git hosting, `https://github.com` unless overridden (development/tests:
    /// `ROCKETSYNC_REMOTE_BASE`, e.g. `file:///srv/repos`).
    pub remote_base: Option<String>,
}

/// Application services.
pub struct Shell {
    engine: Result<Engine, AppError>,
    pub auth: Arc<AuthService>,
    secrets: Arc<dyn SecretStore>,
    store: Store,
    pub platform: Arc<dyn Platform>,
    data_dir: PathBuf,
    config: AppConfig,
    git_version: Option<String>,
    pub settings: Arc<RwLock<AppSettings>>,
    remote_base: Option<String>,
    openrocket: Mutex<Option<OpenRocketInfo>>,
}

fn valid_store_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

impl Shell {
    pub fn new(p: ShellParts) -> Self {
        Self {
            engine: p.engine,
            auth: p.auth,
            secrets: p.secrets,
            store: p.store,
            platform: p.platform,
            data_dir: p.data_dir,
            config: p.config,
            git_version: p.git_version,
            settings: p.settings,
            remote_base: p.remote_base,
            openrocket: Mutex::new(None),
        }
    }

    /// The engine, or the error that prevented it from starting.
    pub fn engine(&self) -> CmdResult<&Engine> {
        self.engine.as_ref().map_err(Clone::clone)
    }

    fn settings_snapshot(&self) -> AppSettings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    /// Renews the GitHub token before a network operation (best effort: `file://` remotes and
    /// tokens that do not expire need nothing).
    async fn fresh_token(&self) {
        let _ = self.auth.ensure_github_token().await;
    }

    // ---- session and credentials --------------------------------------------------------

    pub async fn auth_status(&self) -> CmdResult<AuthStatus> {
        let st = self.auth.status().await?;
        if let (Ok(e), Some(id)) = (self.engine(), self.auth.identity()) {
            e.set_identity(Some(id));
        }
        Ok(st)
    }

    pub async fn auth_sign_in(&self) -> CmdResult<AuthStatus> {
        let platform = self.platform.clone();
        let st = self.auth.sign_in(move |url| platform.open_url(url)).await?;
        if let Ok(e) = self.engine() {
            e.set_identity(self.auth.identity());
        }
        Ok(st)
    }

    pub async fn auth_sign_out(&self) -> CmdResult<()> {
        self.auth.sign_out().await;
        if let Ok(e) = self.engine() {
            e.set_identity(None);
        }
        Ok(())
    }

    pub fn secure_store_get(&self, key: &str) -> CmdResult<Option<String>> {
        if !valid_store_key(key) {
            return Err(app_error(ErrorCode::InvalidPath, "Chiave non valida."));
        }
        self.secrets
            .get(&format!("store.{key}"))
            .map_err(|e| app_error(ErrorCode::Internal, e.to_string()))
    }

    pub fn secure_store_set(&self, key: &str, value: &str) -> CmdResult<()> {
        if !valid_store_key(key) {
            return Err(app_error(ErrorCode::InvalidPath, "Chiave non valida."));
        }
        if value.len() > 64 * 1024 {
            return Err(app_error(ErrorCode::Internal, "Valore troppo grande."));
        }
        self.secrets
            .set(&format!("store.{key}"), value)
            .map_err(|e| app_error(ErrorCode::Internal, e.to_string()))
    }

    pub fn secure_store_delete(&self, key: &str) -> CmdResult<()> {
        if !valid_store_key(key) {
            return Err(app_error(ErrorCode::InvalidPath, "Chiave non valida."));
        }
        self.secrets
            .delete(&format!("store.{key}"))
            .map_err(|e| app_error(ErrorCode::Internal, e.to_string()))
    }

    // ---- local projects -----------------------------------------------------------------

    pub fn list_local_projects(&self) -> CmdResult<Vec<LocalProject>> {
        Ok(self.engine()?.list_projects()?)
    }

    /// `<home>/RocketSync/<project name>`, with a number if the folder already exists.
    pub fn suggest_project_folder(&self, project_name: &str) -> String {
        let root = paths::default_projects_root(self.platform.home_dir().as_deref());
        let name = paths::sanitize_folder_name(project_name);
        let mut candidate = root.join(&name);
        let mut n = 2;
        while candidate.exists() {
            candidate = root.join(format!("{name} ({n})"));
            n += 1;
        }
        candidate.to_string_lossy().into_owned()
    }

    pub fn check_folder(&self, path: &str) -> CmdResult<FolderCheck> {
        Ok(self.engine()?.check_folder(Path::new(path)))
    }

    /// Folder picker; the blocking dialog runs on a blocking thread.
    pub async fn pick_folder(&self, default_path: Option<String>) -> CmdResult<Option<String>> {
        let platform = self.platform.clone();
        tokio::task::spawn_blocking(move || {
            platform
                .pick_folder(default_path.as_deref().map(Path::new))
                .map(|p| p.to_string_lossy().into_owned())
        })
        .await
        .map_err(|_| {
            app_error(
                ErrorCode::Internal,
                "La finestra di selezione si è interrotta.",
            )
        })
    }

    pub async fn link_project(
        &self,
        project_id: &str,
        repo_full_name: &str,
        folder: &str,
    ) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine
            .link_project(LinkRequest {
                project_id: project_id.to_string(),
                repo_full_name: repo_full_name.to_string(),
                remote_url: self
                    .remote_base
                    .as_deref()
                    .map(|b| format!("{}/{}.git", b.trim_end_matches('/'), repo_full_name)),
                folder: folder.to_string(),
                allow_synced_drive: false,
            })
            .await?)
    }

    pub async fn unlink_project(&self, project_id: &str) -> CmdResult<()> {
        Ok(self.engine()?.unlink_project(project_id).await?)
    }

    pub async fn get_project_status(&self, project_id: &str) -> CmdResult<ProjectStatus> {
        Ok(self.engine()?.status(project_id).await?)
    }

    // ---- synchronisation ----------------------------------------------------------------

    pub async fn publish(
        &self,
        project_id: &str,
        title: Option<String>,
        description: Option<String>,
        paths: Option<Vec<String>>,
    ) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine
            .publish(
                project_id,
                PublishRequest {
                    title,
                    description,
                    paths,
                },
            )
            .await?)
    }

    pub async fn sync_now(&self, project_id: &str) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine.sync_now(project_id).await?)
    }

    pub async fn update_now(&self, project_id: &str, force: bool) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine.update_now(project_id, force).await?)
    }

    pub async fn discard_changes(
        &self,
        project_id: &str,
        paths: Vec<String>,
    ) -> CmdResult<ProjectStatus> {
        Ok(self.engine()?.discard_changes(project_id, paths).await?)
    }

    pub async fn answer_stale_save(
        &self,
        project_id: &str,
        path: &str,
        reopened: bool,
    ) -> CmdResult<ProjectStatus> {
        Ok(self
            .engine()?
            .answer_stale_save(project_id, path.to_string(), reopened)
            .await?)
    }

    pub fn notify_remote_changed(&self, project_id: &str) -> CmdResult<()> {
        Ok(self.engine()?.notify_remote_changed(project_id)?)
    }

    pub fn get_publish_policy(&self, project_id: &str) -> CmdResult<PublishPolicy> {
        Ok(self.engine()?.get_publish_policy(project_id)?)
    }

    pub fn set_publish_policy(&self, project_id: &str, policy: PublishPolicy) -> CmdResult<()> {
        Ok(self.engine()?.set_publish_policy(project_id, policy)?)
    }

    /// Syncs every project (tray menu). Errors of single projects are logged, not returned.
    pub async fn sync_all(&self) -> usize {
        let Ok(engine) = self.engine() else { return 0 };
        let Ok(projects) = engine.list_projects() else {
            return 0;
        };
        self.fresh_token().await;
        let mut ok = 0;
        for p in projects {
            match engine.sync_now(&p.project_id).await {
                Ok(_) => ok += 1,
                Err(e) => tracing::warn!(project = %p.project_id, error = %e, "sync_all failed"),
            }
        }
        ok
    }

    /// Waits until no project is publishing or updating (before installing an update).
    pub async fn wait_idle(&self, timeout: Duration) -> bool {
        let Ok(engine) = self.engine() else {
            return true;
        };
        let end = std::time::Instant::now() + timeout;
        loop {
            let busy = match engine.list_projects() {
                Ok(ps) => {
                    let mut busy = false;
                    for p in ps {
                        if let Ok(s) = engine.status(&p.project_id).await {
                            if matches!(s.state, SyncState::Publishing | SyncState::Updating) {
                                busy = true;
                            }
                        }
                    }
                    busy
                }
                Err(_) => false,
            };
            if !busy {
                return true;
            }
            if std::time::Instant::now() >= end {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    // ---- history ------------------------------------------------------------------------

    pub async fn list_versions(
        &self,
        project_id: &str,
        limit: Option<usize>,
        before_sha: Option<String>,
    ) -> CmdResult<Vec<VersionInfo>> {
        Ok(self
            .engine()?
            .list_versions(project_id, limit, before_sha)
            .await?)
    }

    pub async fn get_version(&self, project_id: &str, sha: &str) -> CmdResult<VersionInfo> {
        Ok(self
            .engine()?
            .get_version(project_id, sha.to_string())
            .await?)
    }

    /// Comparison with the semantic diff of `.ork` files and the text diff of text files.
    pub async fn compare_versions(
        &self,
        project_id: &str,
        from_sha: &str,
        to_sha: &str,
    ) -> CmdResult<Comparison> {
        let mut c = self
            .engine()?
            .compare_versions(project_id, from_sha.to_string(), to_sha.to_string())
            .await?;
        // The diff of big files is CPU work: keep it off the async threads.
        tokio::task::spawn_blocking(move || {
            enrich::enrich_comparison(&mut c);
            c
        })
        .await
        .map_err(|_| app_error(ErrorCode::Internal, "Confronto interrotto."))
    }

    pub async fn export_version(
        &self,
        project_id: &str,
        sha: &str,
        paths: Option<Vec<String>>,
        dest_dir: &str,
    ) -> CmdResult<Vec<String>> {
        Ok(self
            .engine()?
            .export_version(project_id, sha.to_string(), paths, PathBuf::from(dest_dir))
            .await?)
    }

    pub async fn open_version_copy(
        &self,
        project_id: &str,
        sha: &str,
        path: &str,
    ) -> CmdResult<()> {
        let copy = self
            .engine()?
            .export_version_copy(project_id, sha.to_string(), path.to_string())
            .await?;
        self.launch(&copy)
    }

    pub async fn restore_version(
        &self,
        project_id: &str,
        sha: &str,
        paths: Option<Vec<String>>,
    ) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine
            .restore_version(project_id, sha.to_string(), paths)
            .await?)
    }

    // ---- conflicts and safety copies ----------------------------------------------------

    async fn enriched(&self, project_id: &str, mut c: Conflict) -> CmdResult<Conflict> {
        // Read the three sides asynchronously first, then fill the diff on a blocking thread.
        let engine = self.engine()?.clone();
        let mut sides: std::collections::HashMap<(String, u8), Vec<u8>> =
            std::collections::HashMap::new();
        for f in c
            .files
            .iter()
            .filter(|f| f.path.to_ascii_lowercase().ends_with(".ork"))
        {
            for (i, side) in [ConflictSide::Base, ConflictSide::Ours, ConflictSide::Theirs]
                .into_iter()
                .enumerate()
            {
                if let Ok(Some(b)) = engine
                    .read_conflict_side(project_id, c.id.clone(), f.path.clone(), side)
                    .await
                {
                    sides.insert((f.path.clone(), i as u8), b);
                }
            }
        }
        tokio::task::spawn_blocking(move || {
            enrich::enrich_conflict_with(&mut c, |path, side| {
                let i = match side {
                    ConflictSide::Base => 0,
                    ConflictSide::Ours => 1,
                    ConflictSide::Theirs => 2,
                };
                sides.get(&(path.to_string(), i)).cloned()
            });
            c
        })
        .await
        .map_err(|_| app_error(ErrorCode::Internal, "Confronto interrotto."))
    }

    pub async fn list_conflicts(
        &self,
        project_id: &str,
        include_resolved: bool,
    ) -> CmdResult<Vec<Conflict>> {
        let list = self
            .engine()?
            .list_conflicts(project_id, include_resolved)
            .await?;
        let mut out = Vec::new();
        for c in list {
            out.push(self.enriched(project_id, c).await?);
        }
        Ok(out)
    }

    pub async fn get_conflict(&self, project_id: &str, conflict_id: &str) -> CmdResult<Conflict> {
        let c = self
            .engine()?
            .get_conflict(project_id, conflict_id.to_string())
            .await?;
        self.enriched(project_id, c).await
    }

    pub async fn open_conflict_copy(
        &self,
        project_id: &str,
        conflict_id: &str,
        path: &str,
        side: ConflictSide,
    ) -> CmdResult<()> {
        if side == ConflictSide::Ours {
            return Err(app_error(
                ErrorCode::InvalidPath,
                "La tua versione è già nella cartella del progetto.",
            ));
        }
        let copy = self
            .engine()?
            .export_conflict_copy(project_id, conflict_id.to_string(), path.to_string(), side)
            .await?;
        self.launch(&copy)
    }

    pub async fn resolve_conflict(
        &self,
        project_id: &str,
        conflict_id: &str,
        resolutions: Vec<FileResolution>,
    ) -> CmdResult<ProjectStatus> {
        let engine = self.engine()?;
        self.fresh_token().await;
        Ok(engine
            .resolve_conflict(project_id, conflict_id.to_string(), resolutions)
            .await?)
    }

    pub async fn list_snapshots(&self, project_id: &str) -> CmdResult<Vec<Snapshot>> {
        Ok(self.engine()?.list_snapshots(project_id).await?)
    }

    pub async fn export_snapshot(
        &self,
        project_id: &str,
        snapshot_id: &str,
        dest_dir: &str,
    ) -> CmdResult<Vec<String>> {
        Ok(self
            .engine()?
            .export_snapshot(project_id, snapshot_id.to_string(), PathBuf::from(dest_dir))
            .await?)
    }

    // ---- system -------------------------------------------------------------------------

    fn openrocket_info(&self) -> OpenRocketInfo {
        let mut g = self.openrocket.lock().unwrap_or_else(|p| p.into_inner());
        if g.as_ref().map(|i| !i.found).unwrap_or(true) {
            *g = Some(openrocket::detect());
        }
        g.clone().unwrap_or_default()
    }

    pub fn get_app_info(&self) -> AppInfo {
        AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            git_version: self.git_version.clone(),
            open_rocket: self.openrocket_info(),
        }
    }

    /// Opens a file in OpenRocket, or with the default application if OpenRocket is not found.
    fn launch(&self, file: &Path) -> CmdResult<()> {
        let info = self.openrocket_info();
        let r = match info.path.as_deref().filter(|_| info.found) {
            Some(exe) if openrocket::is_rocket_file(file) => {
                self.platform.open_with(Path::new(exe), file)
            }
            _ => self.platform.open_path(file),
        };
        r.map_err(|e| {
            app_error(
                ErrorCode::NotFound,
                format!("Impossibile aprire il file: {e}"),
            )
        })
    }

    pub async fn open_in_openrocket(&self, project_id: &str, path: &str) -> CmdResult<()> {
        let projects = self.engine()?.list_projects()?;
        let project = projects
            .iter()
            .find(|p| p.project_id == project_id)
            .ok_or_else(|| app_error(ErrorCode::NotLinked, "Progetto non collegato."))?;
        // The path comes from the interface: it must stay inside the project folder.
        let rel = Path::new(path);
        if path.is_empty()
            || rel.is_absolute()
            || path.contains('\\')
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            || path.split('/').any(|c| c.eq_ignore_ascii_case(".git"))
        {
            return Err(app_error(ErrorCode::InvalidPath, "Percorso non valido."));
        }
        let abs = Path::new(&project.folder).join(rel);
        if !abs.is_file() {
            return Err(app_error(
                ErrorCode::NotFound,
                "Il file non esiste più nella cartella del progetto.",
            ));
        }
        self.launch(&abs)
    }

    /// Opens a folder in the file manager (never a file: a file would be executed).
    pub fn open_folder(&self, path: &str) -> CmdResult<()> {
        let p = Path::new(path);
        if !p.is_dir() {
            return Err(app_error(ErrorCode::NotFound, "La cartella non esiste."));
        }
        self.platform.open_path(p).map_err(|e| {
            app_error(
                ErrorCode::Internal,
                format!("Impossibile aprire la cartella: {e}"),
            )
        })
    }

    pub fn get_app_settings(&self) -> AppSettings {
        self.settings_snapshot()
    }

    pub fn set_app_settings(&self, new: AppSettings) -> CmdResult<()> {
        let new = new.normalized();
        let old = self.settings_snapshot();
        new.save(&self.store)
            .map_err(|e| app_error(ErrorCode::Internal, e.to_string()))?;
        if old.autostart != new.autostart {
            self.platform
                .set_autostart(new.autostart)
                .map_err(|e| app_error(ErrorCode::Internal, format!("Avvio automatico: {e}")))?;
        }
        if let Ok(mut g) = self.settings.write() {
            *g = new;
        }
        Ok(())
    }

    pub fn notify_desktop(&self, title: &str, body: &str) -> CmdResult<()> {
        if !self.settings_snapshot().desktop_notifications {
            return Ok(());
        }
        self.platform
            .notify(title, body)
            .map_err(|e| app_error(ErrorCode::Internal, format!("Notifica: {e}")))
    }

    pub async fn check_for_update(&self) -> CmdResult<UpdateInfo> {
        if self.config.updater_endpoint.is_empty() || self.config.updater_pubkey.is_empty() {
            return Ok(UpdateInfo::default());
        }
        self.platform.check_update().await.map_err(|e| {
            app_error(
                ErrorCode::Network,
                format!("Controllo degli aggiornamenti non riuscito: {e}"),
            )
        })
    }

    pub async fn install_update(&self) -> CmdResult<()> {
        if self.config.updater_endpoint.is_empty() || self.config.updater_pubkey.is_empty() {
            return Err(app_error(
                ErrorCode::Internal,
                "Gli aggiornamenti non sono configurati.",
            ));
        }
        if !self.wait_idle(Duration::from_secs(300)).await {
            return Err(app_error(
                ErrorCode::LockHeld,
                "C'è una sincronizzazione in corso: riprova tra un momento.",
            ));
        }
        self.platform.install_update().await.map_err(|e| {
            app_error(
                ErrorCode::Internal,
                format!("Installazione dell'aggiornamento non riuscita: {e}"),
            )
        })
    }

    /// Writes the diagnostics zip (log, status, journal, command log, versions) and returns its path.
    pub async fn export_diagnostics(&self) -> CmdResult<String> {
        let mut entries: Vec<(String, String)> = Vec::new();
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
        entries.push((
            "info.json".into(),
            serde_json::to_string_pretty(&serde_json::json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "gitVersion": self.git_version,
                "openRocket": self.openrocket_info(),
                "config": self.config.redacted(),
                "settings": self.settings_snapshot(),
                "engineError": self.engine.as_ref().err(),
                "generatedAt": chrono::Utc::now().to_rfc3339(),
            }))
            .unwrap_or_default(),
        ));
        entries.push((
            "log/rocketsync.log".into(),
            logging::tail(
                &self.data_dir.join("logs").join(logging::LOG_FILE),
                2 * 1024 * 1024,
            ),
        ));
        if let Ok(engine) = self.engine() {
            let cmds: Vec<String> = engine
                .command_log()
                .records()
                .iter()
                .rev()
                .take(2000)
                .map(|r| {
                    format!(
                        "{} exit={:?} {}ms {}{}",
                        chrono::DateTime::<chrono::Utc>::from(r.started_at).to_rfc3339(),
                        r.exit_code,
                        r.duration.as_millis(),
                        r.command_line(),
                        r.error
                            .as_deref()
                            .map(|e| format!(" -> {e}"))
                            .unwrap_or_default()
                    )
                })
                .collect();
            entries.push(("git-commands.txt".into(), cmds.join("\n")));
            let json = |v: &dyn erased_ser::Ser| v.to_pretty();
            for p in engine.list_projects().unwrap_or_default() {
                let id = &p.project_id;
                entries.push((
                    diagnostics::project_entry(id, "project.json"),
                    json(&erased_ser::Wrap(&p)),
                ));
                if let Ok(s) = engine.status(id).await {
                    entries.push((
                        diagnostics::project_entry(id, "status.json"),
                        json(&erased_ser::Wrap(&s)),
                    ));
                }
                if let Ok(j) = engine.journal(id, 200) {
                    entries.push((
                        diagnostics::project_entry(id, "journal.json"),
                        json(&erased_ser::Wrap(&j)),
                    ));
                }
                if let Ok(v) = engine.list_versions(id, Some(50), None).await {
                    entries.push((
                        diagnostics::project_entry(id, "versions.json"),
                        json(&erased_ser::Wrap(&v)),
                    ));
                }
                if let Ok(c) = engine.list_conflicts(id, true).await {
                    entries.push((
                        diagnostics::project_entry(id, "conflicts.json"),
                        json(&erased_ser::Wrap(&c)),
                    ));
                }
                if let Ok(s) = engine.list_snapshots(id).await {
                    entries.push((
                        diagnostics::project_entry(id, "snapshots.json"),
                        json(&erased_ser::Wrap(&s)),
                    ));
                }
            }
        }
        let dest = self
            .data_dir
            .join("diagnostics")
            .join(format!("rocketsync-diagnostica-{stamp}.zip"));
        let d2 = dest.clone();
        tokio::task::spawn_blocking(move || diagnostics::write_zip(&d2, &entries))
            .await
            .map_err(|_| app_error(ErrorCode::Internal, "Esportazione interrotta."))?
            .map_err(|e| {
                app_error(
                    ErrorCode::Internal,
                    format!("Impossibile scrivere la diagnostica: {e}"),
                )
            })?;
        Ok(dest.to_string_lossy().into_owned())
    }
}

/// Tiny helper so the diagnostics code can pretty-print any serializable value.
mod erased_ser {
    pub trait Ser {
        fn to_pretty(&self) -> String;
    }
    pub struct Wrap<'a, T: serde::Serialize>(pub &'a T);
    impl<T: serde::Serialize> Ser for Wrap<'_, T> {
        fn to_pretty(&self) -> String {
            serde_json::to_string_pretty(self.0).unwrap_or_default()
        }
    }
}
