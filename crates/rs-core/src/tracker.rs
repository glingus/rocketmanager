//! Stability and validity tracking of the files of a project (`docs/protocollo-sync.md` §5).

use crate::config::Timing;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Instant, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Meta {
    pub size: u64,
    pub mtime: SystemTime,
}

#[derive(Debug, Clone)]
pub(crate) struct Validation {
    pub ok: bool,
    pub reason: Option<String>,
    pub first_invalid: Option<Instant>,
    pub checked_at: Instant,
}

#[derive(Debug, Clone)]
struct Entry {
    last_event: Option<Instant>,
    meta: Option<Meta>,
    meta_since: Instant,
    validation: Option<Validation>,
    /// Metadata right after Rocket Sync wrote the file: events matching it are ignored.
    written_meta: Option<(Meta, Instant)>,
}

/// What the tracker knows about one file at a given instant.
#[derive(Debug, Clone)]
pub(crate) struct Observation {
    pub meta: Option<Meta>,
    pub stable: bool,
    pub validation: Option<Validation>,
    /// A (re)validation is needed: the file is stable and has no result for the current metadata,
    /// or it is invalid and due for a recheck.
    pub needs_validation: bool,
    /// Invalid for longer than the give-up time: reported as unreadable, no more rechecks.
    pub unreadable: bool,
}

/// Per-file bookkeeping. All timing decisions use the injected `now`, which keeps it testable.
#[derive(Debug)]
pub(crate) struct FileTracker {
    entries: HashMap<String, Entry>,
    timing: Timing,
}

impl FileTracker {
    pub(crate) fn new(timing: Timing) -> Self {
        Self {
            entries: HashMap::new(),
            timing,
        }
    }

    /// A file system event for `path` (relative, `/` separated).
    pub(crate) fn on_event(&mut self, path: &str, current: Option<Meta>, now: Instant) {
        let e = self.entry(path, now);
        if let (Some((wm, at)), Some(cur)) = (e.written_meta, current) {
            // Event caused by our own write: ignore while the metadata is still the one we produced.
            if wm == cur && now.duration_since(at) < std::time::Duration::from_secs(10) {
                return;
            }
        }
        e.last_event = Some(now);
    }

    /// Records that Rocket Sync itself wrote (or deleted) `path`.
    pub(crate) fn on_self_write(&mut self, path: &str, meta: Option<Meta>, now: Instant) {
        let backdate = now.checked_sub(self.timing.debounce).unwrap_or(now);
        let e = self.entry(path, now);
        e.meta = meta;
        e.meta_since = backdate;
        e.last_event = None;
        e.validation = None;
        e.written_meta = meta.map(|m| (m, now));
    }

    fn entry(&mut self, path: &str, now: Instant) -> &mut Entry {
        self.entries.entry(path.to_string()).or_insert_with(|| Entry {
            last_event: None,
            meta: None,
            meta_since: now,
            validation: None,
            written_meta: None,
        })
    }

    /// Time of the last event or metadata change of any file (used by the automatic publication).
    pub(crate) fn last_activity(&self, paths: &[String]) -> Option<Instant> {
        paths
            .iter()
            .filter_map(|p| self.entries.get(p))
            .filter_map(|e| match e.last_event {
                Some(l) => Some(l.max(e.meta_since)),
                None => Some(e.meta_since),
            })
            .max()
    }

    /// Observes a file: `abs` is its absolute path (used for the Windows exclusive-open probe) and
    /// `current` its metadata right now (`None` = missing).
    pub(crate) fn observe(&mut self, path: &str, abs: &Path, current: Option<Meta>, now: Instant) -> Observation {
        let debounce = self.timing.debounce;
        let giveup = self.timing.invalid_giveup;
        let recheck = self.timing.revalidate_interval;
        let e = self.entry(path, now);
        if e.meta != current {
            e.meta = current;
            // A file that has not been touched for longer than the debounce is stable at once
            // (e.g. changes made while the app was closed).
            let age = current
                .and_then(|m| SystemTime::now().duration_since(m.mtime).ok())
                .unwrap_or_default();
            e.meta_since = if age >= debounce {
                now.checked_sub(debounce).unwrap_or(now)
            } else {
                now
            };
            e.validation = None;
        }
        let quiet_since = match e.last_event {
            Some(l) => l.max(e.meta_since),
            None => e.meta_since,
        };
        let mut stable = now.duration_since(quiet_since) >= debounce;
        if stable && current.is_some() {
            stable = exclusive_open_ok(abs);
        }
        let (needs_validation, unreadable) = match (&e.validation, current.is_some(), stable) {
            (_, false, _) => (false, false),
            (None, true, true) => (true, false),
            (None, true, false) => (false, false),
            (Some(v), true, true) => {
                if v.ok {
                    (false, false)
                } else {
                    let first = v.first_invalid.unwrap_or(v.checked_at);
                    if now.duration_since(first) >= giveup {
                        (false, true)
                    } else {
                        (now.duration_since(v.checked_at) >= recheck, false)
                    }
                }
            }
            (Some(_), true, false) => (false, false),
        };
        Observation {
            meta: current,
            stable: stable || current.is_none(),
            validation: e.validation.clone(),
            needs_validation,
            unreadable,
        }
    }

