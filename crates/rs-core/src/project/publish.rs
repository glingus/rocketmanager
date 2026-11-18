//! Publication (`§7.4`): selection and checks of the files, local commit, and discarding changes.

use super::integrate::SendOutcome;
use super::snapshot::TempIndex;
use super::status::LocalChange;
use super::*;
use crate::hooks::FileInspector as _;
use crate::message::VersionMessage;
use crate::types::{ChangelogGroup, FileChangeKind, PublishRequest, VersionKind};
use crate::util::{self, atomic_write, file_meta, remove_file_retry};
use rs_git::{CommitSpec, IndexInfoEntry};
use serde_json::json;
use std::time::Duration;

/// The exact bytes of a file as validated, to be committed.
#[derive(Debug, Clone)]
pub(crate) struct LocalInput {
    pub path: String,
    /// `None` = the file was deleted.
    pub bytes: Option<Vec<u8>>,
}

/// Default title when the user did not write one.
pub(crate) fn default_title(inputs: &[LocalInput], head_has: impl Fn(&str) -> bool) -> String {
    if inputs.len() == 1 {
        let i = &inputs[0];
        let verb = match (&i.bytes, head_has(&i.path)) {
            (None, _) => "Rimosso",
            (Some(_), true) => "Modificato",
            (Some(_), false) => "Aggiunto",
        };
        format!("{verb} {}", i.path)
    } else {
        format!("Modificati {} file", inputs.len())
    }
}

impl ProjectInner {
    /// Waits (bounded) for the selected files to be stable, then checks size and validity and
    /// reads the exact bytes that will be committed.
    pub(crate) fn ensure_publishable(&self, paths: Option<&[String]>) -> Result<Vec<LocalInput>> {
        if let Some(ps) = paths {
            for p in ps {
                util::validate_rel_path(p)?;
            }
        }
        let timing = self.shared.config.timing.clone();
        let deadline = Instant::now() + timing.stability_wait;
        let selected: Vec<LocalChange> = loop {
            let changes = self.local_changes()?;
            let sel: Vec<LocalChange> = match paths {
                Some(ps) => changes.into_iter().filter(|c| ps.contains(&c.path)).collect(),
                None => changes,
            };
            let mut unstable: Vec<String> = sel
                .iter()
                .filter(|c| !c.stable || (c.valid.is_none() && c.change != FileChangeKind::Deleted))
                .map(|c| c.path.clone())
                .collect();
            if unstable.is_empty() {
                // Two metadata reads `stability_gap` apart must agree.
                let before: Vec<_> = sel.iter().map(|c| file_meta(&self.folder.join(&c.path))).collect();
                std::thread::sleep(timing.stability_gap);
                let after: Vec<_> = sel.iter().map(|c| file_meta(&self.folder.join(&c.path))).collect();
                for ((b, a), c) in before.iter().zip(&after).zip(&sel) {
                    if b != a {
                        unstable.push(c.path.clone());
                    }
                }
                if unstable.is_empty() {
                    break sel;
                }
            }
            if Instant::now() >= deadline {
                unstable.sort();
                unstable.dedup();
                return Err(CoreError::FileNotStable(unstable));
            }
            std::thread::sleep(timing.stability_gap.min(Duration::from_millis(250)));
        };

        for c in &selected {
            if let Some(sz) = c.size {
                if sz > MAX_FILE_BYTES {
                    return Err(CoreError::FileTooLarge {
                        path: c.path.clone(),
                        size: sz,
                    });
                }
                if sz > WARN_FILE_BYTES {
                    self.progress(
                        "publish",
                        "warning",
                        None,
                        &format!("Il file «{}» supera i 50 MB: GitHub accetta file fino a 100 MB.", c.path),
                    );
                }
            }
        }
        for c in &selected {
            if c.valid == Some(false) {
                return Err(CoreError::FileInvalid {
                    path: c.path.clone(),
                    reason: c.reason.clone().unwrap_or_else(|| "file non valido".into()),
                });
            }
        }
        // Read once, validate the very bytes that are going to be committed.
        let mut inputs = Vec::new();
        for c in &selected {
            if c.change == FileChangeKind::Deleted {
                inputs.push(LocalInput {
                    path: c.path.clone(),
                    bytes: None,
                });
                continue;
            }
            let bytes = std::fs::read(self.folder.join(&c.path))?;
            if let Err(reason) = self.shared.config.inspector.validate(&c.path, &bytes) {
                return Err(CoreError::FileInvalid {
                    path: c.path.clone(),
                    reason,
                });
            }
            inputs.push(LocalInput {
                path: c.path.clone(),
                bytes: Some(bytes),
            });
        }
        Ok(inputs)
    }

