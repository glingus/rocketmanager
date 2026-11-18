//! Materialisation of a tree on disk (`docs/protocollo-sync.md` §7.9) and arming of the stale-editor guard (§7.8).

use super::*;
use crate::hooks::{is_open, EditorState};
use crate::tracker::Meta;
use crate::util::{self, atomic_write, file_meta, remove_file_retry};
use rs_git::IndexInfoEntry;
use rs_store::GuardWatch;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Clone)]
pub(crate) struct WrittenFile {
    pub path: String,
    /// Blob on disk before the write (`None` = file did not exist).
    pub old_blob: Option<String>,
    /// Blob written (`None` = file deleted).
    pub new_blob: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MatReport {
    pub written: Vec<WrittenFile>,
}

struct Planned {
    path: String,
    target: Option<(String, String)>, // (mode, oid)
    from_oid: Option<String>,
    disk: Option<String>,
    write: bool,
}

fn is_regular_mode(m: &str) -> bool {
    matches!(m, "100644" | "100755" | "000000")
}

impl ProjectInner {
    /// Brings the files of the working directory from `from_tree` to `to_tree`.
    ///
    /// For every path that differs between the two trees the file on disk must be identical to the
    /// `from_tree` version, or already identical to the target (which makes the call idempotent).
    /// Paths in `allow_dirty` (the "manual" resolutions) are allowed to differ from `from_tree`
    /// but then must already hold the target content. If any path does not satisfy this,
    /// **nothing is written** and `LocalChangesPresent` is returned. Index entries of all touched paths are
    /// aligned with `to_tree` so that `git status` is clean for them.
    pub(crate) fn materialize(
        &self,
        from_tree: &str,
        to_tree: &str,
        allow_dirty: &HashSet<String>,
    ) -> Result<MatReport> {
        let diff: Vec<_> = self
            .repo
            .diff_tree(from_tree, to_tree, false)?
            .into_iter()
            .filter(|d| is_regular_mode(&d.old_mode) && is_regular_mode(&d.new_mode))
            .collect();
        for d in &diff {
            util::validate_rel_path(&d.path)?;
        }
        let paths: Vec<String> = diff.iter().map(|d| d.path.clone()).collect();
        let hashes = self.repo.hash_files(&paths)?;

        let mut plan: Vec<Planned> = Vec::new();
        let mut mismatches: Vec<String> = Vec::new();
        for (d, disk) in diff.iter().zip(hashes) {
            let from_oid = if rs_git::DiffEntry::is_zero_oid(&d.old_oid) {
                None
            } else {
                Some(d.old_oid.clone())
            };
            let target = if rs_git::DiffEntry::is_zero_oid(&d.new_oid) {
                None
            } else {
                Some((d.new_mode.clone(), d.new_oid.clone()))
            };
            let target_oid = target.as_ref().map(|t| t.1.clone());
            let write = if disk == target_oid {
                false // already in the desired state (idempotent re-run, or a manual merge)
            } else if !allow_dirty.contains(&d.path) && disk == from_oid {
                true
            } else {
                // Either the file was changed locally, or it is a "manual" path that no longer
                // holds the content that was chosen: never overwrite.
                mismatches.push(d.path.clone());
                false
            };
            plan.push(Planned {
                path: d.path.clone(),
                target,
                from_oid,
                disk,
                write,
            });
        }
        if !mismatches.is_empty() {
            mismatches.sort();
            return Err(CoreError::LocalChangesPresent(mismatches));
        }

        // Read every blob before touching the disk: a missing object must not leave half a job.
        let mut blobs: Vec<Option<Vec<u8>>> = Vec::with_capacity(plan.len());
        for p in &plan {
            if p.write {
                blobs.push(match &p.target {
                    Some((_, oid)) => Some(self.repo.cat_blob(oid)?),
                    None => None,
                });
            } else {
                blobs.push(None);
            }
        }

        let mut done: Vec<usize> = Vec::new();
        let mut written_count = 0usize;
        let mut failure: Option<CoreError> = None;
        for (i, p) in plan.iter().enumerate() {
            if !p.write {
                continue;
            }
            let abs = self.folder.join(&p.path);
            let res: Result<()> = match (&p.target, &blobs[i]) {
                (Some(_), Some(data)) => atomic_write(&abs, data).map_err(CoreError::from),
                _ => remove_file_retry(&abs)
                    .map(|_| util::prune_empty_parents(&self.folder, &abs))
                    .map_err(CoreError::from),
            };
            if let Err(e) = res {
                failure = Some(e);
                break;
            }
            done.push(i);
            written_count += 1;
            if written_count == 1 {
                // Simulated crash (tests): stop right here without rolling back.
                self.failpoint("materialize.after_first_write")?;
            }
        }
        if let Some(err) = failure {
            // Best-effort rollback of what was written in this call.
            for &i in done.iter().rev() {
                let p = &plan[i];
                let abs = self.folder.join(&p.path);
                match &p.from_oid {
                    Some(oid) => {
                        if let Ok(data) = self.repo.cat_blob(oid) {
                            let _ = atomic_write(&abs, &data);
                        }
                    }
                    None => {
                        let _ = remove_file_retry(&abs);
                        util::prune_empty_parents(&self.folder, &abs);
                    }
                }
            }
            return Err(err);
        }

        // Align the index and remember our own writes for the watcher.
        let now = Instant::now();
        let mut entries = Vec::new();
        for p in &plan {
            entries.push(IndexInfoEntry {
                path: p.path.clone(),
                mode_oid: p.target.clone(),
            });
        }
        self.repo.update_index_info(None, &entries)?;
        self.repo.refresh_index()?;
        {
            let mut t = self.tracker.lock().unwrap_or_else(|p| p.into_inner());
            for p in &plan {
                if p.write {
                    let meta = file_meta(&self.folder.join(&p.path))
                        .map(|(size, mtime)| Meta { size, mtime });
                    t.on_self_write(&p.path, meta, now);
                }
            }
        }
        let report = MatReport {
            written: plan
                .iter()
                .filter(|p| p.write)
                .map(|p| WrittenFile {
                    path: p.path.clone(),
                    old_blob: p.disk.clone(),
                    new_blob: p.target.as_ref().map(|t| t.1.clone()),
                })
                .collect(),
        };
        Ok(report)
    }

