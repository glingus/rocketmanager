//! Plain data records persisted by the store.

use serde::{Deserialize, Serialize};

/// A project linked to a local folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub project_id: String,
    /// `owner/repo` on GitHub (informational).
    pub repo_full_name: String,
    /// URL used for `origin`.
    pub remote_url: String,
    pub folder: String,
    /// Unix ms.
    pub linked_at: i64,
}

/// Publication policy of a project. Serializes as the `PublishPolicy` of the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PublishPolicy {
    /// Banner with a "Publish" button; automatic publication after `idle_minutes` without saves.
    Assisted { idle_minutes: u32 },
    /// Only when the user asks.
    Manual,
    /// A version after each save, with a minimum interval between two versions.
    OnSave { min_interval_minutes: u32 },
}

impl Default for PublishPolicy {
    fn default() -> Self {
        PublishPolicy::Assisted { idle_minutes: 10 }
    }
}

/// One row of the operation journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub op_id: String,
    pub project_id: String,
    pub kind: String,
    pub step: String,
    pub payload: serde_json::Value,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    /// `ok`, `failed`, `recovered`, ...
    pub outcome: Option<String>,
    /// Human readable note (e.g. the summary of a recovery).
    pub note: Option<String>,
}

/// Status of a conflict in the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStatus {
    /// Waiting for the user.
    Open,
    /// The user has chosen; the resolution commit exists locally but has not been sent yet.
    Resolving,
    /// The resolution has been published.
    Resolved,
}

impl ConflictStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ConflictStatus::Open => "open",
            ConflictStatus::Resolving => "resolving",
            ConflictStatus::Resolved => "resolved",
        }
    }
    pub(crate) fn parse(s: &str) -> Self {
        match s {
            "resolving" => ConflictStatus::Resolving,
            "resolved" => ConflictStatus::Resolved,
            _ => ConflictStatus::Open,
        }
    }
}

/// A conflicting file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictFileRecord {
    pub path: String,
    /// `bothModified`, `bothAdded`, `modifiedDeleted`, `deletedModified`.
    pub kind: String,
}

/// A local conflict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConflictRecord {
    pub id: String,
    pub project_id: String,
    pub status: ConflictStatus,
    pub created_at: i64,
    pub base_sha: String,
    pub ours_sha: String,
    pub theirs_sha: String,
    pub theirs_version: Option<i64>,
    pub theirs_author: Option<String>,
    pub remote_branch_pushed: bool,
    /// `sync` (overlap between local and incoming changes) or `stale-save`.
    pub origin: String,
    pub files: Vec<ConflictFileRecord>,
    pub resolution: Option<serde_json::Value>,
    /// The merge commit created by the resolution.
    pub resolution_sha: Option<String>,
    pub resolved_at: Option<i64>,
    pub resolved_version: Option<i64>,
}

/// "Stale editor" surveillance of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardWatch {
    pub project_id: String,
    pub path: String,
    /// Blob id before Rocket Sync wrote the file (`None` if the file did not exist).
    pub old_blob: Option<String>,
    /// Blob id written by Rocket Sync (`None` if the file was deleted).
    pub new_blob: Option<String>,
    /// Commit that was `HEAD` before the update.
    pub old_commit: String,
    /// Commit that was `HEAD` after the update.
    pub new_commit: String,
    pub version: Option<i64>,
    pub written_at: i64,
    /// A save was detected and the user has not answered yet.
    pub suspected: bool,
}

/// Last known state of a changed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStateRecord {
    pub project_id: String,
    pub path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub stable: bool,
    pub valid: Option<bool>,
    pub invalid_reason: Option<String>,
    pub first_invalid_at: Option<i64>,
    pub checked_at: i64,
}
