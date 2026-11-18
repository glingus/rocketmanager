//! What the logic layer needs from the operating system and from Tauri. A trait keeps
//! `Shell` testable without a window.

use serde::Serialize;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Result of `check_for_update`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Operating system and desktop services.
pub trait Platform: Send + Sync {
    /// Opens a URL in the system browser.
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// Opens a file or folder with the default application.
    fn open_path(&self, path: &Path) -> Result<(), String>;
    /// Starts `exe` with `file` as argument, without waiting.
    fn open_with(&self, exe: &Path, file: &Path) -> Result<(), String> {
        std::process::Command::new(exe)
            .arg(file)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("{}: {e}", exe.display()))
    }
    /// Desktop notification.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
    fn home_dir(&self) -> Option<PathBuf>;
    /// Blocking folder picker; `None` if the user cancels.
    fn pick_folder(&self, default: Option<&Path>) -> Option<PathBuf>;
    fn set_autostart(&self, enabled: bool) -> Result<(), String>;
    fn check_update(&self) -> BoxFut<'_, Result<UpdateInfo, String>>;
    /// Downloads and installs the update, then restarts the application.
    fn install_update(&self) -> BoxFut<'_, Result<(), String>>;
}
