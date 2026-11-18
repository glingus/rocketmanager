//! Fetch, conflict detection, update (`§7.2`, `§7.3`) and sending of pending versions (`§7.4`).

use super::publish::LocalInput;
use super::status::LocalChange;
use super::*;
use crate::message::{parse_version_message, set_number};
use crate::types::{FileChangeKind, VersionKind};
use rs_git::{CommitSpec, MergeTreeResult, Signature};
use rs_store::{ConflictFileRecord, ConflictRecord, ConflictStatus};
use serde_json::json;
use std::collections::HashSet;

#[derive(Debug)]
pub(crate) enum IntegrateOutcome {
    UpToDate,
    Updated,
    Conflict(String),
    Blocked(Vec<String>),
    ConflictOpen,
}

#[derive(Debug, Clone)]
pub(crate) struct SentVersion {
    pub number: i64,
    pub sha: String,
    pub title: String,
    pub conflict_id: Option<String>,
}

/// Result of a sending attempt; the payloads are kept for diagnostics (`Debug`).
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum SendOutcome {
    NothingToSend,
    Sent(Vec<SentVersion>),
    Offline,
    Blocked(Vec<String>),
    Conflict(String),
    ConflictOpen,
}

enum Rebase {
    Done(String),
    Conflict(Vec<String>),
}

pub(crate) const MAX_SEND_ATTEMPTS: u32 = 3;

impl ProjectInner {
    /// Fetches `origin/main` and the tags. A network failure marks the project offline.
    pub(crate) fn fetch_remote(&self) -> Result<()> {
        let res = self.repo.fetch(
            "origin",
            &[
                "refs/heads/main:refs/remotes/origin/main",
                "refs/tags/*:refs/tags/*",
            ],
        );
        match res {
            Ok(()) => {
                let now = rs_store::now_ms();
                self.rt(|r| {
                    r.offline = false;
                    r.last_fetch_at = Some(now);
                });
                let _ = self
                    .shared
                    .store
                    .set_setting(&self.id, "lastFetchAt", &now.to_string());
                Ok(())
            }
            Err(e) => {
                let ce = CoreError::Git(e);
                if ce.is_network() {
                    self.rt(|r| r.offline = true);
                }
                Err(ce)
            }
        }
    }

    /// The signature used as committer when Rocket Sync rewrites a commit.
    fn rewrite_committer(&self, fallback: &Signature) -> Signature {
        match self.shared.identity() {
            Ok(i) => Signature::now(i.name, i.email),
            Err(_) => Signature::now(fallback.name.clone(), fallback.email.clone()),
        }
    }

    /// Commit of the stable and valid local changes on top of `head`, **not** referenced by any ref.
    /// `None` when there is nothing to include.
    fn local_snapshot(&self, changes: &[LocalChange], head: &str) -> Result<Option<String>> {
        let paths: Vec<String> = changes
            .iter()
            .filter(|c| c.publishable())
            .map(|c| c.path.clone())
            .collect();
        if paths.is_empty() {
            return Ok(None);
        }
        let head_tree = self.repo.tree_of(head)?;
        let idx = super::snapshot::TempIndex::new(&self.repo);
        self.repo.read_tree(Some(idx.path()), &head_tree)?;
        self.repo.update_index_paths(Some(idx.path()), &paths)?;
        let tree = self.repo.write_tree(Some(idx.path()))?;
        if tree == head_tree {
            return Ok(None);
        }
        let sig = self.service_signature();
        let c = self.repo.commit_tree(&CommitSpec {
            tree: &tree,
            parents: &[head.to_string()],
            message: "Modifiche locali (temporaneo)\n",
            author: &sig,
            committer: &sig,
        })?;
        Ok(Some(c))
    }

