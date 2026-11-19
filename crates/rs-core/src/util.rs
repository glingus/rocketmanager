//! Small helpers: time formatting, path safety, atomic file writes, unique names.

use crate::error::{CoreError, Result};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use std::fs;
use std::io::Write;
use std::path::{Component, Path};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Temporary files of the OpenRocket save sequence (`ORSave*.tmp`, `<name>.ork-bak`): never part of
/// a project, whatever the project's `.gitignore` says.
pub(crate) fn is_rocket_temp(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    name.ends_with(".ork-bak") || (name.starts_with("orsave") && name.ends_with(".tmp"))
}

/// Whether the folder of `abs` holds a leftover of an OpenRocket save in progress.
///
/// * `deleted = true` (the file is absent): a backup `<name>-bak` of this very file or any
///   `ORSave*.tmp`, whatever their age: the file is probably just between the two renames.
/// * `deleted = false`: only an `ORSave*.tmp` modified in the last 10 s (a tmp left behind by a
///   crash must not block the folder for ever).
pub(crate) fn save_in_progress(abs: &Path, deleted: bool) -> bool {
    let Some(dir) = abs.parent() else {
        return false;
    };
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let bak = format!("{name}-bak");
    let Ok(rd) = fs::read_dir(dir) else {
        return false;
    };
    rd.flatten().any(|e| {
        let n = e.file_name().to_string_lossy().to_lowercase();
        if deleted && n == bak {
            return true;
        }
        if n.starts_with("orsave") && n.ends_with(".tmp") {
            if deleted {
                return true;
            }
            let recent = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .map(|d| d < Duration::from_secs(10))
                .unwrap_or(true);
            return recent;
        }
        false
    })
}

/// Unix milliseconds → ISO 8601 UTC (`2026-01-01T10:00:00Z`).
pub(crate) fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap())
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(crate) fn iso_from_system_time(t: SystemTime) -> String {
    iso_from_ms(ms_from_system_time(t))
}

pub(crate) fn ms_from_system_time(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Any ISO 8601 date with offset → UTC with `Z`. Falls back to the input if it cannot be parsed.
pub(crate) fn iso_to_utc(s: &str) -> String {
    DateTime::parse_from_rfc3339(s)
        .map(|d| {
            d.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        })
        .unwrap_or_else(|_| s.to_string())
}

/// `AAAA-MM-GG` of today (local time is irrelevant for the file names: UTC is used).
pub(crate) fn today_ymd() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

pub(crate) fn today_compact() -> String {
    Utc::now().format("%Y%m%d").to_string()
}

pub(crate) fn random_id(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Validates a path coming from a git tree or from the interface before it is joined to a folder.
///
/// Rejects empty paths, absolute paths, drive prefixes, `.`/`..`/empty components, NUL, `:` and
/// backslashes (Windows alternate streams and separators) and anything inside `.git`.
pub(crate) fn validate_rel_path(p: &str) -> Result<()> {
    let bad = || Err(CoreError::InvalidPath(p.to_string()));
    if p.is_empty() || p.contains('\0') || p.contains('\\') || p.contains(':') {
        return bad();
    }
    if p.starts_with('/') {
        return bad();
    }
    for comp in p.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            return bad();
        }
        if comp.eq_ignore_ascii_case(".git") {
            return bad();
        }
        // Windows silently strips trailing dots/spaces: `.git.` would be `.git`.
        let trimmed = comp.trim_end_matches(['.', ' ']);
        if trimmed.eq_ignore_ascii_case(".git") {
            return bad();
        }
    }
    // Defence in depth with the std parser.
    for c in Path::new(p).components() {
        match c {
            Component::Normal(_) => {}
            _ => return bad(),
        }
    }
    Ok(())
}

/// Splits `dir/name.ext` into (`dir/name`, `.ext`) on the last component only.
pub(crate) fn split_ext(path: &str) -> (String, String) {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    match file.rfind('.') {
        Some(i) if i > 0 => (format!("{dir}{}", &file[..i]), file[i..].to_string()),
        _ => (format!("{dir}{file}"), String::new()),
    }
}

/// `dir/name SUFFIX.ext`, with a counter if the candidate is already taken according to `taken`.
pub(crate) fn unique_name(path: &str, suffix: &str, taken: impl Fn(&str) -> bool) -> String {
    let (stem, ext) = split_ext(path);
    let first = format!("{stem} {suffix}{ext}");
    if !taken(&first) {
        return first;
    }
    for n in 2..1000 {
        let cand = format!("{stem} {suffix} ({n}){ext}");
        if !taken(&cand) {
            return cand;
        }
    }
    format!("{stem} {suffix} ({}){ext}", random_id(6))
}