    /// Creates the pending version holding exactly `inputs` on top of `main`.
    pub(crate) fn commit_local(
        &self,
        inputs: &[LocalInput],
        title: &str,
        description: Option<&str>,
        kind: VersionKind,
    ) -> Result<String> {
        let identity = self.shared.identity()?;
        let head = self.head()?;
        let head_tree = self.repo.tree_of(&head)?;
        let head_map = self.repo.tree_map(&head)?;
        let idx = TempIndex::new(&self.repo);
        self.repo.read_tree(Some(idx.path()), &head_tree)?;

        let mut entries = Vec::new();
        for i in inputs {
            util::validate_rel_path(&i.path)?;
            let mode_oid = match &i.bytes {
                Some(b) => {
                    let oid = self.repo.write_blob(b)?;
                    let mode = head_map
                        .get(&i.path)
                        .map(|e| e.mode.clone())
                        .unwrap_or_else(|| "100644".to_string());
                    Some((mode, oid))
                }
                None => None,
            };
            entries.push(IndexInfoEntry {
                path: i.path.clone(),
                mode_oid,
            });
        }
        self.repo.update_index_info(Some(idx.path()), &entries)?;
        let tree = self.repo.write_tree(Some(idx.path()))?;
        if tree == head_tree {
            return Err(CoreError::NothingToPublish);
        }

        let mut groups = Vec::new();
        let mut sorted: Vec<&LocalInput> = inputs.iter().collect();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        for i in sorted {
            let before = match head_map.get(&i.path) {
                Some(e) => Some(self.repo.cat_blob(&e.oid)?),
                None => None,
            };
            let mut lines = self
                .shared
                .config
                .inspector
                .changelog(&i.path, before.as_deref(), i.bytes.as_deref());
            lines.retain(|l| !l.trim().is_empty());
            if lines.is_empty() {
                lines = crate::hooks::DefaultInspector.changelog(&i.path, before.as_deref(), i.bytes.as_deref());
            }
            let interpreted = !lines.iter().all(|l| crate::hooks::is_generic_line(l));
            groups.push(ChangelogGroup {
                path: i.path.clone(),
                lines,
                interpreted,
            });
        }

        let mut vm = VersionMessage::new(kind, title, &self.shared.config.client_version);
        vm.description = description.map(str::to_string);
        vm.changelog = groups;
        let msg = vm.render();
        let sig = rs_git::Signature::now(identity.name, identity.email);
        let commit = self.repo.commit_tree(&CommitSpec {
            tree: &tree,
            parents: &[head.clone()],
            message: &msg,
            author: &sig,
            committer: &sig,
        })?;
        self.repo.update_ref(MAIN_REF, &commit, Some(&head))?;
        // The real index mirrors the new HEAD for the committed paths.
        self.repo.update_index_info(None, &entries)?;
        self.repo.refresh_index()?;
        Ok(commit)
    }

    /// `publish`: commit the selected changes as a pending version and send everything pending.
    pub(crate) fn publish(&self, req: &PublishRequest) -> Result<ProjectStatus> {
        self.run_op(
            "publish",
            Busy::Publishing,
            json!({"paths": req.paths, "title": req.title}),
            |op| {
                if self.has_open_conflict()? {
                    return Err(CoreError::ConflictOpen);
                }
                self.publish_local(op, req)?;
                match self.send_pending(op, false)? {
                    SendOutcome::ConflictOpen => Err(CoreError::ConflictOpen),
                    _ => Ok(()),
                }
            },
        )?;
        self.status_now()
    }