    /// Replays `pending` (oldest first) on top of `onto` using `merge-tree`; empty results are dropped.
    fn rebase_pending(&self, pending: &[String], onto: &str) -> Result<Rebase> {
        let mut tip = onto.to_string();
        let mut tip_tree = self.repo.tree_of(onto)?;
        for p in pending {
            let info = self.repo.commit_info(p)?;
            let Some(base) = info.parents.first().cloned() else {
                return Err(CoreError::Internal(format!(
                    "la versione {p} non ha un genitore"
                )));
            };
            let m = self.repo.merge_tree(&base, &tip, p)?;
            if !m.clean {
                return Ok(Rebase::Conflict(m.conflicted));
            }
            if m.tree == tip_tree {
                continue; // already contained in the new base
            }
            let msg = set_number(&info.message, None);
            let mut parents = vec![tip.clone()];
            parents.extend(info.parents.iter().skip(1).cloned());
            let committer = self.rewrite_committer(&info.author);
            let new = self.repo.commit_tree(&CommitSpec {
                tree: &m.tree,
                parents: &parents,
                message: &msg,
                author: &info.author,
                committer: &committer,
            })?;
            tip = new;
            tip_tree = m.tree;
        }
        Ok(Rebase::Done(tip))
    }

    /// Opens a conflict between the local line (`ours`, saving the unpublished changes first) and `theirs`.
    fn open_sync_conflict(
        &self,
        op: &OpCtx,
        base: &str,
        theirs: &str,
        conflicted: &[String],
        changes: &[LocalChange],
    ) -> Result<String> {
        // 1. unpublished changes become a pending version
        let inputs = self.inputs_for_changes(changes.iter().filter(|c| c.publishable()))?;
        if !inputs.is_empty() {
            self.safety_snapshot("conflitto")?;
            match self.commit_local(
                &inputs,
                "Modifiche locali in conflitto",
                None,
                VersionKind::Publish,
            ) {
                Ok(_) | Err(CoreError::NothingToPublish) => {}
                Err(e) => return Err(e),
            }
        }
        let ours = self.head()?;
        self.create_conflict_record(op, base, &ours, theirs, conflicted, "sync")
    }

    /// Registers a conflict, pushes the safety branch and emits the event.
    pub(crate) fn create_conflict_record(
        &self,
        op: &OpCtx,
        base: &str,
        ours: &str,
        theirs: &str,
        conflicted: &[String],
        origin_kind: &str,
    ) -> Result<String> {
        let id = format!(
            "{}-{}",
            crate::util::today_compact(),
            crate::util::random_id(6)
        );
        let base_map = self.repo.tree_map(base)?;
        let ours_map = self.repo.tree_map(ours)?;
        let theirs_map = self.repo.tree_map(theirs)?;
        let mut files = Vec::new();
        for p in conflicted {
            let kind = match (base_map.get(p), ours_map.get(p), theirs_map.get(p)) {
                (None, Some(_), Some(_)) => crate::types::ConflictFileKind::BothAdded,
                (_, Some(_), None) => crate::types::ConflictFileKind::ModifiedDeleted,
                (_, None, Some(_)) => crate::types::ConflictFileKind::DeletedModified,
                _ => crate::types::ConflictFileKind::BothModified,
            };
            files.push(ConflictFileRecord {
                path: p.clone(),
                kind: kind.as_str().to_string(),
            });
        }
        let theirs_info = self.repo.commit_info(theirs)?;
        let rec = ConflictRecord {
            id: id.clone(),
            project_id: self.id.clone(),
            status: ConflictStatus::Open,
            created_at: rs_store::now_ms(),
            base_sha: base.to_string(),
            ours_sha: ours.to_string(),
            theirs_sha: theirs.to_string(),
            theirs_version: self.version_of(theirs)?,
            theirs_author: Some(theirs_info.author.name.clone()),
            remote_branch_pushed: false,
            origin: origin_kind.to_string(),
            files,
            resolution: None,
            resolution_sha: None,
            resolved_at: None,
            resolved_version: None,
        };
        self.shared.store.save_conflict(&rec)?;
        self.step(
            op,
            "conflict_created",
            Some(&json!({"conflictId": id, "ours": ours, "theirs": theirs, "base": base})),
        )?;
        self.failpoint("conflict.before_branch_push")?;
        self.push_conflict_branch(&id)?;
        self.emit(EngineEvent::ConflictDetected {
            project_id: self.id.clone(),
            conflict_id: id.clone(),
            files: conflicted.to_vec(),
        });
        Ok(id)
    }

