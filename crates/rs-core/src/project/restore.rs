//! Restoring an old version (`§7.6`): a new commit, history is never rewritten.

use super::integrate::{IntegrateOutcome, SendOutcome};
use super::snapshot::TempIndex;
use super::*;
use crate::hooks::FileInspector as _;
use crate::message::{parse_version_message, VersionMessage};
use crate::types::{ChangelogGroup, VersionKind};
use crate::util;
use rs_git::{CommitSpec, IndexInfoEntry, Signature};
use serde_json::json;
use std::collections::HashSet;

impl ProjectInner {
    pub(crate) fn restore_version(&self, sha: &str, paths: Option<&[String]>) -> Result<ProjectStatus> {
        self.run_op(
            "restore",
            Busy::Publishing,
            json!({"sha": sha, "paths": paths}),
            |op| self.restore_inner(op, sha, paths),
        )?;
        self.status_now()
    }

    fn restore_inner(&self, op: &OpCtx, sha: &str, paths: Option<&[String]>) -> Result<()> {
        let identity = self.shared.identity()?;
        if self.has_open_conflict()? {
            return Err(CoreError::ConflictOpen);
        }
        let target = self.resolve_commit(sha)?;
        if !self.is_published_commit(&target)? {
            return Err(CoreError::InvalidArgument(
                "si possono ripristinare solo versioni già pubblicate".into(),
            ));
        }
        let target_info = self.repo.commit_info(&target)?;
        let number = parse_version_message(&target_info.message)
            .number
            .or(self.version_of(&target)?)
            .ok_or_else(|| CoreError::InvalidArgument("la versione non ha un numero".into()))?;
        if let Some(ps) = paths {
            for p in ps {
                util::validate_rel_path(p)?;
            }
        }

        // The project must be up to date first.
        self.fetch_remote()?;
        match self.integrate(op, false)? {
            IntegrateOutcome::Conflict(_) | IntegrateOutcome::ConflictOpen => return Err(CoreError::ConflictOpen),
            IntegrateOutcome::Blocked(f) => return Err(CoreError::BlockedByEditor(f)),
            IntegrateOutcome::Updated { .. } | IntegrateOutcome::UpToDate => {}
        }

        let head = self.head()?;
        let head_tree = self.repo.tree_of(&head)?;
        let target_tree = self.repo.tree_of(&target)?;
        let head_map = self.repo.tree_map(&head)?;
        let target_map = self.repo.tree_map(&target)?;

        let new_tree = match paths {
            None => target_tree.clone(),
            Some(ps) => {
                let mut entries = Vec::new();
                for p in ps {
                    if !head_map.contains_key(p) && !target_map.contains_key(p) {
                        return Err(CoreError::NotFound(format!("file {p}")));
                    }
                    entries.push(IndexInfoEntry {
                        path: p.clone(),
                        mode_oid: target_map.get(p).map(|e| (e.mode.clone(), e.oid.clone())),
                    });
                }
                let idx = TempIndex::new(&self.repo);
                self.repo.read_tree(Some(idx.path()), &head_tree)?;
                self.repo.update_index_info(Some(idx.path()), &entries)?;
                self.repo.write_tree(Some(idx.path()))?
            }
        };
        if new_tree == head_tree {
            return Err(CoreError::InvalidArgument(format!(
                "i file sono già uguali alla versione {number}"
            )));
        }
        let affected: Vec<String> = self
            .repo
            .diff_tree(&head_tree, &new_tree, false)?
            .into_iter()
            .map(|d| d.path)
            .collect();

        // No unpublished changes on the files involved.
        let changes = self.local_changes()?;
        let affected_set: HashSet<&String> = affected.iter().collect();
        let mut clash: Vec<String> = changes
            .iter()
            .filter(|c| affected_set.contains(&c.path))
            .map(|c| c.path.clone())
            .collect();
        if !clash.is_empty() {
            clash.sort();
            return Err(CoreError::LocalChangesPresent(clash));
        }
        let blockers = self.editor_blockers(&affected);
        if !blockers.is_empty() {
            return Err(CoreError::BlockedByEditor(blockers));
        }

        self.safety_snapshot("ripristino")?;
        self.step(op, "snapshot", None)?;

        let new_map = self.repo.tree_map(&new_tree)?;
        let mut groups = Vec::new();
        let mut sorted = affected.clone();
        sorted.sort();
        for p in &sorted {
            let before = match head_map.get(p) {
                Some(e) => Some(self.repo.cat_blob(&e.oid)?),
                None => None,
            };
            let after = match new_map.get(p) {
                Some(e) => Some(self.repo.cat_blob(&e.oid)?),
                None => None,
            };
            let mut lines = self
                .shared
                .config
                .inspector
                .changelog(p, before.as_deref(), after.as_deref());
            lines.retain(|l| !l.trim().is_empty());
            if lines.is_empty() {
                lines = crate::hooks::DefaultInspector.changelog(p, before.as_deref(), after.as_deref());
            }
            groups.push(ChangelogGroup {
                path: p.clone(),
                interpreted: !lines.iter().all(|l| crate::hooks::is_generic_line(l)),
                lines,
            });
        }
        let title = match paths {
            None => format!("Ripristinata la versione {number}"),
            Some(ps) if ps.len() == 1 => format!("Ripristinato {} dalla versione {number}", ps[0]),
            Some(ps) => format!("Ripristinati {} file dalla versione {number}", ps.len()),
        };
        let mut vm = VersionMessage::new(VersionKind::Restore, title, &self.shared.config.client_version);
        vm.changelog = groups;
        vm.restored_from = Some(number);
        if let Some(ps) = paths {
            vm.restored_paths = ps.to_vec();
        }
        let sig = Signature::now(identity.name, identity.email);
        let commit = self.repo.commit_tree(&CommitSpec {
            tree: &new_tree,
            parents: &[head.clone()],
            message: &vm.render(),
            author: &sig,
            committer: &sig,
        })?;
        self.step(
            op,
            "materializing",
            Some(&json!({
                "oldHead": head, "newHead": commit, "fromTree": head_tree, "toTree": new_tree,
                "allowDirty": Vec::<String>::new(),
            })),
        )?;
        let report = self.materialize(&head_tree, &new_tree, &HashSet::new())?;
        self.failpoint("materialize.before_ref_update")?;
        self.repo.update_ref(MAIN_REF, &commit, Some(&head))?;
        self.step(op, "applied", None)?;
        self.arm_guards(&report, &head, &commit)?;
        match self.send_pending(op, true)? {
            SendOutcome::Conflict(_)
            | SendOutcome::Sent(_)
            | SendOutcome::Offline
            | SendOutcome::Blocked(_)
            | SendOutcome::NothingToSend
            | SendOutcome::ConflictOpen => Ok(()),
        }
    }

    pub(crate) fn is_published_commit(&self, commit: &str) -> Result<bool> {
        match self.origin()? {
            Some(o) => Ok(self.repo.is_ancestor(commit, &o)?),
            None => Ok(false),
        }
    }
}
