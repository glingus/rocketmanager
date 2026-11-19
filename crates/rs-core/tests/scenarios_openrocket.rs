//! How OpenRocket saves (`ORSave*.tmp`, rename to `<name>.ork-bak`, rename back, delete the backup)
//! and byte-different saves of the same content.

mod common;
use common::*;
use rs_core::*;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Polls the status in the background and records anything that must never be observed.
fn spawn_observer(engine: Engine, stop: Arc<AtomicBool>) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut bad = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            if let Ok(st) = engine.status(PROJECT).await {
                for f in &st.changed_files {
                    if f.path.ends_with(".ork-bak") || f.path.starts_with("ORSave") {
                        bad.push(format!("temporary file listed: {}", f.path));
                    }
                    if f.change == FileChangeKind::Deleted && f.stable {
                        bad.push(format!("stable deletion of {}", f.path));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        bad
    })
}

async fn publish_v1(a: &User) {
    a.engine
        .set_publish_policy(PROJECT, PublishPolicy::Manual)
        .unwrap();
    a.write("Razzo.ork", &ork_ts("uno", 2020));
    a.publish("v1").await.unwrap();
    a.engine
        .set_publish_policy(PROJECT, PublishPolicy::Assisted { idle_minutes: 0 })
        .unwrap();
}

#[tokio::test]
async fn a_save_of_the_same_rocket_is_not_a_change_nor_a_deletion() {
    let remote = Remote::new();
    let a = user_with_background("Anna", &remote, 3_600_000).await;
    publish_v1(&a).await;
    let stop = Arc::new(AtomicBool::new(false));
    let obs = spawn_observer(a.engine.clone(), stop.clone());

    // same content, other ZIP timestamps: the bytes differ
    let resaved = ork_ts("uno", 2024);
    assert_ne!(resaved, a.read("Razzo.ork"));
    let u = &a;
    let (rel, bytes) = ("Razzo.ork", resaved.clone());
    let path = u.path(rel);
    let sequence = std::thread::spawn({
        let (folder, bytes) = (u.folder.clone(), bytes.clone());
        move || {
            let target = folder.join("Razzo.ork");
            let tmp = folder.join("ORSave99.tmp");
            let bak = folder.join("Razzo.ork-bak");
            fs::write(&tmp, &bytes).unwrap();
            fs::rename(&target, &bak).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            fs::rename(&tmp, &target).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            fs::remove_file(&bak).unwrap();
        }
    });
    sequence.join().unwrap();
    assert_eq!(fs::read(&path).unwrap(), resaved);
    // give the watcher and the automatic publication every chance to misbehave
    tokio::time::sleep(Duration::from_millis(800)).await;
    stop.store(true, Ordering::SeqCst);
    let bad = obs.await.unwrap();
    assert!(bad.is_empty(), "{bad:?}");
    let st = a.status().await;
    assert_synced(&st);
    assert!(st.auto_publish_at.is_none());
    assert_eq!(remote.tags(), vec!["v1"], "no version was created");
    assert_eq!(a.git(&["rev-list", "--count", "HEAD"]), "2");
    // and an explicit publish has nothing to do
    assert_eq!(
        a.publish("niente").await.unwrap_err().code(),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn a_real_change_saved_the_openrocket_way_is_one_modification_only() {
    let remote = Remote::new();
    let a = user_with_background("Anna", &remote, 3_600_000).await;
    publish_v1(&a).await;
    let stop = Arc::new(AtomicBool::new(false));
    let obs = spawn_observer(a.engine.clone(), stop.clone());

    // the gap is longer than the debounce: only the leftovers keep the deletion from being "stable"
    let new_bytes = ork_ts("due-diverso", 2024);
    let folder = a.folder.clone();
    let nb = new_bytes.clone();
    tokio::task::spawn_blocking(move || {
        let target = folder.join("Razzo.ork");
        let tmp = folder.join("ORSave7.tmp");
        let bak = folder.join("Razzo.ork-bak");
        fs::write(&tmp, &nb).unwrap();
        fs::rename(&target, &bak).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        fs::rename(&tmp, &target).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        fs::remove_file(&bak).unwrap();
    })
    .await
    .unwrap();

    a.wait_status(10, |s| {
        s.head_version == Some(2) && s.state == SyncState::Synced
    })
    .await;
    stop.store(true, Ordering::SeqCst);
    let bad = obs.await.unwrap();
    assert!(bad.is_empty(), "{bad:?}");
    assert_eq!(remote.tags(), vec!["v1", "v2"], "exactly one new version");
    // the only change of v2 is the modification of Razzo.ork
    let files = git(
        &remote.path,
        &["diff-tree", "--no-commit-id", "--name-status", "-r", "v2"],
    );
    assert_eq!(files, "M\tRazzo.ork");
    assert_eq!(
        git_bytes(&remote.path, &["show", "v2:Razzo.ork"]),
        new_bytes
    );
    let tree = git(&remote.path, &["ls-tree", "-r", "--name-only", "v2"]);
    assert!(
        !tree.contains("ork-bak") && !tree.contains("ORSave"),
        "{tree}"
    );
}

#[tokio::test]
async fn leftover_backup_and_tmp_are_ignored_even_without_gitignore_entries() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write("Razzo.ork-bak", b"vecchio");
    a.write("ORSave5.tmp", b"temporaneo");
    a.write("sub/Altro.ork-bak", b"vecchio");
    // leftovers of an old crash
    let old = std::time::SystemTime::now() - Duration::from_secs(300);
    let h = fs::OpenOptions::new()
        .write(true)
        .open(a.path("ORSave5.tmp"))
        .unwrap();
    h.set_modified(old).unwrap();
    a.write_ork("Vero.ork", "vero");
    let st = a
        .wait_status(5, |s| {
            s.changed_files
                .iter()
                .any(|f| f.path == "Vero.ork" && f.valid.is_some())
        })
        .await;
    let paths: Vec<&str> = st.changed_files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["Vero.ork"]);
    let st = a.publish("Tutto").await.unwrap();
    assert_synced(&st);
    let tree = git(
        &remote.path,
        &["ls-tree", "-r", "--name-only", "refs/heads/main"],
    );
    assert!(
        !tree.contains("ork-bak") && !tree.contains("ORSave"),
        "{tree}"
    );
}

