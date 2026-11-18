//! Shared helpers of the integration tests: bare `file://` remotes, several "users" (each with its
//! own engine, data directory and project folder, all under temporary directories), a simulated
//! `EditorDetector` and a `FileInspector` that rejects `.ork` files that are not complete ZIPs.
#![allow(dead_code)]

use rs_core::RetryPolicy;
use rs_core::{
    CoreError, EditorDetector, EditorState, Engine, EngineConfig, FileInspector, Identity,
    LinkRequest, ProjectStatus, PublishRequest, SyncState, Timing,
};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;

pub const PROJECT: &str = "proj-1";

/// Runs the system git with an isolated environment (used to prepare remotes and to play the
/// role of "a colleague who is not using Rocket Sync").
pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Server")
        .env("GIT_AUTHOR_EMAIL", "server@example.com")
        .env("GIT_COMMITTER_NAME", "Server")
        .env("GIT_COMMITTER_EMAIL", "server@example.com")
        .env("LC_ALL", "C")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A bare remote with the initial commit the server creates (`Rocket-Sync-Kind: init`, version 0).
pub struct Remote {
    pub root: TempDir,
    pub path: PathBuf,
    pub url: String,
}

impl Remote {
    pub fn new() -> Remote {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("remote.git");
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "--bare", "-b", "main", "."]);
        let seed = root.path().join("seed");
        std::fs::create_dir_all(seed.join(".rocketsync")).unwrap();
        git(&seed, &["init", "-b", "main", "."]);
        std::fs::write(seed.join(".gitattributes"), "*.ork binary\n* -text\n").unwrap();
        std::fs::write(
            seed.join(".gitignore"),
            ".rocketsync/local/\n*.tmp\n~$*\n*.swp\n*.bak\nThumbs.db\ndesktop.ini\n.DS_Store\n",
        )
        .unwrap();
        std::fs::write(
            seed.join(".rocketsync/project.json"),
            "{ \"projectId\": \"proj-1\", \"schema\": 1 }\n",
        )
        .unwrap();
        git(&seed, &["add", "-A"]);
        git(
            &seed,
            &[
                "commit",
                "-m",
                "v0 — Progetto creato\n\nRocket-Sync-Version: 0\nRocket-Sync-Kind: init\nRocket-Sync-Client: server\n",
            ],
        );
        let url = format!("file://{}", path.display());
        git(&seed, &["push", &url, "main"]);
        Remote { root, path, url }
    }

    /// Sha of `refs/heads/main` on the remote.
    pub fn main_sha(&self) -> String {
        git(&self.path, &["rev-parse", "refs/heads/main"])
    }

    pub fn has_ref(&self, name: &str) -> bool {
        Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", name])
            .current_dir(&self.path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn tags(&self) -> Vec<String> {
        let t = git(&self.path, &["tag", "--list"]);
        t.lines().map(str::to_string).collect()
    }

    pub fn branches(&self) -> Vec<String> {
        git(
            &self.path,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// First-parent subjects, newest first.
    pub fn log_subjects(&self) -> Vec<String> {
        git(
            &self.path,
            &["log", "--first-parent", "--format=%s", "refs/heads/main"],
        )
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// Simulates a network outage by moving the repository away.
    pub fn go_offline(&self) -> PathBuf {
        let away = self.root.path().join("remote-away.git");
        std::fs::rename(&self.path, &away).unwrap();
        away
    }

    pub fn go_online(&self) {
        let away = self.root.path().join("remote-away.git");
        std::fs::rename(away, &self.path).unwrap();
    }

    /// Publishes a commit as "someone else" with plain git (a colleague's raw push).
    pub fn push_as_colleague(&self, files: &[(&str, &[u8])], number: i64, title: &str) {
        let work = tempfile::tempdir().unwrap();
        git(work.path(), &["clone", "-q", &self.url, "w"]);
        let w = work.path().join("w");
        for (p, b) in files {
            let f = w.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, b).unwrap();
        }
        git(&w, &["add", "-A"]);
        git(
            &w,
            &[
                "commit",
                "-q",
                "-m",
                &format!("v{number} — {title}\n\nRocket-Sync-Version: {number}\nRocket-Sync-Kind: publish\nRocket-Sync-Client: test\n"),
            ],
        );
        git(&w, &["tag", &format!("v{number}")]);
        git(&w, &["push", "-q", "origin", "main", &format!("v{number}")]);
    }
}

/// `.ork` content for tests: a valid ZIP whose bytes depend on `content`.
pub fn ork(content: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zw.start_file("rocket.ork", opts).unwrap();
        let mut body = format!("<openrocket><rocket name=\"{content}\"/>");
        for i in 0..200 {
            body.push_str(&format!("<c i=\"{i}\" v=\"{}\"/>", content.len() * i));
        }
        body.push_str("</openrocket>");
        zw.write_all(body.as_bytes()).unwrap();
        zw.finish().unwrap();
    }
    buf
}

/// Like [`ork`] but with the ZIP entry time set to `year` (same content, different bytes).
pub fn ork_ts(content: &str, year: u16) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::from_date_and_time(year, 1, 1, 0, 0, 0).unwrap());
        zw.start_file("rocket.ork", opts).unwrap();
        let mut body = format!("<openrocket><rocket name=\"{content}\"/>");
        for i in 0..200 {
            body.push_str(&format!("<c i=\"{i}\" v=\"{}\"/>", content.len() * i));
        }
        body.push_str("</openrocket>");
        zw.write_all(body.as_bytes()).unwrap();
        zw.finish().unwrap();
    }
    buf
}

