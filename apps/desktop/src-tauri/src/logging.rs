//! File logging with credentials redacted line by line.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;

/// Name of the log file inside `<data dir>/logs`.
pub const LOG_FILE: &str = "rocketsync.log";
const ROTATE_AT: u64 = 5 * 1024 * 1024;

/// Shared handle to the log file.
#[derive(Clone)]
pub struct RedactingLog {
    file: Arc<Mutex<File>>,
}

/// Writer that removes tokens and URL credentials before anything reaches the disk.
pub struct RedactingWriter {
    file: Arc<Mutex<File>>,
}

impl Write for RedactingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let clean = rs_git::redact(&text);
        if let Ok(mut f) = self.file.lock() {
            f.write_all(clean.as_bytes())?;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(mut f) = self.file.lock() {
            f.flush()?;
        }
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for RedactingLog {
    type Writer = RedactingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            file: self.file.clone(),
        }
    }
}

/// Opens (rotating if big) the log file under `data_dir/logs`.
pub fn open_log(data_dir: &Path) -> std::io::Result<(RedactingLog, PathBuf)> {
    let dir = data_dir.join("logs");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(LOG_FILE);
    if std::fs::metadata(&path)
        .map(|m| m.len() > ROTATE_AT)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(&path, dir.join("rocketsync.old.log"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((
        RedactingLog {
            file: Arc::new(Mutex::new(file)),
        },
        path,
    ))
}

/// Installs the global subscriber (once). Returns the log path.
pub fn init(data_dir: &Path) -> Option<PathBuf> {
    let (log, path) = open_log(data_dir).ok()?;
    let _ = tracing_subscriber::fmt()
        .with_writer(log)
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .try_init();
    Some(path)
}

/// Last `max_bytes` of a text file (whole lines), redacted again for safety.
pub fn tail(path: &Path, max_bytes: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max_bytes {
        let _ = f.seek(SeekFrom::Start(len - max_bytes));
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    let s = if len > max_bytes {
        s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or(s)
    } else {
        s
    };
    rs_git::redact(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_never_reach_the_file() {
        let d = tempfile::tempdir().unwrap();
        let (log, path) = open_log(d.path()).unwrap();
        let mut w = log.make_writer();
        w.write_all(
            b"fetch https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git\n",
        )
        .unwrap();
        w.write_all(b"Authorization: Bearer topsecret\n").unwrap();
        w.write_all(b"normal line\n").unwrap();
        w.flush().unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("ghp_") && !text.contains("topsecret"),
            "{text}"
        );
        assert!(text.contains("normal line"));
        assert!(tail(&path, 10).len() <= 20);
    }
}
