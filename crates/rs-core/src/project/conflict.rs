//! Conflicts: queries, resolution (`§7.5`), stale-editor answers (`§7.8`) and copies to open in OpenRocket.

use super::integrate::SendOutcome;
use super::snapshot::TempIndex;
use super::*;
use crate::message::VersionMessage;
use crate::types::{
    ChangelogGroup, Conflict, ConflictFile, ConflictFileKind, ConflictSide, ConflictStatusDto, FileResolution,
    ResolutionChoice, VersionKind,
};
use crate::util::{self, atomic_write, iso_from_ms};
use rs_git::{CommitSpec, IndexInfoEntry, Signature};
use rs_store::{ConflictRecord, ConflictStatus};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

fn to_dto(r: &ConflictRecord) -> Conflict {
    Conflict {
        id: r.id.clone(),
        project_id: r.project_id.clone(),
        status: match r.status {
            ConflictStatus::Open => ConflictStatusDto::Open,
            // `resolving` = resolution committed locally and waiting to be sent: the user is done.
            ConflictStatus::Resolving | ConflictStatus::Resolved => ConflictStatusDto::Resolved,
        },
        created_at: iso_from_ms(r.created_at),
        base_sha: r.base_sha.clone(),
        ours_sha: r.ours_sha.clone(),
        theirs_sha: r.theirs_sha.clone(),
        theirs_version: r.theirs_version,
        theirs_author: r.theirs_author.clone(),
        remote_branch_pushed: r.remote_branch_pushed,
        files: r
            .files
            .iter()
            .map(|f| ConflictFile {
                path: f.path.clone(),
                kind: ConflictFileKind::parse(&f.kind),
                three_way: None,
            })
            .collect(),
    }
}

impl ProjectInner {
    pub(crate) fn list_conflicts(&self, include_resolved: bool) -> Result<Vec<Conflict>> {
        Ok(self
            .shared
            .store
            .list_conflicts(&self.id, include_resolved)?
            .iter()
            .map(to_dto)
            .collect())
    }

    fn conflict_record(&self, id: &str) -> Result<ConflictRecord> {
        self.shared
            .store
            .get_conflict(&self.id, id)?
            .ok_or_else(|| CoreError::NotFound(format!("conflitto {id}")))
    }

    pub(crate) fn get_conflict(&self, id: &str) -> Result<Conflict> {
        Ok(to_dto(&self.conflict_record(id)?))
    }

    /// Content of one side of a conflicting file (`None` if the side does not have the file).
    pub(crate) fn conflict_side_bytes(&self, id: &str, path: &str, side: ConflictSide) -> Result<Option<Vec<u8>>> {
        util::validate_rel_path(path)?;
        let rec = self.conflict_record(id)?;
        if !rec.files.iter().any(|f| f.path == path) {
            return Err(CoreError::NotFound(format!("file {path} nel conflitto {id}")));
        }
        let commit = match side {
            ConflictSide::Base => &rec.base_sha,
            ConflictSide::Ours => &rec.ours_sha,
            ConflictSide::Theirs => &rec.theirs_sha,
        };
        match self.repo.resolve(&format!("{commit}:{path}"))? {
            Some(oid) => Ok(Some(self.repo.cat_blob(&oid)?)),
            None => Ok(None),
        }
    }

    /// Writes one side of a conflicting file in `.rocketsync/local/conflitti/<id>/` and returns the path.
    pub(crate) fn export_conflict_copy(&self, id: &str, path: &str, side: ConflictSide) -> Result<PathBuf> {
        let bytes = self
            .conflict_side_bytes(id, path, side)?
            .ok_or_else(|| CoreError::NotFound(format!("il file {path} non esiste in questa versione")))?;
        let label = match side {
            ConflictSide::Base => "versione di partenza",
            ConflictSide::Ours => "la mia versione",
            ConflictSide::Theirs => "versione dei colleghi",
        };
        let (stem, ext) = util::split_ext(path);
        let rel = format!(".rocketsync/local/conflitti/{id}/{stem} ({label}){ext}");
        let abs = self.folder.join(&rel);
        atomic_write(&abs, &bytes)?;
        Ok(abs)
    }

