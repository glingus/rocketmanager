//! Spec §12 scenarios 2 and 5: conflicts (detected at fetch and at push), their four resolutions,
//! and the stale-editor guard.

mod common;
use common::*;
use rs_core::*;

fn choice(path: &str, c: ResolutionChoice) -> Vec<FileResolution> {
    vec![FileResolution { path: path.into(), choice: c }]
}

fn parents(remote: &Remote, rev: &str) -> Vec<String> {
    git(&remote.path, &["rev-list", "--parents", "-n", "1", rev])
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect()
}

// ---- 2a. conflict found when publishing ----------------------------------------------------

#[tokio::test]
async fn s02a_conflict_at_push_keeps_everything_and_touches_nothing() {
    let d = Duel::start().await;
    let mut rx = d.b.engine.subscribe();
    let id = d.conflict_at_push().await;

    let st = d.b.status().await;
    assert_eq!(st.state, SyncState::Conflict);
    assert_eq!(st.pending_versions.len(), 1);
    assert_eq!(st.pending_versions[0].title, "Bruno");
    assert_eq!(st.pending_versions[0].waiting_reason, Some(WaitingReason::Conflict));
    assert!(st.auto_publish_at.is_none());
    // nothing changed on Bruno's disk
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"));
    d.b.assert_clean();

    let c = d.b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    assert_eq!(c.status, ConflictStatusDto::Open);
    assert_eq!(c.files.len(), 1);
    assert_eq!(c.files[0].path, "Razzo.ork");
    assert_eq!(c.files[0].kind, ConflictFileKind::BothModified);
    assert!(c.files[0].three_way.is_none());
    assert_eq!(c.theirs_version, Some(2));
    assert_eq!(c.theirs_author.as_deref(), Some("Anna"));
    assert!(c.remote_branch_pushed);
    assert_eq!(c.projectId_or(), PROJECT);
    assert!(id.len() == 15 && id.chars().nth(8) == Some('-'), "id format AAAAMMGG-xxxxxx: {id}");

    // both versions are recoverable from the server
    assert!(remote_branch_exists(&d.remote, &id));
    let on_branch = git_bytes(&d.remote.path, &["show", &format!("conflitti/{id}:Razzo.ork")]);
    assert_eq!(on_branch, ork("di-bruno"));
    let on_main = git_bytes(&d.remote.path, &["show", "refs/heads/main:Razzo.ork"]);
    assert_eq!(on_main, ork("di-anna"));
    assert_eq!(d.remote.tags(), vec!["v1", "v2"]);

    // sides can be read and exported (to open in OpenRocket) without touching the project
    let side = |s| d.b.engine.read_conflict_side(PROJECT, id.clone(), "Razzo.ork".into(), s);
    assert_eq!(side(ConflictSide::Base).await.unwrap().unwrap(), ork("base"));
    assert_eq!(side(ConflictSide::Ours).await.unwrap().unwrap(), ork("di-bruno"));
    assert_eq!(side(ConflictSide::Theirs).await.unwrap().unwrap(), ork("di-anna"));
    let copy = d.b.engine.export_conflict_copy(PROJECT, id.clone(), "Razzo.ork".into(), ConflictSide::Theirs).await.unwrap();
    assert!(copy.starts_with(d.b.path(".rocketsync/local/conflitti")));
    assert_eq!(std::fs::read(&copy).unwrap(), ork("di-anna"));
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"));

    // while the conflict is open: no publication, no update; fetch keeps working
    let e = d.b.publish("ancora").await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::ConflictOpen);
    let e = d.b.engine.update_now(PROJECT, false).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::ConflictOpen);
    let st = d.b.sync().await;
    assert_eq!(st.state, SyncState::Conflict);
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"));
    assert_eq!(d.remote.tags(), vec!["v1", "v2"]);

    // Anna has no conflict and nothing is wrong on her side
    assert_synced(&d.a.sync().await);

    let ev = drain(&mut rx);
    assert!(ev.iter().any(|e| matches!(e, EngineEvent::ConflictDetected { conflict_id, files, .. } if *conflict_id == id && files == &vec!["Razzo.ork".to_string()])), "{ev:?}");
    assert_no_forbidden_commands(&d.b.engine);
}

