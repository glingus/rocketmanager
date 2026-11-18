//! Events emitted by the engine (`docs/contratto-ipc.md` §6, `docs/protocollo-sync.md` §11).

use crate::error::AppError;
use crate::types::ProjectStatus;
use serde_json::{json, Value};

/// An event of the engine. Use [`EngineEvent::to_ipc`] to get the `(name, payload)` pair the shell
/// emits towards the interface.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// `project-status`
    StatusChanged(Box<ProjectStatus>),
    /// `operation-progress`
    OperationProgress {
        project_id: String,
        op: String,
        step: String,
        percent: Option<f32>,
        message: String,
    },
    /// `version-published`
    VersionPublished {
        project_id: String,
        number: i64,
        sha: String,
        title: String,
    },
    /// `update-applied`
    UpdateApplied {
        project_id: String,
        from_version: Option<i64>,
        to_version: Option<i64>,
        files: Vec<String>,
    },
    /// `conflict-detected`
    ConflictDetected {
        project_id: String,
        conflict_id: String,
        files: Vec<String>,
    },
    /// `conflict-resolved`
    ConflictResolved {
        project_id: String,
        conflict_id: String,
        number: Option<i64>,
    },
    /// `stale-save-suspected`
    StaleSaveSuspected { project_id: String, path: String },
    /// `recovery-performed`
    RecoveryPerformed {
        project_id: String,
        op_id: String,
        summary: String,
    },
    /// `sync-error`
    SyncError { project_id: String, error: AppError },
}

impl EngineEvent {
    /// Project the event refers to.
    pub fn project_id(&self) -> &str {
        match self {
            EngineEvent::StatusChanged(s) => &s.project_id,
            EngineEvent::OperationProgress { project_id, .. }
            | EngineEvent::VersionPublished { project_id, .. }
            | EngineEvent::UpdateApplied { project_id, .. }
            | EngineEvent::ConflictDetected { project_id, .. }
            | EngineEvent::ConflictResolved { project_id, .. }
            | EngineEvent::StaleSaveSuspected { project_id, .. }
            | EngineEvent::RecoveryPerformed { project_id, .. }
            | EngineEvent::SyncError { project_id, .. } => project_id,
        }
    }

    /// Event name of the IPC contract.
    pub fn name(&self) -> &'static str {
        match self {
            EngineEvent::StatusChanged(_) => "project-status",
            EngineEvent::OperationProgress { .. } => "operation-progress",
            EngineEvent::VersionPublished { .. } => "version-published",
            EngineEvent::UpdateApplied { .. } => "update-applied",
            EngineEvent::ConflictDetected { .. } => "conflict-detected",
            EngineEvent::ConflictResolved { .. } => "conflict-resolved",
            EngineEvent::StaleSaveSuspected { .. } => "stale-save-suspected",
            EngineEvent::RecoveryPerformed { .. } => "recovery-performed",
            EngineEvent::SyncError { .. } => "sync-error",
        }
    }

    /// JSON payload as defined by the contract.
    pub fn payload(&self) -> Value {
        match self {
            EngineEvent::StatusChanged(s) => serde_json::to_value(s).unwrap_or(Value::Null),
            EngineEvent::OperationProgress {
                project_id,
                op,
                step,
                percent,
                message,
            } => {
                json!({"projectId": project_id, "op": op, "step": step, "percent": percent, "message": message})
            }
            EngineEvent::VersionPublished {
                project_id,
                number,
                sha,
                title,
            } => json!({"projectId": project_id, "number": number, "sha": sha, "title": title}),
            EngineEvent::UpdateApplied {
                project_id,
                from_version,
                to_version,
                files,
            } => {
                json!({"projectId": project_id, "fromVersion": from_version, "toVersion": to_version, "files": files})
            }
            EngineEvent::ConflictDetected {
                project_id,
                conflict_id,
                files,
            } => json!({"projectId": project_id, "conflictId": conflict_id, "files": files}),
            EngineEvent::ConflictResolved {
                project_id,
                conflict_id,
                number,
            } => json!({"projectId": project_id, "conflictId": conflict_id, "number": number}),
            EngineEvent::StaleSaveSuspected { project_id, path } => {
                json!({"projectId": project_id, "path": path})
            }
            EngineEvent::RecoveryPerformed {
                project_id,
                summary,
                ..
            } => json!({"projectId": project_id, "summary": summary}),
            EngineEvent::SyncError { project_id, error } => {
                json!({"projectId": project_id, "error": error})
            }
        }
    }

    /// `(event name, JSON payload)` ready for `emit`.
    pub fn to_ipc(&self) -> (&'static str, Value) {
        (self.name(), self.payload())
    }
}
