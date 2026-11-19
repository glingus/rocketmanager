//! The Tauri commands of the IPC contract (`docs/contratto-ipc.md` §5). Each one only waits for
//! the application services to be ready and delegates to [`Shell`](crate::shell::Shell).

use crate::auth::AuthStatus;
use crate::platform::UpdateInfo;
use crate::settings::AppSettings;
use crate::shell::{AppInfo, CmdResult, Shell};
use rs_core::{
    AppError, Comparison, Conflict, ConflictSide, ErrorCode, FileResolution, FolderCheck,
    LocalProject, ProjectStatus, PublishPolicy, Snapshot, VersionInfo,
};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::State;

/// Managed state: the services appear when the engine has finished its startup recovery.
pub struct AppState {
    slot: tokio::sync::watch::Sender<Option<Arc<Shell>>>,
    /// Mirror of `AppSettings.minimizeToTray`, read synchronously by the window-close handler.
    pub minimize_to_tray: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        let (slot, _) = tokio::sync::watch::channel(None);
        Self {
            slot,
            minimize_to_tray: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn set_shell(&self, shell: Arc<Shell>) {
        self.slot.send_replace(Some(shell));
    }

    pub fn try_shell(&self) -> Option<Arc<Shell>> {
        self.slot.borrow().clone()
    }

    /// Waits (at most a minute) for the services to be ready.
    pub async fn shell(&self) -> CmdResult<Arc<Shell>> {
        let mut rx = self.slot.subscribe();
        let ready = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            rx.wait_for(|s| s.is_some()),
        )
        .await
        .ok()
        .and_then(|r| r.ok().and_then(|g| g.clone()));
        ready.ok_or_else(not_ready)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn not_ready() -> AppError {
    AppError {
        code: ErrorCode::Internal,
        message: "Rocket Sync si sta ancora avviando: riprova tra un istante.".into(),
        detail: None,
        retryable: true,
    }
}

type St<'a> = State<'a, AppState>;

#[tauri::command]
pub async fn auth_status(state: St<'_>) -> CmdResult<AuthStatus> {
    let s = state.shell().await?;
    s.auth_status().await
}

#[tauri::command]
pub async fn auth_sign_in(state: St<'_>) -> CmdResult<AuthStatus> {
    let s = state.shell().await?;
    s.auth_sign_in().await
}

#[tauri::command]
pub async fn auth_sign_out(state: St<'_>) -> CmdResult<()> {
    let s = state.shell().await?;
    s.auth_sign_out().await
}

#[tauri::command]
pub async fn secure_store_get(state: St<'_>, key: String) -> CmdResult<Option<String>> {
    let s = state.shell().await?;
    s.secure_store_get(&key)
}

#[tauri::command]
pub async fn secure_store_set(state: St<'_>, key: String, value: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.secure_store_set(&key, &value)
}

#[tauri::command]
pub async fn secure_store_delete(state: St<'_>, key: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.secure_store_delete(&key)
}

#[tauri::command]
pub async fn list_local_projects(state: St<'_>) -> CmdResult<Vec<LocalProject>> {
    let s = state.shell().await?;
    s.list_local_projects()
}

#[tauri::command]
pub async fn suggest_project_folder(state: St<'_>, project_name: String) -> CmdResult<String> {
    let s = state.shell().await?;
    Ok(s.suggest_project_folder(&project_name))
}

#[tauri::command]
pub async fn check_folder(state: St<'_>, path: String) -> CmdResult<FolderCheck> {
    let s = state.shell().await?;
    s.check_folder(&path)
}

#[tauri::command]
pub async fn pick_folder(state: St<'_>, default_path: Option<String>) -> CmdResult<Option<String>> {
    let s = state.shell().await?;
    s.pick_folder(default_path).await
}

#[tauri::command]
pub async fn link_project(
    state: St<'_>,
    project_id: String,
    repo_full_name: String,
    folder: String,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.link_project(&project_id, &repo_full_name, &folder).await
}

#[tauri::command]
pub async fn unlink_project(state: St<'_>, project_id: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.unlink_project(&project_id).await
}

#[tauri::command]
pub async fn get_project_status(state: St<'_>, project_id: String) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.get_project_status(&project_id).await
}

#[tauri::command]
pub async fn publish(
    state: St<'_>,
    project_id: String,
    title: Option<String>,
    description: Option<String>,
    paths: Option<Vec<String>>,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.publish(&project_id, title, description, paths).await
}

#[tauri::command]
pub async fn sync_now(state: St<'_>, project_id: String) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.sync_now(&project_id).await
}

#[tauri::command]
pub async fn update_now(
    state: St<'_>,
    project_id: String,
    force: Option<bool>,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.update_now(&project_id, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn discard_changes(
    state: St<'_>,
    project_id: String,
    paths: Vec<String>,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.discard_changes(&project_id, paths).await
}

#[tauri::command]
pub async fn answer_stale_save(
    state: St<'_>,
    project_id: String,
    path: String,
    reopened: bool,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.answer_stale_save(&project_id, &path, reopened).await
}

#[tauri::command]
pub async fn notify_remote_changed(state: St<'_>, project_id: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.notify_remote_changed(&project_id)
}

#[tauri::command]
pub async fn get_publish_policy(state: St<'_>, project_id: String) -> CmdResult<PublishPolicy> {
    let s = state.shell().await?;
    s.get_publish_policy(&project_id)
}

#[tauri::command]
pub async fn set_publish_policy(
    state: St<'_>,
    project_id: String,
    policy: PublishPolicy,
) -> CmdResult<()> {
    let s = state.shell().await?;
    s.set_publish_policy(&project_id, policy)
}

#[tauri::command]
pub async fn list_versions(
    state: St<'_>,
    project_id: String,
    limit: Option<usize>,
    before_sha: Option<String>,
) -> CmdResult<Vec<VersionInfo>> {
    let s = state.shell().await?;
    s.list_versions(&project_id, limit, before_sha).await
}

#[tauri::command]
pub async fn get_version(state: St<'_>, project_id: String, sha: String) -> CmdResult<VersionInfo> {
    let s = state.shell().await?;
    s.get_version(&project_id, &sha).await
}

#[tauri::command]
pub async fn compare_versions(
    state: St<'_>,
    project_id: String,
    from_sha: String,
    to_sha: String,
) -> CmdResult<Comparison> {
    let s = state.shell().await?;
    s.compare_versions(&project_id, &from_sha, &to_sha).await
}

#[tauri::command]
pub async fn export_version(
    state: St<'_>,
    project_id: String,
    sha: String,
    paths: Option<Vec<String>>,
    dest_dir: String,
) -> CmdResult<Vec<String>> {
    let s = state.shell().await?;
    s.export_version(&project_id, &sha, paths, &dest_dir).await
}

#[tauri::command]
pub async fn open_version_copy(
    state: St<'_>,
    project_id: String,
    sha: String,
    path: String,
) -> CmdResult<()> {
    let s = state.shell().await?;
    s.open_version_copy(&project_id, &sha, &path).await
}

#[tauri::command]
pub async fn restore_version(
    state: St<'_>,
    project_id: String,
    sha: String,
    paths: Option<Vec<String>>,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.restore_version(&project_id, &sha, paths).await
}

#[tauri::command]
pub async fn list_conflicts(
    state: St<'_>,
    project_id: String,
    include_resolved: Option<bool>,
) -> CmdResult<Vec<Conflict>> {
    let s = state.shell().await?;
    s.list_conflicts(&project_id, include_resolved.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn get_conflict(
    state: St<'_>,
    project_id: String,
    conflict_id: String,
) -> CmdResult<Conflict> {
    let s = state.shell().await?;
    s.get_conflict(&project_id, &conflict_id).await
}

#[tauri::command]
pub async fn open_conflict_copy(
    state: St<'_>,
    project_id: String,
    conflict_id: String,
    path: String,
    side: ConflictSide,
) -> CmdResult<()> {
    let s = state.shell().await?;
    s.open_conflict_copy(&project_id, &conflict_id, &path, side)
        .await
}

#[tauri::command]
pub async fn resolve_conflict(
    state: St<'_>,
    project_id: String,
    conflict_id: String,
    resolutions: Vec<FileResolution>,
) -> CmdResult<ProjectStatus> {
    let s = state.shell().await?;
    s.resolve_conflict(&project_id, &conflict_id, resolutions)
        .await
}

#[tauri::command]
pub async fn list_snapshots(state: St<'_>, project_id: String) -> CmdResult<Vec<Snapshot>> {
    let s = state.shell().await?;
    s.list_snapshots(&project_id).await
}

#[tauri::command]
pub async fn export_snapshot(
    state: St<'_>,
    project_id: String,
    snapshot_id: String,
    dest_dir: String,
) -> CmdResult<Vec<String>> {
    let s = state.shell().await?;
    s.export_snapshot(&project_id, &snapshot_id, &dest_dir)
        .await
}

#[tauri::command]
pub async fn get_app_info(state: St<'_>) -> CmdResult<AppInfo> {
    let s = state.shell().await?;
    Ok(s.get_app_info())
}

#[tauri::command]
pub async fn open_in_openrocket(state: St<'_>, project_id: String, path: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.open_in_openrocket(&project_id, &path).await
}

#[tauri::command]
pub async fn open_folder(state: St<'_>, path: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.open_folder(&path)
}

#[tauri::command]
pub async fn get_app_settings(state: St<'_>) -> CmdResult<AppSettings> {
    let s = state.shell().await?;
    Ok(s.get_app_settings())
}

#[tauri::command]
pub async fn set_app_settings(state: St<'_>, settings: AppSettings) -> CmdResult<()> {
    let s = state.shell().await?;
    s.set_app_settings(settings)
}

#[tauri::command]
pub async fn export_diagnostics(state: St<'_>) -> CmdResult<String> {
    let s = state.shell().await?;
    s.export_diagnostics().await
}

#[tauri::command]
pub async fn check_for_update(state: St<'_>) -> CmdResult<UpdateInfo> {
    let s = state.shell().await?;
    s.check_for_update().await
}

#[tauri::command]
pub async fn install_update(state: St<'_>) -> CmdResult<()> {
    let s = state.shell().await?;
    s.install_update().await
}

#[tauri::command]
pub async fn notify_desktop(state: St<'_>, title: String, body: String) -> CmdResult<()> {
    let s = state.shell().await?;
    s.notify_desktop(&title, &body)
}
