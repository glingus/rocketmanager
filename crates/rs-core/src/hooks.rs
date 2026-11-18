//! Extension points of the engine (`docs/protocollo-sync.md` §10).
//!
//! `rs-core` depends neither on `rs-ork` nor on Tauri: the host application provides a
//! [`FileInspector`] (validation and changelog per file type) and an [`EditorDetector`] (which
//! files are open in OpenRocket).

use std::path::{Path, PathBuf};

/// Validation and changelog per file type (`rs-ork` provides the implementation for `.ork`).
pub trait FileInspector: Send + Sync {
    /// `Ok` if the file is complete and readable; `Err(reason in Italian)` if partial or corrupt.
    fn validate(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
    /// Changelog lines in Italian, without the leading `• `.
    fn changelog(&self, path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String>;
    /// Whether two byte strings are the same *content* for this file type. Two saves of the same
    /// rocket produce different bytes (ZIP metadata): such a file is not a change. The default is
    /// plain byte equality.
    fn content_equal(&self, _path: &str, a: &[u8], b: &[u8]) -> bool {
        a == b
    }
}

/// Default inspector: validates everything and produces generic changelog lines.
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultInspector;

/// Suffix that marks a changelog group as "not semantically interpreted".
pub(crate) const UNINTERPRETED_SUFFIX: &str = "(contenuto non interpretato)";

/// Whether a changelog line is one of the generic ones of the default inspector.
pub(crate) fn is_generic_line(l: &str) -> bool {
    l == "Aggiunto" || l == "Rimosso" || l.ends_with(UNINTERPRETED_SUFFIX)
}

impl FileInspector for DefaultInspector {
    fn validate(&self, _path: &str, _bytes: &[u8]) -> Result<(), String> {
        Ok(())
    }

    fn changelog(&self, _path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String> {
        match (before, after) {
            (None, Some(_)) => vec!["Aggiunto".to_string()],
            (Some(_), None) => vec!["Rimosso".to_string()],
            _ => vec![format!("Modificato {UNINTERPRETED_SUFFIX}")],
        }
    }
}

/// What OpenRocket is doing on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorState {
    /// OpenRocket is not running.
    NotRunning,
    /// OpenRocket is running. `open_files` is `None` when it is not known which files are open.
    Running { open_files: Option<Vec<PathBuf>> },
}

/// Detection of the files open in OpenRocket (real implementation on Windows, mock in tests).
pub trait EditorDetector: Send + Sync {
    /// State of the editor with respect to the files under `project_root`.
    fn state(&self, project_root: &Path) -> EditorState;
}

/// Detector for platforms without a real implementation: OpenRocket is always "not running".
#[derive(Debug, Default, Clone, Copy)]
pub struct NullEditorDetector;

impl EditorDetector for NullEditorDetector {
    fn state(&self, _project_root: &Path) -> EditorState {
        EditorState::NotRunning
    }
}

/// Whether the file at `rel_path` (relative to `root`) is among the files reported open.
pub(crate) fn is_open(root: &Path, rel_path: &str, open: &[PathBuf]) -> bool {
    let target = root.join(rel_path);
    open.iter().any(|p| paths_equal(p, &target))
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

pub(crate) fn paths_equal(a: &Path, b: &Path) -> bool {
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_inspector_lines() {
        let i = DefaultInspector;
        assert!(i.validate("a.ork", b"anything").is_ok());
        assert_eq!(i.changelog("a", None, Some(b"x")), vec!["Aggiunto"]);
        assert_eq!(i.changelog("a", Some(b"x"), None), vec!["Rimosso"]);
        assert!(i.changelog("a", Some(b"x"), Some(b"y"))[0].ends_with(UNINTERPRETED_SUFFIX));
    }

    #[test]
    fn open_file_matching() {
        let root = Path::new("/p");
        assert!(is_open(root, "a/b.ork", &[PathBuf::from("/p/a/b.ork")]));
        assert!(!is_open(root, "a/b.ork", &[PathBuf::from("/p/a/c.ork")]));
    }
}
