//! Detection and launch of OpenRocket.
//!
//! On Windows the installation is searched in the uninstall registry keys, in
//! `Program Files\OpenRocket` and through the association of the `.ork` extension. The parsing
//! helpers are plain functions tested on every platform; the registry access is Windows only.
//! `ROCKETSYNC_OPENROCKET` (path of the executable) overrides the detection (development).

use serde::Serialize;
use std::path::{Path, PathBuf};

/// `openRocket` field of `get_app_info`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRocketInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// Extracts the executable of a shell command such as `"C:\Program Files\OpenRocket\OpenRocket.exe" "%1"`.
pub fn exe_from_command(cmd: &str) -> Option<PathBuf> {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some(PathBuf::from(&rest[..end]));
    }
    let lower = c.to_lowercase();
    let end = lower.find(".exe").map(|i| i + 4).unwrap_or(c.len());
    let p = c[..end].trim();
    if p.is_empty() {
        None
    } else {
        Some(PathBuf::from(p))
    }
}

/// `OpenRocket 23.09` → `23.09`.
pub fn version_from_display_name(name: &str) -> Option<String> {
    let rest = name.trim().strip_prefix("OpenRocket").or_else(|| name.trim().strip_prefix("openrocket"))?;
    let v = rest.trim().trim_start_matches(['v', 'V']).trim();
    if v.is_empty() || !v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        None
    } else {
        Some(v.split_whitespace().next().unwrap_or(v).to_string())
    }
}

/// Candidate installation folders under the Program Files directories.
pub fn program_files_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|r| [r.join("OpenRocket").join("OpenRocket.exe"), r.join("OpenRocket").join("openrocket.exe")])
        .collect()
}

fn info_for(path: PathBuf, version: Option<String>) -> OpenRocketInfo {
    OpenRocketInfo {
        found: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    }
}

/// Finds OpenRocket on this machine.
pub fn detect() -> OpenRocketInfo {
    if let Ok(p) = std::env::var("ROCKETSYNC_OPENROCKET") {
        let p = PathBuf::from(p.trim());
        if p.is_file() {
            return info_for(p, None);
        }
    }
    detect_platform()
}

#[cfg(not(windows))]
fn detect_platform() -> OpenRocketInfo {
    OpenRocketInfo::default()
}

#[cfg(windows)]
fn detect_platform() -> OpenRocketInfo {
    use winreg::enums::*;
    use winreg::RegKey;

    // 1. uninstall registry keys
    let uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let wow = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    for (hive, path) in [
        (HKEY_CURRENT_USER, uninstall),
        (HKEY_LOCAL_MACHINE, uninstall),
        (HKEY_LOCAL_MACHINE, wow),
    ] {
        let Ok(key) = RegKey::predef(hive).open_subkey(path) else { continue };
        for name in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey(&name) else { continue };
            let display: String = sub.get_value("DisplayName").unwrap_or_default();
            if !display.to_lowercase().contains("openrocket") {
                continue;
            }
            let version = sub
                .get_value::<String, _>("DisplayVersion")
                .ok()
                .or_else(|| version_from_display_name(&display));
            let location: String = sub.get_value("InstallLocation").unwrap_or_default();
            let icon: String = sub.get_value("DisplayIcon").unwrap_or_default();
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Some(e) = exe_from_command(&icon) {
                candidates.push(e);
            }
            if !location.is_empty() {
                candidates.push(PathBuf::from(&location).join("OpenRocket.exe"));
            }
            if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
                return info_for(p, version);
            }
        }
    }
    // 2. Program Files
    let mut roots = Vec::new();
    for v in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(p) = std::env::var_os(v) {
            let p = PathBuf::from(p);
            roots.push(if v == "LOCALAPPDATA" { p.join("Programs") } else { p });
        }
    }
    if let Some(p) = program_files_candidates(&roots).into_iter().find(|p| p.is_file()) {
        return info_for(p, None);
    }
    // 3. association of .ork
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    if let Ok(ext) = classes.open_subkey(".ork") {
        let progid: String = ext.get_value("").unwrap_or_default();
        if !progid.is_empty() {
            if let Ok(cmd) = classes.open_subkey(format!(r"{progid}\shell\open\command")) {
                let line: String = cmd.get_value("").unwrap_or_default();
                if let Some(exe) = exe_from_command(&line) {
                    if exe.is_file() && exe.to_string_lossy().to_lowercase().contains("openrocket") {
                        return info_for(exe, None);
                    }
                }
            }
        }
    }
    OpenRocketInfo::default()
}

/// Whether `file` has an extension OpenRocket opens.
pub fn is_rocket_file(file: &Path) -> bool {
    file.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "ork" || e == "rkt"
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shell_commands() {
        assert_eq!(
            exe_from_command(r#""C:\Program Files\OpenRocket\OpenRocket.exe" "%1""#),
            Some(PathBuf::from(r"C:\Program Files\OpenRocket\OpenRocket.exe"))
        );
        assert_eq!(
            exe_from_command(r"C:\OpenRocket\OpenRocket.exe %1"),
            Some(PathBuf::from(r"C:\OpenRocket\OpenRocket.exe"))
        );
        assert_eq!(exe_from_command(""), None);
        assert_eq!(exe_from_command(r#""unterminated"#), None);
    }

    #[test]
    fn parses_versions() {
        assert_eq!(version_from_display_name("OpenRocket 23.09").as_deref(), Some("23.09"));
        assert_eq!(version_from_display_name("OpenRocket v15.03 (64-bit)").as_deref(), Some("15.03"));
        assert_eq!(version_from_display_name("OpenRocket"), None);
        assert_eq!(version_from_display_name("Altro 1.0"), None);
    }

    #[test]
    fn candidates_and_extensions() {
        let c = program_files_candidates(&[PathBuf::from("/p")]);
        assert_eq!(c.len(), 2);
        assert!(c[0].ends_with("OpenRocket/OpenRocket.exe"));
        assert!(is_rocket_file(Path::new("a/Razzo.ORK")));
        assert!(!is_rocket_file(Path::new("a/run.exe")));
        assert!(!is_rocket_file(Path::new("noext")));
    }

    #[test]
    fn env_override_wins() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("or");
        std::fs::write(&exe, b"").unwrap();
        std::env::set_var("ROCKETSYNC_OPENROCKET", &exe);
        let i = detect();
        std::env::remove_var("ROCKETSYNC_OPENROCKET");
        assert!(i.found);
        assert_eq!(i.path.as_deref(), Some(exe.to_string_lossy().as_ref()));
    }
}
