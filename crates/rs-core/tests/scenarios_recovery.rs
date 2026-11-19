//! Spec §12 scenarios 4 (restore) and 7 (simulated crashes and recovery at startup).

mod common;
use common::*;
use rs_core::*;

async fn sha_of(u: &User, n: i64) -> String {
    u.engine
        .list_versions(PROJECT, Some(100), None)
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.number == Some(n))
        .unwrap()
        .sha
}

// ---- 4. restore ----------------------------------------------------------------------------

async fn three_versions() -> (Remote, User, User) {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("X.ork", "x1");
    a.write_ork("Y.ork", "y1");
    a.publish("v1").await.unwrap();
    a.write_ork("X.ork", "x2");
    a.publish("v2").await.unwrap();
    a.write_ork("Y.ork", "y2");
    a.write_ork("Z.ork", "z3");
    a.publish("v3").await.unwrap();
    (remote, a, b)
}

#[tokio::test]
async fn s04_restore_old_version_creates_a_new_one_and_keeps_history() {
    let (remote, a, b) = three_versions().await;
    let v1 = sha_of(&a, 1).await;
    let mut rx = a.engine.subscribe();
    let st = a
        .engine
        .restore_version(PROJECT, v1.clone(), None)
        .await
        .unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(4), "a new number, not 1");
    assert_eq!(remote.tags(), vec!["v1", "v2", "v3", "v4"]);
    assert_eq!(remote.log_subjects()[0], "v4 — Ripristinata la versione 1");
    // identical content to v1 (tree equality), and the folder shows it
    assert_eq!(
        git(&remote.path, &["rev-parse", "v4^{tree}"]),
        git(&remote.path, &["rev-parse", "v1^{tree}"])
    );
    assert_eq!(a.read("X.ork"), ork("x1"));
    assert_eq!(a.read("Y.ork"), ork("y1"));
    assert!(
        !a.exists("Z.ork"),
        "files that did not exist in v1 are removed"
    );
    a.assert_clean();
    // history untouched: every old commit is still reachable, in order
    for t in ["v1", "v2", "v3"] {
        assert!(is_ancestor(&remote.path, t, "refs/heads/main"));
    }
    assert_eq!(
        git(&remote.path, &["rev-parse", "v3^{commit}"]),
        git(&remote.path, &["rev-parse", "main~1"])
    );
    let msg = git(&remote.path, &["log", "-1", "--format=%B", "main"]);
    assert!(
        msg.contains("Rocket-Sync-Kind: restore") && msg.contains("Rocket-Sync-Restored-From: 1"),
        "{msg}"
    );
    let vi = a
        .engine
        .get_version(PROJECT, sha_of(&a, 4).await)
        .await
        .unwrap();
    assert_eq!(vi.kind, VersionKind::Restore);
    assert_eq!(vi.restored_from, Some(1));
    assert!(drain(&mut rx)
        .iter()
        .any(|e| matches!(e, EngineEvent::VersionPublished { number: 4, .. })));
    b.sync().await;
    assert_eq!(b.read("X.ork"), ork("x1"));
    assert!(!b.exists("Z.ork"));
    b.assert_clean();
    assert_no_forbidden_commands(&a.engine);
}