    /// Pushes `ours` to `conflitti/<id>`; failures leave `remoteBranchPushed = false` (retried later).
    pub(crate) fn push_conflict_branch(&self, id: &str) -> Result<bool> {
        let Some(mut rec) = self.shared.store.get_conflict(&self.id, id)? else {
            return Ok(false);
        };
        if rec.remote_branch_pushed {
            return Ok(true);
        }
        let spec = format!("{}:refs/heads/conflitti/{id}", rec.ours_sha);
        match self.repo.push_atomic("origin", &[spec]) {
            Ok(()) => {
                rec.remote_branch_pushed = true;
                self.shared.store.save_conflict(&rec)?;
                Ok(true)
            }
            Err(e) => {
                let ce = CoreError::Git(e);
                if ce.is_network() {
                    self.rt(|r| r.offline = true);
                } else {
                    tracing::warn!(error = %ce, "push of the conflict branch failed");
                }
                Ok(false)
            }
        }
    }

    /// Local changes, after waiting (bounded) for the files that overlap `incoming` to settle: a file
    /// that is still being saved must not be mistaken for "no local change" and then overwritten.
    fn local_changes_settled(&self, incoming: &HashSet<String>) -> Result<Vec<LocalChange>> {
        let timing = self.shared.config.timing.clone();
        let deadline = Instant::now() + timing.stability_wait;
        loop {
            let changes = self.local_changes()?;
            let mut pending: Vec<String> = changes
                .iter()
                .filter(|c| {
                    incoming.contains(&c.path)
                        && (!c.stable || (c.valid.is_none() && c.change != FileChangeKind::Deleted))
                })
                .map(|c| c.path.clone())
                .collect();
            if pending.is_empty() {
                return Ok(changes);
            }
            if Instant::now() >= deadline {
                pending.sort();
                return Err(CoreError::FileNotStable(pending));
            }
            std::thread::sleep(
                timing
                    .stability_gap
                    .min(std::time::Duration::from_millis(250)),
            );
        }
    }

