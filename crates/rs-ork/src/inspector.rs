//! Adapter-friendly facade with the same signatures as `rs-core`'s `FileInspector` trait
//! (protocollo-sync.md section 10). `rs-ork` does not depend on `rs-core`: the adapter that
//! implements the trait by delegating to these methods lives in `rs-core`/the shell.

use crate::{changelog_lines, diff, validate};

#[derive(Debug, Clone, Copy, Default)]
pub struct OrkInspector;

fn is_ork(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".ork")
}

impl OrkInspector {
    pub fn new() -> Self {
        OrkInspector
    }

    /// `Ok` if the file is complete and readable; `Err(reason in Italian)` otherwise.
    /// Non-`.ork` paths are always valid (nothing to check).
    pub fn validate(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        if !is_ork(path) {
            return Ok(());
        }
        validate(bytes).map(|_| ()).map_err(|e| e.to_string())
    }

    /// Changelog lines in Italian (without the "• " prefix).
    pub fn changelog(
        &self,
        path: &str,
        before: Option<&[u8]>,
        after: Option<&[u8]>,
    ) -> Vec<String> {
        if !is_ork(path) {
            return generic(before, after);
        }
        let d = diff(path, before, after);
        if d.parse_error.is_some() {
            return generic(before, after);
        }
        changelog_lines(&d)
    }
}

fn generic(before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String> {
    match (before, after) {
        (None, Some(_)) => vec!["Aggiunto".to_string()],
        (Some(_), None) => vec!["Rimosso".to_string()],
        (Some(b), Some(a)) if b == a => vec!["Nessuna modifica".to_string()],
        (Some(_), Some(_)) => vec!["Modificato (contenuto non interpretato)".to_string()],
        (None, None) => Vec::new(),
    }
}
