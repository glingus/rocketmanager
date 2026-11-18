//! Background loop of one project: status refresh, periodic fetch, automatic publication.

use super::*;
use crate::types::{PublishRequest, SyncState};
use chrono::{DateTime, Utc};
use serde_json::json;
use std::time::Duration;

impl ProjectInner {
    /// One iteration of the background loop. Runs on the worker, between two commands.
    pub(crate) fn tick(&self) {
        let cfg = &self.shared.config;
        let now = Instant::now();
        if cfg.background {
            let (due, notified) = self.rt(|r| (now >= r.next_fetch, r.remote_notified));
            if due || notified {
                let interval = cfg.timing.fetch_interval;
                self.rt(|r| {
                    r.next_fetch = now + interval;
                    r.remote_notified = false;
                });
                self.background_sync();
            }
        }

        let watching = self
            .shared
            .store
            .list_watches(&self.id)
            .map(|w| !w.is_empty())
            .unwrap_or(false);
        let need_status = self.dirty.load(std::sync::atomic::Ordering::SeqCst)
            || self.needs_followup()
            || watching
            || self.rt(|r| r.last_status.is_none());
        if need_status {
            if let Err(e) = self.refresh_status() {
                tracing::warn!(project = %self.id, error = %e, "status refresh failed");
                self.note_error(&e);
            }
        }
        if cfg.background {
            self.maybe_auto_publish();
        }
    }

    /// Periodic fetch; runs the full sync only when there is something to do (keeps the journal small).
    pub(crate) fn background_sync(&self) {
        let before = self.origin().ok().flatten();
        match self.fetch_remote() {
            Ok(()) => {}
            Err(e) if e.is_network() => {
                self.mark_dirty();
                return;
            }
            Err(e) => {
                self.note_error(&e);
                return;
            }
        }
        let after = self.origin().ok().flatten();
        let incoming = match (&after, self.head()) {
            (Some(o), Ok(h)) => !self.repo.is_ancestor(o, &h).unwrap_or(false),
            _ => false,
        };
        let pending = self.pending_commits().map(|p| !p.is_empty()).unwrap_or(false);
        let open_conflict = self.has_open_conflict().unwrap_or(false);
        if !open_conflict && (before != after || incoming || pending) {
            let _ = self.run_op("sync", Busy::Updating, json!({"background": true}), |op| {
                self.sync_after_fetch(op)
            });
        }
        let _ = self.retry_conflict_branches();
        self.mark_dirty();
    }

    fn maybe_auto_publish(&self) {
        let (status, backoff) = self.rt(|r| (r.last_status.clone(), r.auto_publish_backoff));
        let Some(status) = status else { return };
        if matches!(status.state, SyncState::Conflict | SyncState::Error)
            || !status.open_conflict_ids.is_empty()
            || !status.stale_save_suspected.is_empty()
        {
            return;
        }
        if let Some(b) = backoff {
            if Instant::now() < b {
                return;
            }
        }
        let Some(at) = status.auto_publish_at.as_deref() else {
            return;
        };
        let Ok(due) = DateTime::parse_from_rfc3339(at) else {
            return;
        };
        if due.with_timezone(&Utc) > Utc::now() {
            return;
        }
        let paths: Vec<String> = status
            .changed_files
            .iter()
            .filter(|f| {
                f.stable
                    && (f.change == crate::types::FileChangeKind::Deleted || f.valid == Some(true))
                    && !status.stale_save_suspected.contains(&f.path)
            })
            .map(|f| f.path.clone())
            .collect();
        if paths.is_empty() {
            return;
        }
        let req = PublishRequest {
            title: None,
            description: None,
            paths: Some(paths),
        };
        if let Err(e) = self.publish(&req) {
            tracing::info!(project = %self.id, error = %e, "automatic publication failed");
            let retry: Duration = self.shared.config.timing.auto_publish_retry;
            self.rt(|r| r.auto_publish_backoff = Some(Instant::now() + retry));
        }
    }
}