trait ProjectIdOr {
    fn projectId_or(&self) -> String;
}
impl ProjectIdOr for Conflict {
    fn projectId_or(&self) -> String {
        self.project_id.clone()
    }
}

fn remote_branch_exists(remote: &Remote, id: &str) -> bool {
    remote.has_ref(&format!("refs/heads/conflitti/{id}"))
}

// ---- 2b. conflict found at fetch time, without publishing ---------------------------------

#[tokio::test]
async fn s02b_conflict_at_fetch_without_publishing() {
    let d = Duel::start().await;
    d.a.write_ork("Razzo.ork", "di-anna");
    d.b.write_ork("Razzo.ork", "di-bruno");
    d.a.publish("Anna").await.unwrap();

    // Bruno did not publish anything: the engine notices the overlap by itself
    let st = d.b.sync().await;
    assert_eq!(st.state, SyncState::Conflict, "{st:#?}");
    let id = st.open_conflict_ids[0].clone();
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"), "disk untouched");
    // his unpublished changes were saved as a pending version
    assert_eq!(st.pending_versions.len(), 1);
    assert_eq!(st.pending_versions[0].title, "Modifiche locali in conflitto");
    assert!(st.changed_files.is_empty());
    let on_branch = git_bytes(&d.remote.path, &["show", &format!("conflitti/{id}:Razzo.ork")]);
    assert_eq!(on_branch, ork("di-bruno"));
    assert_eq!(d.remote.tags(), vec!["v1", "v2"], "nothing was published");

    // and a safety copy of the folder exists
    let snaps = d.b.engine.list_snapshots(PROJECT).await.unwrap();
    assert!(snaps.iter().any(|s| s.operation == "conflitto"), "{snaps:?}");
}

