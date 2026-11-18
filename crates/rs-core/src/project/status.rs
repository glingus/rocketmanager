//! Computation of the `ProjectStatus`, change collection, stability/validity and the stale-editor guard.

use super::*;
use crate::hooks::{is_open, EditorState};
use crate::tracker::Meta;
use crate::types::*;
use crate::util::{self, file_meta, iso_from_ms, iso_from_system_time, iso_to_utc};
use rs_git::{StatusKind, EMPTY_TREE};
use rs_store::{FileStateRecord, PublishPolicy};
use std::time::{Duration, SystemTime};

/// An unpublished change of one file with its stability/validity.
#[derive(Debug, Clone)]
pub(crate) struct LocalChange {
    pub path: String,
    pub change: FileChangeKind,
    pub size: Option<u64>,
    pub mtime: Option<SystemTime>,
    pub stable: bool,
    pub valid: Option<bool>,
    pub reason: Option<String>,
}

impl LocalChange {
    pub(crate) fn publishable(&self) -> bool {
        self.stable && (self.change == FileChangeKind::Deleted || self.valid == Some(true))
    }
}

pub(crate) type Observed = (Option<Meta>, bool, Option<bool>, Option<String>, bool);

impl ProjectInner {
    /// Observes one file (stability + validation) and returns what is known now:
    /// `(metadata, stable, valid, reason, unreadable)`.
    pub(crate) fn observe_file(&self, rel: &str) -> Observed {
        let abs = self.folder.join(rel);
        let meta = file_meta(&abs).map(|(size, mtime)| Meta { size, mtime });
        let now = Instant::now();
        let mut obs = self
            .tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe(rel, &abs, meta, now);
        if obs.needs_validation {
            if let Some(m) = meta {
                let result: Option<std::result::Result<(), String>> = if m.size > MAX_FILE_BYTES {
                    Some(Err("il file supera il limite di 100 MB".to_string()))
                } else {
                    match std::fs::read(&abs) {
                        Ok(bytes) => {
                            // The file may have changed while we were reading it: do not trust the result.
                            let after = file_meta(&abs).map(|(size, mtime)| Meta { size, mtime });
                            if after == meta {
                                Some(self.shared.config.inspector.validate(rel, &bytes))
                            } else {
                                None
                            }
                        }
                        Err(e) => Some(Err(format!("file non leggibile: {e}"))),
                    }
                };
                if let Some(r) = result {
                    let mut t = self.tracker.lock().unwrap_or_else(|p| p.into_inner());
                    t.set_validation(rel, r, now);
                    obs = t.observe(rel, &abs, meta, Instant::now());
                }
            }
        }
        let (valid, reason) = match &obs.validation {
            Some(v) => (Some(v.ok), v.reason.clone()),
            None => (None, None),
        };
        (meta, obs.stable, valid, reason, obs.unreadable)
    }

    /// Whether the file on disk has the same *content* as the HEAD blob `oid` according to the
    /// inspector (cached by file metadata).
    fn equals_head(&self, path: &str, meta: Meta, oid: &str) -> bool {
        if let Some((m, o, eq)) = self.rt(|r| r.equal_cache.get(path).cloned()) {
            if m == meta && o == oid {
                return eq;
            }
        }
        let eq = if meta.size > MAX_FILE_BYTES {
            false
        } else {
            match (std::fs::read(self.folder.join(path)), self.repo.cat_blob(oid)) {
                (Ok(disk), Ok(head)) => self.shared.config.inspector.content_equal(path, &disk, &head),
                _ => false,
            }
        };
        self.rt(|r| {
            r.equal_cache.insert(path.to_string(), (meta, oid.to_string(), eq));
        });
        eq
    }

