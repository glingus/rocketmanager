//! Detection of the files open in OpenRocket.
//!
//! The decision logic ([`parse_openrocket_title`], [`interpret_windows`]) is plain Rust and unit
//! tested on every platform. Only the enumeration of the top-level windows is Windows specific
//! (`WindowsEditorDetector`, behind `cfg(windows)`).
//!
//! OpenRocket shows the file name in the title of each document window (for example
//! `OpenRocket - Razzo.ork` or `*Razzo.ork - OpenRocket`, a leading `*` marks unsaved changes).
//! The exact format depends on the OpenRocket version and must be verified on a real Windows
//! machine; whenever a title cannot be interpreted the detector falls back to
//! `Running { open_files: None }`, which makes the engine treat every file as possibly open.

use crate::hooks::EditorState;
use std::path::{Path, PathBuf};

/// A top-level window as seen by the detector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub pid: u32,
    /// Executable file name of the owning process, lower case (`openrocket.exe`, `javaw.exe`).
    pub exe: String,
    pub title: String,
}

/// What the title of an OpenRocket window says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenRocketTitle {
    /// Window without document (start page, splash).
    Idle,
    /// Document window with a file name (or a full path).
    File(String),
    /// Document window whose file cannot be determined (e.g. an unsaved new rocket).
    Unknown,
}

fn is_rocket_file_name(s: &str) -> bool {
    let l = s.to_lowercase();
    l.ends_with(".ork") || l.ends_with(".rkt")
}

/// Interprets the title of a window. `None` means "not an OpenRocket window".
pub fn parse_openrocket_title(title: &str) -> Option<OpenRocketTitle> {
    let t = title.trim();
    if t.is_empty() || !t.to_lowercase().contains("openrocket") {
        return None;
    }
    // Split on the usual separators and drop the "OpenRocket [version]" part.
    let seps = [" - ", " – ", " — ", " | "];
    let mut parts: Vec<String> = vec![t.to_string()];
    for s in seps {
        parts = parts
            .into_iter()
            .flat_map(|p| p.split(s).map(str::to_string).collect::<Vec<_>>())
            .collect();
    }
    let mut candidate: Option<String> = None;
    let mut others = 0;
    for p in parts {
        let p = p.trim().to_string();
        if p.to_lowercase().starts_with("openrocket") {
            // "OpenRocket", "OpenRocket 23.09": the application name
            let rest = p["openrocket".len()..].trim();
            if rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ' ') {
                continue;
            }
        }
        let p = p.trim_start_matches('*').trim().to_string();
        if p.is_empty() {
            continue;
        }
        if is_rocket_file_name(&p) {
            candidate = Some(p);
        } else {
            others += 1;
        }
    }
    match candidate {
        Some(c) => Some(OpenRocketTitle::File(c)),
        None if others == 0 => Some(OpenRocketTitle::Idle),
        None => Some(OpenRocketTitle::Unknown),
    }
}

fn is_openrocket_process(exe: &str) -> bool {
    exe.starts_with("openrocket") && exe.ends_with(".exe")
}

fn is_java_process(exe: &str) -> bool {
    exe == "javaw.exe" || exe == "java.exe"
}

/// Files of `root` (any depth, `.git` excluded) whose name is `name`.
fn find_by_name(root: &Path, name: &str) -> Vec<PathBuf> {
    let want = name.to_lowercase();
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let fname = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if fname != ".git" && depth < 8 {
                    stack.push((p, depth + 1));
                }
            } else if fname.to_lowercase() == want {
                out.push(p);
            }
        }
    }
    out
}

/// Decides the [`EditorState`] from the list of top-level windows.
///
/// * no OpenRocket window → `NotRunning`;
/// * at least one document window with a file name → `Running` with the files of the project
///   that have that name (a file of another folder does not matter);
/// * only start-page windows → `Running` with no open files;
/// * otherwise (titles that cannot be interpreted) → `Running { open_files: None }`.
pub fn interpret_windows(windows: &[WindowInfo], project_root: &Path) -> EditorState {
    let mut any = false;
    let mut files: Vec<String> = Vec::new();
    let mut idle = false;
    let mut unknown = false;
    for w in windows {
        let parsed = parse_openrocket_title(&w.title);
        let ours = is_openrocket_process(&w.exe) || (is_java_process(&w.exe) && parsed.is_some());
        if !ours {
            continue;
        }
        any = true;
        match parsed {
            Some(OpenRocketTitle::File(f)) => files.push(f),
            Some(OpenRocketTitle::Idle) => idle = true,
            Some(OpenRocketTitle::Unknown) | None => {
                if !w.title.trim().is_empty() {
                    unknown = true;
                }
            }
        }
    }
    if !any {
        return EditorState::NotRunning;
    }
    if files.is_empty() {
        return if idle {
            EditorState::Running {
                open_files: Some(Vec::new()),
            }
        } else {
            debug_assert!(unknown || !any || !idle);
            EditorState::Running { open_files: None }
        };
    }
    let mut open: Vec<PathBuf> = Vec::new();
    for f in files {
        let as_path = PathBuf::from(&f);
        if as_path.is_absolute() {
            open.push(as_path);
        } else {
            open.extend(find_by_name(project_root, &f));
        }
    }
    open.sort();
    open.dedup();
    EditorState::Running {
        open_files: Some(open),
    }
}

