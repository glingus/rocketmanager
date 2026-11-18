//! # rs-store
//!
//! Local SQLite store of Rocket Sync (via `rusqlite` with the bundled SQLite).
//!
//! It persists everything the sync engine must remember across restarts and crashes:
//!
//! | Table | Content |
//! |---|---|
//! | `projects` | linked projects (folder, repo, remote URL) |
//! | `settings` | key/value settings by scope: `app` or a project id (e.g. the publish policy) |
//! | `journal` | operation journal: kind, last step reached, JSON payload, outcome |
//! | `conflicts` | local conflicts with their files and resolution |
//! | `guard_watches` | "stale editor" surveillance of files written while OpenRocket was running |
//! | `file_states` | last known stability/validity of each changed file |
//!
//! The schema is versioned with `PRAGMA user_version`; [`Store::open`] applies the pending
//! migrations inside a transaction each. All timestamps are unix milliseconds (`i64`).
//!
//! [`Store`] is cheap to clone and thread-safe (a mutex around one connection): every method is
//! short and synchronous, so it can be called from async code without `spawn_blocking`.
//!
//! ```
//! use rs_store::{Store, PublishPolicy};
//! let store = Store::open_in_memory().unwrap();
//! assert_eq!(store.get_publish_policy("p1").unwrap(), PublishPolicy::default());
//! store.set_publish_policy("p1", &PublishPolicy::Manual).unwrap();
//! assert_eq!(store.get_publish_policy("p1").unwrap(), PublishPolicy::Manual);
//! ```

mod models;
mod schema;
mod store;

pub use models::{
    ConflictFileRecord, ConflictRecord, ConflictStatus, FileStateRecord, GuardWatch, JournalEntry,
    ProjectRecord, PublishPolicy,
};
pub use store::{now_ms, Store, StoreError};
