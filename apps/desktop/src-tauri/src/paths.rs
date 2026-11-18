//! Folders used by the application. They are computed without Tauri so that the askpass helper
//! and the self-test (which run before Tauri starts) agree with the application.

use std::path::{Path, PathBuf};

/// Application identifier (also the name of the data folder).
pub const IDENTIFIER: &str = "it.rocketsync.app";

/// Data folder: `%APPDATA%\it.rocketsync.app` on Windows (what Tauri's `app_data_dir` returns),
/// `~/.local/share/it.rocketsync.app` on Linux, `~/Library/Application Support/...` on macOS.
/// `ROCKETSYNC_DATA_DIR` overrides it (development and tests).
pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ROCKETSYNC_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(IDENTIFIER)
}

/// Folder of the executable (on Windows this is where Tauri puts the bundled resources).
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Where MinGit lives relative to the resource folder.
pub const MINGIT_GIT_EXE: &str = "resources/mingit/cmd/git.exe";

/// Chooses the git executable.
///
/// * `ROCKETSYNC_GIT` (development override) wins;
/// * Windows: the bundled MinGit; a debug build without it falls back to `git.exe` from `PATH`;
/// * other platforms (development): `git` from `PATH`.
pub fn locate_git(
    resource_dir: Option<&Path>,
    windows: bool,
    debug: bool,
    env_override: Option<&str>,
    exists: &dyn Fn(&Path) -> bool,
) -> PathBuf {
    if let Some(p) = env_override.map(str::trim).filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if windows {
        let bundled = resource_dir.map(|r| r.join(MINGIT_GIT_EXE));
        return match bundled {
            Some(b) if exists(&b) => b,
            Some(b) if !debug => b, // reported later as "git missing" with this path
            _ if debug => PathBuf::from("git.exe"),
            _ => PathBuf::from(MINGIT_GIT_EXE),
        };
    }
    PathBuf::from("git")
}

/// The git executable of this process.
pub fn git_path() -> PathBuf {
    locate_git(
        exe_dir().as_deref(),
        cfg!(windows),
        cfg!(debug_assertions),
        std::env::var("ROCKETSYNC_GIT").ok().as_deref(),
        &|p| p.exists(),
    )
}

/// Default parent of new project folders: `<home>/RocketSync`.
pub fn default_projects_root(home: Option<&Path>) -> PathBuf {
    home.map(|h| h.join("RocketSync"))
        .unwrap_or_else(|| std::env::temp_dir().join("RocketSync"))
}

/// A folder name derived from the project name, valid on Windows.
pub fn sanitize_folder_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    let upper = s.to_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem)
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if s.is_empty() {
        "Progetto".to_string()
    } else if reserved {
        format!("_{s}")
    } else {
        s.chars().take(80).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_location_rules() {
        let res = Path::new("/app");
        let bundled = res.join(MINGIT_GIT_EXE);
        // override
        assert_eq!(locate_git(Some(res), true, false, Some("/x/git"), &|_| false), PathBuf::from("/x/git"));
        // bundled MinGit present
        assert_eq!(locate_git(Some(res), true, false, None, &|p| p == bundled), bundled);
        // missing in release: the bundled path (so the error names it)
        assert_eq!(locate_git(Some(res), true, false, None, &|_| false), bundled);
        // missing in debug: system git
        assert_eq!(locate_git(Some(res), true, true, None, &|_| false), PathBuf::from("git.exe"));
        // other platforms
        assert_eq!(locate_git(Some(res), false, false, None, &|_| false), PathBuf::from("git"));
        assert_eq!(locate_git(Some(res), false, false, Some("  "), &|_| false), PathBuf::from("git"));
    }

    #[test]
    fn folder_names_are_valid_on_windows() {
        assert_eq!(sanitize_folder_name("Experimental Rocket"), "Experimental Rocket");
        assert_eq!(sanitize_folder_name("A/B: \"C\"?"), "A_B_ _C__");
        assert_eq!(sanitize_folder_name("  Razzo.  "), "Razzo");
        assert_eq!(sanitize_folder_name("..."), "Progetto");
        assert_eq!(sanitize_folder_name(""), "Progetto");
        assert_eq!(sanitize_folder_name("con"), "_con");
        assert_eq!(sanitize_folder_name("COM3.txt"), "_COM3.txt");
        assert_eq!(sanitize_folder_name(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn projects_root() {
        assert_eq!(default_projects_root(Some(Path::new("/home/u"))), PathBuf::from("/home/u/RocketSync"));
    }
}
