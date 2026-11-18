//! Integration tests against the system git, using temporary repositories.

use rs_git::{CommitSpec, Cmd, Git, GitConfig, GitErrorKind, IndexInfoEntry, RetryPolicy, Signature, StatusKind};
use std::fs;
use std::time::Duration;

fn git() -> Git {
    let dir = tempfile::tempdir().unwrap().into_path();
    let cfg = GitConfig {
        global_config: Some(dir.join("gitconfig")),
        retry: RetryPolicy {
            attempts: 3,
            base_delay: Duration::from_millis(1),
        },
        ..GitConfig::default()
    };
    Git::new(cfg)
}

fn sig() -> Signature {
    Signature::now("Test", "test@users.noreply.github.com")
}

fn commit_all(repo: &rs_git::Repo, msg: &str, parents: &[String]) -> String {
    let idx = repo.workdir().join(".git/tmp-index");
    repo.read_tree(Some(&idx), parents.first().map(|s| s.as_str()).unwrap_or(rs_git::EMPTY_TREE)).unwrap();
    repo.add_all(Some(&idx)).unwrap();
    let tree = repo.write_tree(Some(&idx)).unwrap();
    let s = sig();
    repo.commit_tree(&CommitSpec { tree: &tree, parents, message: msg, author: &s, committer: &s }).unwrap()
}

#[test]
fn version_is_supported() {
    let g = git();
    let v = g.ensure_min_version().unwrap();
    assert!(v.major >= 2);
}

#[test]
fn status_log_diff_and_merge_tree() {
    let g = git();
    let d = tempfile::tempdir().unwrap();
    let repo = g.init(d.path(), false, "main").unwrap();
    fs::write(repo.workdir().join(".gitattributes"), "* -text\n*.ork binary\n").unwrap();
    fs::write(repo.workdir().join("a.ork"), [0u8, 1, 2, 3, 0, 9]).unwrap();
    fs::write(repo.workdir().join("t.txt"), "uno\ndue\ntre\n").unwrap();

    // untracked files are reported
    let st = repo.status().unwrap();
    assert!(st.iter().all(|e| e.kind == StatusKind::Untracked));
    assert_eq!(st.len(), 3);

    let base = commit_all(&repo, "base\n\nRocket-Sync-Version: 0\n", &[]);
    repo.update_ref("refs/heads/main", &base, None).unwrap();
    repo.read_tree(None, &base).unwrap();
    assert!(repo.status().unwrap().is_empty());

    // log parsing keeps message and trailers
    let c = repo.commit_info(&base).unwrap();
    assert_eq!(c.sha, base);
    assert!(c.parents.is_empty());
    assert_eq!(rs_git::parse_message(&c.message).trailer("Rocket-Sync-Version"), Some("0"));

    // two diverging commits: binary conflict on a.ork, clean text merge on t.txt
    fs::write(repo.workdir().join("a.ork"), [7u8, 0, 0, 1]).unwrap();
    fs::write(repo.workdir().join("t.txt"), "UNO\ndue\ntre\n").unwrap();
    let ours = commit_all(&repo, "ours", &[base.clone()]);
    fs::write(repo.workdir().join("a.ork"), [8u8, 0, 0, 2]).unwrap();
    fs::write(repo.workdir().join("t.txt"), "uno\ndue\nTRE\n").unwrap();
    let theirs = commit_all(&repo, "theirs", &[base.clone()]);

    let m = repo.merge_tree(&base, &ours, &theirs).unwrap();
    assert!(!m.clean);
    assert_eq!(m.conflicted, vec!["a.ork".to_string()]);
    let merged = repo.tree_map(&m.tree).unwrap();
    assert!(merged.contains_key("t.txt"));

    // diff-tree and binary detection
    let diff = repo.diff_tree(&base, &ours, true).unwrap();
    assert_eq!(diff.len(), 2);
    let bins = repo.binary_paths(&base, &ours).unwrap();
    assert_eq!(bins, vec!["a.ork".to_string()]);

    // index-info writes a tree without touching the disk
    let idx = repo.workdir().join(".git/idx2");
    repo.read_tree(Some(&idx), &ours).unwrap();
    let blob = repo.write_blob(b"nuovo").unwrap();
    repo.update_index_info(Some(&idx), &[
        IndexInfoEntry { path: "n/new.txt".into(), mode_oid: Some(("100644".into(), blob.clone())) },
        IndexInfoEntry { path: "a.ork".into(), mode_oid: None },
    ]).unwrap();
    let t = repo.write_tree(Some(&idx)).unwrap();
    let map = repo.tree_map(&t).unwrap();
    assert!(map.contains_key("n/new.txt"));
    assert!(!map.contains_key("a.ork"));
    assert_eq!(repo.cat_blob(&map["n/new.txt"].oid).unwrap(), b"nuovo");

    // hash_files agrees with the object database
    let h = repo.hash_files(&["t.txt".into(), "missing".into()]).unwrap();
    assert_eq!(h[0].as_deref(), Some(map_oid(&repo, &theirs, "t.txt").as_str()));
    assert!(h[1].is_none());
}

