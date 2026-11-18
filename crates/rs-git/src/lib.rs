//! # rs-git
//!
//! Safe wrapper around the `git` binary for Rocket Sync.
//!
//! * [`Git`] holds the configuration (binary path, isolated global config, askpass hook point,
//!   timeouts, retry policy) and runs every command with an **isolated environment**
//!   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, empty
//!   `core.hooksPath`, `credential.helper=` ...).
//! * Every executed command is recorded in a [`CommandLog`] (arguments redacted), which lets tests
//!   assert that no `--force` was ever used.
//! * Failures are mapped to a typed [`GitError`] (`NotARepository`, `Network`, `AuthFailed`,
//!   `NonFastForward`, `LockHeld`, `Conflict`, `Timeout`, `Other`). Transient errors (`index.lock`,
//!   files locked by an antivirus, network) are retried automatically with growing delays.
//! * [`Repo`] offers typed helpers over stable machine formats: `status --porcelain=v2 -z`,
//!   `diff-tree --raw -z`, `ls-tree -z`, `log -z`, `merge-tree --write-tree -z`.
//! * [`redact`] removes tokens and URL credentials from any text before it is logged.
//!
//! Tokens never appear on a command line, in a remote URL or in `.git/config`: in production the
//! program configured in [`GitConfig::askpass`] answers git's credential questions (user
//! `x-access-token`, password read from the Windows Credential Manager). This crate only exposes
//! the hook point ([`GitConfig::askpass`] and [`GitConfig::extra_env`]); tests use `file://` remotes.
//!
//! ```no_run
//! use rs_git::{Git, GitConfig};
//! let git = Git::new(GitConfig::default());
//! git.ensure_min_version().unwrap();
//! let repo = git.open("/path/to/project").unwrap();
//! for e in repo.status().unwrap() {
//!     println!("{} {}{}", e.path, e.x, e.y);
//! }
//! ```
//!
//! The wrapper is synchronous; async callers should run it inside `spawn_blocking`.

mod error;
mod exec;
mod message;
mod redact;
mod repo;
mod version;

pub use error::{GitError, GitErrorKind};
pub use exec::{
    CancelToken, Cmd, CommandLog, CommandRecord, Git, GitConfig, Output, RetryPolicy,
};
pub use message::{parse_message, ParsedMessage};
pub use redact::redact;
pub use repo::{
    CommitInfo, CommitSpec, DiffEntry, IndexInfoEntry, MergeTreeResult, RefInfo, Repo, Signature,
    StatusEntry, StatusKind, TreeEntry, EMPTY_TREE,
};
pub use version::{GitVersion, MIN_GIT_VERSION};
