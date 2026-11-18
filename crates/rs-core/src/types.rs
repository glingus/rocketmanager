//! Public data types. They serialize (camelCase) exactly as the IPC contract
//! (`docs/contratto-ipc.md`). The semantic-diff fields (`ork`, `threeWay`) are always `None`
//! here: the Tauri shell fills them using `rs-ork`.

use crate::error::AppError;
pub use rs_store::PublishPolicy;
use serde::{Deserialize, Serialize};

/// `SyncState` of the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    Synced,
    LocalChanges,
    Publishing,
    UpdateAvailable,
    Updating,
    Conflict,
    Offline,
    Error,
    NotLinked,
}

/// `FileChangeKind` of the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// A file with unpublished changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the project folder, `/` separated.
    pub path: String,
    pub change: FileChangeKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub old_path: Option<String>,
    pub stable: bool,
    /// `None` = not validated yet.
    pub valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub invalid_reason: Option<String>,
    pub size_bytes: Option<u64>,
    pub modified_at: Option<String>,
}

/// Why a pending version has not been sent yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WaitingReason {
    Offline,
    BlockedByEditor,
    Conflict,
    Retrying,
}

/// A version created locally and not yet sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingVersion {
    pub sha: String,
    pub title: String,
    pub created_at: String,
    pub waiting_reason: Option<WaitingReason>,
}

/// Complete state of a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub project_id: String,
    pub state: SyncState,
    pub folder: Option<String>,
    pub head_version: Option<i64>,
    pub remote_version: Option<i64>,
    pub behind_by: u32,
    pub changed_files: Vec<ChangedFile>,
    pub pending_versions: Vec<PendingVersion>,
    pub blocked_by_editor: Vec<String>,
    pub open_conflict_ids: Vec<String>,
    pub stale_save_suspected: Vec<String>,
    pub last_fetch_at: Option<String>,
    pub last_publish_at: Option<String>,
    pub auto_publish_at: Option<String>,
    pub repo_size_bytes: Option<u64>,
    pub error: Option<AppError>,
}

/// `VersionKind` of the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionKind {
    Init,
    Publish,
    Restore,
    ConflictResolution,
}

/// Group of changelog lines for one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogGroup {
    pub path: String,
    pub lines: Vec<String>,
    pub interpreted: bool,
}

/// Author of a version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionAuthor {
    pub name: String,
    pub email: String,
    pub github_login: Option<String>,
}

/// A file touched by a version or by a comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub change: FileChangeKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub old_path: Option<String>,
    pub binary: bool,
    pub size_before: Option<u64>,
    pub size_after: Option<u64>,
}

/// A version of the project (published or pending).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    /// `None` = pending.
    pub number: Option<i64>,
    pub sha: String,
    pub kind: VersionKind,
    pub title: String,
    pub description: Option<String>,
    pub changelog: Vec<ChangelogGroup>,
    pub author: VersionAuthor,
    pub date: String,
    pub files: Vec<FileChange>,
    pub restored_from: Option<i64>,
    pub conflict_id: Option<String>,
    pub published: bool,
}

/// `VersionRef` of the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRef {
    pub number: Option<i64>,
    pub sha: String,
}

/// Comparison of one file between two versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileComparison {
    #[serde(flatten)]
    pub file: FileChange,
    /// Semantic diff of `.ork` files: filled by the shell (always `None` here).
    pub ork: Option<serde_json::Value>,
    /// Unified diff, only for text files.
    pub text_diff: Option<String>,
    pub note: Option<String>,
    /// Content of the file in the "from" version (not serialized).
    #[serde(skip)]
    pub before: Option<Vec<u8>>,
    /// Content of the file in the "to" version (not serialized).
    #[serde(skip)]
    pub after: Option<Vec<u8>>,
}

/// Comparison between two versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub from: VersionRef,
    pub to: VersionRef,
    pub files: Vec<FileComparison>,
}

/// Status of a conflict as exposed by the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStatusDto {
    Open,
    Resolved,
}

/// Kind of a conflicting file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictFileKind {
    /// Changed by both sides.
    BothModified,
    /// Added by both sides with different content.
    BothAdded,
    /// Modified locally, deleted by the colleague.
    ModifiedDeleted,
    /// Deleted locally, modified by the colleague.
    DeletedModified,
}

impl ConflictFileKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ConflictFileKind::BothModified => "bothModified",
            ConflictFileKind::BothAdded => "bothAdded",
            ConflictFileKind::ModifiedDeleted => "modifiedDeleted",
            ConflictFileKind::DeletedModified => "deletedModified",
        }
    }
    pub(crate) fn parse(s: &str) -> Self {
        match s {
            "bothAdded" => ConflictFileKind::BothAdded,
            "modifiedDeleted" => ConflictFileKind::ModifiedDeleted,
            "deletedModified" => ConflictFileKind::DeletedModified,
            _ => ConflictFileKind::BothModified,
        }
    }
}

/// A conflicting file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictFileKind,
    /// Three-way semantic diff: filled by the shell (always `None` here).
    pub three_way: Option<serde_json::Value>,
}

/// A conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub project_id: String,
    pub status: ConflictStatusDto,
    pub created_at: String,
    pub base_sha: String,
    pub ours_sha: String,
    pub theirs_sha: String,
    pub theirs_version: Option<i64>,
    pub theirs_author: Option<String>,
    pub remote_branch_pushed: bool,
    pub files: Vec<ConflictFile>,
}

/// Which side of a conflict to read or export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Base,
    Ours,
    Theirs,
}

/// Choice of the user for a conflicting file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionChoice {
    Mine,
    Theirs,
    Both,
    Manual,
}

impl ResolutionChoice {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ResolutionChoice::Mine => "mine",
            ResolutionChoice::Theirs => "theirs",
            ResolutionChoice::Both => "both",
            ResolutionChoice::Manual => "manual",
        }
    }
}

/// One resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResolution {
    pub path: String,
    pub choice: ResolutionChoice,
}

/// A safety copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub created_at: String,
    pub operation: String,
    pub file_count: u64,
}

/// A linked project (`LocalProject` of the contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub project_id: String,
    pub folder: String,
    pub repo_full_name: String,
    pub linked_at: String,
}

/// Synced-drive providers recognised by [`crate::Engine::check_folder`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncedDrive {
    Onedrive,
    Dropbox,
    GoogleDrive,
}

/// Result of `check_folder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    pub exists: bool,
    pub empty: bool,
    pub writable: bool,
    pub in_synced_drive: Option<SyncedDrive>,
    pub file_count: u64,
}

/// Request of `publish`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    /// Only these paths (default: all unpublished changes).
    pub paths: Option<Vec<String>>,
}

/// Request of `link_project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
    pub project_id: String,
    /// `owner/repo`.
    pub repo_full_name: String,
    /// Remote URL; defaults to `https://github.com/<repo_full_name>.git`. Never contains credentials.
    pub remote_url: Option<String>,
    pub folder: String,
    /// Accept a folder inside OneDrive/Dropbox/Google Drive.
    #[serde(default)]
    pub allow_synced_drive: bool,
}

/// What the recovery at startup did for one operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub project_id: String,
    pub op_id: String,
    pub summary: String,
}