    /// First half of the publication: checks, safety copy and local commit.
    fn publish_local(&self, op: &OpCtx, req: &PublishRequest) -> Result<()> {
        let stale: Vec<String> = self
            .shared
            .store
            .list_watches(&self.id)?
            .into_iter()
            .filter(|w| w.suspected)
            .map(|w| w.path)
            .collect();
        let blocked: Vec<String> = match &req.paths {
            Some(ps) => stale.iter().filter(|s| ps.contains(s)).cloned().collect(),
            None => stale,
        };
        if !blocked.is_empty() {
            return Err(CoreError::StaleSavePending(blocked));
        }
        let inputs = self.ensure_publishable(req.paths.as_deref())?;
        if inputs.is_empty() {
            if self.pending_commits()?.is_empty() {
                return Err(CoreError::NothingToPublish);
            }
            return Ok(()); // only pending versions to send
        }
        self.progress("publish", "snapshot", None, "Copia di sicurezza");
        self.safety_snapshot("pubblicazione")?;
        self.step(op, "snapshot", None)?;
        let head = self.head()?;
        let head_map = self.repo.tree_map(&head)?;
        let title = match req.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => t.to_string(),
            None => default_title(&inputs, |p| head_map.contains_key(p)),
        };
        let desc = req.description.as_deref().map(str::trim).filter(|d| !d.is_empty());
        let commit = self.commit_local(&inputs, &title, desc, VersionKind::Publish)?;
        self.step(op, "committed", Some(&json!({"commit": commit})))?;
        Ok(())
    }

    /// Discards the local changes of `paths` (always after a safety copy).
    pub(crate) fn discard_changes(&self, paths: &[String]) -> Result<ProjectStatus> {
        for p in paths {
            util::validate_rel_path(p)?;
        }
        self.run_op("discard", Busy::Updating, json!({"paths": paths}), |op| {
            let changes = self.local_changes()?;
            let targets: Vec<&LocalChange> = changes.iter().filter(|c| paths.contains(&c.path)).collect();
            if targets.is_empty() {
                return Ok(());
            }
            self.safety_snapshot("scarto")?;
            self.step(op, "snapshot", None)?;
            let head = self.head()?;
            let head_map = self.repo.tree_map(&head)?;
            let old_hashes = self
                .repo
                .hash_files(&targets.iter().map(|c| c.path.clone()).collect::<Vec<_>>())?;
            let mut report = super::materialize::MatReport::default();
            let mut entries = Vec::new();
            for (c, old) in targets.iter().zip(old_hashes) {
                let abs = self.folder.join(&c.path);
                match head_map.get(&c.path) {
                    Some(e) => {
                        let data = self.repo.cat_blob(&e.oid)?;
                        atomic_write(&abs, &data)?;
                        entries.push(IndexInfoEntry {
                            path: c.path.clone(),
                            mode_oid: Some((e.mode.clone(), e.oid.clone())),
                        });
                        report.written.push(super::materialize::WrittenFile {
                            path: c.path.clone(),
                            old_blob: old,
                            new_blob: Some(e.oid.clone()),
                        });
                    }
                    None => {
                        remove_file_retry(&abs)?;
                        util::prune_empty_parents(&self.folder, &abs);
                        entries.push(IndexInfoEntry {
                            path: c.path.clone(),
                            mode_oid: None,
                        });
                    }
                }
                let meta = file_meta(&abs).map(|(size, mtime)| crate::tracker::Meta { size, mtime });
                self.tracker
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .on_self_write(&c.path, meta, Instant::now());
            }
            self.repo.update_index_info(None, &entries)?;
            self.repo.refresh_index()?;
            for c in &targets {
                // A discarded file has nothing left to protect against.
                let _ = self.shared.store.delete_watch(&self.id, &c.path);
            }
            self.arm_guards(&report, &head, &head)?;
            Ok(())
        })?;
        self.status_now()
    }
}