    /// Brings the local line up to date with `origin/main` (§7.3): overlap check → conflict,
    /// otherwise the pending versions are replayed on `origin/main` and the files are materialised.
    pub(crate) fn integrate(&self, op: &OpCtx, force: bool) -> Result<IntegrateOutcome> {
        let head = self.head()?;
        let Some(origin) = self.origin()? else {
            return Ok(IntegrateOutcome::UpToDate);
        };
        if self.repo.is_ancestor(&origin, &head)? {
            return Ok(IntegrateOutcome::UpToDate);
        }
        if self.has_open_conflict()? {
            return Ok(IntegrateOutcome::ConflictOpen);
        }
        let base = self.repo.merge_base(&head, &origin)?.ok_or_else(|| {
            CoreError::Internal("storie non collegate tra locale e server".into())
        })?;
        let incoming: HashSet<String> = {
            let bt = self.repo.tree_of(&base)?;
            let ot = self.repo.tree_of(&origin)?;
            self.repo
                .diff_tree(&bt, &ot, false)?
                .into_iter()
                .map(|d| d.path)
                .collect()
        };
        let changes = self.local_changes_settled(&incoming)?;

        // Overlap between the local line (pending + unpublished) and the incoming changes.
        let snap = self.local_snapshot(&changes, &head)?;
        let ours_tip = snap.clone().unwrap_or_else(|| head.clone());
        if ours_tip != base {
            let m: MergeTreeResult = self.repo.merge_tree(&base, &ours_tip, &origin)?;
            if !m.clean {
                let id = self.open_sync_conflict(op, &base, &origin, &m.conflicted, &changes)?;
                return Ok(IntegrateOutcome::Conflict(id));
            }
        }

        // Plan the new local line.
        let new_head = if self.repo.is_ancestor(&head, &origin)? {
            origin.clone()
        } else {
            let range = format!("{origin}..{head}");
            let pending = self
                .repo
                .rev_list(&["--first-parent", "--reverse", &range])?;
            match self.rebase_pending(&pending, &origin)? {
                Rebase::Done(tip) => tip,
                Rebase::Conflict(paths) => {
                    let id = self.open_sync_conflict(op, &base, &origin, &paths, &changes)?;
                    return Ok(IntegrateOutcome::Conflict(id));
                }
            }
        };
        let from_tree = self.repo.tree_of(&head)?;
        let to_tree = self.repo.tree_of(&new_head)?;
        let files: Vec<String> = self
            .repo
            .diff_tree(&from_tree, &to_tree, false)?
            .into_iter()
            .map(|d| d.path)
            .collect();

        let blockers = self.editor_blockers(&files);
        if !blockers.is_empty() && !force {
            return Ok(IntegrateOutcome::Blocked(blockers));
        }

        let from_version = self.version_of(&base)?;
        self.safety_snapshot("aggiornamento")?;
        self.step(
            op,
            "materializing",
            Some(&json!({
                "oldHead": head, "newHead": new_head, "fromTree": from_tree, "toTree": to_tree,
                "allowDirty": Vec::<String>::new(),
            })),
        )?;
        self.progress(
            "update",
            "materializing",
            None,
            "Aggiornamento dei file in corso",
        );
        let report = self.materialize(&from_tree, &to_tree, &HashSet::new())?;
        self.failpoint("materialize.before_ref_update")?;
        self.repo.update_ref(MAIN_REF, &new_head, Some(&head))?;
        self.step(op, "applied", None)?;
        self.arm_guards(&report, &head, &new_head)?;
        let to_version = self.version_of(&origin)?;
        if !files.is_empty() {
            self.emit(EngineEvent::UpdateApplied {
                project_id: self.id.clone(),
                from_version,
                to_version,
                files,
            });
        }
        Ok(IntegrateOutcome::Updated)
    }

