//! Fills the fields that `rs-core` leaves empty: the semantic diff of `.ork` files, the textual
//! diff of text files and the three-way diff of conflicts. Also the adapter between the engine's
//! `FileInspector` and `rs-ork`.

use rs_core::{Comparison, Conflict, FileChangeKind, FileInspector};
use similar::TextDiff;

fn is_ork(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".ork")
}

/// `FileInspector` for the engine: `rs-ork` for `.ork` files, the default behaviour otherwise.
#[derive(Debug, Default, Clone, Copy)]
pub struct ShellInspector {
    ork: rs_ork::OrkInspector,
}

impl FileInspector for ShellInspector {
    fn validate(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.ork.validate(path, bytes)
    }

    fn changelog(&self, path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String> {
        self.ork.changelog(path, before, after)
    }

    fn content_equal(&self, path: &str, a: &[u8], b: &[u8]) -> bool {
        a == b || (is_ork(path) && self.ork.content_equal(path, a, b))
    }
}

/// Maximum size of a text diff computed here.
const MAX_TEXT_DIFF: usize = 1024 * 1024;

/// Unified diff of two texts (`None` if they are not UTF-8 or too big).
pub fn unified_text_diff(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Option<String> {
    let b = before.unwrap_or(&[]);
    let a = after.unwrap_or(&[]);
    if b.len() > MAX_TEXT_DIFF || a.len() > MAX_TEXT_DIFF {
        return None;
    }
    let (b, a) = (std::str::from_utf8(b).ok()?, std::str::from_utf8(a).ok()?);
    let old_name = if before.is_some() { format!("a/{path}") } else { "/dev/null".to_string() };
    let new_name = if after.is_some() { format!("b/{path}") } else { "/dev/null".to_string() };
    Some(
        TextDiff::from_lines(b, a)
            .unified_diff()
            .context_radius(3)
            .header(&old_name, &new_name)
            .to_string(),
    )
}

/// Adds `ork` (semantic diff) to `.ork` files and `textDiff` to text files.
pub fn enrich_comparison(c: &mut Comparison) {
    for f in &mut c.files {
        let path = f.file.path.clone();
        if is_ork(&path) {
            let d = rs_ork::diff(&path, f.before.as_deref(), f.after.as_deref());
            f.ork = serde_json::to_value(&d).ok();
            f.text_diff = None;
        } else if !f.file.binary && f.file.change != FileChangeKind::Renamed {
            if let Some(t) = unified_text_diff(&path, f.before.as_deref(), f.after.as_deref()) {
                f.text_diff = Some(t);
            }
        }
    }
}

/// Adds `threeWay` to the `.ork` files of a conflict whose three sides all exist.
pub fn enrich_conflict_with(c: &mut Conflict, mut read: impl FnMut(&str, rs_core::ConflictSide) -> Option<Vec<u8>>) {
    for f in &mut c.files {
        if !is_ork(&f.path) {
            continue;
        }
        let base = read(&f.path, rs_core::ConflictSide::Base);
        let ours = read(&f.path, rs_core::ConflictSide::Ours);
        let theirs = read(&f.path, rs_core::ConflictSide::Theirs);
        if let (Some(b), Some(o), Some(t)) = (base, ours, theirs) {
            f.three_way = serde_json::to_value(rs_ork::three_way(&f.path, &b, &o, &t)).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rs_core::{ConflictFile, ConflictFileKind, ConflictStatusDto, FileChange, FileComparison, VersionRef};

    fn fc(path: &str, binary: bool, before: Option<&[u8]>, after: Option<&[u8]>) -> FileComparison {
        FileComparison {
            file: FileChange {
                path: path.into(),
                change: FileChangeKind::Modified,
                old_path: None,
                binary,
                size_before: before.map(|b| b.len() as u64),
                size_after: after.map(|b| b.len() as u64),
            },
            ork: None,
            text_diff: None,
            note: None,
            before: before.map(<[u8]>::to_vec),
            after: after.map(<[u8]>::to_vec),
        }
    }

    #[test]
    fn text_files_get_a_unified_diff_and_binaries_do_not() {
        let mut c = Comparison {
            from: VersionRef { number: Some(1), sha: "a".into() },
            to: VersionRef { number: Some(2), sha: "b".into() },
            files: vec![
                fc("Note.txt", false, Some(b"uno\ndue\n"), Some(b"uno\ndue modificato\ntre\n")),
                fc("img.png", true, Some(&[0, 1]), Some(&[0, 2])),
                fc("Nuovo.md", false, None, Some(b"# titolo\n")),
                fc("Binario.dat", false, Some(&[0xff, 0xfe, 0x00]), Some(&[0xff])),
            ],
        };
        enrich_comparison(&mut c);
        let d = c.files[0].text_diff.as_deref().unwrap();
        assert!(d.contains("--- a/Note.txt") && d.contains("+++ b/Note.txt"), "{d}");
        assert!(d.contains("-due\n") && d.contains("+due modificato\n") && d.contains("+tre\n"), "{d}");
        assert!(c.files[1].text_diff.is_none());
        let n = c.files[2].text_diff.as_deref().unwrap();
        assert!(n.contains("--- /dev/null") && n.contains("+# titolo"), "{n}");
        assert!(c.files[3].text_diff.is_none(), "not UTF-8");
    }

    #[test]
    fn unreadable_ork_gets_a_parse_error_not_a_panic() {
        let mut c = Comparison {
            from: VersionRef { number: None, sha: "a".into() },
            to: VersionRef { number: None, sha: "b".into() },
            files: vec![fc("Razzo.ork", true, Some(b"not a zip"), Some(b"neither"))],
        };
        enrich_comparison(&mut c);
        let ork = c.files[0].ork.as_ref().expect("ork diff present");
        assert_eq!(ork["path"], "Razzo.ork");
        assert!(ork["parseError"].is_string(), "{ork}");
        assert!(c.files[0].text_diff.is_none());
        let j = serde_json::to_value(&c).unwrap();
        assert!(j["files"][0]["ork"]["parseError"].is_string());
        assert!(j["files"][0].get("before").is_none());
    }

    #[test]
    fn conflict_three_way_is_filled_only_when_all_sides_exist() {
        let mut c = Conflict {
            id: "x".into(),
            project_id: "p".into(),
            status: ConflictStatusDto::Open,
            created_at: "2026-01-01T00:00:00Z".into(),
            base_sha: "b".into(),
            ours_sha: "o".into(),
            theirs_sha: "t".into(),
            theirs_version: None,
            theirs_author: None,
            remote_branch_pushed: true,
            files: vec![
                ConflictFile { path: "A.ork".into(), kind: ConflictFileKind::BothModified, three_way: None },
                ConflictFile { path: "B.ork".into(), kind: ConflictFileKind::BothAdded, three_way: None },
                ConflictFile { path: "t.txt".into(), kind: ConflictFileKind::BothModified, three_way: None },
            ],
        };
        enrich_conflict_with(&mut c, |path, side| match (path, side) {
            ("A.ork", _) => Some(b"junk".to_vec()),
            ("B.ork", rs_core::ConflictSide::Base) => None,
            ("B.ork", _) => Some(b"junk".to_vec()),
            _ => Some(b"x".to_vec()),
        });
        let tw = c.files[0].three_way.as_ref().expect("filled");
        assert_eq!(tw["path"], "A.ork");
        assert_eq!(tw["independent"], false);
        assert!(c.files[1].three_way.is_none(), "no base: nothing to compare");
        assert!(c.files[2].three_way.is_none(), "not an .ork");
    }

    #[test]
    fn inspector_delegates_to_rs_ork() {
        let i = ShellInspector::default();
        assert!(i.validate("note.txt", b"anything").is_ok());
        assert!(i.validate("Razzo.ork", b"not a zip").is_err());
        assert!(i.content_equal("a.txt", b"x", b"x"));
        assert!(!i.content_equal("a.txt", b"x", b"y"));
        assert!(!i.changelog("a.txt", Some(b"a"), Some(b"b")).is_empty());
    }
}