fn zip_entries(bytes: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut v = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).ok()?;
        let mut data = Vec::new();
        f.read_to_end(&mut data).ok()?;
        v.push((f.name().to_string(), data));
    }
    Some(v)
}

/// A ZIP cut in the middle (what OpenRocket leaves while it is still writing).
pub fn partial_ork(content: &str) -> Vec<u8> {
    let full = ork(content);
    full[..full.len() * 6 / 10].to_vec()
}

/// Validates `.ork` files as complete ZIP archives; everything else is accepted.
pub struct ZipInspector;

impl FileInspector for ZipInspector {
    fn validate(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        if !path.to_lowercase().ends_with(".ork") {
            return Ok(());
        }
        let mut z = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|e| format!("archivio ZIP incompleto o danneggiato ({e})"))?;
        for i in 0..z.len() {
            let mut f = z
                .by_index(i)
                .map_err(|e| format!("voce {i} non leggibile ({e})"))?;
            let mut sink = Vec::new();
            f.read_to_end(&mut sink)
                .map_err(|e| format!("voce {i} non leggibile ({e})"))?;
        }
        Ok(())
    }

    fn content_equal(&self, path: &str, a: &[u8], b: &[u8]) -> bool {
        if a == b {
            return true;
        }
        if !path.to_lowercase().ends_with(".ork") {
            return false;
        }
        match (zip_entries(a), zip_entries(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        }
    }

    fn changelog(&self, path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String> {
        match (before, after) {
            (None, Some(_)) => vec![format!("Aggiunto {path}")],
            (Some(_), None) => vec![format!("Rimosso {path}")],
            (Some(b), Some(a)) => vec![format!("Modificato: {} → {} byte", b.len(), a.len())],
            _ => vec![],
        }
    }
}

/// `EditorDetector` that tests drive by hand.
#[derive(Default)]
pub struct MockDetector {
    state: Mutex<Option<EditorState>>,
}

impl MockDetector {
    pub fn set(&self, s: EditorState) {
        *self.state.lock().unwrap() = Some(s);
    }
    pub fn not_running(&self) {
        self.set(EditorState::NotRunning);
    }
    pub fn running_with(&self, files: Vec<PathBuf>) {
        self.set(EditorState::Running {
            open_files: Some(files),
        });
    }
    pub fn running_unknown(&self) {
        self.set(EditorState::Running { open_files: None });
    }
}

impl EditorDetector for MockDetector {
    fn state(&self, _root: &Path) -> EditorState {
        self.state
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(EditorState::NotRunning)
    }
}

/// One person: own engine, own data directory, own project folder.
pub struct User {
    pub name: String,
    pub engine: Engine,
    pub folder: PathBuf,
    pub data_dir: PathBuf,
    pub detector: Arc<MockDetector>,
    pub _tmp: TempDir,
}

pub fn test_config(data_dir: &Path, detector: Arc<MockDetector>) -> EngineConfig {
    let mut cfg = EngineConfig::new(data_dir);
    cfg.inspector = Arc::new(ZipInspector);
    cfg.detector = detector;
    cfg.timing = Timing::fast();
    cfg.background = false;
    cfg.watch = false;
    cfg.git.retry = RetryPolicy {
        attempts: 3,
        base_delay: Duration::from_millis(2),
    };
    cfg.client_version = "0.0.0-test".into();
    cfg
}

impl User {
    /// A user with an engine that is *not* linked to any project yet.
    pub async fn unlinked(name: &str) -> User {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let folder = tmp.path().join("progetto");
        let detector = Arc::new(MockDetector::default());
        let cfg = test_config(&data_dir, detector.clone());
        let engine = Engine::open(cfg).await.unwrap();
        engine.set_identity(Some(Identity {
            name: name.to_string(),
            email: format!("1+{}@users.noreply.github.com", name.to_lowercase()),
        }));
        User {
            name: name.to_string(),
            engine,
            folder,
            data_dir,
            detector,
            _tmp: tmp,
        }
    }

    pub async fn linked(name: &str, remote: &Remote) -> User {
        let u = User::unlinked(name).await;
        u.link(remote).await.unwrap();
        u
    }

    pub async fn link(&self, remote: &Remote) -> Result<ProjectStatus, CoreError> {
        self.engine
            .link_project(LinkRequest {
                project_id: PROJECT.into(),
                repo_full_name: "team/razzo".into(),
                remote_url: Some(remote.url.clone()),
                folder: self.folder.to_string_lossy().into_owned(),
                allow_synced_drive: false,
            })
            .await
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.folder.join(rel)
    }

    pub fn write(&self, rel: &str, bytes: &[u8]) {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    pub fn write_ork(&self, rel: &str, content: &str) {
        self.write(rel, &ork(content));
    }

    pub fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.path(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.path(rel).exists()
    }

    pub async fn status(&self) -> ProjectStatus {
        self.engine.status(PROJECT).await.unwrap()
    }

    pub async fn publish(&self, title: &str) -> Result<ProjectStatus, CoreError> {
        self.engine
            .publish(
                PROJECT,
                PublishRequest {
                    title: Some(title.to_string()),
                    description: None,
                    paths: None,
                },
            )
            .await
    }

    pub async fn publish_paths(
        &self,
        title: &str,
        paths: &[&str],
    ) -> Result<ProjectStatus, CoreError> {
        self.engine
            .publish(
                PROJECT,
                PublishRequest {
                    title: Some(title.to_string()),
                    description: None,
                    paths: Some(paths.iter().map(|s| s.to_string()).collect()),
                },
            )
            .await
    }

    pub async fn sync(&self) -> ProjectStatus {
        self.engine.sync_now(PROJECT).await.unwrap()
    }

    /// Git in this user's project folder (read-only inspection in tests).
    pub fn git(&self, args: &[&str]) -> String {
        git(&self.folder, args)
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "refs/heads/main"])
    }

    pub fn assert_clean(&self) {
        let st = self.git(&["status", "--porcelain"]);
        assert!(
            st.is_empty(),
            "git status not clean for {}: {st}",
            self.name
        );
    }
}