    /// Reads a file that the user merged by hand: it must be stable and valid.
    fn read_manual_file(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let abs = self.folder.join(path);
        if !abs.exists() {
            return Ok(None);
        }
        let timing = self.shared.config.timing.clone();
        let deadline = Instant::now() + timing.stability_wait;
        loop {
            let (meta, stable, valid, reason, _) = self.observe_file(path);
            if meta.is_some() && stable && valid == Some(true) {
                let before = util::file_meta(&abs);
                std::thread::sleep(timing.stability_gap);
                if util::file_meta(&abs) == before {
                    break;
                }
            } else if valid == Some(false) && stable {
                return Err(CoreError::FileInvalid {
                    path: path.to_string(),
                    reason: reason.unwrap_or_else(|| "file non valido".into()),
                });
            }
            if Instant::now() >= deadline {
                return Err(CoreError::FileNotStable(vec![path.to_string()]));
            }
            std::thread::sleep(timing.stability_gap.min(Duration::from_millis(250)));
        }
        let bytes = std::fs::read(&abs)?;
        self.shared
            .config
            .inspector
            .validate(path, &bytes)
            .map_err(|reason| CoreError::FileInvalid {
                path: path.to_string(),
                reason,
            })?;
        Ok(Some(bytes))
    }

    /// Resolves a conflict with one choice per file, creating the merge commit (`§7.5.6`).
    pub(crate) fn resolve_conflict(&self, id: &str, resolutions: &[FileResolution]) -> Result<ProjectStatus> {
        self.run_op(
            "resolve",
            Busy::Publishing,
            json!({"conflictId": id}),
            |op| self.resolve_inner(op, id, resolutions),
        )?;
        self.status_now()
    }

