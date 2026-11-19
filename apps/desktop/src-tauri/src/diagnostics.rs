//! The diagnostics archive (`export_diagnostics`): a zip of text files in which every credential
//! has been removed.

use std::io::Write;
use std::path::Path;

/// Writes `entries` (name, text) into a zip at `path`, redacting every text.
pub fn write_zip(path: &Path, entries: &[(String, String)]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, text) in entries {
        zw.start_file(name, opts).map_err(|e| e.to_string())?;
        zw.write_all(rs_git::redact(text).as_bytes())
            .map_err(|e| e.to_string())?;
    }
    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Entry name for a project file: `projects/<id>/<file>` with the id made safe.
pub fn project_entry(project_id: &str, file: &str) -> String {
    let safe: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("projects/{safe}/{file}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn zip_contains_the_entries_without_secrets() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub/diag.zip");
        write_zip(
            &p,
            &[
                ("a.txt".into(), "hello".into()),
                ("log.txt".into(), "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r token=abc".into()),
            ],
        )
        .unwrap();
        let mut z = zip::ZipArchive::new(std::fs::File::open(&p).unwrap()).unwrap();
        assert_eq!(z.len(), 2);
        let mut s = String::new();
        z.by_name("log.txt")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(!s.contains("ghp_") && !s.contains("token=abc"), "{s}");
        assert_eq!(
            project_entry("a/b:c", "status.json"),
            "projects/a_b_c/status.json"
        );
    }
}