    /// Stores the validation result for the current metadata of `path`.
    pub(crate) fn set_validation(&mut self, path: &str, result: Result<(), String>, now: Instant) {
        let e = self.entry(path, now);
        let first_invalid = match (&result, &e.validation) {
            (Err(_), Some(v)) if !v.ok => v.first_invalid,
            (Err(_), _) => Some(now),
            (Ok(()), _) => None,
        };
        e.validation = Some(Validation {
            ok: result.is_ok(),
            reason: result.err(),
            first_invalid,
            checked_at: now,
        });
    }

    /// Forgets files that are no longer changed.
    pub(crate) fn retain(&mut self, keep: &[String]) {
        self.entries.retain(|k, _| keep.contains(k));
    }
}

/// Windows: the file can be opened in exclusive mode (nobody is still writing it).
/// Elsewhere there is no equivalent notion and the probe always succeeds.
#[cfg(windows)]
fn exclusive_open_ok(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
        .map(|_| true)
        .unwrap_or_else(|e| e.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(not(windows))]
fn exclusive_open_ok(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn p() -> &'static Path {
        Path::new("/nonexistent/probe")
    }

    fn meta(size: u64) -> Option<Meta> {
        Some(Meta {
            size,
            mtime: SystemTime::now(),
        })
    }

    fn timing() -> Timing {
        Timing {
            debounce: Duration::from_millis(100),
            invalid_giveup: Duration::from_millis(500),
            revalidate_interval: Duration::from_millis(50),
            ..Timing::fast()
        }
    }

    #[test]
    fn stable_only_after_debounce_without_changes() {
        let mut t = FileTracker::new(timing());
        let t0 = Instant::now();
        let m = meta(10);
        let o = t.observe("a.ork", p(), m, t0);
        assert!(!o.stable, "freshly written file is not stable");
        let o = t.observe("a.ork", p(), m, t0 + Duration::from_millis(150));
        assert!(o.stable);
        assert!(o.needs_validation);
        // a new event resets the timer
        t.on_event("a.ork", m, t0 + Duration::from_millis(160));
        let o = t.observe("a.ork", p(), m, t0 + Duration::from_millis(200));
        assert!(!o.stable);
        // metadata change resets as well
        let o = t.observe("a.ork", p(), meta(11), t0 + Duration::from_millis(400));
        assert!(!o.stable);
    }

    #[test]
    fn old_files_are_stable_immediately() {
        let mut t = FileTracker::new(timing());
        let old = Some(Meta {
            size: 5,
            mtime: SystemTime::now() - Duration::from_secs(60),
        });
        let o = t.observe("a.ork", p(), old, Instant::now());
        assert!(o.stable);
    }

    #[test]
    fn invalid_files_are_rechecked_then_given_up() {
        let mut t = FileTracker::new(timing());
        let old = Some(Meta {
            size: 5,
            mtime: SystemTime::now() - Duration::from_secs(60),
        });
        let t0 = Instant::now();
        assert!(t.observe("a", p(), old, t0).needs_validation);
        t.set_validation("a", Err("troncato".into()), t0);
        let o = t.observe("a", p(), old, t0 + Duration::from_millis(10));
        assert!(!o.needs_validation, "too early to recheck");
        let o = t.observe("a", p(), old, t0 + Duration::from_millis(60));
        assert!(o.needs_validation, "due for recheck");
        t.set_validation("a", Err("ancora troncato".into()), t0 + Duration::from_millis(60));
        let o = t.observe("a", p(), old, t0 + Duration::from_millis(600));
        assert!(o.unreadable);
        assert!(!o.needs_validation);
        // a change of metadata clears the verdict
        let o = t.observe("a", p(), meta(6), t0 + Duration::from_millis(700));
        assert!(!o.unreadable);
        assert!(o.validation.is_none());
    }

    #[test]
    fn own_writes_do_not_trigger_events() {
        let mut t = FileTracker::new(timing());
        let t0 = Instant::now();
        let m = meta(42);
        t.on_self_write("a", m, t0);
        t.on_event("a", m, t0 + Duration::from_millis(5));
        let o = t.observe("a", p(), m, t0 + Duration::from_millis(10));
        assert!(o.stable, "own write is stable at once");
        // a different metadata is a real event
        t.on_event("a", meta(43), t0 + Duration::from_millis(20));
        let o = t.observe("a", p(), meta(43), t0 + Duration::from_millis(30));
        assert!(!o.stable);
    }
}
