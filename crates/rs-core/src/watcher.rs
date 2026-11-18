//! File system watcher of a project folder (`docs/protocollo-sync.md` §5.1).
//!
//! The watcher only *feeds* the [`FileTracker`](crate::tracker): the stability and validity rules
//! are applied when the status is computed. It ignores `.git/`, `.rocketsync/local/`, the
//! patterns of the project's `.gitignore` and the events caused by Rocket Sync's own writes.

use crate::project::{build_ignore, ProjectInner};
use crate::tracker::Meta;
use crate::util::file_meta;
use notify::event::{AccessKind, AccessMode, EventKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Instant;

/// Keeps the OS watcher alive; dropping it stops the watching.
pub(crate) struct ProjectWatcher {
    _watcher: RecommendedWatcher,
}

/// Relative `/`-separated path of `path` under `root` (or its canonical form).
fn relative(path: &Path, root: &Path, canon: &Path) -> Option<String> {
    let rel = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(canon))
        .ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

impl ProjectInner {
    /// Whether events on `rel` must be ignored.
    pub(crate) fn is_ignored_path(&self, rel: &str) -> bool {
        if rel == ".git" || rel.starts_with(".git/") || rel.starts_with(".rocketsync/local") {
            return true;
        }
        let abs = self.folder.join(rel);
        let is_dir = abs.is_dir();
        let g = self.ignore.lock().unwrap_or_else(|p| p.into_inner());
        g.matched_path_or_any_parents(Path::new(rel), is_dir)
            .is_ignore()
    }

    fn handle_fs_event(&self, canon: &Path, ev: &notify::Event) {
        let relevant = match &ev.kind {
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
            EventKind::Access(_) => false,
            _ => true,
        };
        if !relevant {
            return;
        }
        let mut any = false;
        for p in &ev.paths {
            let Some(rel) = relative(p, &self.folder, canon) else {
                continue;
            };
            if rel == ".gitignore" {
                *self.ignore.lock().unwrap_or_else(|g| g.into_inner()) = build_ignore(&self.folder);
            }
            if self.is_ignored_path(&rel) {
                continue;
            }
            let meta = file_meta(p).map(|(size, mtime)| Meta { size, mtime });
            self.tracker
                .lock()
                .unwrap_or_else(|g| g.into_inner())
                .on_event(&rel, meta, Instant::now());
            any = true;
        }
        if any {
            self.mark_dirty();
            self.wake.notify_one();
        }
    }
}

/// Starts watching the project folder recursively.
pub(crate) fn start_watcher(inner: &Arc<ProjectInner>) -> Result<ProjectWatcher, notify::Error> {
    let weak: Weak<ProjectInner> = Arc::downgrade(inner);
    let canon: PathBuf = inner
        .folder
        .canonicalize()
        .unwrap_or_else(|_| inner.folder.clone());
    let canon2 = canon.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Some(inner) = weak.upgrade() else { return };
        match res {
            Ok(ev) => inner.handle_fs_event(&canon2, &ev),
            Err(_) => {
                // The watcher lost events (overflow): re-read everything.
                inner.mark_dirty();
                inner.wake.notify_one();
            }
        }
    })?;
    watcher.watch(&inner.folder, RecursiveMode::Recursive)?;
    Ok(ProjectWatcher { _watcher: watcher })
}
