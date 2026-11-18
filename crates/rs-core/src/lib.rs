//! # rs-core
//!
//! The Rocket Sync synchronisation engine: it makes Git/GitHub invisible to a small team that
//! works on OpenRocket (`.ork`) files. The specification is `docs/protocollo-sync.md`; the JSON
//! shapes of the public types follow `docs/contratto-ipc.md` (`camelCase`).
//!
//! ## Overview
//!
//! * [`Engine`] manages many projects. Each project has **one worker** with a queue: Git
//!   operations never run in parallel on the same repository, and every operation is journalled
//!   in `rs-store`, preceded by a safety copy when it can touch the working folder.
//! * Commands are `async` and return [`Result<T, CoreError>`](CoreError). `CoreError` converts
//!   into the contract's [`AppError`] (code, Italian message, technical detail, `retryable`) with
//!   [`CoreError::to_app_error`].
//! * Events are broadcast with [`Engine::subscribe`] ([`EngineEvent`]); the shell forwards
//!   `event.to_ipc()` = `(name, payload)` to the interface.
//! * The host provides two hooks (`docs/protocollo-sync.md` §10): a [`FileInspector`]
//!   (validation and changelog, `rs-ork` for `.ork`) and an [`EditorDetector`] (which files
//!   OpenRocket has open). [`WindowsEditorDetector`] is the real implementation on Windows;
//!   other platforms use [`NullEditorDetector`].
//!
//! ## Model
//!
//! Published = reachable from `origin/main`. A *pending version* is a local commit with the
//! trailer `Rocket-Sync-Version: pending`; its number is **always recomputed** right before the
//! atomic push (`git push --atomic origin main vN…`). Conflicts keep both lines of work: the local
//! one is pushed to `conflitti/<id>`, the working folder is never touched, and the resolution is a
//! merge commit with two parents. Rocket Sync never runs `git merge`, `rebase`, `stash`,
//! `reset --hard` or `--force` on the user's repository: merges are computed with
//! `git merge-tree --write-tree` and files are written by the engine itself (materialisation,
//! `§7.9`) only when they are identical to the version being replaced.
//!
//! ## Typical use
//!
//! ```no_run
//! use rs_core::{Engine, EngineConfig, Identity, LinkRequest, PublishRequest};
//!
//! # async fn demo() -> Result<(), rs_core::CoreError> {
//! let mut cfg = EngineConfig::new("/path/to/app-data");
//! cfg.git.git_path = "/path/to/mingit/cmd/git.exe".into();
//! let engine = Engine::new(cfg).await?;
//! let mut events = engine.subscribe();
//! engine.set_identity(Some(Identity {
//!     name: "Luca Rossi".into(),
//!     email: "12345+luca@users.noreply.github.com".into(),
//! }));
//! engine.start().await?; // recovery + watchers + background loop
//!
//! engine
//!     .link_project(LinkRequest {
//!         project_id: "p1".into(),
//!         repo_full_name: "team/razzo".into(),
//!         remote_url: None,
//!         folder: "C:/Users/luca/RocketSync/Razzo".into(),
//!         allow_synced_drive: false,
//!     })
//!     .await?;
//! let status = engine.publish("p1", PublishRequest::default()).await?;
//! println!("{:?}", status.state);
//! while let Ok(ev) = events.try_recv() {
//!     let (name, payload) = ev.to_ipc();
//!     println!("{name}: {payload}");
//! }
//! # Ok(()) }
//! ```
//!
//! ## Modules
//!
//! The public surface is re-exported at the crate root: [`Engine`], [`EngineConfig`] / [`Timing`],
//! the data types of the contract ([`ProjectStatus`], [`VersionInfo`], [`Conflict`], ...), the
//! hooks and [`Failpoints`] (fault injection used by the crash-recovery tests).

mod config;
mod editor;
mod engine;
mod error;
mod events;
mod failpoints;
mod hooks;
mod message;
mod project;
mod tracker;
mod types;
mod util;
mod watcher;

pub use config::{EngineConfig, GitSettings, Identity, Timing};
pub use editor::{interpret_windows, parse_openrocket_title, OpenRocketTitle, WindowInfo};
#[cfg(windows)]
pub use editor::WindowsEditorDetector;
pub use engine::Engine;
pub use error::{AppError, CoreError, ErrorCode, Result};
pub use events::EngineEvent;
pub use failpoints::{Action as FailAction, Failpoints};
pub use hooks::{DefaultInspector, EditorDetector, EditorState, FileInspector, NullEditorDetector};
pub use rs_git::RetryPolicy;
pub use types::*;
