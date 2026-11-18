//! Safety copies (`docs/protocollo-sync.md` §8): complete snapshots of the working directory in
//! hidden local refs, built with a private index so neither the working directory nor the real
//! index are touched.

use super::*;
use crate::types::Snapshot;
use crate::util::{iso_from_ms, random_id};
use rs_git::{CommitSpec, Signature};
use std::path::Path;

pub(crate) const SAFETY_PREFIX: &str = "refs/rocketsync/safety/";

/// A private index file inside `.git`, removed on drop.
pub(crate) struct TempIndex(pub PathBuf);

impl TempIndex {
    pub(crate) fn new(repo: &Repo) -> Self {
        TempIndex(
            repo.git_dir()
                .join(format!("rocketsync-index-{}", random_id(8))),
        )
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

impl ProjectInner {
    /// Signature for commits that are not authored by a publication (safety copies).
    pub(crate) fn service_signature(&self) -> Signature {
        match self.shared.identity() {
            Ok(i) => Signature::now(i.name, i.email),
            Err(_) => Signature::now("Rocket Sync", "rocketsync@users.noreply.github.com"),
        }
    }

    /// Creates a safety copy of the whole working directory (new files included, ignored ones
    /// excluded). Returns the ref name, or `None` when the folder is identical to `HEAD`.
    pub(crate) fn safety_snapshot(&self, operation: &str) -> Result<Option<String>> {
        let head = self.head()?;
        let head_tree = self.repo.tree_of(&head)?;
        let idx = TempIndex::new(&self.repo);
        self.repo.read_tree(Some(idx.path()), &head_tree)?;
        self.repo.add_all(Some(idx.path()))?;
        let tree = self.repo.write_tree(Some(idx.path()))?;
        if tree == head_tree {
            return Ok(None);
        }
        let sig = self.service_signature();
        let msg = format!(
            "Copia di sicurezza ({operation})\n\nRocket-Sync-Kind: safety\nRocket-Sync-Client: {}\n",
            self.shared.config.client_version
        );
        let commit = self.repo.commit_tree(&CommitSpec {
            tree: &tree,
            parents: &[head],
            message: &msg,
            author: &sig,
            committer: &sig,
        })?;
        let op: String = operation
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let mut name = format!("{SAFETY_PREFIX}{}-{op}", rs_store::now_ms());
        if self.repo.resolve(&name)?.is_some() {
            name.push_str(&format!("-{}", random_id(4)));
        }
        self.repo.update_ref(&name, &commit, None)?;
        self.prune_snapshots()?;
        Ok(Some(name))
    }

    fn prune_snapshots(&self) -> Result<()> {
        let mut refs = self.repo.for_each_ref(SAFETY_PREFIX)?;
        refs.sort_by_key(|r| (r.date_unix, r.name.clone()));
        let timing = &self.shared.config.timing;
        let cutoff = rs_store::now_ms() / 1000 - timing.snapshot_retention.as_secs() as i64;
        let mut remaining: Vec<_> = Vec::new();
        for r in refs {
            if r.date_unix < cutoff {
                self.repo.delete_ref(&r.name)?;
            } else {
                remaining.push(r);
            }
        }
        while remaining.len() > timing.snapshot_max {
            let r = remaining.remove(0);
            self.repo.delete_ref(&r.name)?;
        }
        Ok(())
    }

    /// Safety copies, newest first.
    pub(crate) fn list_snapshots(&self) -> Result<Vec<Snapshot>> {
        let mut refs = self.repo.for_each_ref(SAFETY_PREFIX)?;
        refs.sort_by_key(|r| std::cmp::Reverse((r.date_unix, r.name.clone())));
        let mut out = Vec::new();
        for r in refs {
            let id = r.name.trim_start_matches(SAFETY_PREFIX).to_string();
            let (ms, op) = match id.split_once('-') {
                Some((a, b)) => (
                    a.parse::<i64>().unwrap_or(r.date_unix * 1000),
                    b.to_string(),
                ),
                None => (r.date_unix * 1000, String::new()),
            };
            let count = self.repo.ls_tree(&r.sha)?.len() as u64;
            out.push(Snapshot {
                id,
                created_at: iso_from_ms(ms),
                operation: op,
                file_count: count,
            });
        }
        Ok(out)
    }

    /// Writes the files of a safety copy into `dest_dir`; returns the paths written.
    pub(crate) fn export_snapshot(
        &self,
        snapshot_id: &str,
        dest_dir: &Path,
    ) -> Result<Vec<String>> {
        if snapshot_id.is_empty()
            || !snapshot_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CoreError::InvalidArgument(
                "id della copia di sicurezza".into(),
            ));
        }
        let name = format!("{SAFETY_PREFIX}{snapshot_id}");
        let sha = self
            .repo
            .resolve(&name)?
            .ok_or_else(|| CoreError::NotFound(format!("copia di sicurezza {snapshot_id}")))?;
        self.export_tree(&sha, None, dest_dir)
    }
}