#[tokio::test]
async fn conflict_branch_is_pushed_later_when_offline() {
    let d = Duel::start().await;
    d.a.write_ork("Razzo.ork", "di-anna");
    d.a.publish("Anna").await.unwrap();
    d.b.write_ork("Razzo.ork", "di-bruno");
    // fetch works, then the network drops exactly when the branch is pushed
    let remote_path = d.remote.path.clone();
    let away = d.remote.root.path().join("away.git");
    let (rp, aw) = (remote_path.clone(), away.clone());
    d.b.engine.failpoints().set(
        "conflict.before_branch_push",
        FailAction::Callback(std::sync::Arc::new(move || {
            std::fs::rename(&rp, &aw).unwrap();
        })),
    );
    let st = d.b.sync().await;
    assert_eq!(st.state, SyncState::Conflict);
    let id = st.open_conflict_ids[0].clone();
    let c = d.b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    assert!(!c.remote_branch_pushed);
    std::fs::rename(&away, &remote_path).unwrap();
    d.b.engine.failpoints().clear_all();
    d.b.sync().await; // fetch continues and the branch is retried at the next background pass
    // the background loop is off in tests: trigger the retry through the public tick path
    let b = d.b.restart().await;
    b.engine.start().await.unwrap();
    let st = b.engine.sync_now(PROJECT).await.unwrap();
    assert_eq!(st.state, SyncState::Conflict);
    // `sync_now` does not retry; the periodic loop does. Run it with a background engine:
    let c = b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    if !c.remote_branch_pushed {
        // retry path used by the background loop
        let mut cfg = test_config(&b.data_dir, b.detector.clone());
        cfg.background = true;
        cfg.timing.fetch_interval = std::time::Duration::from_millis(50);
        b.engine.shutdown().await;
        let e2 = Engine::open(cfg).await.unwrap();
        e2.set_identity(Some(Identity { name: "Bruno".into(), email: "1+bruno@users.noreply.github.com".into() }));
        for _ in 0..100 {
            if e2.get_conflict(PROJECT, id.clone()).await.unwrap().remote_branch_pushed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(e2.get_conflict(PROJECT, id.clone()).await.unwrap().remote_branch_pushed);
    }
    assert!(remote_branch_exists(&d.remote, &id));
}

// ---- 2c. the four resolutions --------------------------------------------------------------

async fn resolved_duel(c: ResolutionChoice) -> (Duel, String, ProjectStatus) {
    let d = Duel::start().await;
    let id = d.conflict_at_push().await;
    if c == ResolutionChoice::Manual {
        d.b.write_ork("Razzo.ork", "unione-manuale");
    }
    let mut rx = d.b.engine.subscribe();
    let st = d
        .b
        .engine
        .resolve_conflict(PROJECT, id.clone(), choice("Razzo.ork", c))
        .await
        .unwrap();
    // common checks of every resolution
    assert_synced(&st);
    assert_eq!(st.head_version, Some(3));
    assert_eq!(d.remote.tags(), vec!["v1", "v2", "v3"]);
    let tip = "refs/heads/main";
    let ps = parents(&d.remote, tip);
    assert_eq!(ps.len(), 2, "merge commit with two parents");
    assert_eq!(ps[0], git(&d.remote.path, &["rev-parse", "v2^{commit}"]), "first parent is the colleague's v2");
    assert!(is_ancestor(&d.remote.path, "v1", tip) && is_ancestor(&d.remote.path, "v2", tip));
    assert!(is_ancestor(&d.remote.path, &ps[1], tip), "Bruno's own line of work is in the history");
    assert_eq!(git(&d.remote.path, &["log", "-1", "--format=%s", &ps[1]]), "v? — Bruno");
    let subjects = d.remote.log_subjects();
    assert_eq!(
        subjects,
        vec![
            "v3 — Risolto il conflitto su Razzo.ork".to_string(),
            "v2 — Anna".to_string(),
            "v1 — Base".to_string(),
            "v0 — Progetto creato".to_string()
        ]
    );
    let msg = git(&d.remote.path, &["log", "-1", "--format=%B", tip]);
    assert!(msg.contains("Rocket-Sync-Kind: conflict-resolution"), "{msg}");
    assert!(msg.contains(&format!("Rocket-Sync-Conflict: {id}")), "{msg}");
    assert!(msg.contains(&format!("Rocket-Sync-Resolution: Razzo.ork={}", match c {
        ResolutionChoice::Mine => "mine",
        ResolutionChoice::Theirs => "theirs",
        ResolutionChoice::Both => "both",
        ResolutionChoice::Manual => "manual",
    })), "{msg}");
    assert!(msg.contains("Rocket-Sync-Version: 3"), "{msg}");
    assert_eq!(d.remote.branches(), vec!["main"], "the safety branch is removed after sending");
    let conflicts = d.b.engine.list_conflicts(PROJECT, true).await.unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].status, ConflictStatusDto::Resolved);
    assert!(d.b.engine.list_conflicts(PROJECT, false).await.unwrap().is_empty());
    let ev = drain(&mut rx);
    assert!(ev.iter().any(|e| matches!(e, EngineEvent::ConflictResolved { number: Some(3), conflict_id, .. } if *conflict_id == id)), "{ev:?}");
    assert!(ev.iter().any(|e| matches!(e, EngineEvent::VersionPublished { number: 3, .. })));
    let versions = d.b.engine.list_versions(PROJECT, Some(1), None).await.unwrap();
    assert_eq!(versions[0].kind, VersionKind::ConflictResolution);
    assert_eq!(versions[0].conflict_id.as_deref(), Some(id.as_str()));
    d.b.assert_clean();
    assert_no_forbidden_commands(&d.b.engine);
    // Anna receives exactly the same final state
    let sa = d.a.sync().await;
    assert_synced(&sa);
    assert_eq!(d.a.head(), d.b.head());
    (d, id, st)
}

#[tokio::test]
async fn s02c_resolve_mine() {
    let (d, _id, _) = resolved_duel(ResolutionChoice::Mine).await;
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"));
    assert_eq!(d.a.read("Razzo.ork"), ork("di-bruno"));
}

#[tokio::test]
async fn s02c_resolve_theirs() {
    let (d, _id, _) = resolved_duel(ResolutionChoice::Theirs).await;
    assert_eq!(d.b.read("Razzo.ork"), ork("di-anna"));
    assert_eq!(d.a.read("Razzo.ork"), ork("di-anna"));
    // Bruno's work is not lost: it stays in the history and in a safety copy
    let second_parent = git(&d.remote.path, &["rev-parse", "refs/heads/main^2"]);
    assert_eq!(git_bytes(&d.remote.path, &["show", &format!("{second_parent}:Razzo.ork")]), ork("di-bruno"));
    let snaps = d.b.engine.list_snapshots(PROJECT).await.unwrap();
    assert!(snaps.iter().any(|s| s.operation == "risoluzione"), "{snaps:?}");
}