pub fn assert_synced(st: &ProjectStatus) {
    assert_eq!(st.state, SyncState::Synced, "status: {st:#?}");
    assert!(st.changed_files.is_empty(), "{st:#?}");
    assert!(st.pending_versions.is_empty(), "{st:#?}");
}

use rs_core::EngineEvent;
use tokio::sync::broadcast;

/// Collects the events received so far.
pub fn drain(rx: &mut broadcast::Receiver<EngineEvent>) -> Vec<EngineEvent> {
    let mut v = Vec::new();
    loop {
        match rx.try_recv() {
            Ok(e) => v.push(e),
            Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(_) => break,
        }
    }
    v
}

/// Asserts that Rocket Sync never ran a forbidden command on the repositories of `engine`.
pub fn assert_no_forbidden_commands(engine: &Engine) {
    let log = engine.command_log().records();
    assert!(!log.is_empty(), "the command log is empty");
    for r in &log {
        let line = r.command_line();
        for bad in ["--force", "--force-with-lease", "--hard", "--mirror"] {
            assert!(
                !r.args.iter().any(|a| a == bad),
                "forbidden option {bad} in: {line}"
            );
        }
        assert!(
            !r.args
                .iter()
                .any(|a| a == "-f" || a.starts_with("+refs/") || a.starts_with('+')),
            "forced refspec/option in: {line}"
        );
        let sub = r
            .args
            .iter()
            .find(|a| !a.starts_with('-') && !a.contains('='))
            .map(String::as_str)
            .unwrap_or("");
        for bad in [
            "merge",
            "rebase",
            "stash",
            "reset",
            "checkout",
            "switch",
            "restore",
            "pull",
            "cherry-pick",
            "revert",
            "clean",
        ] {
            assert!(sub != bad, "forbidden subcommand {bad}: {line}");
        }
    }
}