#[tokio::test]
async fn s04_partial_restore_and_preconditions() {
    let (remote, a, _b) = three_versions().await;
    let v1 = sha_of(&a, 1).await;
    let st = a
        .engine
        .restore_version(
            PROJECT,
            v1.clone(),
            Some(vec!["X.ork".into(), "Z.ork".into()]),
        )
        .await
        .unwrap();
    assert_synced(&st);
    assert_eq!(a.read("X.ork"), ork("x1"));
    assert_eq!(a.read("Y.ork"), ork("y2"), "other files untouched");
    assert!(!a.exists("Z.ork"), "removed because it did not exist in v1");
    assert_eq!(
        remote.log_subjects()[0],
        "v4 — Ripristinati 2 file dalla versione 1"
    );
    let msg = git(&remote.path, &["log", "-1", "--format=%B", "main"]);
    assert!(
        msg.contains("Rocket-Sync-Restored-Paths: X.ork;Z.ork"),
        "{msg}"
    );

    // unpublished changes on an involved file: refused, nothing changes
    a.write_ork("Y.ork", "y-locale");
    let e = a
        .engine
        .restore_version(PROJECT, v1.clone(), None)
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::LocalChangesPresent, "{e}");
    assert_eq!(a.read("Y.ork"), ork("y-locale"));
    assert_eq!(remote.tags().len(), 4);
    // ... but changes on files that are not involved are fine
    let e = a
        .engine
        .restore_version(PROJECT, v1.clone(), Some(vec!["X.ork".into()]))
        .await
        .unwrap_err();
    assert_eq!(
        e.code(),
        ErrorCode::Internal,
        "already identical: invalid argument"
    );
    // unknown version / path
    assert_eq!(
        a.engine
            .restore_version(PROJECT, "deadbeef".into(), None)
            .await
            .unwrap_err()
            .code(),
        ErrorCode::NotFound
    );
    assert_eq!(
        a.engine
            .restore_version(PROJECT, v1, Some(vec!["Nope.ork".into()]))
            .await
            .unwrap_err()
            .code(),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn s04_restore_first_updates_the_project_and_respects_the_editor() {
    let (remote, a, b) = three_versions().await;
    b.sync().await;
    a.write_ork("W.ork", "w4");
    a.publish("v4").await.unwrap();
    // Bruno is behind by one version: restoring brings him up to date first
    let v1 = sha_of(&b, 1).await;
    let st = b
        .engine
        .restore_version(PROJECT, v1.clone(), Some(vec!["X.ork".into()]))
        .await
        .unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(5));
    assert_eq!(b.read("W.ork"), ork("w4"));
    assert_eq!(b.read("X.ork"), ork("x1"));
    assert_eq!(remote.tags().len(), 5);
    // the editor has the file open: refused
    b.detector.running_with(vec![b.path("Y.ork")]);
    let e = b
        .engine
        .restore_version(PROJECT, v1, Some(vec!["Y.ork".into()]))
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::BlockedByEditor);
    assert_eq!(b.read("Y.ork"), ork("y2"));
}

// ---- 7. crashes ----------------------------------------------------------------------------

#[tokio::test]
async fn s07_crash_in_the_middle_of_materialisation_is_completed_at_startup() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("A1.ork", "a1");
    a.write_ork("A2.ork", "a2");
    a.write_ork("A3.ork", "a3");
    a.publish("Tre file").await.unwrap();
    // Bruno has unpublished work on another file
    b.write_ork("Mio.ork", "lavoro-di-bruno");
    b.status().await;

    b.engine
        .failpoints()
        .set("materialize.after_first_write", FailAction::Crash);
    let e = b.engine.sync_now(PROJECT).await.unwrap_err();
    assert!(matches!(e, CoreError::InjectedCrash(_)), "{e}");
    // half way: some files written, HEAD not moved, journal not closed
    let written = ["A1.ork", "A2.ork", "A3.ork"]
        .iter()
        .filter(|f| b.exists(f))
        .count();
    assert_eq!(written, 1, "exactly one file was written before the crash");
    let unfinished = b.store().journal_unfinished(PROJECT).unwrap();
    assert_eq!(unfinished.len(), 1);
    assert_eq!(unfinished[0].step, "materializing");

    // the app starts again
    let b = b.restart().await;
    let mut rx = b.engine.subscribe();
    let reports = b.engine.start().await.unwrap();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert!(
        reports[0].summary.contains("interrotto a metà"),
        "{}",
        reports[0].summary
    );
    assert!(drain(&mut rx)
        .iter()
        .any(|e| matches!(e, EngineEvent::RecoveryPerformed { .. })));
    assert!(b.store().journal_unfinished(PROJECT).unwrap().is_empty());
    let j = b.engine.journal(PROJECT, 20).unwrap();
    assert!(j.iter().any(|e| e.outcome.as_deref() == Some("recovered")));

    for f in ["A1.ork", "A2.ork", "A3.ork"] {
        assert_eq!(b.read(f), ork(&f[..2].to_lowercase()), "{f}");
    }
    assert_eq!(
        b.read("Mio.ork"),
        ork("lavoro-di-bruno"),
        "unpublished work untouched"
    );
    let st = b.status().await;
    assert_eq!(st.head_version, Some(1));
    assert_eq!(st.behind_by, 0);
    assert_eq!(st.changed_files.len(), 1);
    assert_eq!(b.head(), remote.main_sha());
    assert_eq!(b.engine.startup_reports().len(), 1);
    // and the project keeps working
    let st = b.publish("Dopo il crash").await.unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(2));
}