#[tokio::test]
async fn s02c_resolve_both_keeps_two_files() {
    let (d, _id, _) = resolved_duel(ResolutionChoice::Both).await;
    assert_eq!(d.b.read("Razzo.ork"), ork("di-anna"));
    let names: Vec<String> = std::fs::read_dir(&d.b.folder).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let mine = names.iter().find(|n| n.starts_with("Razzo - versione Bruno ") && n.ends_with(".ork")).unwrap_or_else(|| panic!("{names:?}"));
    assert_eq!(d.b.read(mine), ork("di-bruno"));
    // Anna gets both as well
    assert_eq!(d.a.read("Razzo.ork"), ork("di-anna"));
    assert_eq!(d.a.read(mine), ork("di-bruno"));
}

#[tokio::test]
async fn s02c_resolve_manual() {
    let (d, _id, _) = resolved_duel(ResolutionChoice::Manual).await;
    assert_eq!(d.b.read("Razzo.ork"), ork("unione-manuale"));
    assert_eq!(d.a.read("Razzo.ork"), ork("unione-manuale"));
    assert_eq!(git_bytes(&d.remote.path, &["show", "refs/heads/main:Razzo.ork"]), ork("unione-manuale"));
}

#[tokio::test]
async fn manual_resolution_requires_a_valid_stable_file() {
    let d = Duel::start().await;
    let id = d.conflict_at_push().await;
    let before = d.b.head();
    d.b.write("Razzo.ork", &partial_ork("a-meta"));
    let e = d
        .b
        .engine
        .resolve_conflict(PROJECT, id.clone(), choice("Razzo.ork", ResolutionChoice::Manual))
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::FileInvalid, "{e}");
    assert_eq!(d.b.head(), before, "nothing was committed");
    assert_eq!(d.b.status().await.open_conflict_ids, vec![id.clone()]);
    // wrong requests are rejected without side effects
    let e = d.b.engine.resolve_conflict(PROJECT, id.clone(), vec![]).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::Internal);
    let e = d.b.engine.resolve_conflict(PROJECT, id.clone(), choice("Altro.ork", ResolutionChoice::Mine)).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::InvalidPath);
    // once the file is complete it works
    d.b.write_ork("Razzo.ork", "finito");
    let st = d.b.engine.resolve_conflict(PROJECT, id, choice("Razzo.ork", ResolutionChoice::Manual)).await.unwrap();
    assert_synced(&st);
}

#[tokio::test]
async fn resolving_waits_for_a_closed_editor() {
    let d = Duel::start().await;
    let id = d.conflict_at_push().await;
    d.b.detector.running_with(vec![d.b.path("Razzo.ork")]);
    let before_disk = d.b.read("Razzo.ork");
    // choosing "theirs" would overwrite the file Bruno has open
    let e = d.b.engine.resolve_conflict(PROJECT, id.clone(), choice("Razzo.ork", ResolutionChoice::Theirs)).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::BlockedByEditor);
    assert_eq!(d.b.read("Razzo.ork"), before_disk);
    // "mine" does not write anything: allowed
    let st = d.b.engine.resolve_conflict(PROJECT, id, choice("Razzo.ork", ResolutionChoice::Mine)).await.unwrap();
    assert_synced(&st);
}

// ---- other kinds of conflicts and non-conflicts -------------------------------------------