    /// Paths that [`ProjectInner::materialize`] would actually have to write (disk differs from the target).
    pub(crate) fn paths_needing_write(
        &self,
        from_tree: &str,
        to_tree: &str,
    ) -> Result<Vec<String>> {
        let diff: Vec<_> = self
            .repo
            .diff_tree(from_tree, to_tree, false)?
            .into_iter()
            .filter(|d| is_regular_mode(&d.old_mode) && is_regular_mode(&d.new_mode))
            .collect();
        let paths: Vec<String> = diff.iter().map(|d| d.path.clone()).collect();
        let hashes = self.repo.hash_files(&paths)?;
        Ok(diff
            .iter()
            .zip(hashes)
            .filter(|(d, disk)| {
                let target = if rs_git::DiffEntry::is_zero_oid(&d.new_oid) {
                    None
                } else {
                    Some(d.new_oid.clone())
                };
                *disk != target
            })
            .map(|(d, _)| d.path.clone())
            .collect())
    }

    /// Registers a stale-editor surveillance for every written file that OpenRocket may have open.
    pub(crate) fn arm_guards(
        &self,
        report: &MatReport,
        old_commit: &str,
        new_commit: &str,
    ) -> Result<()> {
        if report.written.is_empty() {
            return Ok(());
        }
        let state = self.shared.config.detector.state(&self.folder);
        let version = self.version_of(new_commit).ok().flatten();
        for w in &report.written {
            if w.new_blob.is_none() {
                continue;
            }
            let armed = match &state {
                EditorState::NotRunning => false,
                EditorState::Running { open_files: None } => true,
                EditorState::Running {
                    open_files: Some(open),
                } => is_open(&self.folder, &w.path, open),
            };
            if armed {
                self.shared.store.save_watch(&GuardWatch {
                    project_id: self.id.clone(),
                    path: w.path.clone(),
                    old_blob: w.old_blob.clone(),
                    new_blob: w.new_blob.clone(),
                    old_commit: old_commit.to_string(),
                    new_commit: new_commit.to_string(),
                    version,
                    written_at: rs_store::now_ms(),
                    suspected: false,
                })?;
            }
        }
        Ok(())
    }
}