#[cfg(windows)]
mod win {
    use super::{interpret_windows, WindowInfo};
    use crate::hooks::{EditorDetector, EditorState};
    use std::collections::HashMap;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct Collector {
        windows: Vec<(u32, String)>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        // SAFETY: `lparam` is the address of the `Collector` that lives on the caller's stack for
        // the whole duration of `EnumWindows`.
        let c = &mut *(lparam as *mut Collector);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        c.windows.push((pid, title));
        1
    }

    fn exe_name(pid: u32) -> Option<String> {
        // SAFETY: plain Win32 calls; the handle is closed before returning.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..size as usize]);
            full.rsplit(['\\', '/']).next().map(|s| s.to_lowercase())
        }
    }

    /// Lists the visible top-level windows with their process.
    pub fn enumerate_windows() -> Vec<WindowInfo> {
        let mut c = Collector { windows: Vec::new() };
        // SAFETY: `enum_proc` only dereferences the pointer passed here, which outlives the call.
        unsafe {
            EnumWindows(Some(enum_proc), &mut c as *mut Collector as LPARAM);
        }
        let mut names: HashMap<u32, Option<String>> = HashMap::new();
        let mut out = Vec::new();
        for (pid, title) in c.windows {
            let exe = names.entry(pid).or_insert_with(|| exe_name(pid)).clone();
            if let Some(exe) = exe {
                out.push(WindowInfo { pid, exe, title });
            }
        }
        out
    }

    /// Real detector for Windows: `EnumWindows` on the OpenRocket / `javaw` processes and
    /// interpretation of the window titles.
    #[derive(Debug, Default, Clone, Copy)]
    pub struct WindowsEditorDetector;

    impl EditorDetector for WindowsEditorDetector {
        fn state(&self, project_root: &Path) -> EditorState {
            interpret_windows(&enumerate_windows(), project_root)
        }
    }
}

#[cfg(windows)]
pub use win::{enumerate_windows, WindowsEditorDetector};

#[cfg(test)]
mod tests {
    use super::*;

    fn w(exe: &str, title: &str) -> WindowInfo {
        WindowInfo {
            pid: 1,
            exe: exe.into(),
            title: title.into(),
        }
    }

    #[test]
    fn parses_titles() {
        assert_eq!(
            parse_openrocket_title("OpenRocket - Razzo.ork"),
            Some(OpenRocketTitle::File("Razzo.ork".into()))
        );
        assert_eq!(
            parse_openrocket_title("*Razzo.ork - OpenRocket"),
            Some(OpenRocketTitle::File("Razzo.ork".into()))
        );
        assert_eq!(
            parse_openrocket_title("OpenRocket 23.09 - *Mio razzo v2.ork"),
            Some(OpenRocketTitle::File("Mio razzo v2.ork".into()))
        );
        assert_eq!(parse_openrocket_title("OpenRocket"), Some(OpenRocketTitle::Idle));
        assert_eq!(parse_openrocket_title("OpenRocket 23.09"), Some(OpenRocketTitle::Idle));
        assert_eq!(
            parse_openrocket_title("OpenRocket - [Nuovo razzo]"),
            Some(OpenRocketTitle::Unknown)
        );
        assert_eq!(parse_openrocket_title("Blocco note"), None);
        assert_eq!(parse_openrocket_title(""), None);
    }

    #[test]
    fn interprets_windows() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(d.path().join("sub/Razzo.ork"), b"x").unwrap();
        std::fs::write(d.path().join("Altro.ork"), b"x").unwrap();

        assert_eq!(interpret_windows(&[w("notepad.exe", "Razzo.ork")], d.path()), EditorState::NotRunning);
        assert_eq!(interpret_windows(&[], d.path()), EditorState::NotRunning);

        let st = interpret_windows(
            &[
                w("javaw.exe", "OpenRocket - Razzo.ork"),
                w("javaw.exe", "Configure simulation"),
                w("chrome.exe", "OpenRocket download"),
            ],
            d.path(),
        );
        assert_eq!(
            st,
            EditorState::Running {
                open_files: Some(vec![d.path().join("sub/Razzo.ork")])
            }
        );

        // a file with that name that is not in this project: running but nothing of ours is open
        let st = interpret_windows(&[w("openrocket.exe", "OpenRocket - Esterno.ork")], d.path());
        assert_eq!(st, EditorState::Running { open_files: Some(vec![]) });

        // start page only
        let st = interpret_windows(&[w("openrocket.exe", "OpenRocket")], d.path());
        assert_eq!(st, EditorState::Running { open_files: Some(vec![]) });

        // process present, titles not interpretable -> unknown files
        let st = interpret_windows(&[w("openrocket.exe", "Qualcosa di strano")], d.path());
        assert_eq!(st, EditorState::Running { open_files: None });
        let st = interpret_windows(&[w("javaw.exe", "OpenRocket - [Nuovo razzo]")], d.path());
        assert_eq!(st, EditorState::Running { open_files: None });
    }
}
