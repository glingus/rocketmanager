//! Linking a folder to a remote repository (`§7.1`) and folder checks.

use super::*;
use crate::types::{FolderCheck, LinkRequest, SyncedDrive};
use crate::util::{self, random_id, today_ymd};
use rs_git::Git;
use std::fs;
use std::path::{Path, PathBuf};

/// Counts files (recursively, capped) and tells whether the folder is empty.
fn count_files(dir: &Path, cap: u64) -> u64 {
    let mut n = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if n >= cap {
                return n;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                n += 1;
            }
        }
    }
    n
}

fn synced_drive_of(path: &Path) -> Option<SyncedDrive> {
    for c in path.components() {
        let s = c.as_os_str().to_string_lossy().to_lowercase();
        if s.starts_with("onedrive") {
            return Some(SyncedDrive::Onedrive);
        }
        if s.starts_with("dropbox") {
            return Some(SyncedDrive::Dropbox);
        }
        if s == "google drive"
            || s == "googledrive"
            || s == "my drive"
            || s.starts_with("google drive")
        {
            return Some(SyncedDrive::GoogleDrive);
        }
    }
    None
}

/// Inspects a candidate folder (existence, emptiness, writability, synced drives).
pub(crate) fn check_folder(path: &Path) -> FolderCheck {
    let exists = path.is_dir();
    let (empty, count) = if exists {
        let has_any = fs::read_dir(path)
            .map(|mut r| r.next().is_some())
            .unwrap_or(false);
        (!has_any, count_files(path, 100_000))
    } else {
        (true, 0)
    };
    let writable = {
        let probe_dir = if exists {
            Some(path.to_path_buf())
        } else {
            path.ancestors()
                .skip(1)
                .find(|a| a.is_dir())
                .map(Path::to_path_buf)
        };
        match probe_dir {
            Some(d) => {
                let probe = d.join(format!(".rocketsync-probe-{}", random_id(6)));
                let ok = fs::write(&probe, b"").is_ok();
                let _ = fs::remove_file(&probe);
                ok
            }
            None => false,
        }
    };
    FolderCheck {
        exists,
        empty,
        writable,
        in_synced_drive: synced_drive_of(path),
        file_count: count,
    }
}

fn files_equal(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) if x.len() == y.len() => match (fs::read(a), fs::read(b)) {
            (Ok(p), Ok(q)) => p == q,
            _ => false,
        },
        _ => false,
    }
}

/// Moves `path` (a file or folder) aside to `<name> (copia locale AAAA-MM-GG).<ext>`.
fn move_aside(root: &Path, rel: &str) -> Result<String> {
    let suffix = format!("(copia locale {})", today_ymd());
    let new_rel = util::unique_name(rel, &suffix, |c| root.join(c).exists());
    fs::rename(root.join(rel), root.join(&new_rel))?;
    Ok(new_rel)
}

/// Result of [`link_folder`].
pub(crate) struct Linked {
    pub remote_url: String,
}

/// Clones the remote into `req.folder`, never losing a local file (`§7.1`).
pub(crate) fn link_folder(
    git: &Git,
    req: &LinkRequest,
    progress: &dyn Fn(&str, Option<f32>, &str),
) -> Result<Linked> {
    let folder = PathBuf::from(&req.folder);
    let remote_url = req
        .remote_url
        .clone()
        .unwrap_or_else(|| format!("https://github.com/{}.git", req.repo_full_name));
    let check = check_folder(&folder);
    if let (Some(d), false) = (check.in_synced_drive, req.allow_synced_drive) {
        return Err(CoreError::FolderInSyncedDrive(format!("{d:?}")));
    }
    if !check.exists {
        fs::create_dir_all(&folder)?;
    } else if !check.writable {
        return Err(CoreError::Io(format!(
            "la cartella {} non è scrivibile",
            folder.display()
        )));
    }

    // Folder that already holds a repository: adopt it only if it points to the same remote.
    if folder.join(".git").exists() {
        let repo = git.open(&folder)?;
        let url = repo.config_get("remote.origin.url")?;
        if url.as_deref() != Some(remote_url.as_str()) {
            return Err(CoreError::FolderNotEmpty(
                "contiene già un repository collegato a un altro indirizzo".into(),
            ));
        }
        progress("fetch", None, "Controllo delle novità");
        repo.fetch(
            "origin",
            &[
                "refs/heads/main:refs/remotes/origin/main",
                "refs/tags/*:refs/tags/*",
            ],
        )?;
        if repo.resolve("refs/heads/main")?.is_none() {
            return Err(CoreError::NotLinked(
                "il repository non ha il branch main".into(),
            ));
        }
        return Ok(Linked { remote_url });
    }

    let empty = check.empty || !check.exists;
    if empty {
        progress("clone", None, "Scaricamento del progetto");
        git.clone_repo(&remote_url, &folder, "main")?;
        return Ok(Linked { remote_url });
    }

    // Non-empty folder: clone aside, merge the files, then move `.git` in.
    let tmp_name = format!(".rocketsync-link-{}", random_id(8));
    let tmp = folder.join(&tmp_name);
    progress("clone", None, "Scaricamento del progetto");
    let tmp_repo = git.clone_repo(&remote_url, &tmp, "main")?;
    let result = (|| -> Result<()> {
        let entries = tmp_repo.ls_tree("HEAD")?;
        let total = entries.len().max(1);
        for (i, e) in entries.iter().enumerate() {
            util::validate_rel_path(&e.path)?;
            let src = tmp.join(&e.path);
            let dst = folder.join(&e.path);
            // A local *file* where the remote has a folder.
            let parts: Vec<&str> = e.path.split('/').collect();
            for n in 1..parts.len() {
                let prefix = parts[..n].join("/");
                if folder.join(&prefix).is_file() {
                    move_aside(&folder, &prefix)?;
                }
            }
            if dst.is_dir() {
                move_aside(&folder, &e.path)?;
            }
            if dst.is_file() {
                if files_equal(&src, &dst) {
                    continue;
                }
                move_aside(&folder, &e.path)?;
            }
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&src, &dst)?;
            progress(
                "merge",
                Some((i + 1) as f32 / total as f32 * 100.0),
                "Unione dei file locali con quelli del progetto",
            );
        }
        fs::rename(tmp.join(".git"), folder.join(".git"))?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp);
    result?;

    // The index must reflect HEAD; untracked local files stay as unpublished changes.
    let repo = git.repo(&folder);
    repo.read_tree(None, "HEAD")?;
    repo.refresh_index()?;
    Ok(Linked { remote_url })
}