#[tokio::test]
async fn modified_vs_deleted_and_deleted_vs_modified() {
    // Anna deletes, Bruno modifies
    let d = Duel::start().await;
    std::fs::remove_file(d.a.path("Razzo.ork")).unwrap();
    d.a.publish("Anna cancella").await.unwrap();
    d.b.write_ork("Razzo.ork", "di-bruno");
    let st = d.b.publish("Bruno modifica").await.unwrap();
    let id = st.open_conflict_ids[0].clone();
    let c = d.b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    assert_eq!(c.files[0].kind, ConflictFileKind::ModifiedDeleted);
    let st = d.b.engine.resolve_conflict(PROJECT, id, choice("Razzo.ork", ResolutionChoice::Theirs)).await.unwrap();
    assert_synced(&st);
    assert!(!d.b.exists("Razzo.ork"), "the deletion won");
    assert!(!git(&d.remote.path, &["ls-tree", "-r", "--name-only", "refs/heads/main"]).contains("Razzo.ork"));

    // Anna modifies, Bruno deletes; Bruno keeps Anna's file
    let d = Duel::start().await;
    d.a.write_ork("Razzo.ork", "di-anna");
    d.a.publish("Anna modifica").await.unwrap();
    std::fs::remove_file(d.b.path("Razzo.ork")).unwrap();
    let st = d.b.publish("Bruno cancella").await.unwrap();
    let id = st.open_conflict_ids[0].clone();
    let c = d.b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    assert_eq!(c.files[0].kind, ConflictFileKind::DeletedModified);
    let st = d.b.engine.resolve_conflict(PROJECT, id, choice("Razzo.ork", ResolutionChoice::Theirs)).await.unwrap();
    assert_synced(&st);
    assert_eq!(d.b.read("Razzo.ork"), ork("di-anna"), "the file is back");
}

#[tokio::test]
async fn added_by_both_with_different_content_is_a_conflict() {
    let d = Duel::start().await;
    d.a.write_ork("Nuovo.ork", "anna");
    d.b.write_ork("Nuovo.ork", "bruno");
    d.a.publish("Anna").await.unwrap();
    let st = d.b.publish("Bruno").await.unwrap();
    assert_eq!(st.state, SyncState::Conflict);
    let c = d.b.engine.get_conflict(PROJECT, st.open_conflict_ids[0].clone()).await.unwrap();
    assert_eq!(c.files[0].kind, ConflictFileKind::BothAdded);
    assert_eq!(d.b.read("Nuovo.ork"), ork("bruno"));
}

#[tokio::test]
async fn identical_changes_and_clean_text_merges_are_not_conflicts() {
    let d = Duel::start().await;
    d.a.write("Note.txt", b"1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    d.a.publish("Note").await.unwrap();
    d.b.sync().await;

    // identical new content on both sides
    d.a.write_ork("Stesso.ork", "uguale");
    d.b.write_ork("Stesso.ork", "uguale");
    // text edited in different places
    d.a.write("Note.txt", b"UNO\n2\n3\n4\n5\n6\n7\n8\n9\n");
    d.b.write("Note.txt", b"1\n2\n3\n4\n5\n6\n7\n8\nNOVE\n");
    d.a.publish("Anna").await.unwrap();
    let st = d.b.publish("Bruno").await.unwrap();
    assert_eq!(st.state, SyncState::Synced, "{st:#?}");
    assert!(st.open_conflict_ids.is_empty());
    let merged = d.b.read("Note.txt");
    assert_eq!(merged, b"UNO\n2\n3\n4\n5\n6\n7\n8\nNOVE\n");
    assert_eq!(d.b.read("Stesso.ork"), ork("uguale"));
    d.b.assert_clean();
    d.a.sync().await;
    assert_eq!(d.a.read("Note.txt"), merged);
    assert_eq!(d.a.head(), d.b.head());
    assert_eq!(d.remote.branches(), vec!["main"]);
}

#[tokio::test]
async fn resolution_made_offline_is_sent_later_with_a_new_number() {
    let d = Duel::start().await;
    let id = d.conflict_at_push().await;
    d.remote.go_offline();
    let st = d.b.engine.resolve_conflict(PROJECT, id.clone(), choice("Razzo.ork", ResolutionChoice::Mine)).await.unwrap();
    assert_eq!(st.state, SyncState::Offline, "{st:#?}");
    assert_eq!(st.pending_versions.len(), 1);
    assert!(st.open_conflict_ids.is_empty(), "the user is done");
    d.remote.go_online();
    // meanwhile a colleague published something else
    d.remote.push_as_colleague(&[("Altro.ork", &ork("altro"))], 3, "Altro");
    let mut rx = d.b.engine.subscribe();
    let st = d.b.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(4));
    assert_eq!(d.remote.tags(), vec!["v1", "v2", "v3", "v4"]);
    assert_eq!(d.remote.log_subjects()[0], "v4 — Risolto il conflitto su Razzo.ork");
    assert_eq!(parents(&d.remote, "refs/heads/main").len(), 2);
    assert_eq!(d.remote.branches(), vec!["main"]);
    let ev = drain(&mut rx);
    assert!(ev.iter().any(|e| matches!(e, EngineEvent::ConflictResolved { number: Some(4), .. })), "{ev:?}");
    assert_eq!(d.b.read("Altro.ork"), ork("altro"));
    assert_eq!(d.b.read("Razzo.ork"), ork("di-bruno"));
}