    fn resolve_inner(&self, op: &OpCtx, id: &str, resolutions: &[FileResolution]) -> Result<()> {
        let identity = self.shared.identity()?;
        let mut rec = self.conflict_record(id)?;
        if rec.status != ConflictStatus::Open {
            return Err(CoreError::InvalidArgument("il conflitto è già stato risolto".into()));
        }
        let mut choices: HashMap<&str, ResolutionChoice> = HashMap::new();
        for r in resolutions {
            if !rec.files.iter().any(|f| f.path == r.path) {
                return Err(CoreError::InvalidPath(r.path.clone()));
            }
            choices.insert(r.path.as_str(), r.choice);
        }
        for f in &rec.files {
            if !choices.contains_key(f.path.as_str()) {
                return Err(CoreError::InvalidArgument(format!("manca la scelta per «{}»", f.path)));
            }
        }

        let head = self.head()?;
        let first_parent = if rec.origin == "stale-save" {
            head.clone()
        } else {
            rec.theirs_sha.clone()
        };
        if head != rec.ours_sha && head != rec.theirs_sha {
            return Err(CoreError::InvalidArgument(
                "la cartella è cambiata dopo la rilevazione del conflitto".into(),
            ));
        }

        let merged = self.repo.merge_tree(&rec.base_sha, &rec.ours_sha, &first_parent)?;
        let ours_map = self.repo.tree_map(&rec.ours_sha)?;
        let theirs_map = self.repo.tree_map(&first_parent)?;
        let merged_map = self.repo.tree_map(&merged.tree)?;

        let mut entries: Vec<IndexInfoEntry> = Vec::new();
        let mut manual: HashSet<String> = HashSet::new();
        let mut taken: HashSet<String> = merged_map.keys().cloned().collect();
        let mut groups: Vec<ChangelogGroup> = Vec::new();
        let date = util::today_ymd();

        for f in &rec.files {
            let choice = choices[f.path.as_str()];
            let mode_of = |m: &HashMap<String, rs_git::TreeEntry>| {
                m.get(&f.path).map(|e| (e.mode.clone(), e.oid.clone()))
            };
            let line = match choice {
                ResolutionChoice::Mine => {
                    entries.push(IndexInfoEntry {
                        path: f.path.clone(),
                        mode_oid: mode_of(&ours_map),
                    });
                    "Tenuta la mia versione".to_string()
                }
                ResolutionChoice::Theirs => {
                    entries.push(IndexInfoEntry {
                        path: f.path.clone(),
                        mode_oid: mode_of(&theirs_map),
                    });
                    "Tenuta la versione dei colleghi".to_string()
                }
                ResolutionChoice::Both => {
                    entries.push(IndexInfoEntry {
                        path: f.path.clone(),
                        mode_oid: mode_of(&theirs_map),
                    });
                    if let Some(o) = ours_map.get(&f.path) {
                        let suffix = format!("- versione {} {date}", identity.name);
                        let name = util::unique_name(&f.path, &suffix, |c| {
                            taken.contains(c) || entries.iter().any(|e| e.path == c)
                        });
                        taken.insert(name.clone());
                        util::validate_rel_path(&name)?;
                        entries.push(IndexInfoEntry {
                            path: name.clone(),
                            mode_oid: Some((o.mode.clone(), o.oid.clone())),
                        });
                        format!("Tenute entrambe: la mia versione è in «{name}»")
                    } else {
                        "Tenuta la versione dei colleghi".to_string()
                    }
                }
                ResolutionChoice::Manual => {
                    let bytes = self.read_manual_file(&f.path)?;
                    let mode_oid = match &bytes {
                        Some(b) => {
                            let oid = self.repo.write_blob(b)?;
                            let mode = ours_map
                                .get(&f.path)
                                .or_else(|| theirs_map.get(&f.path))
                                .map(|e| e.mode.clone())
                                .unwrap_or_else(|| "100644".into());
                            Some((mode, oid))
                        }
                        None => None,
                    };
                    entries.push(IndexInfoEntry {
                        path: f.path.clone(),
                        mode_oid,
                    });
                    manual.insert(f.path.clone());
                    "Unione manuale".to_string()
                }
            };
            groups.push(ChangelogGroup {
                path: f.path.clone(),
                lines: vec![line],
                interpreted: true,
            });
        }

        let idx = TempIndex::new(&self.repo);
        self.repo.read_tree(Some(idx.path()), &merged.tree)?;
        self.repo.update_index_info(Some(idx.path()), &entries)?;
        let final_tree = self.repo.write_tree(Some(idx.path()))?;
        drop(idx);

        // Editor guard: files that really have to be written must not be open in OpenRocket.
        let from_tree = self.repo.tree_of(&head)?;
        let need = self.paths_needing_write(&from_tree, &final_tree)?;
        let need: Vec<String> = need.into_iter().filter(|p| !manual.contains(p)).collect();
        let blockers = self.editor_blockers(&need);
        if !blockers.is_empty() {
            return Err(CoreError::BlockedByEditor(blockers));
        }

        self.safety_snapshot("risoluzione")?;
        self.step(op, "snapshot", None)?;

        let title = if rec.files.len() == 1 {
            format!("Risolto il conflitto su {}", rec.files[0].path)
        } else {
            format!("Risolti i conflitti su {} file", rec.files.len())
        };
        let mut vm = VersionMessage::new(
            VersionKind::ConflictResolution,
            title,
            &self.shared.config.client_version,
        );
        vm.changelog = groups;
        vm.conflict_id = Some(rec.id.clone());
        vm.resolution = resolutions
            .iter()
            .map(|r| (r.path.clone(), r.choice.as_str().to_string()))
            .collect();
        let msg = vm.render();
        let sig = Signature::now(identity.name.clone(), identity.email.clone());
        let parents = vec![first_parent.clone(), rec.ours_sha.clone()];
        let merge = self.repo.commit_tree(&CommitSpec {
            tree: &final_tree,
            parents: &parents,
            message: &msg,
            author: &sig,
            committer: &sig,
        })?;

        self.step(
            op,
            "materializing",
            Some(&json!({
                "oldHead": head, "newHead": merge, "fromTree": from_tree, "toTree": final_tree,
                "allowDirty": manual.iter().collect::<Vec<_>>(), "conflictId": rec.id,
                "resolutions": resolutions.iter().map(|r| json!({"path": r.path, "choice": r.choice})).collect::<Vec<_>>(),
            })),
        )?;
        let report = self.materialize(&from_tree, &final_tree, &manual)?;
        self.failpoint("materialize.before_ref_update")?;
        self.repo.update_ref(MAIN_REF, &merge, Some(&head))?;
        self.step(op, "applied", None)?;
        self.arm_guards(&report, &head, &merge)?;

        rec.status = ConflictStatus::Resolving;
        rec.resolution = Some(json!(resolutions
            .iter()
            .map(|r| json!({"path": r.path, "choice": r.choice}))
            .collect::<Vec<_>>()));
        rec.resolution_sha = Some(merge);
        self.shared.store.save_conflict(&rec)?;

        match self.send_pending(op, false)? {
            SendOutcome::Conflict(_)
            | SendOutcome::Sent(_)
            | SendOutcome::Offline
            | SendOutcome::Blocked(_)
            | SendOutcome::NothingToSend
            | SendOutcome::ConflictOpen => Ok(()),
        }
    }