/// Writes `data` to `target` through a temporary file in the same directory and a rename,
/// retrying a few times on errors typical of antivirus/sharing locks.
pub(crate) fn atomic_write(target: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    // `.tmp` is covered by the project's .gitignore and ignored by the watcher.
    let tmp = dir.join(format!(".{}.rs{}.tmp", name, random_id(6)));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    let mut last_err = None;
    for attempt in 0..5 {
        match fs::rename(&tmp, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(last_err.unwrap_or_else(|| std::io::Error::other("rename fallita")))
}

/// Removes a file, retrying like [`atomic_write`]; a missing file is not an error.
pub(crate) fn remove_file_retry(path: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rimozione fallita")))
}

/// Removes empty parent directories of `file` up to (excluding) `root`.
pub(crate) fn prune_empty_parents(root: &Path, file: &Path) {
    let mut cur = file.parent();
    while let Some(d) = cur {
        if d == root || !d.starts_with(root) {
            break;
        }
        if fs::remove_dir(d).is_err() {
            break;
        }
        cur = d.parent();
    }
}

/// Last modification time and size of a file, if it exists and is a regular file.
pub(crate) fn file_meta(path: &Path) -> Option<(u64, SystemTime)> {
    let m = fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    Some((m.len(), m.modified().unwrap_or(UNIX_EPOCH)))
}

/// Extracts the GitHub login from a noreply address (`123+login@users.noreply.github.com`).
pub(crate) fn github_login_from_email(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let login = match local.split_once('+') {
        Some((_, l)) => l,
        None => local,
    };
    if login.is_empty() {
        None
    } else {
        Some(login.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_validation() {
        for ok in [
            "a.ork",
            "dir/sub/a b.ork",
            ".rocketsync/project.json",
            "x/.gitignore",
        ] {
            assert!(validate_rel_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "/abs",
            "../x",
            "a/../b",
            "a//b",
            "C:/x",
            "a\\b",
            ".git/config",
            "a/.git/hooks/x",
            "a/.GIT/x",
            ".git./x",
            "a/./b",
            "x\0y",
            "a/",
        ] {
            assert!(validate_rel_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn names_and_extensions() {
        assert_eq!(
            split_ext("dir/Razzo.ork"),
            ("dir/Razzo".into(), ".ork".into())
        );
        assert_eq!(split_ext(".hidden"), (".hidden".into(), String::new()));
        assert_eq!(split_ext("noext"), ("noext".into(), String::new()));
        let n = unique_name("a/Razzo.ork", "(copia locale 2026-01-01)", |c| {
            c == "a/Razzo (copia locale 2026-01-01).ork"
        });
        assert_eq!(n, "a/Razzo (copia locale 2026-01-01) (2).ork");
    }

    #[test]
    fn openrocket_temp_files() {
        assert!(is_rocket_temp("a/Razzo.ork-bak"));
        assert!(is_rocket_temp("ORSave123.tmp"));
        assert!(is_rocket_temp("x/orsave9.TMP"));
        assert!(!is_rocket_temp("Razzo.ork"));
        assert!(!is_rocket_temp("note.tmp.txt"));
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("Razzo.ork");
        assert!(!save_in_progress(&f, true));
        fs::write(d.path().join("Razzo.ork-bak"), b"x").unwrap();
        assert!(save_in_progress(&f, true), "absent file with a backup");
        assert!(
            !save_in_progress(&f, false),
            "existing file: a backup alone does not matter"
        );
        assert!(!save_in_progress(&d.path().join("Altro.ork"), true));
        fs::remove_file(d.path().join("Razzo.ork-bak")).unwrap();
        let tmp = d.path().join("ORSave42.tmp");
        fs::write(&tmp, b"x").unwrap();
        assert!(save_in_progress(&f, false));
        let old = fs::OpenOptions::new().write(true).open(&tmp).unwrap();
        old.set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        assert!(
            !save_in_progress(&f, false),
            "an old leftover does not block existing files"
        );
        assert!(
            save_in_progress(&f, true),
            "...but still protects a deletion"
        );
    }

    #[test]
    fn noreply_login() {
        assert_eq!(
            github_login_from_email("12345+luca@users.noreply.github.com").as_deref(),
            Some("luca")
        );
        assert_eq!(
            github_login_from_email("luca@users.noreply.github.com").as_deref(),
            Some("luca")
        );
        assert_eq!(github_login_from_email("x@y.it"), None);
    }

    #[test]
    fn iso_formats() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso_to_utc("2026-03-01T12:00:00+01:00"),
            "2026-03-01T11:00:00Z"
        );
    }

    #[test]
    fn atomic_write_replaces_and_prunes() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a/b/c.txt");
        atomic_write(&f, b"one").unwrap();
        atomic_write(&f, b"two").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"two");
        assert_eq!(
            fs::read_dir(d.path().join("a/b")).unwrap().count(),
            1,
            "no temp file left"
        );
        remove_file_retry(&f).unwrap();
        prune_empty_parents(d.path(), &f);
        assert!(!d.path().join("a").exists());
    }
}