    /// Unpublished changes of the working directory.
    pub(crate) fn local_changes(&self) -> Result<Vec<LocalChange>> {
        let entries = self.repo.status()?;
        let mut out = Vec::new();
        for e in entries {
            if e.path.starts_with(".rocketsync/local/")
                || util::is_rocket_temp(&e.path)
                || util::validate_rel_path(&e.path).is_err()
            {
                continue;
            }
            let change = if e.kind == StatusKind::Untracked || (e.x == 'A' && e.y != 'D') {
                FileChangeKind::Added
            } else if e.y == 'D' || e.x == 'D' {
                FileChangeKind::Deleted
            } else {
                FileChangeKind::Modified
            };
            let saving = util::save_in_progress(&self.folder.join(&e.path));
            if change == FileChangeKind::Deleted {
                // A deletion is real only if the file stays away for the whole debounce and no
                // OpenRocket save sequence (`ORSave*.tmp`, `<name>.ork-bak`) is going on.
                let (_, stable, _, _, _) = self.observe_file(&e.path);
                out.push(LocalChange {
                    path: e.path,
                    change,
                    size: None,
                    mtime: None,
                    stable: stable && !saving,
                    valid: Some(true),
                    reason: None,
                });
                continue;
            }
            let (meta, stable, valid, reason, unreadable) = self.observe_file(&e.path);
            let stable = stable && !saving;
            if change == FileChangeKind::Modified {
                if let (Some(m), Some(oid)) = (meta, e.head_oid.as_deref()) {
                    if self.equals_head(&e.path, m, oid) {
                        continue; // same content as HEAD (e.g. a re-save): not a change
                    }
                }
            }
            let reason = if unreadable {
                reason.map(|r| format!("illeggibile: {r}"))
            } else {
                reason
            };
            out.push(LocalChange {
                path: e.path,
                change,
                size: meta.map(|m| m.size),
                mtime: meta.map(|m| m.mtime),
                stable,
                valid,
                reason,
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        // Keep the tracker small and the store in sync with what is still changed.
        let keep: Vec<String> = out.iter().map(|c| c.path.clone()).collect();
        self.tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(&keep);
        self.persist_file_states(&out);
        Ok(out)
    }

    fn persist_file_states(&self, changes: &[LocalChange]) {
        let now = rs_store::now_ms();
        let mut to_save: Vec<FileStateRecord> = Vec::new();
        let mut removed = false;
        self.rt(|r| {
            for c in changes {
                if c.change == FileChangeKind::Deleted {
                    continue;
                }
                let mtime = c.mtime.map(util::ms_from_system_time).unwrap_or(0);
                let key = (c.stable, c.valid, c.size.unwrap_or(0) as i64, mtime);
                if r.persisted_states.get(&c.path) != Some(&key) {
                    r.persisted_states.insert(c.path.clone(), key);
                    to_save.push(FileStateRecord {
                        project_id: self.id.clone(),
                        path: c.path.clone(),
                        size: key.2,
                        mtime_ms: key.3,
                        stable: c.stable,
                        valid: c.valid,
                        invalid_reason: c.reason.clone(),
                        first_invalid_at: if c.valid == Some(false) {
                            Some(now)
                        } else {
                            None
                        },
                        checked_at: now,
                    });
                }
            }
            let before = r.persisted_states.len();
            r.persisted_states.retain(|p, _| {
                changes
                    .iter()
                    .any(|c| &c.path == p && c.change != FileChangeKind::Deleted)
            });
            removed = r.persisted_states.len() != before;
        });
        for s in to_save {
            let _ = self.shared.store.save_file_state(&s);
        }
        if removed {
            let keep: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();
            let _ = self.shared.store.retain_file_states(&self.id, &keep);
        }
    }

    /// Files (among `files`) that OpenRocket may have open.
    pub(crate) fn editor_blockers(&self, files: &[String]) -> Vec<String> {
        if files.is_empty() {
            return Vec::new();
        }
        match self.shared.config.detector.state(&self.folder) {
            EditorState::NotRunning => Vec::new(),
            EditorState::Running { open_files: None } => files.to_vec(),
            EditorState::Running {
                open_files: Some(open),
            } => files
                .iter()
                .filter(|f| is_open(&self.folder, f, &open))
                .cloned()
                .collect(),
        }
    }

    /// Versions created locally and not yet on `origin/main`, newest first.
    pub(crate) fn pending_commits(&self) -> Result<Vec<String>> {
        let head = self.head()?;
        match self.origin()? {
            Some(o) => {
                let range = format!("{o}..{head}");
                Ok(self.repo.rev_list(&["--first-parent", &range])?)
            }
            None => Ok(self.repo.rev_list(&["--first-parent", &head])?),
        }
    }

    pub(crate) fn count_behind(&self) -> Result<u32> {
        let head = self.head()?;
        let Some(o) = self.origin()? else {
            return Ok(0);
        };
        let range = format!("{head}..{o}");
        let out = self
            .repo
            .run(Cmd::new(["rev-list", "--count", "--first-parent", &range]))?;
        Ok(out.stdout_trimmed().parse().unwrap_or(0))
    }

    /// Paths that changed between the merge base of `main`/`origin` and `origin`.
    pub(crate) fn incoming_paths(&self) -> Result<Vec<String>> {
        let head = self.head()?;
        let Some(o) = self.origin()? else {
            return Ok(vec![]);
        };
        let base_tree = match self.repo.merge_base(&head, &o)? {
            Some(b) => self.repo.tree_of(&b)?,
            None => EMPTY_TREE.to_string(),
        };
        let otree = self.repo.tree_of(&o)?;
        Ok(self
            .repo
            .diff_tree(&base_tree, &otree, false)?
            .into_iter()
            .map(|d| d.path)
            .collect())
    }

    /// Suspected stale saves: watches whose file was saved while the editor was open.
    pub(crate) fn evaluate_guards(&self, changes: &[LocalChange]) -> Result<()> {
        let watches = self.shared.store.list_watches(&self.id)?;
        let active: Vec<&rs_store::GuardWatch> = watches.iter().filter(|w| !w.suspected).collect();
        if active.is_empty() {
            return Ok(());
        }
        let running = !matches!(
            self.shared.config.detector.state(&self.folder),
            EditorState::NotRunning
        );
        let paths: Vec<String> = active.iter().map(|w| w.path.clone()).collect();
        let hashes = self.repo.hash_files(&paths)?;
        for (w, h) in active.iter().zip(hashes) {
            let differs = h != w.new_blob;
            if differs {
                match changes.iter().find(|c| c.path == w.path) {
                    Some(c) if h.is_some() && c.stable && c.valid == Some(true) => {
                        let mut nw = (*w).clone();
                        nw.suspected = true;
                        self.shared.store.save_watch(&nw)?;
                        self.emit(EngineEvent::StaleSaveSuspected {
                            project_id: self.id.clone(),
                            path: w.path.clone(),
                        });
                    }
                    _ if h.is_none() => {
                        // The user deleted the file: nothing to protect any more.
                        self.shared.store.delete_watch(&self.id, &w.path)?;
                    }
                    _ => {}
                }
            } else if !running {
                self.shared.store.delete_watch(&self.id, &w.path)?;
            }
        }
        Ok(())
    }

    fn compute_auto_publish_at(
        &self,
        changes: &[LocalChange],
        stale: &[String],
        has_conflict: bool,
    ) -> Option<String> {
        if has_conflict || !stale.is_empty() {
            return None;
        }
        let policy = self
            .shared
            .store
            .get_publish_policy(&self.id)
            .unwrap_or_default();
        let publishable: Vec<String> = changes
            .iter()
            .filter(|c| c.publishable())
            .map(|c| c.path.clone())
            .collect();
        if publishable.is_empty() {
            return None;
        }
        let activity = self
            .tracker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last_activity(&publishable);
        let activity_wall = activity
            .map(|a| SystemTime::now() - Instant::now().saturating_duration_since(a))
            .unwrap_or_else(SystemTime::now);
        let last_publish = self.rt(|r| r.last_publish_at);
        let at = match policy {
            PublishPolicy::Manual => return None,
            PublishPolicy::Assisted { idle_minutes } => {
                activity_wall + Duration::from_secs(idle_minutes as u64 * 60)
            }
            PublishPolicy::OnSave {
                min_interval_minutes,
            } => {
                let earliest = last_publish
                    .map(|ms| {
                        std::time::UNIX_EPOCH
                            + Duration::from_millis(ms.max(0) as u64)
                            + Duration::from_secs(min_interval_minutes as u64 * 60)
                    })
                    .unwrap_or(std::time::UNIX_EPOCH);
                activity_wall.max(earliest)
            }
        };
        Some(iso_from_system_time(at))
    }

    /// Builds the complete status. Runs git; call from the worker only.
    pub(crate) fn compute_status(&self) -> Result<ProjectStatus> {
        let head = self.head()?;
        let origin = self.origin()?;
        let changes = self.local_changes()?;
        self.evaluate_guards(&changes)?;

        let pending_shas = self.pending_commits()?;
        let behind = self.count_behind()?;
        let has_conflict = self.has_open_conflict()?;
        let open_ids = self.open_conflict_ids()?;
        let stale: Vec<String> = self
            .shared
            .store
            .list_watches(&self.id)?
            .into_iter()
            .filter(|w| w.suspected)
            .map(|w| w.path)
            .collect();

        let (head_version, remote_version) = match &origin {
            Some(o) => {
                let hv = match self.repo.merge_base(&head, o)? {
                    Some(m) => self.version_of(&m)?,
                    None => None,
                };
                (hv, self.version_of(o)?)
            }
            None => (self.version_of(&head)?, None),
        };

        let (busy, offline, last_fetch, last_publish, last_error, retrying) = self.rt(|r| {
            (
                r.busy,
                r.offline,
                r.last_fetch_at,
                r.last_publish_at,
                r.last_error.clone(),
                r.retrying,
            )
        });

        let blocked_by_editor = if behind > 0 && !has_conflict {
            let inc = self.incoming_paths()?;
            self.editor_blockers(&inc)
        } else {
            Vec::new()
        };

        let mut pending_versions = Vec::new();
        for sha in &pending_shas {
            let info = self.repo.commit_info(sha)?;
            let parsed = crate::message::parse_version_message(&info.message);
            let waiting = if has_conflict {
                Some(WaitingReason::Conflict)
            } else if offline {
                Some(WaitingReason::Offline)
            } else if !blocked_by_editor.is_empty() {
                Some(WaitingReason::BlockedByEditor)
            } else if retrying {
                Some(WaitingReason::Retrying)
            } else {
                None
            };
            pending_versions.push(PendingVersion {
                sha: sha.clone(),
                title: parsed.title,
                created_at: iso_to_utc(info.author.when_iso.as_deref().unwrap_or("")),
                waiting_reason: waiting,
            });
        }

        let state = if last_error.is_some() {
            SyncState::Error
        } else if has_conflict {
            SyncState::Conflict
        } else if let Some(b) = busy {
            match b {
                Busy::Publishing => SyncState::Publishing,
                Busy::Updating => SyncState::Updating,
            }
        } else if offline && !pending_versions.is_empty() {
            SyncState::Offline
        } else if behind > 0 {
            SyncState::UpdateAvailable
        } else if !changes.is_empty() || !pending_versions.is_empty() {
            SyncState::LocalChanges
        } else {
            SyncState::Synced
        };

        let auto_publish_at = if busy.is_some() {
            None
        } else {
            self.compute_auto_publish_at(&changes, &stale, has_conflict)
        };

        let repo_size = self.repo_size_bytes();

        let changed_files = changes
            .iter()
            .map(|c| ChangedFile {
                path: c.path.clone(),
                change: c.change,
                old_path: None,
                stable: c.stable,
                valid: c.valid,
                invalid_reason: if c.valid == Some(false) {
                    c.reason.clone()
                } else {
                    None
                },
                size_bytes: c.size,
                modified_at: c.mtime.map(iso_from_system_time),
            })
            .collect();

        Ok(ProjectStatus {
            project_id: self.id.clone(),
            state,
            folder: Some(self.folder.to_string_lossy().into_owned()),
            head_version,
            remote_version,
            behind_by: behind,
            changed_files,
            pending_versions,
            blocked_by_editor,
            open_conflict_ids: open_ids,
            stale_save_suspected: stale,
            last_fetch_at: last_fetch.map(iso_from_ms),
            last_publish_at: last_publish.map(iso_from_ms),
            auto_publish_at,
            repo_size_bytes: repo_size,
            error: last_error,
        })
    }

    fn repo_size_bytes(&self) -> Option<u64> {
        let cached = self.rt(|r| r.repo_size);
        if let Some((at, v)) = cached {
            if at.elapsed() < Duration::from_secs(60) {
                return Some(v);
            }
        }
        let v = self.repo.object_store_kib().ok()? * 1024;
        self.rt(|r| r.repo_size = Some((Instant::now(), v)));
        Some(v)
    }

    /// Recomputes the status, stores it and emits `StatusChanged` when it differs from the last one.
    pub(crate) fn refresh_status(&self) -> Result<ProjectStatus> {
        self.dirty.store(false, std::sync::atomic::Ordering::SeqCst);
        let st = self.compute_status()?;
        let changed = self.rt(|r| {
            let changed = r.last_status.as_ref() != Some(&st);
            r.last_status = Some(st.clone());
            changed
        });
        if changed {
            self.emit(EngineEvent::StatusChanged(Box::new(st.clone())));
        }
        Ok(st)
    }

    /// Fresh status for a command result.
    pub(crate) fn status_now(&self) -> Result<ProjectStatus> {
        self.refresh_status()
    }

    /// Emits the last known status again with the busy state applied (cheap, no git).
    pub(crate) fn emit_status_quiet(&self) {
        let st = self.rt(|r| {
            r.last_status.clone().map(|mut s| {
                s.state = match r.busy {
                    Some(Busy::Publishing) => SyncState::Publishing,
                    Some(Busy::Updating) => SyncState::Updating,
                    None => s.state,
                };
                s
            })
        });
        if let Some(s) = st {
            self.emit(EngineEvent::StatusChanged(Box::new(s)));
        }
    }

    /// Whether the background loop must keep watching the clock (unstable or unvalidated files,
    /// or a scheduled automatic publication).
    pub(crate) fn needs_followup(&self) -> bool {
        self.rt(|r| {
            r.last_status.as_ref().is_some_and(|s| {
                s.changed_files.iter().any(|f| {
                    !f.stable || (f.valid.is_none() && f.change != FileChangeKind::Deleted)
                }) || s.auto_publish_at.is_some()
            })
        })
    }
}