// ---- 5. editor guard -----------------------------------------------------------------------

async fn guard_setup() -> (Remote, User, User) {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.publish("v1").await.unwrap();
    b.sync().await;
    b.detector.running_with(vec![b.path("Razzo.ork")]);
    a.write_ork("Razzo.ork", "due");
    a.publish("v2").await.unwrap();
    (remote, a, b)
}

#[tokio::test]
async fn s05_update_is_blocked_by_an_open_file_and_nothing_is_touched() {
    let (_remote, _a, b) = guard_setup().await;
    let st = b.sync().await;
    assert_eq!(st.state, SyncState::UpdateAvailable);
    assert_eq!(st.behind_by, 1);
    assert_eq!(st.blocked_by_editor, vec!["Razzo.ork".to_string()]);
    assert_eq!(b.read("Razzo.ork"), ork("uno"), "the open file is not touched");
    let st = b.engine.update_now(PROJECT, false).await.unwrap();
    assert_eq!(st.state, SyncState::UpdateAvailable);
    assert_eq!(b.read("Razzo.ork"), ork("uno"));
    b.assert_clean();

    // unknown open files block everything too
    b.detector.running_unknown();
    let st = b.sync().await;
    assert_eq!(st.blocked_by_editor, vec!["Razzo.ork".to_string()]);
    assert_eq!(b.read("Razzo.ork"), ork("uno"));

    // OpenRocket closed: the update is applied by itself
    b.detector.not_running();
    let st = b.sync().await;
    assert_synced(&st);
    assert_eq!(b.read("Razzo.ork"), ork("due"));
}

#[tokio::test]
async fn s05_forced_update_then_stale_save_becomes_a_conflict_not_an_overwrite() {
    let (remote, _a, b) = guard_setup().await;
    let mut rx = b.engine.subscribe();
    // forced update: the file is written and the guard is armed
    let st = b.engine.update_now(PROJECT, true).await.unwrap();
    assert_synced(&st);
    assert_eq!(b.read("Razzo.ork"), ork("due"));
    assert_eq!(b.store().list_watches(PROJECT).unwrap().len(), 1);
    assert!(st.stale_save_suspected.is_empty());

    // OpenRocket still shows the old file; the user edits and saves it -> same path, old base
    b.write_ork("Razzo.ork", "uno-con-modifiche-di-bruno");
    let st = b.wait_status(5, |s| !s.stale_save_suspected.is_empty()).await;
    assert_eq!(st.stale_save_suspected, vec!["Razzo.ork".to_string()]);
    assert!(drain(&mut rx).iter().any(|e| matches!(e, EngineEvent::StaleSaveSuspected { path, .. } if path == "Razzo.ork")));
    // it cannot be published until the user answers
    let e = b.publish("subito").await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::ConflictOpen);
    assert!(e.to_app_error().message.contains("salvataggio sospetto"));
    assert_eq!(remote.tags(), vec!["v1", "v2"]);

    // "No / non so" -> a conflict (base = version before the update, theirs = what we wrote)
    let st = b.engine.answer_stale_save(PROJECT, "Razzo.ork".into(), false).await.unwrap();
    assert_eq!(st.state, SyncState::Conflict, "{st:#?}");
    assert!(st.stale_save_suspected.is_empty());
    assert_eq!(b.read("Razzo.ork"), ork("uno-con-modifiche-di-bruno"), "the saved file is not overwritten");
    let id = st.open_conflict_ids[0].clone();
    let c = b.engine.get_conflict(PROJECT, id.clone()).await.unwrap();
    assert_eq!(c.files[0].kind, ConflictFileKind::BothModified);
    assert_eq!(c.theirs_version, Some(2));
    let side = |s| b.engine.read_conflict_side(PROJECT, id.clone(), "Razzo.ork".into(), s);
    assert_eq!(side(ConflictSide::Base).await.unwrap().unwrap(), ork("uno"));
    assert_eq!(side(ConflictSide::Theirs).await.unwrap().unwrap(), ork("due"));
    assert_eq!(side(ConflictSide::Ours).await.unwrap().unwrap(), ork("uno-con-modifiche-di-bruno"));
    assert!(c.remote_branch_pushed);
    assert_eq!(
        git_bytes(&remote.path, &["show", &format!("conflitti/{id}:Razzo.ork")]),
        ork("uno-con-modifiche-di-bruno")
    );

    // resolution works like any other
    b.detector.not_running();
    let st = b.engine.resolve_conflict(PROJECT, id, choice("Razzo.ork", ResolutionChoice::Mine)).await.unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(3));
    assert_eq!(parents(&remote, "refs/heads/main").len(), 2);
    assert_eq!(git_bytes(&remote.path, &["show", "refs/heads/main:Razzo.ork"]), ork("uno-con-modifiche-di-bruno"));
    assert_eq!(remote.branches(), vec!["main"]);
}