#[tokio::test]
async fn s07_crash_before_the_ref_update_is_completed_too() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("A1.ork", "a1");
    a.publish("v1").await.unwrap();
    b.engine
        .failpoints()
        .set("materialize.before_ref_update", FailAction::Crash);
    assert!(b.engine.sync_now(PROJECT).await.is_err());
    assert_eq!(b.read("A1.ork"), ork("a1"), "file written, HEAD still old");
    let b = b.restart().await;
    let reports = b.engine.start().await.unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(b.head(), remote.main_sha());
    assert_synced(&b.status().await);
    b.assert_clean();
}

#[tokio::test]
async fn s07_recovery_never_overwrites_a_file_changed_after_the_crash() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("A1.ork", "a1");
    a.write_ork("A2.ork", "a2");
    a.publish("v1").await.unwrap();
    b.engine
        .failpoints()
        .set("materialize.after_first_write", FailAction::Crash);
    assert!(b.engine.sync_now(PROJECT).await.is_err());
    let missing = ["A1.ork", "A2.ork"]
        .into_iter()
        .find(|f| !b.exists(f))
        .unwrap();
    // before the app restarts the user creates the very file the update still had to write
    b.write(missing, &ork("creato-dall-utente"));
    let b = b.restart().await;
    let reports = b.engine.start().await.unwrap();
    assert!(
        reports[0].summary.contains("modificati nel frattempo"),
        "{}",
        reports[0].summary
    );
    assert_eq!(
        b.read(missing),
        ork("creato-dall-utente"),
        "never overwritten"
    );
    assert_ne!(b.head(), remote.main_sha(), "the old version stays active");
    // the engine does not hide the situation: the file is reported as a local change/conflict on the next sync
    let st = b.engine.sync_now(PROJECT).await;
    match st {
        Ok(st) => assert!(
            st.state == SyncState::Conflict
                || st.state == SyncState::LocalChanges
                || st.state == SyncState::UpdateAvailable,
            "{st:#?}"
        ),
        Err(e) => assert_eq!(e.code(), ErrorCode::LocalChangesPresent),
    }
    assert_eq!(b.read(missing), ork("creato-dall-utente"));
}

#[tokio::test]
async fn s07_crash_before_push_keeps_the_pending_version_and_sends_it_later() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.engine
        .failpoints()
        .set("send.before_push", FailAction::Crash);
    assert!(a.publish("Non inviata").await.is_err());
    assert!(remote.tags().is_empty());
    let a = a.restart().await;
    let reports = a.engine.start().await.unwrap();
    assert!(
        reports
            .iter()
            .any(|r| r.summary.contains("Invio interrotto")),
        "{reports:?}"
    );
    let st = a.status().await;
    assert_eq!(st.pending_versions.len(), 1);
    assert_eq!(st.pending_versions[0].title, "Non inviata");
    let st = a.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(remote.tags(), vec!["v1"]);
    assert_eq!(a.read("Razzo.ork"), ork("uno"));
}

#[tokio::test]
async fn s07_crash_after_push_does_not_duplicate_versions() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.engine
        .failpoints()
        .set("send.after_push", FailAction::Crash);
    assert!(a.publish("Inviata ma non registrata").await.is_err());
    assert_eq!(remote.tags(), vec!["v1"], "the push went through");
    let a = a.restart().await;
    let reports = a.engine.start().await.unwrap();
    assert!(
        reports
            .iter()
            .any(|r| r.summary.contains("Invio interrotto")),
        "{reports:?}"
    );
    // locally the version is still "pending": the next sync recognises it as already published
    let st = a.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(a.head(), remote.main_sha());
    assert_eq!(remote.tags(), vec!["v1"]);
    assert_eq!(
        remote.log_subjects().len(),
        2,
        "no duplicate commit on the server"
    );
    let versions = a.engine.list_versions(PROJECT, None, None).await.unwrap();
    assert_eq!(
        versions
            .iter()
            .filter(|v| v.title == "Inviata ma non registrata")
            .count(),
        1
    );
    a.assert_clean();
}