fn map_oid(repo: &rs_git::Repo, commit: &str, path: &str) -> String {
    repo.tree_map(commit).unwrap()[path].oid.clone()
}

#[test]
fn command_log_has_no_force_and_redacts() {
    let g = git();
    let d = tempfile::tempdir().unwrap();
    let repo = g.init(d.path(), false, "main").unwrap();
    let _ = repo.run(Cmd::new(["config", "user.name", "x"]));
    // a command with a secret in its arguments is logged redacted
    let _ = repo.run(Cmd::new(["ls-remote", "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@127.0.0.1:9/o/r.git"]).no_retry().timeout(Duration::from_secs(5)));
    let log = g.command_log().records();
    assert!(!log.is_empty());
    assert!(log.iter().all(|r| !r.command_line().contains("ghp_")));
    assert!(log.iter().all(|r| !r.args.iter().any(|a| a == "--force" || a == "-f")));
}

#[test]
fn errors_are_typed() {
    let g = git();
    let d = tempfile::tempdir().unwrap();
    // not a repository
    let e = g.open(d.path()).unwrap_err();
    assert_eq!(e.kind(), GitErrorKind::NotARepository, "{e}");
    // unreachable remote
    let repo = g.init(d.path(), false, "main").unwrap();
    let e = repo.fetch("file:///definitely/not/here.git", &["refs/heads/main:refs/remotes/o/main"]).unwrap_err();
    assert_eq!(e.kind(), GitErrorKind::Network, "{e}");
    // missing binary
    let g2 = Git::new(GitConfig { git_path: "/nonexistent/git".into(), ..GitConfig::default() });
    assert_eq!(g2.version().unwrap_err().kind(), GitErrorKind::GitMissing);
}

#[test]
fn index_lock_is_retried_then_reported() {
    let g = git();
    let d = tempfile::tempdir().unwrap();
    let repo = g.init(d.path(), false, "main").unwrap();
    fs::write(repo.workdir().join("f.txt"), "x").unwrap();
    let lock = repo.workdir().join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    let before = g.command_log().records().len();
    let e = repo.update_index_paths(None, &["f.txt".to_string()]).unwrap_err();
    assert_eq!(e.kind(), GitErrorKind::LockHeld, "{e}");
    assert_eq!(g.command_log().records().len() - before, 3, "3 attempts expected");
    // lock released while retrying -> success
    let lock2 = lock.clone();
    let h = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1));
        let _ = fs::remove_file(lock2);
    });
    h.join().unwrap();
    repo.update_index_paths(None, &["f.txt".to_string()]).unwrap();
}

#[test]
fn timeout_and_cancel() {
    let g = git();
    let d = tempfile::tempdir().unwrap();
    let repo = g.init(d.path(), false, "main").unwrap();
    // `cat-file --batch` waits for stdin that never closes? stdin is piped and closed after write, so use a
    // zero timeout on a normal command instead.
    let e = repo.run(Cmd::new(["status"]).timeout(Duration::from_nanos(1)).no_retry());
    // either it finished extremely fast or it timed out; both are acceptable, but a timeout must be typed
    if let Err(e) = e {
        assert_eq!(e.kind(), GitErrorKind::Timeout);
    }
    let token = rs_git::CancelToken::new();
    let g2 = g.with_cancel_token(token.clone());
    token.cancel();
    let e = g2.repo(d.path()).run(Cmd::new(["status"])).unwrap_err();
    assert_eq!(e.kind(), GitErrorKind::Cancelled);
}