impl User {
    /// Simulates quitting (or crashing) and starting the app again on the same data and folder.
    pub async fn restart(self) -> User {
        self.engine.shutdown().await;
        let engine = Engine::new(test_config(&self.data_dir, self.detector.clone()))
            .await
            .unwrap();
        engine.set_identity(Some(Identity {
            name: self.name.clone(),
            email: format!("1+{}@users.noreply.github.com", self.name.to_lowercase()),
        }));
        User {
            name: self.name,
            engine,
            folder: self.folder,
            data_dir: self.data_dir,
            detector: self.detector,
            _tmp: self._tmp,
        }
    }

    /// Opens the user's database for inspection.
    pub fn store(&self) -> rs_store::Store {
        rs_store::Store::open(&self.data_dir.join("rocketsync.db")).unwrap()
    }

    /// Waits (up to `secs`) until `f` is true, polling the status.
    pub async fn wait_status(
        &self,
        secs: u64,
        f: impl Fn(&ProjectStatus) -> bool,
    ) -> ProjectStatus {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let st = self.status().await;
            if f(&st) {
                return st;
            }
            if std::time::Instant::now() > end {
                panic!("timeout waiting for status, last: {st:#?}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Raw bytes of `git <args>` output (for binary blobs).
pub fn git_bytes(cwd: &Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// Whether `a` is an ancestor of `b` in the repository at `cwd`.
pub fn is_ancestor(cwd: &Path, a: &str, b: &str) -> bool {
    Command::new("git")
        .args(["merge-base", "--is-ancestor", a, b])
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A duel on the same file: Anna and Bruno both start from v1 and change `Razzo.ork`.
pub struct Duel {
    pub remote: Remote,
    pub a: User,
    pub b: User,
}

impl Duel {
    /// Both linked at v1 (`Razzo.ork` = "base"); nothing else done.
    pub async fn start() -> Duel {
        let remote = Remote::new();
        let a = User::linked("Anna", &remote).await;
        let b = User::linked("Bruno", &remote).await;
        a.write_ork("Razzo.ork", "base");
        a.publish("Base").await.unwrap();
        b.sync().await;
        assert_eq!(b.read("Razzo.ork"), ork("base"));
        Duel { remote, a, b }
    }

    /// Anna publishes v2, Bruno publishes and runs into the conflict. Returns the conflict id.
    pub async fn conflict_at_push(&self) -> String {
        self.a.write_ork("Razzo.ork", "di-anna");
        self.b.write_ork("Razzo.ork", "di-bruno");
        self.a.publish("Anna").await.unwrap();
        let st = self.b.publish("Bruno").await.unwrap();
        assert_eq!(st.state, SyncState::Conflict, "{st:#?}");
        assert_eq!(st.open_conflict_ids.len(), 1);
        st.open_conflict_ids[0].clone()
    }
}

/// A user whose engine runs the watcher and the background loop (automatic publication, fetch).
pub async fn user_with_background(name: &str, remote: &Remote, fetch_ms: u64) -> User {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let folder = tmp.path().join("progetto");
    let detector = Arc::new(MockDetector::default());
    let mut cfg = test_config(&data_dir, detector.clone());
    cfg.background = true;
    cfg.watch = true;
    cfg.timing.fetch_interval = Duration::from_millis(fetch_ms);
    let engine = Engine::open(cfg).await.unwrap();
    engine.set_identity(Some(Identity {
        name: name.into(),
        email: format!("1+{}@users.noreply.github.com", name.to_lowercase()),
    }));
    let u = User { name: name.into(), engine, folder, data_dir, detector, _tmp: tmp };
    u.link(remote).await.unwrap();
    u
}