    /// Sends the pending versions with their definitive numbers (§7.4.4).
    pub(crate) fn send_pending(&self, op: &OpCtx, skip_first_fetch: bool) -> Result<SendOutcome> {
        let mut last_err: Option<CoreError> = None;
        for attempt in 0..MAX_SEND_ATTEMPTS {
            if !(attempt == 0 && skip_first_fetch) {
                match self.fetch_remote() {
                    Ok(()) => {}
                    Err(e) if e.is_network() => return Ok(SendOutcome::Offline),
                    Err(e) => return Err(e),
                }
            }
            self.rt(|r| r.retrying = attempt > 0);
            if self.pending_commits()?.is_empty() {
                self.rt(|r| r.retrying = false);
                return Ok(SendOutcome::NothingToSend);
            }
            if self.has_open_conflict()? {
                return Ok(SendOutcome::ConflictOpen);
            }
            match self.integrate(op, false)? {
                IntegrateOutcome::Conflict(id) => return Ok(SendOutcome::Conflict(id)),
                IntegrateOutcome::Blocked(f) => return Ok(SendOutcome::Blocked(f)),
                IntegrateOutcome::ConflictOpen => return Ok(SendOutcome::ConflictOpen),
                IntegrateOutcome::Updated | IntegrateOutcome::UpToDate => {}
            }
            let Some(origin) = self.origin()? else {
                return Err(CoreError::NotLinked("origin/main non disponibile".into()));
            };
            let head = self.head()?;
            if !self.repo.is_ancestor(&origin, &head)? {
                continue; // origin moved again: start over
            }
            let range = format!("{origin}..{head}");
            let pending = self
                .repo
                .rev_list(&["--first-parent", "--reverse", &range])?;
            if pending.is_empty() {
                return Ok(SendOutcome::NothingToSend);
            }

            // Definitive numbers: always recomputed from origin/main.
            let base_version = self.version_of(&origin)?.unwrap_or(0);
            let mut prev = origin.clone();
            let mut sent: Vec<SentVersion> = Vec::new();
            for (i, p) in pending.iter().enumerate() {
                let n = base_version + 1 + i as i64;
                let info = self.repo.commit_info(p)?;
                let parsed = parse_version_message(&info.message);
                let msg = set_number(&info.message, Some(n));
                let mut parents = vec![prev.clone()];
                parents.extend(info.parents.iter().skip(1).cloned());
                let tree = self.repo.tree_of(p)?;
                let committer = self.rewrite_committer(&info.author);
                let new = self.repo.commit_tree(&CommitSpec {
                    tree: &tree,
                    parents: &parents,
                    message: &msg,
                    author: &info.author,
                    committer: &committer,
                })?;
                sent.push(SentVersion {
                    number: n,
                    sha: new.clone(),
                    title: parsed.title,
                    conflict_id: parsed.conflict_id,
                });
                prev = new;
            }
            let final_tip = prev;
            self.step(
                op,
                "send_prepared",
                Some(&json!({
                    "oldHead": head, "finalTip": final_tip, "origin": origin,
                    "versions": sent.iter().map(|s| json!({"number": s.number, "sha": s.sha})).collect::<Vec<_>>(),
                })),
            )?;
            self.failpoint("send.before_push")?;

            let mut refspecs = vec![format!("{final_tip}:refs/heads/main")];
            for s in &sent {
                refspecs.push(format!("{}:refs/tags/v{}", s.sha, s.number));
            }
            self.progress("publish", "pushing", None, "Invio delle versioni al server");
            match self.repo.push_atomic("origin", &refspecs) {
                Ok(()) => {}
                Err(e) => {
                    let ce = CoreError::Git(e);
                    if matches!(&ce, CoreError::Git(g) if g.kind() == rs_git::GitErrorKind::NonFastForward)
                    {
                        self.rt(|r| r.retrying = true);
                        last_err = Some(ce);
                        continue;
                    }
                    if ce.is_network() {
                        self.rt(|r| {
                            r.offline = true;
                            r.retrying = false;
                        });
                        return Ok(SendOutcome::Offline);
                    }
                    return Err(ce);
                }
            }
            self.step(op, "pushed", None)?;
            self.failpoint("send.after_push")?;

            // The local line now becomes exactly what was published (same trees, final messages).
            self.repo.update_ref(ORIGIN_REF, &final_tip, None)?;
            self.repo.update_ref(MAIN_REF, &final_tip, Some(&head))?;
            for s in &sent {
                let _ = self
                    .repo
                    .update_ref(&format!("refs/tags/v{}", s.number), &s.sha, None);
            }
            let now = rs_store::now_ms();
            self.rt(|r| {
                r.offline = false;
                r.retrying = false;
                r.last_publish_at = Some(now);
            });
            let _ = self
                .shared
                .store
                .set_setting(&self.id, "lastPublishAt", &now.to_string());
            self.finish_resolved_conflicts(&sent, &origin, &final_tip)?;
            for s in &sent {
                self.emit(EngineEvent::VersionPublished {
                    project_id: self.id.clone(),
                    number: s.number,
                    sha: s.sha.clone(),
                    title: s.title.clone(),
                });
            }
            self.step(op, "sent", None)?;
            return Ok(SendOutcome::Sent(sent));
        }
        self.rt(|r| r.retrying = false);
        Err(last_err.unwrap_or_else(|| CoreError::Internal("invio non riuscito".into())))
    }