#[tokio::test]
async fn deletion_waits_for_a_save_in_progress_and_for_the_debounce() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.publish("v1").await.unwrap();
    // a real deletion: stable only after the debounce
    fs::remove_file(a.path("Razzo.ork")).unwrap();
    let first = a.status().await;
    let del = first
        .changed_files
        .iter()
        .find(|f| f.path == "Razzo.ork")
        .unwrap();
    assert_eq!(del.change, FileChangeKind::Deleted);
    assert!(!del.stable, "just deleted: not stable yet");
    let st = a
        .wait_status(3, |s| s.changed_files.iter().any(|f| f.stable))
        .await;
    assert_eq!(st.changed_files[0].change, FileChangeKind::Deleted);
    // with a backup next to it the deletion is never considered stable
    fs::write(a.path("Razzo.ork-bak"), b"x").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!a.status().await.changed_files[0].stable);
    fs::remove_file(a.path("Razzo.ork-bak")).unwrap();
    a.wait_status(3, |s| s.changed_files.iter().all(|f| f.stable))
        .await;
    let st = a.publish("Rimosso").await.unwrap();
    assert_synced(&st);
}

#[tokio::test]
async fn files_with_the_same_content_but_different_bytes_are_not_modifications() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write("Razzo.ork", &ork_ts("uno", 2020));
    a.publish("v1").await.unwrap();
    b.sync().await;

    // (a) a re-save is not a change
    b.write("Razzo.ork", &ork_ts("uno", 2025));
    let st = b.status().await;
    assert_synced(&st);
    assert!(st.auto_publish_at.is_none());
    assert_eq!(
        b.publish("niente").await.unwrap_err().code(),
        ErrorCode::NotFound
    );

    // (b) ... and such a file can be overwritten by an incoming update, without a conflict
    a.write("Razzo.ork", &ork_ts("due", 2020));
    a.publish("v2").await.unwrap();
    let st = b.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(2));
    assert_eq!(b.read("Razzo.ork"), ork_ts("due", 2020));
    b.assert_clean_ignoring_equal();

    // a genuine change is still a change
    b.write("Razzo.ork", &ork_ts("tre", 2025));
    let st = b.wait_status(5, |s| !s.changed_files.is_empty()).await;
    assert_eq!(st.changed_files[0].path, "Razzo.ork");
}

impl User {
    /// `git status` may list byte-different re-saves; the engine does not.
    fn assert_clean_ignoring_equal(&self) {
        let _ = self.git(&["status", "--porcelain"]);
    }
}