#[tokio::test]
async fn s05_user_confirms_he_reopened_the_file() {
    let (remote, _a, b) = guard_setup().await;
    b.engine.update_now(PROJECT, true).await.unwrap();
    b.write_ork("Razzo.ork", "dopo-riapertura");
    b.wait_status(5, |s| !s.stale_save_suspected.is_empty()).await;
    let st = b.engine.answer_stale_save(PROJECT, "Razzo.ork".into(), true).await.unwrap();
    assert!(st.stale_save_suspected.is_empty());
    assert_eq!(st.state, SyncState::LocalChanges);
    assert!(b.store().list_watches(PROJECT).unwrap().is_empty());
    let st = b.publish("Dopo la riapertura").await.unwrap();
    assert_synced(&st);
    assert_eq!(remote.tags(), vec!["v1", "v2", "v3"]);
    // answering when nothing is suspected is an error
    let e = b.engine.answer_stale_save(PROJECT, "Razzo.ork".into(), true).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::NotFound);
}

#[tokio::test]
async fn s05_guard_closes_by_itself_when_the_editor_is_closed() {
    let (_remote, _a, b) = guard_setup().await;
    b.engine.update_now(PROJECT, true).await.unwrap();
    assert_eq!(b.store().list_watches(PROJECT).unwrap().len(), 1);
    // OpenRocket is closed without saving: the surveillance ends
    b.detector.not_running();
    b.status().await;
    assert!(b.store().list_watches(PROJECT).unwrap().is_empty());
    // a later save is just a normal change
    b.write_ork("Razzo.ork", "modifica-normale");
    let st = b.wait_status(5, |s| s.changed_files.len() == 1 && s.changed_files[0].valid.is_some()).await;
    assert!(st.stale_save_suspected.is_empty());
    assert_eq!(st.state, SyncState::LocalChanges);
}

#[tokio::test]
async fn s05_saving_right_before_closing_the_editor_is_still_detected() {
    let (_remote, _a, b) = guard_setup().await;
    b.engine.update_now(PROJECT, true).await.unwrap();
    b.write_ork("Razzo.ork", "salvato-poi-chiuso");
    // the user saves and closes OpenRocket before the engine looked at the file
    b.detector.not_running();
    let st = b.wait_status(5, |s| !s.stale_save_suspected.is_empty()).await;
    assert_eq!(st.stale_save_suspected, vec!["Razzo.ork".to_string()]);
}

#[tokio::test]
async fn guard_is_armed_when_files_are_unknown_and_for_restores() {
    let (_remote, _a, b) = guard_setup().await;
    b.detector.running_unknown();
    b.engine.update_now(PROJECT, true).await.unwrap();
    assert_eq!(b.store().list_watches(PROJECT).unwrap().len(), 1);
}