    /// After a successful push: conflicts whose resolution has just been published become `resolved`.
    ///
    /// A resolution normally is one of the versions just sent (matched by its
    /// `Rocket-Sync-Conflict` trailer). If it was folded into a later resolution (a second
    /// conflict appeared while the first resolution was waiting to be sent), it is found in the
    /// history that has just been published.
    fn finish_resolved_conflicts(
        &self,
        sent: &[SentVersion],
        old_origin: &str,
        final_tip: &str,
    ) -> Result<()> {
        for c in self.shared.store.list_conflicts(&self.id, false)? {
            if c.status != ConflictStatus::Resolving {
                continue;
            }
            let number = match sent
                .iter()
                .find(|s| s.conflict_id.as_deref() == Some(c.id.as_str()))
            {
                Some(v) => Some(v.number),
                None => {
                    let range = format!("{old_origin}..{final_tip}");
                    let needle = format!("Rocket-Sync-Conflict: {}", c.id);
                    let found = self.repo.run(Cmd::new([
                        "log",
                        "--format=%H",
                        "-n",
                        "1",
                        "--fixed-strings",
                        "--grep",
                        needle.as_str(),
                        range.as_str(),
                        "--",
                    ]))?;
                    if found.stdout_trimmed().is_empty() {
                        None
                    } else {
                        sent.last().map(|s| s.number)
                    }
                }
            };
            let Some(number) = number else { continue };
            if c.remote_branch_pushed {
                let _ = self
                    .repo
                    .push_delete("origin", &format!("refs/heads/conflitti/{}", c.id));
            }
            let mut rec = c.clone();
            rec.status = ConflictStatus::Resolved;
            rec.resolved_at = Some(rs_store::now_ms());
            rec.resolved_version = Some(number);
            self.shared.store.save_conflict(&rec)?;
            self.emit(EngineEvent::ConflictResolved {
                project_id: self.id.clone(),
                conflict_id: c.id.clone(),
                number: Some(number),
            });
        }
        Ok(())
    }

    /// Fetch + update + sending of the pending versions (`sync_now`, periodic loop).
    pub(crate) fn sync_after_fetch(&self, op: &OpCtx) -> Result<()> {
        if self.has_open_conflict()? {
            return Ok(());
        }
        self.integrate(op, false)?;
        if !self.has_open_conflict()? && !self.pending_commits()?.is_empty() {
            self.send_pending(op, true)?;
        }
        Ok(())
    }

    pub(crate) fn sync_now(&self) -> Result<ProjectStatus> {
        self.run_op("sync", Busy::Updating, json!({}), |op| {
            match self.fetch_remote() {
                Ok(()) => {}
                Err(e) if e.is_network() => return Ok(()),
                Err(e) => return Err(e),
            }
            self.sync_after_fetch(op)
        })?;
        self.status_now()
    }

    pub(crate) fn update_now(&self, force: bool) -> Result<ProjectStatus> {
        self.run_op("update", Busy::Updating, json!({"force": force}), |op| {
            self.fetch_remote()?;
            if self.has_open_conflict()? {
                return Err(CoreError::ConflictOpen);
            }
            self.integrate(op, force)?;
            Ok(())
        })?;
        self.status_now()
    }

    /// Reads the files that make up `changes` (validating them) for inclusion in a commit.
    pub(crate) fn inputs_for_changes<'a>(
        &self,
        changes: impl Iterator<Item = &'a LocalChange>,
    ) -> Result<Vec<LocalInput>> {
        let mut out = Vec::new();
        for c in changes {
            if c.change == FileChangeKind::Deleted {
                out.push(LocalInput {
                    path: c.path.clone(),
                    bytes: None,
                });
                continue;
            }
            let bytes = std::fs::read(self.folder.join(&c.path))?;
            if self
                .shared
                .config
                .inspector
                .validate(&c.path, &bytes)
                .is_ok()
            {
                out.push(LocalInput {
                    path: c.path.clone(),
                    bytes: Some(bytes),
                });
            }
        }
        Ok(out)
    }
}