#[tokio::test]
async fn s07_crash_while_resolving_a_conflict_is_recovered() {
    let d = Duel::start().await;
    let id = d.conflict_at_push().await;
    d.b.engine
        .failpoints()
        .set("materialize.before_ref_update", FailAction::Crash);
    let r = vec![FileResolution {
        path: "Razzo.ork".into(),
        choice: ResolutionChoice::Theirs,
    }];
    assert!(d
        .b
        .engine
        .resolve_conflict(PROJECT, id.clone(), r)
        .await
        .is_err());
    assert_eq!(
        d.b.read("Razzo.ork"),
        ork("di-anna"),
        "file already written"
    );
    let b = d.b.restart().await;
    let reports = b.engine.start().await.unwrap();
    assert_eq!(reports.len(), 1);
    // the resolution commit is now HEAD and waits to be sent
    let st = b.status().await;
    assert!(st.open_conflict_ids.is_empty(), "{st:#?}");
    assert_eq!(st.pending_versions.len(), 1);
    let st = b.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(3));
    assert_eq!(d.remote.branches(), vec!["main"]);
    let c = b.engine.get_conflict(PROJECT, id).await.unwrap();
    assert_eq!(c.status, ConflictStatusDto::Resolved);
}

#[tokio::test]
async fn s07_startup_cleans_stale_locks_and_half_merges() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.publish("v1").await.unwrap();
    a.write_ork("Locale.ork", "non-pubblicato");

    let git_dir = a.path(".git");
    // an old lock and a fresh one
    let old_lock = git_dir.join("index.lock");
    std::fs::write(&old_lock, "").unwrap();
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(&old_lock)
        .unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600))
        .unwrap();
    drop(f);
    let fresh_lock = git_dir.join("HEAD.lock");
    std::fs::write(&fresh_lock, "").unwrap();
    // a half-done merge left by another tool
    std::fs::write(git_dir.join("MERGE_HEAD"), a.head()).unwrap();
    std::fs::create_dir_all(git_dir.join("rebase-merge")).unwrap();
    std::fs::write(git_dir.join("rebase-merge/head-name"), "x").unwrap();

    let a = a.restart().await;
    let reports = a.engine.start().await.unwrap();
    assert!(!old_lock.exists(), "old lock removed");
    assert!(
        fresh_lock.exists(),
        "a recent lock may belong to a running git: kept"
    );
    assert!(!git_dir.join("MERGE_HEAD").exists());
    assert!(!git_dir.join("rebase-merge").exists());
    assert!(
        reports.iter().any(|r| r.summary.contains("blocchi di Git")),
        "{reports:?}"
    );
    assert!(
        reports
            .iter()
            .any(|r| r.summary.contains("unione rimasto a metà")),
        "{reports:?}"
    );
    assert_eq!(
        a.read("Locale.ork"),
        ork("non-pubblicato"),
        "user files untouched"
    );
    std::fs::remove_file(&fresh_lock).unwrap();
    let st = a.publish("Dopo il recupero").await.unwrap();
    assert_synced(&st);
}

#[tokio::test]
async fn s07_recovery_is_idempotent() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let a = a.restart().await;
    assert!(a.engine.start().await.unwrap().is_empty());
    let a = a.restart().await;
    assert!(a.engine.start().await.unwrap().is_empty());
}

// ---- TOCTOU: a file saved between planning and writing ------------------------------------

#[tokio::test]
async fn materialize_rechecks_each_file_right_before_writing_it() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("X.ork", "x1");
    a.write_ork("Y.ork", "y1");
    a.publish("v1").await.unwrap();
    b.sync().await;
    a.write_ork("X.ork", "x2");
    a.write_ork("Y.ork", "y2");
    a.publish("v2").await.unwrap();

    // Bruno saves Y.ork after the plan was made and before the engine writes it
    let y = b.path("Y.ork");
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h2 = hits.clone();
    b.engine.failpoints().set(
        "materialize.before_write",
        FailAction::Callback(std::sync::Arc::new(move || {
            if h2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                std::fs::write(&y, ork("salvato-da-bruno")).unwrap();
            }
        })),
    );
    let e = b.engine.update_now(PROJECT, false).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::LocalChangesPresent, "{e}");
    assert!(
        matches!(&e, CoreError::LocalChangesPresent(p) if p == &vec!["Y.ork".to_string()]),
        "{e}"
    );
    assert_eq!(
        b.read("Y.ork"),
        ork("salvato-da-bruno"),
        "the user's save is never overwritten"
    );
    assert_eq!(
        b.read("X.ork"),
        ork("x1"),
        "what was already written has been rolled back"
    );
    assert_eq!(
        b.head(),
        git(&b.folder, &["rev-parse", "v1^{commit}"]),
        "HEAD did not move"
    );
    // nothing left half-way: the next update sees a normal overlap and opens a conflict
    b.engine.failpoints().clear_all();
    let st = b.sync().await;
    assert_eq!(st.state, SyncState::Conflict, "{st:#?}");
    assert_eq!(b.read("Y.ork"), ork("salvato-da-bruno"));
}