    /// The user says whether he reopened the file before saving it (`§7.8`).
    pub(crate) fn answer_stale_save(&self, path: &str, reopened: bool) -> Result<ProjectStatus> {
        util::validate_rel_path(path)?;
        let watch = self
            .shared
            .store
            .list_watches(&self.id)?
            .into_iter()
            .find(|w| w.path == path && w.suspected)
            .ok_or_else(|| CoreError::NotFound(format!("salvataggio sospetto su {path}")))?;
        if reopened {
            self.shared.store.delete_watch(&self.id, path)?;
            self.mark_dirty();
            return self.status_now();
        }
        self.run_op("stale-save", Busy::Updating, json!({"path": path}), |op| {
            let identity = self.shared.identity()?;
            let bytes = self.read_manual_file(path)?.ok_or_else(|| {
                CoreError::NotFound(format!("il file {path} non esiste più nella cartella"))
            })?;
            // `ours` = the version before the update with the saved file on top.
            let base = watch.old_commit.clone();
            let base_tree = self.repo.tree_of(&base)?;
            let base_map = self.repo.tree_map(&base)?;
            let oid = self.repo.write_blob(&bytes)?;
            let mode = base_map
                .get(path)
                .map(|e| e.mode.clone())
                .unwrap_or_else(|| "100644".into());
            let idx = TempIndex::new(&self.repo);
            self.repo.read_tree(Some(idx.path()), &base_tree)?;
            self.repo.update_index_info(
                Some(idx.path()),
                &[IndexInfoEntry {
                    path: path.to_string(),
                    mode_oid: Some((mode, oid)),
                }],
            )?;
            let tree = self.repo.write_tree(Some(idx.path()))?;
            drop(idx);
            let sig = Signature::now(identity.name, identity.email);
            let mut vm = VersionMessage::new(
                VersionKind::Publish,
                format!("Salvataggio da una copia non aggiornata di {path}"),
                &self.shared.config.client_version,
            );
            vm.changelog = vec![ChangelogGroup {
                path: path.to_string(),
                lines: vec!["Salvato mentre OpenRocket aveva aperta una versione precedente".into()],
                interpreted: true,
            }];
            let ours = self.repo.commit_tree(&CommitSpec {
                tree: &tree,
                parents: &[base.clone()],
                message: &vm.render(),
                author: &sig,
                committer: &sig,
            })?;
            let theirs = self.head()?;
            self.safety_snapshot("salvataggio-sospetto")?;
            self.create_conflict_record(op, &base, &ours, &theirs, &[path.to_string()], "stale-save")?;
            self.shared.store.delete_watch(&self.id, path)?;
            Ok(())
        })?;
        self.status_now()
    }

    /// Retries to push the safety branch of conflicts for which it did not work (offline).
    pub(crate) fn retry_conflict_branches(&self) -> Result<()> {
        for c in self.shared.store.list_conflicts(&self.id, false)? {
            if c.status == ConflictStatus::Open && !c.remote_branch_pushed {
                self.push_conflict_branch(&c.id)?;
            }
        }
        Ok(())
    }
}
