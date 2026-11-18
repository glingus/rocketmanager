//! Fault-injection hooks.
//!
//! Tests (and only tests) register an [`Action`] on a named point; when the engine reaches the
//! point it either aborts the operation with [`CoreError::InjectedCrash`] *without* any cleanup
//! (the journal is left unfinished, exactly like a crash) or runs a callback (e.g. to let a third
//! party publish at a precise moment). With no registered action the points cost one hash lookup.
//!
//! Points used by the engine: `materialize.after_first_write`, `materialize.before_ref_update`,
//! `send.before_push`, `send.after_push`, `conflict.before_branch_push`.

use crate::error::CoreError;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// What happens when a point is reached.
#[derive(Clone)]
pub enum Action {
    /// Abort the operation as if the process had died (every time the point is reached).
    Crash,
    /// Abort once, then behave normally.
    CrashOnce,
    /// Run the callback and continue.
    Callback(Arc<dyn Fn() + Send + Sync>),
}

/// Registry of fault-injection points. Cheap to clone.
#[derive(Clone, Default)]
pub struct Failpoints {
    inner: Arc<Mutex<HashMap<String, Action>>>,
}

impl std::fmt::Debug for Failpoints {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<String> = self
            .inner
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default();
        f.debug_struct("Failpoints").field("armed", &names).finish()
    }
}

impl Failpoints {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms a point.
    pub fn set(&self, name: &str, action: Action) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(name.to_string(), action);
        }
    }

    /// Disarms a point.
    pub fn clear(&self, name: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(name);
        }
    }

    /// Disarms everything.
    pub fn clear_all(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.clear();
        }
    }

    /// Called by the engine at each point.
    pub(crate) fn hit(&self, name: &str) -> Result<(), CoreError> {
        let action = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return Ok(()),
            };
            match g.get(name).cloned() {
                Some(Action::CrashOnce) => {
                    g.remove(name);
                    Some(Action::Crash)
                }
                other => other,
            }
        };
        match action {
            None => Ok(()),
            Some(Action::Crash) | Some(Action::CrashOnce) => Err(CoreError::InjectedCrash(name.to_string())),
            Some(Action::Callback(f)) => {
                f();
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn crash_once_and_callback() {
        let fp = Failpoints::new();
        assert!(fp.hit("x").is_ok());
        fp.set("x", Action::CrashOnce);
        assert!(matches!(fp.hit("x"), Err(CoreError::InjectedCrash(_))));
        assert!(fp.hit("x").is_ok());
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        fp.set("y", Action::Callback(Arc::new(move || { n2.fetch_add(1, Ordering::SeqCst); })));
        fp.hit("y").unwrap();
        fp.hit("y").unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 2);
        fp.set("z", Action::Crash);
        assert!(fp.hit("z").is_err());
        assert!(fp.hit("z").is_err());
        fp.clear_all();
        assert!(fp.hit("z").is_ok());
    }
}
