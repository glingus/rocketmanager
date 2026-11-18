//! History, comparison and export (`§7.7`).

use super::*;
use crate::message::parse_version_message;
use crate::types::{
    Comparison, FileChange, FileChangeKind, FileComparison, VersionAuthor, VersionInfo, VersionRef,
};
use crate::util::{self, atomic_write, github_login_from_email, iso_to_utc};
use rs_git::{DiffEntry, EMPTY_TREE};
use std::collections::HashSet;
use std::path::Path;

const DEFAULT_LIMIT: usize = 50;
const MAX_TEXT_DIFF_BYTES: u64 = 1024 * 1024;

fn is_hex_sha(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

impl ProjectInner {
    /// Resolves a user-supplied commit id (abbreviations allowed) to a full commit id.
    pub(crate) fn resolve_commit(&self, sha: &str) -> Result<String> {
        if !is_hex_sha(sha) {
            return Err(CoreError::InvalidArgument(format!(
                "identificativo di versione non valido: {sha}"
            )));
        }
        self.repo
            .resolve(&format!("{sha}^{{commit}}"))?
            .ok_or_else(|| CoreError::NotFound(format!("versione {sha}")))
    }

    fn tree_or_empty(&self, commit: Option<&String>) -> Result<String> {
        match commit {
            Some(c) => Ok(self.repo.tree_of(c)?),
            None => Ok(EMPTY_TREE.to_string()),
        }
    }

    fn file_changes(
        &self,
        from_tree: &str,
        to_tree: &str,
    ) -> Result<(Vec<DiffEntry>, Vec<FileChange>)> {
        let diff = self.repo.diff_tree(from_tree, to_tree, true)?;
        let binaries: HashSet<String> = self
            .repo
            .binary_paths(from_tree, to_tree)?
            .into_iter()
            .collect();
        let mut specs: Vec<String> = Vec::new();
        for d in &diff {
            specs.push(if DiffEntry::is_zero_oid(&d.old_oid) {
                "0".repeat(40)
            } else {
                d.old_oid.clone()
            });
            specs.push(if DiffEntry::is_zero_oid(&d.new_oid) {
                "0".repeat(40)
            } else {
                d.new_oid.clone()
            });
        }
        let sizes = self.repo.batch_check(&specs)?;
        let mut out = Vec::new();
        for (i, d) in diff.iter().enumerate() {
            let size_before = if DiffEntry::is_zero_oid(&d.old_oid) {
                None
            } else {
                sizes[2 * i].as_ref().map(|s| s.1)
            };
            let size_after = if DiffEntry::is_zero_oid(&d.new_oid) {
                None
            } else {
                sizes[2 * i + 1].as_ref().map(|s| s.1)
            };
            let change = match d.status {
                'A' => FileChangeKind::Added,
                'D' => FileChangeKind::Deleted,
                'R' | 'C' => FileChangeKind::Renamed,
                _ => FileChangeKind::Modified,
            };
            out.push(FileChange {
                path: d.path.clone(),
                change,
                old_path: d.old_path.clone(),
                binary: binaries.contains(&d.path),
                size_before,
                size_after,
            });
        }
        Ok((diff, out))
    }

    fn version_info_for(&self, sha: &str, published: bool) -> Result<VersionInfo> {
        let info = self.repo.commit_info(sha)?;
        let parsed = parse_version_message(&info.message);
        let parent_tree = self.tree_or_empty(info.parents.first())?;
        let tree = self.repo.tree_of(sha)?;
        let (_, files) = self.file_changes(&parent_tree, &tree)?;
        Ok(VersionInfo {
            number: if published { parsed.number } else { None },
            sha: sha.to_string(),
            kind: parsed.kind,
            title: parsed.title,
            description: parsed.description,
            changelog: parsed.changelog,
            author: VersionAuthor {
                github_login: github_login_from_email(&info.author.email),
                name: info.author.name.clone(),
                email: info.author.email.clone(),
            },
            date: iso_to_utc(info.author.when_iso.as_deref().unwrap_or("")),
            files,
            restored_from: parsed.restored_from,
            conflict_id: parsed.conflict_id,
            published,
        })
    }

    fn is_published(&self, commit: &str) -> Result<bool> {
        match self.origin()? {
            Some(o) => Ok(self.repo.is_ancestor(commit, &o)?),
            None => Ok(false),
        }
    }

    /// Versions, newest first: pending ones, then the first-parent history of `origin/main`.
    pub(crate) fn list_versions(
        &self,
        limit: Option<usize>,
        before_sha: Option<&str>,
    ) -> Result<Vec<VersionInfo>> {
        let pending = self.pending_commits()?;
        let published = match self.origin()? {
            Some(o) => self.repo.rev_list(&["--first-parent", &o])?,
            None => Vec::new(),
        };
        let pending_set: HashSet<String> = pending.iter().cloned().collect();
        let mut all: Vec<String> = pending;
        all.extend(published);
        let start = match before_sha {
            Some(b) => {
                let full = self.resolve_commit(b)?;
                all.iter()
                    .position(|s| *s == full)
                    .map(|i| i + 1)
                    .ok_or_else(|| CoreError::NotFound(format!("versione {b}")))?
            }
            None => 0,
        };
        let take = limit.unwrap_or(DEFAULT_LIMIT);
        let mut out = Vec::new();
        for sha in all.iter().skip(start).take(take) {
            out.push(self.version_info_for(sha, !pending_set.contains(sha))?);
        }
        Ok(out)
    }

    pub(crate) fn get_version(&self, sha: &str) -> Result<VersionInfo> {
        let full = self.resolve_commit(sha)?;
        let published = self.is_published(&full)?;
        self.version_info_for(&full, published)
    }

    fn version_ref(&self, commit: &str) -> Result<VersionRef> {
        let published = self.is_published(commit)?;
        let number = if published {
            parse_version_message(&self.repo.commit_info(commit)?.message).number
        } else {
            None
        };
        Ok(VersionRef {
            number,
            sha: commit.to_string(),
        })
    }

    /// Comparison between any two versions, with the bytes of both parts for each file.
    pub(crate) fn compare_versions(&self, from_sha: &str, to_sha: &str) -> Result<Comparison> {
        let from = self.resolve_commit(from_sha)?;
        let to = self.resolve_commit(to_sha)?;
        let ft = self.repo.tree_of(&from)?;
        let tt = self.repo.tree_of(&to)?;
        let (diff, changes) = self.file_changes(&ft, &tt)?;
        let mut files = Vec::new();
        for (d, c) in diff.iter().zip(changes) {
            let before = if DiffEntry::is_zero_oid(&d.old_oid) {
                None
            } else {
                Some(self.repo.cat_blob(&d.old_oid)?)
            };
            let after = if DiffEntry::is_zero_oid(&d.new_oid) {
                None
            } else {
                Some(self.repo.cat_blob(&d.new_oid)?)
            };
            let small =
                c.size_before.unwrap_or(0).max(c.size_after.unwrap_or(0)) <= MAX_TEXT_DIFF_BYTES;
            let text_diff = if !c.binary && small && c.change != FileChangeKind::Renamed {
                Some(self.repo.diff_text(&from, &to, &c.path)?)
            } else {
                None
            };
            let is_ork = c.path.to_lowercase().ends_with(".ork");
            let note = if c.binary && !is_ork {
                Some(match (c.size_before, c.size_after) {
                    (Some(a), Some(b)) if a == b => {
                        "File binario: stessa dimensione, contenuto diverso".to_string()
                    }
                    (Some(a), Some(b)) => {
                        format!("File binario: la dimensione è passata da {a} a {b} byte")
                    }
                    (None, Some(b)) => format!("File binario aggiunto ({b} byte)"),
                    (Some(a), None) => format!("File binario rimosso ({a} byte)"),
                    _ => "File binario".to_string(),
                })
            } else {
                None
            };
            files.push(FileComparison {
                file: c,
                ork: None,
                text_diff,
                note,
                before,
                after,
            });
        }
        Ok(Comparison {
            from: self.version_ref(&from)?,
            to: self.version_ref(&to)?,
            files,
        })
    }

    /// Content of a file in a version.
    pub(crate) fn read_file_at(&self, sha: &str, path: &str) -> Result<Option<Vec<u8>>> {
        util::validate_rel_path(path)?;
        let full = self.resolve_commit(sha)?;
        match self.repo.resolve(&format!("{full}:{path}"))? {
            Some(oid) => Ok(Some(self.repo.cat_blob(&oid)?)),
            None => Ok(None),
        }
    }

    /// Writes (a subset of) the files of a tree-ish into `dest_dir`; existing files are never
    /// overwritten (a numeric suffix is added). Returns the absolute paths written.
    pub(crate) fn export_tree(
        &self,
        rev: &str,
        paths: Option<&[String]>,
        dest_dir: &Path,
    ) -> Result<Vec<String>> {
        let entries = self.repo.ls_tree(rev)?;
        let selected: Vec<_> = match paths {
            Some(ps) => {
                for p in ps {
                    util::validate_rel_path(p)?;
                }
                let mut v = Vec::new();
                for p in ps {
                    match entries.iter().find(|e| &e.path == p) {
                        Some(e) => v.push(e.clone()),
                        None => {
                            return Err(CoreError::NotFound(format!("file {p} nella versione")))
                        }
                    }
                }
                v
            }
            None => entries,
        };
        std::fs::create_dir_all(dest_dir)?;
        let mut written = Vec::new();
        for e in selected {
            util::validate_rel_path(&e.path)?;
            let mut rel = e.path.clone();
            if dest_dir.join(&rel).exists() {
                rel = util::unique_name(&e.path, "(copia)", |c| dest_dir.join(c).exists());
            }
            let target = dest_dir.join(&rel);
            let data = self.repo.cat_blob(&e.oid)?;
            atomic_write(&target, &data)?;
            written.push(target.to_string_lossy().into_owned());
        }
        Ok(written)
    }

    pub(crate) fn export_version(
        &self,
        sha: &str,
        paths: Option<&[String]>,
        dest_dir: &Path,
    ) -> Result<Vec<String>> {
        let full = self.resolve_commit(sha)?;
        self.export_tree(&full, paths, dest_dir)
    }

    /// Temporary copy of one file of a version, to open in OpenRocket (`.rocketsync/local/versioni/`).
    pub(crate) fn export_version_copy(&self, sha: &str, path: &str) -> Result<PathBuf> {
        let full = self.resolve_commit(sha)?;
        let bytes = self
            .read_file_at(&full, path)?
            .ok_or_else(|| CoreError::NotFound(format!("file {path} nella versione")))?;
        let published = self.is_published(&full)?;
        let label = if published {
            match self.version_ref(&full)?.number {
                Some(n) => format!("v{n}"),
                None => full[..8.min(full.len())].to_string(),
            }
        } else {
            full[..8.min(full.len())].to_string()
        };
        let (stem, ext) = util::split_ext(path);
        let rel = format!(".rocketsync/local/versioni/{label}/{stem} ({label}){ext}");
        let abs = self.folder.join(&rel);
        atomic_write(&abs, &bytes)?;
        Ok(abs)
    }
}
