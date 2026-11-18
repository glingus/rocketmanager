//! Forwards the engine events to the interface (`app.emit`) and raises desktop notifications.

use crate::platform::Platform;
use crate::settings::AppSettings;
use rs_core::EngineEvent;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

/// Destination of the events (Tauri's `AppHandle` in the application).
pub trait EventSink: Send + Sync {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

/// Text of the desktop notification for an event, if it deserves one.
pub fn notification_for(ev: &EngineEvent) -> Option<(String, String)> {
    match ev {
        EngineEvent::UpdateApplied { to_version, files, .. } => Some((
            "Progetto aggiornato".into(),
            match to_version {
                Some(v) => format!("Aggiornato alla versione {v} ({} file).", files.len()),
                None => format!("Aggiornati {} file.", files.len()),
            },
        )),
        EngineEvent::ConflictDetected { files, .. } => Some((
            "Conflitto da risolvere".into(),
            format!("Hai modificato lo stesso file di un collega: {}.", files.join(", ")),
        )),
        EngineEvent::StaleSaveSuspected { path, .. } => Some((
            "Salvataggio da controllare".into(),
            format!("«{path}» potrebbe essere stato salvato da una copia non aggiornata."),
        )),
        EngineEvent::RecoveryPerformed { summary, .. } => Some(("Recupero dopo un arresto".into(), summary.clone())),
        EngineEvent::SyncError { error, .. } if error.code != rs_core::ErrorCode::Network => {
            Some(("Problema di sincronizzazione".into(), error.message.clone()))
        }
        _ => None,
    }
}

/// Runs until the engine is dropped: every event goes to `sink` with the contract's name and payload.
pub async fn forward(
    mut rx: broadcast::Receiver<EngineEvent>,
    sink: Arc<dyn EventSink>,
    platform: Arc<dyn Platform>,
    settings: Arc<RwLock<AppSettings>>,
) {
    loop {
        match rx.recv().await {
            Ok(ev) => {
                let (name, payload) = ev.to_ipc();
                sink.emit(name, payload);
                let notify = settings.read().map(|s| s.desktop_notifications).unwrap_or(true);
                if notify {
                    if let Some((t, b)) = notification_for(&ev) {
                        let _ = platform.notify(&t, &b);
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(lost = n, "event receiver lagged");
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_only_for_events_that_matter() {
        let upd = EngineEvent::UpdateApplied { project_id: "p".into(), from_version: Some(1), to_version: Some(2), files: vec!["a".into()] };
        assert!(notification_for(&upd).unwrap().1.contains("versione 2"));
        let status = EngineEvent::OperationProgress { project_id: "p".into(), op: "x".into(), step: "y".into(), percent: None, message: String::new() };
        assert!(notification_for(&status).is_none());
        let net = EngineEvent::SyncError {
            project_id: "p".into(),
            error: rs_core::CoreError::Git(rs_git::GitError::Network { stderr: "x".into() }).to_app_error(),
        };
        assert!(notification_for(&net).is_none(), "being offline is not worth a notification");
        let other = EngineEvent::SyncError { project_id: "p".into(), error: rs_core::CoreError::Internal("x".into()).to_app_error() };
        assert!(notification_for(&other).is_some());
    }
}
