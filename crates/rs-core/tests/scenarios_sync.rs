//! Spec §12 scenarios 1, 3, 6, 8, 9, 10 plus policy, watcher and linking behaviours.

mod common;
use common::*;
use rs_core::*;
use std::sync::Arc;
use std::time::Duration;

fn version_numbers(v: &[VersionInfo]) -> Vec<Option<i64>> {
    v.iter().map(|x| x.number).collect()
}

// ---- 1. A publishes, B receives; B publishes, A receives -----------------------------------

#[tokio::test]
async fn s01_publish_receive_and_back() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    let mut rx_a = a.engine.subscribe();
    let mut rx_b = b.engine.subscribe();

    a.write_ork("Razzo.ork", "uno");
    a.write("note/Appunti.txt", b"prime note\n");
    let st = a
        .engine
        .publish(
            PROJECT,
            PublishRequest {
                title: Some("Primo razzo".into()),
                description: Some("Prima bozza del razzo".into()),
                paths: None,
            },
        )
        .await
        .unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(st.remote_version, Some(1));
    assert!(st.last_publish_at.is_some());
    assert_eq!(remote.tags(), vec!["v1"]);
    assert_eq!(remote.log_subjects()[0], "v1 — Primo razzo");
    a.assert_clean();

    // commit message and identity as in the spec
    let msg = remote_message(&remote, "refs/heads/main");
    assert!(
        msg.starts_with("v1 — Primo razzo\n\nPrima bozza del razzo\n"),
        "{msg}"
    );
    assert!(msg.contains("Razzo.ork\n• Aggiunto Razzo.ork"), "{msg}");
    assert!(
        msg.contains("note/Appunti.txt\n• Aggiunto note/Appunti.txt"),
        "{msg}"
    );
    assert!(
        msg.contains(
            "\nRocket-Sync-Version: 1\nRocket-Sync-Kind: publish\nRocket-Sync-Client: 0.0.0-test"
        ),
        "{msg}"
    );
    let author = git(
        &remote.path,
        &[
            "log",
            "-1",
            "--format=%an <%ae> / %cn <%ce>",
            "refs/heads/main",
        ],
    );
    assert_eq!(
        author,
        "Anna <1+anna@users.noreply.github.com> / Anna <1+anna@users.noreply.github.com>"
    );

    let ev_a = drain(&mut rx_a);
    assert!(ev_a.iter().any(|e| matches!(e, EngineEvent::VersionPublished { number: 1, title, .. } if title == "Primo razzo")), "{ev_a:?}");
    assert!(ev_a
        .iter()
        .any(|e| matches!(e, EngineEvent::StatusChanged(_))));

    // B receives
    let st = b.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(b.read("Razzo.ork"), ork("uno"));
    assert_eq!(b.read("note/Appunti.txt"), b"prime note\n");
    b.assert_clean();
    let ev_b = drain(&mut rx_b);
    let upd = ev_b.iter().find_map(|e| match e {
        EngineEvent::UpdateApplied {
            from_version,
            to_version,
            files,
            ..
        } => Some((*from_version, *to_version, files.clone())),
        _ => None,
    });
    let (from, to, files) = upd.expect("UpdateApplied");
    assert_eq!((from, to), (Some(0), Some(1)));
    assert!(files.contains(&"Razzo.ork".to_string()));

    // B edits and publishes; A receives
    b.write_ork("Razzo.ork", "due");
    let st = b.publish("Pinne più grandi").await.unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(2));
    assert_eq!(remote.tags(), vec!["v1", "v2"]);
    let st = a.sync().await;
    assert_synced(&st);
    assert_eq!(st.head_version, Some(2));
    assert_eq!(a.read("Razzo.ork"), ork("due"));
    a.assert_clean();

    // the history shows both, newest first, with authors and changelog
    let versions = a.engine.list_versions(PROJECT, None, None).await.unwrap();
    assert_eq!(version_numbers(&versions), vec![Some(2), Some(1), Some(0)]);
    assert_eq!(versions[0].author.github_login.as_deref(), Some("bruno"));
    assert_eq!(versions[0].kind, VersionKind::Publish);
    assert_eq!(versions[0].changelog[0].path, "Razzo.ork");
    assert!(versions[0].changelog[0].interpreted);
    assert_eq!(
        versions[1].description.as_deref(),
        Some("Prima bozza del razzo")
    );
    assert_eq!(versions[2].kind, VersionKind::Init);
    assert!(versions.iter().all(|v| v.published));

    assert_no_forbidden_commands(&a.engine);
    assert_no_forbidden_commands(&b.engine);
}

fn remote_message(remote: &Remote, rev: &str) -> String {
    git(&remote.path, &["log", "-1", "--format=%B", rev])
}

// ---- 3. different files at the same time ---------------------------------------------------

#[tokio::test]
async fn s03_different_files_concurrently_no_conflict() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("Alfa.ork", "alfa");
    b.write_ork("Beta.ork", "beta");

    let (ra, rb) = tokio::join!(a.publish("Alfa"), b.publish("Beta"));
    let (ra, rb) = (ra.unwrap(), rb.unwrap());
    assert_synced(&ra);
    assert_synced(&rb);
    assert_eq!(
        remote.tags(),
        vec!["v1", "v2"],
        "consecutive and unique numbers"
    );
    let mut nums: Vec<Option<i64>> = vec![ra.head_version, rb.head_version];
    nums.sort();
    assert_eq!(nums[1], Some(2));

    let (sa, sb) = (a.sync().await, b.sync().await);
    assert_synced(&sa);
    assert_synced(&sb);
    for u in [&a, &b] {
        assert_eq!(u.read("Alfa.ork"), ork("alfa"));
        assert_eq!(u.read("Beta.ork"), ork("beta"));
        u.assert_clean();
        assert_eq!(u.status().await.head_version, Some(2));
    }
    assert_eq!(a.head(), b.head());
    // no conflict branch was ever created
    assert_eq!(remote.branches(), vec!["main"]);
    let subjects = remote.log_subjects();
    assert_eq!(subjects.len(), 3);
    assert!(subjects[0].starts_with("v2 — ") && subjects[1].starts_with("v1 — "));
}

#[tokio::test]
async fn s03b_push_rejected_is_retried_with_new_number() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Mio.ork", "mio");
    // A colleague publishes (with plain git) exactly between our fetch and our push.
    let r = Arc::new(Remote {
        root: tempfile::tempdir().unwrap(),
        path: remote.path.clone(),
        url: remote.url.clone(),
    });
    let r2 = r.clone();
    a.engine.failpoints().set(
        "send.before_push",
        FailAction::Callback(Arc::new({
            let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
            move || {
                if !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    r2.push_as_colleague(&[("Loro.ork", &ork("loro"))], 1, "Del collega");
                }
            }
        })),
    );
    let st = a.publish("Mio").await.unwrap();
    assert_synced(&st);
    assert_eq!(
        st.head_version,
        Some(2),
        "renumbered after the rejected push"
    );
    assert_eq!(remote.tags(), vec!["v1", "v2"]);
    assert_eq!(remote.log_subjects()[0], "v2 — Mio");
    assert_eq!(
        a.read("Loro.ork"),
        ork("loro"),
        "colleague's file materialised"
    );
    a.assert_clean();
    drop(r);
}

// ---- 6. offline ----------------------------------------------------------------------------

#[tokio::test]
async fn s06_offline_publish_then_online_renumbers() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    remote.go_offline();

    a.write_ork("Offline.ork", "mio");
    let st = a.publish("Lavoro offline").await.unwrap();
    assert_eq!(st.state, SyncState::Offline, "{st:#?}");
    assert_eq!(st.pending_versions.len(), 1);
    assert_eq!(st.pending_versions[0].title, "Lavoro offline");
    assert_eq!(
        st.pending_versions[0].waiting_reason,
        Some(WaitingReason::Offline)
    );
    assert!(
        st.changed_files.is_empty(),
        "the change is already a (pending) version"
    );
    let msg = a.git(&["log", "-1", "--format=%B", "refs/heads/main"]);
    assert!(msg.starts_with("v? — Lavoro offline"), "{msg}");
    assert!(msg.contains("Rocket-Sync-Version: pending"));
    let versions = a.engine.list_versions(PROJECT, None, None).await.unwrap();
    assert_eq!(versions[0].number, None);
    assert!(!versions[0].published);

    // meanwhile a colleague publishes v1 and the server comes back
    remote.go_online();
    remote.push_as_colleague(&[("Loro.ork", &ork("loro"))], 1, "Del collega");

    let st = a.sync().await;
    assert_synced(&st);
    assert_eq!(
        st.head_version,
        Some(2),
        "number recomputed from the server"
    );
    assert_eq!(remote.tags(), vec!["v1", "v2"]);
    assert_eq!(remote.log_subjects()[0], "v2 — Lavoro offline");
    assert_eq!(a.read("Loro.ork"), ork("loro"));
    let msg = remote_message(&remote, "refs/heads/main");
    assert!(msg.contains("Rocket-Sync-Version: 2\n"), "{msg}");
    a.assert_clean();
}

#[tokio::test]
async fn s06b_offline_fetch_keeps_state_and_recovers() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    remote.go_offline();
    let st = a.sync().await; // fetch fails with a network error: not an error state
    assert_eq!(st.state, SyncState::Synced);
    let e = a.engine.update_now(PROJECT, false).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::Network);
    assert!(e.to_app_error().retryable);
    remote.go_online();
    assert_synced(&a.sync().await);
}

// ---- 8. independent projects ---------------------------------------------------------------

#[tokio::test]
async fn s08_two_projects_do_not_interfere() {
    let r1 = Remote::new();
    let r2 = Remote::new();
    let u = User::unlinked("Anna").await;
    let f1 = u.folder.parent().unwrap().join("uno");
    let f2 = u.folder.parent().unwrap().join("due");
    for (id, r, f) in [("p-uno", &r1, &f1), ("p-due", &r2, &f2)] {
        u.engine
            .link_project(LinkRequest {
                project_id: id.into(),
                repo_full_name: format!("team/{id}"),
                remote_url: Some(r.url.clone()),
                folder: f.to_string_lossy().into_owned(),
                allow_synced_drive: false,
            })
            .await
            .unwrap();
    }
    assert_eq!(u.engine.list_projects().unwrap().len(), 2);
    std::fs::write(f1.join("A.ork"), ork("a")).unwrap();
    std::fs::write(f2.join("B.ork"), ork("b")).unwrap();

    // publish only in the first one
    let st1 = u
        .engine
        .publish(
            "p-uno",
            PublishRequest {
                title: Some("Solo uno".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let st2 = u.engine.status("p-due").await.unwrap();
    assert_eq!(st1.state, SyncState::Synced);
    assert_eq!(st2.state, SyncState::LocalChanges);
    assert_eq!(st2.changed_files.len(), 1);
    assert_eq!(r1.tags(), vec!["v1"]);
    assert!(r2.tags().is_empty());
    assert_eq!(r2.log_subjects().len(), 1, "second remote untouched");

    // concurrent operations on both
    let (x, y) = tokio::join!(
        u.engine.publish(
            "p-due",
            PublishRequest {
                title: Some("Solo due".into()),
                ..Default::default()
            }
        ),
        u.engine.sync_now("p-uno")
    );
    assert_eq!(x.unwrap().head_version, Some(1));
    assert_eq!(y.unwrap().head_version, Some(1));
    assert_eq!(r2.tags(), vec!["v1"]);

    // journals are per project
    let j1 = u.engine.journal("p-uno", 50).unwrap();
    let j2 = u.engine.journal("p-due", 50).unwrap();
    assert!(j1.iter().all(|e| e.project_id == "p-uno"));
    assert!(j2.iter().all(|e| e.project_id == "p-due"));
    assert!(j1.iter().any(|e| e.kind == "publish") && j2.iter().any(|e| e.kind == "publish"));
    // a conflict in one project does not show in the other
    assert!(u
        .engine
        .list_conflicts("p-due", true)
        .await
        .unwrap()
        .is_empty());

    // unlinking one leaves the other (and the folder) alone
    u.engine.unlink_project("p-uno").await.unwrap();
    assert!(f1.join("A.ork").exists());
    assert_eq!(u.engine.list_projects().unwrap().len(), 1);
    assert_eq!(
        u.engine.status("p-uno").await.unwrap_err().code(),
        ErrorCode::NotLinked
    );
    assert_eq!(
        u.engine.status("p-due").await.unwrap().state,
        SyncState::Synced
    );
}

// ---- 9. partial files never enter a version ------------------------------------------------

#[tokio::test]
async fn s09_partial_zip_is_never_published() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write("Rotto.ork", &partial_ork("troncato"));
    a.write_ork("Buono.ork", "buono");

    // wait until the engine has judged both files
    let st = a
        .wait_status(5, |s| {
            s.changed_files.len() == 2
                && s.changed_files
                    .iter()
                    .all(|f| f.stable && f.valid.is_some())
        })
        .await;
    let rotto = st
        .changed_files
        .iter()
        .find(|f| f.path == "Rotto.ork")
        .unwrap();
    assert_eq!(rotto.valid, Some(false));
    assert!(
        rotto.invalid_reason.as_deref().unwrap().contains("ZIP"),
        "{rotto:?}"
    );
    let buono = st
        .changed_files
        .iter()
        .find(|f| f.path == "Buono.ork")
        .unwrap();
    assert_eq!(buono.valid, Some(true));

    // publishing everything is refused with an explicit error
    let e = a.publish("Tutto").await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::FileInvalid, "{e}");
    assert!(e.to_app_error().message.contains("Rotto.ork"));
    assert!(remote.tags().is_empty());

    // publishing only the good one works and the partial file is nowhere in the version
    let st = a
        .publish_paths("Solo il buono", &["Buono.ork"])
        .await
        .unwrap();
    assert_eq!(st.head_version, Some(1));
    assert_eq!(st.changed_files.len(), 1);
    assert_eq!(st.changed_files[0].path, "Rotto.ork");
    let tree = git(
        &remote.path,
        &["ls-tree", "-r", "--name-only", "refs/heads/main"],
    );
    assert!(
        tree.contains("Buono.ork") && !tree.contains("Rotto.ork"),
        "{tree}"
    );

    // the same partial file is never part of a conflict/safety commit on the server either
    a.write_ork("Rotto.ork", "completato");
    let st = a.publish("Completato").await.unwrap();
    assert_eq!(st.head_version, Some(2));
    assert_synced(&st);
}

#[tokio::test]
async fn s09b_file_still_being_written_is_not_stable() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Vivo.ork", "inizio");
    let path = a.path("Vivo.ork");
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop2 = stop.clone();
    let writer = std::thread::spawn(move || {
        let mut i = 0;
        while !stop2.load(std::sync::atomic::Ordering::SeqCst) {
            i += 1;
            let _ = std::fs::write(&path, ork(&format!("scrittura {i}")));
            std::thread::sleep(Duration::from_millis(15));
        }
    });
    let e = a.publish("Troppo presto").await.unwrap_err();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    writer.join().unwrap();
    assert_eq!(e.code(), ErrorCode::FileNotStable, "{e}");
    assert!(remote.tags().is_empty());
    // once the writer stops the same publish works
    let st = a.publish("Ora sì").await.unwrap();
    assert_eq!(st.head_version, Some(1));
}

// ---- 10. no forced operations anywhere -----------------------------------------------------

#[tokio::test]
async fn s10_command_log_has_no_force_and_no_merge_commands() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    a.write_ork("Razzo.ork", "a1");
    a.publish("v1").await.unwrap();
    b.sync().await;
    // a conflict and its resolution exercise the riskiest commands
    a.write_ork("Razzo.ork", "a2");
    b.write_ork("Razzo.ork", "b2");
    a.publish("a2").await.unwrap();
    let st = b.publish("b2").await.unwrap();
    let id = st.open_conflict_ids[0].clone();
    b.engine
        .resolve_conflict(
            PROJECT,
            id,
            vec![FileResolution {
                path: "Razzo.ork".into(),
                choice: ResolutionChoice::Mine,
            }],
        )
        .await
        .unwrap();
    a.sync().await;
    a.engine
        .restore_version(PROJECT, a.head_sha_of_version(1).await, None)
        .await
        .unwrap();
    b.sync().await;
    let discard_target = "Extra.txt";
    b.write(discard_target, b"x");
    b.engine
        .discard_changes(PROJECT, vec![discard_target.into()])
        .await
        .unwrap();

    for u in [&a, &b] {
        assert_no_forbidden_commands(&u.engine);
        let log = u.engine.command_log().records();
        assert!(log.iter().any(|r| r.args.iter().any(|a| a == "push")));
        assert!(log.iter().any(|r| r.args.iter().any(|a| a == "--atomic")));
    }
    let uses_merge_tree = |u: &User| {
        u.engine
            .command_log()
            .records()
            .iter()
            .any(|r| r.args.first().map(String::as_str) == Some("merge-tree"))
    };
    assert!(
        uses_merge_tree(&a) || uses_merge_tree(&b),
        "merges are computed with merge-tree"
    );
}

impl User {
    async fn head_sha_of_version(&self, n: i64) -> String {
        let v = self
            .engine
            .list_versions(PROJECT, Some(100), None)
            .await
            .unwrap();
        v.into_iter().find(|x| x.number == Some(n)).unwrap().sha
    }
}

// ---- history, comparison, export -----------------------------------------------------------

#[tokio::test]
async fn history_compare_and_export() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.write("Note.txt", b"riga 1\nriga 2\n");
    a.write("img.png", &[0u8, 1, 2, 3, 255]);
    a.publish("Inizio").await.unwrap();
    a.write_ork("Razzo.ork", "due!");
    a.write("Note.txt", b"riga 1\nriga 2 modificata\nriga 3\n");
    a.write("img.png", &[0u8, 1, 2, 3, 255, 9, 9]);
    a.publish("Seconda").await.unwrap();

    let vs = a
        .engine
        .list_versions(PROJECT, Some(2), None)
        .await
        .unwrap();
    assert_eq!(vs.len(), 2);
    let older = a
        .engine
        .list_versions(PROJECT, Some(10), Some(vs[1].sha.clone()))
        .await
        .unwrap();
    assert_eq!(version_numbers(&older), vec![Some(0)]);
    let v2 = a
        .engine
        .get_version(PROJECT, vs[0].sha[..10].to_string())
        .await
        .unwrap();
    assert_eq!(v2.number, Some(2));
    assert_eq!(v2.files.len(), 3);
    let razzo = v2.files.iter().find(|f| f.path == "Razzo.ork").unwrap();
    assert_eq!(razzo.change, FileChangeKind::Modified);
    assert!(razzo.binary);
    assert!(razzo.size_before.is_some() && razzo.size_after.is_some());
    assert!(
        !v2.files
            .iter()
            .find(|f| f.path == "Note.txt")
            .unwrap()
            .binary
    );

    let cmp = a
        .engine
        .compare_versions(PROJECT, vs[1].sha.clone(), vs[0].sha.clone())
        .await
        .unwrap();
    assert_eq!(cmp.from.number, Some(1));
    assert_eq!(cmp.to.number, Some(2));
    assert_eq!(cmp.files.len(), 3);
    let note = cmp
        .files
        .iter()
        .find(|f| f.file.path == "Note.txt")
        .unwrap();
    assert!(note
        .text_diff
        .as_deref()
        .unwrap()
        .contains("+riga 2 modificata"));
    assert_eq!(note.before.as_deref(), Some(&b"riga 1\nriga 2\n"[..]));
    let img = cmp.files.iter().find(|f| f.file.path == "img.png").unwrap();
    assert!(img.text_diff.is_none());
    assert!(
        img.note.as_deref().unwrap().contains("dimensione"),
        "{:?}",
        img.note
    );
    let r = cmp
        .files
        .iter()
        .find(|f| f.file.path == "Razzo.ork")
        .unwrap();
    assert_eq!(r.before.as_deref(), Some(&ork("uno")[..]));
    assert_eq!(r.after.as_deref(), Some(&ork("due!")[..]));
    assert!(r.ork.is_none());
    // JSON shape of the contract
    let j = serde_json::to_value(&cmp).unwrap();
    assert!(j["files"][0]["change"].is_string());
    assert!(j["files"][0].get("before").is_none());

    // export
    let dest = tempfile::tempdir().unwrap();
    let out = a
        .engine
        .export_version(
            PROJECT,
            vs[1].sha.clone(),
            Some(vec!["Razzo.ork".into()]),
            dest.path().join("fuori"),
        )
        .await
        .unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(std::fs::read(&out[0]).unwrap(), ork("uno"));
    let all = a
        .engine
        .export_version(PROJECT, vs[1].sha.clone(), None, dest.path().join("tutto"))
        .await
        .unwrap();
    assert!(all.len() >= 4, "{all:?}"); // 3 files + .gitattributes/.gitignore/.rocketsync
                                        // never overwrites: a second export gets other names
    let again = a
        .engine
        .export_version(
            PROJECT,
            vs[1].sha.clone(),
            Some(vec!["Razzo.ork".into()]),
            dest.path().join("fuori"),
        )
        .await
        .unwrap();
    assert_ne!(again[0], out[0]);
    assert_eq!(a.read("Razzo.ork"), ork("due!"), "working folder untouched");
    // path validation
    for bad in ["../x", "/etc/passwd", ".git/config", "a/../../b"] {
        let e = a
            .engine
            .export_version(
                PROJECT,
                vs[1].sha.clone(),
                Some(vec![bad.into()]),
                dest.path().join("x"),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidPath, "{bad}");
    }
    let e = a
        .engine
        .get_version(PROJECT, "--help".into())
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::Internal);
    let e = a
        .engine
        .get_version(PROJECT, "deadbeef".into())
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::NotFound);

    // temporary copy to open in OpenRocket
    let copy = a
        .engine
        .export_version_copy(PROJECT, vs[1].sha.clone(), "Razzo.ork".into())
        .await
        .unwrap();
    assert!(copy.starts_with(a.path(".rocketsync/local")));
    assert_eq!(std::fs::read(&copy).unwrap(), ork("uno"));
    assert_eq!(
        a.engine
            .read_file_at(PROJECT, vs[1].sha.clone(), "Razzo.ork".into())
            .await
            .unwrap()
            .unwrap(),
        ork("uno")
    );
    // ... and it does not show up as an unpublished change
    assert_synced(&a.status().await);
}

// ---- safety copies and discard -------------------------------------------------------------

#[tokio::test]
async fn discard_changes_is_preceded_by_a_safety_copy() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "originale");
    a.publish("v1").await.unwrap();
    a.write_ork("Razzo.ork", "modificato");
    a.write_ork("Nuovo.ork", "nuovo");
    let st = a.status().await;
    assert_eq!(st.changed_files.len(), 2);

    let st = a
        .engine
        .discard_changes(PROJECT, vec!["Razzo.ork".into(), "Nuovo.ork".into()])
        .await
        .unwrap();
    assert_synced(&st);
    assert_eq!(a.read("Razzo.ork"), ork("originale"));
    assert!(!a.exists("Nuovo.ork"));
    a.assert_clean();

    let snaps = a.engine.list_snapshots(PROJECT).await.unwrap();
    assert!(snaps.iter().any(|s| s.operation == "scarto"), "{snaps:?}");
    let snap = snaps.iter().find(|s| s.operation == "scarto").unwrap();
    assert!(snap.file_count >= 2);
    let dest = tempfile::tempdir().unwrap();
    let files = a
        .engine
        .export_snapshot(PROJECT, snap.id.clone(), dest.path().to_path_buf())
        .await
        .unwrap();
    assert!(!files.is_empty());
    assert_eq!(
        std::fs::read(dest.path().join("Razzo.ork")).unwrap(),
        ork("modificato")
    );
    assert_eq!(
        std::fs::read(dest.path().join("Nuovo.ork")).unwrap(),
        ork("nuovo")
    );
    assert_eq!(
        a.engine
            .export_snapshot(PROJECT, "../etc".into(), dest.path().to_path_buf())
            .await
            .unwrap_err()
            .code(),
        ErrorCode::Internal
    );
}

// ---- link a folder that already has files (§7.1) -------------------------------------------

#[tokio::test]
async fn link_non_empty_folder_never_loses_local_files() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "del-server");
    a.write("Note.txt", b"uguale\n");
    a.write_ork("sub/Ala.ork", "ala-server");
    a.publish("Base").await.unwrap();

    let b = User::unlinked("Bruno").await;
    b.write("Razzo.ork", &ork("locale-diverso"));
    b.write("Note.txt", b"uguale\n");
    b.write_ork("Solo-mio.ork", "solo-mio");
    b.write("sub", b"un file dove il server ha una cartella");
    let st = b.link(&remote).await.unwrap();

    assert_eq!(
        b.read("Razzo.ork"),
        ork("del-server"),
        "remote content at the original path"
    );
    let names: Vec<String> = std::fs::read_dir(&b.folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let copy = names
        .iter()
        .find(|n| n.starts_with("Razzo (copia locale ") && n.ends_with(").ork"))
        .unwrap_or_else(|| panic!("{names:?}"));
    assert_eq!(
        b.read(copy),
        ork("locale-diverso"),
        "local content preserved in the renamed copy"
    );
    assert_eq!(b.read("Note.txt"), b"uguale\n");
    assert_eq!(b.read("Solo-mio.ork"), ork("solo-mio"));
    let sub_copy = names
        .iter()
        .find(|n| n.starts_with("sub (copia locale "))
        .unwrap_or_else(|| panic!("{names:?}"));
    assert_eq!(b.read(sub_copy), b"un file dove il server ha una cartella");
    assert_eq!(b.read("sub/Ala.ork"), ork("ala-server"));

    // local-only files are unpublished changes; identical ones are not
    let changed: Vec<&str> = st.changed_files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        changed.contains(&"Solo-mio.ork") && changed.contains(&copy.as_str()),
        "{changed:?}"
    );
    assert!(
        !changed.contains(&"Note.txt") && !changed.contains(&"Razzo.ork"),
        "{changed:?}"
    );
    assert_eq!(st.head_version, Some(1));
    // no leftovers of the temporary clone
    assert!(
        !names.iter().any(|n| n.starts_with(".rocketsync-link")),
        "{names:?}"
    );

    // and they can be published
    let st = b.publish("I miei file").await.unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(2));
}

#[tokio::test]
async fn link_refuses_synced_drive_and_foreign_repo() {
    let remote = Remote::new();
    let u = User::unlinked("Anna").await;
    let onedrive = u.folder.parent().unwrap().join("OneDrive").join("Razzi");
    let check = u.engine.check_folder(&onedrive);
    assert_eq!(check.in_synced_drive, Some(SyncedDrive::Onedrive));
    assert!(!check.exists);
    let e = u
        .engine
        .link_project(LinkRequest {
            project_id: PROJECT.into(),
            repo_full_name: "t/r".into(),
            remote_url: Some(remote.url.clone()),
            folder: onedrive.to_string_lossy().into_owned(),
            allow_synced_drive: false,
        })
        .await
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::FolderInSyncedDrive);
    assert!(!onedrive.exists(), "nothing was created");

    // a folder that already is a *different* repository is refused
    std::fs::create_dir_all(&u.folder).unwrap();
    git(&u.folder, &["init", "-q", "-b", "main", "."]);
    let e = u.link(&remote).await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::FolderNotEmpty, "{e}");
    let c = u.engine.check_folder(&u.folder);
    assert!(c.exists && !c.empty && c.writable);
}

#[tokio::test]
async fn relink_after_unlink_adopts_the_existing_repository() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    a.publish("v1").await.unwrap();
    a.write_ork("Locale.ork", "mio");
    a.engine.unlink_project(PROJECT).await.unwrap();
    assert!(a.exists("Razzo.ork") && a.exists(".git"));
    let st = a.link(&remote).await.unwrap();
    assert_eq!(st.head_version, Some(1));
    assert_eq!(st.changed_files.len(), 1);
    assert_eq!(a.read("Locale.ork"), ork("mio"));
}

// ---- publication policy, watcher, background loop ------------------------------------------

#[tokio::test]
async fn publish_policy_is_stored_per_project() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    assert_eq!(
        a.engine.get_publish_policy(PROJECT).unwrap(),
        PublishPolicy::Assisted { idle_minutes: 10 }
    );
    a.engine
        .set_publish_policy(
            PROJECT,
            PublishPolicy::OnSave {
                min_interval_minutes: 3,
            },
        )
        .unwrap();
    assert_eq!(
        a.engine.get_publish_policy(PROJECT).unwrap(),
        PublishPolicy::OnSave {
            min_interval_minutes: 3
        }
    );
    let a = a.restart().await;
    a.engine.start().await.unwrap();
    assert_eq!(
        a.engine.get_publish_policy(PROJECT).unwrap(),
        PublishPolicy::OnSave {
            min_interval_minutes: 3
        }
    );
}

fn bg_config(data_dir: &std::path::Path, det: Arc<MockDetector>, fetch_ms: u64) -> EngineConfig {
    let mut cfg = test_config(data_dir, det);
    cfg.background = true;
    cfg.watch = true;
    cfg.timing.fetch_interval = Duration::from_millis(fetch_ms);
    cfg
}

async fn user_with_background(name: &str, remote: &Remote, fetch_ms: u64) -> User {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let folder = tmp.path().join("progetto");
    let detector = Arc::new(MockDetector::default());
    let engine = Engine::open(bg_config(&data_dir, detector.clone(), fetch_ms))
        .await
        .unwrap();
    engine.set_identity(Some(Identity {
        name: name.into(),
        email: format!("1+{}@users.noreply.github.com", name.to_lowercase()),
    }));
    let u = User {
        name: name.into(),
        engine,
        folder,
        data_dir,
        detector,
        _tmp: tmp,
    };
    u.link(remote).await.unwrap();
    u
}

#[tokio::test]
async fn assisted_policy_publishes_after_idle_and_background_fetch_updates_others() {
    let remote = Remote::new();
    let a = user_with_background("Anna", &remote, 3_600_000).await;
    let b = user_with_background("Bruno", &remote, 200).await;
    a.engine
        .set_publish_policy(PROJECT, PublishPolicy::Assisted { idle_minutes: 0 })
        .unwrap();

    // the watcher notices the save; the engine publishes by itself
    a.write_ork("Auto.ork", "automatico");
    let st = a
        .wait_status(10, |s| {
            s.head_version == Some(1) && s.state == SyncState::Synced
        })
        .await;
    assert!(st.last_publish_at.is_some());
    assert_eq!(remote.tags(), vec!["v1"]);
    assert!(
        remote.log_subjects()[0].starts_with("v1 — Aggiunto Auto.ork"),
        "{:?}",
        remote.log_subjects()
    );

    // Bruno's periodic fetch brings the file without any command
    b.wait_status(10, |s| {
        s.head_version == Some(1) && s.state == SyncState::Synced
    })
    .await;
    assert_eq!(b.read("Auto.ork"), ork("automatico"));
}

#[tokio::test]
async fn manual_policy_never_publishes_and_onsave_respects_min_interval() {
    let remote = Remote::new();
    let a = user_with_background("Anna", &remote, 3_600_000).await;

    a.engine
        .set_publish_policy(PROJECT, PublishPolicy::Manual)
        .unwrap();
    a.write_ork("Manuale.ork", "m");
    let st = a
        .wait_status(5, |s| {
            s.changed_files.len() == 1
                && s.changed_files[0].stable
                && s.changed_files[0].valid == Some(true)
        })
        .await;
    assert!(st.auto_publish_at.is_none());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(remote.tags().is_empty(), "manual means manual");

    // switch to "on every save": publishes at once, then waits for the minimum interval
    a.engine
        .set_publish_policy(
            PROJECT,
            PublishPolicy::OnSave {
                min_interval_minutes: 60,
            },
        )
        .unwrap();
    a.wait_status(10, |s| s.head_version == Some(1)).await;
    a.write_ork("Manuale.ork", "m2");
    let st = a
        .wait_status(5, |s| {
            s.changed_files.len() == 1
                && s.changed_files[0].valid == Some(true)
                && s.auto_publish_at.is_some()
        })
        .await;
    let at = st.auto_publish_at.unwrap();
    assert!(
        at > st.last_publish_at.unwrap(),
        "next automatic publication is in the future: {at}"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(remote.tags(), vec!["v1"], "min interval not elapsed yet");
}

#[tokio::test]
async fn watcher_ignores_git_internals_and_ignored_files() {
    let remote = Remote::new();
    let a = user_with_background("Anna", &remote, 3_600_000).await;
    a.engine
        .set_publish_policy(PROJECT, PublishPolicy::Manual)
        .unwrap();
    a.write("backup.bak", b"ignorato");
    a.write("~$lock.ork", b"ignorato");
    a.write(".rocketsync/local/x.ork", b"ignorato");
    a.write("scrivendo.tmp", b"ignorato");
    a.write_ork("Vero.ork", "vero");
    let st = a
        .wait_status(5, |s| {
            !s.changed_files.is_empty() && s.changed_files.iter().all(|f| f.stable)
        })
        .await;
    let paths: Vec<&str> = st.changed_files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["Vero.ork"]);
}

#[tokio::test]
async fn remote_notification_triggers_a_fetch() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = user_with_background("Bruno", &remote, 3_600_000).await;
    a.write_ork("Razzo.ork", "uno");
    a.publish("v1").await.unwrap();
    b.engine.notify_remote_changed(PROJECT).unwrap();
    b.wait_status(10, |s| s.head_version == Some(1)).await;
    assert_eq!(b.read("Razzo.ork"), ork("uno"));
}

#[tokio::test]
async fn errors_convert_to_the_contract_app_error() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let e = a.publish("niente").await.unwrap_err();
    let app = e.to_app_error();
    assert_eq!(app.code, ErrorCode::NotFound);
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["code"], "notFound");
    assert!(json["message"].as_str().unwrap().contains("modifiche"));
    assert_eq!(json["retryable"], false);
    let e = a.engine.status("nope").await.unwrap_err();
    assert_eq!(e.to_app_error().code, ErrorCode::NotLinked);
    // no identity -> authRequired
    a.engine.set_identity(None);
    a.write_ork("X.ork", "x");
    let e = a.publish("x").await.unwrap_err();
    assert_eq!(e.code(), ErrorCode::AuthRequired);
}

#[tokio::test]
async fn status_json_matches_the_ipc_contract() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    a.write_ork("Razzo.ork", "uno");
    let st = a
        .wait_status(5, |s| {
            s.changed_files.len() == 1 && s.changed_files[0].valid.is_some()
        })
        .await;
    let v = serde_json::to_value(&st).unwrap();
    for k in [
        "projectId",
        "state",
        "folder",
        "headVersion",
        "remoteVersion",
        "behindBy",
        "changedFiles",
        "pendingVersions",
        "blockedByEditor",
        "openConflictIds",
        "staleSaveSuspected",
        "lastFetchAt",
        "lastPublishAt",
        "autoPublishAt",
        "repoSizeBytes",
        "error",
    ] {
        assert!(v.get(k).is_some(), "missing {k}: {v}");
    }
    assert_eq!(v["state"], "localChanges");
    let f = &v["changedFiles"][0];
    for k in [
        "path",
        "change",
        "stable",
        "valid",
        "sizeBytes",
        "modifiedAt",
    ] {
        assert!(f.get(k).is_some(), "missing {k}: {f}");
    }
    assert_eq!(f["change"], "added");
    assert!(f.get("oldPath").is_none());
    assert_eq!(v["error"], serde_json::Value::Null);
    assert!(v["repoSizeBytes"].as_u64().is_some());
    // events have contract names and payloads
    let ev = EngineEvent::VersionPublished {
        project_id: "p".into(),
        number: 3,
        sha: "abc".into(),
        title: "T".into(),
    };
    assert_eq!(ev.to_ipc().0, "version-published");
    assert_eq!(
        ev.to_ipc().1,
        serde_json::json!({"projectId": "p", "number": 3, "sha": "abc", "title": "T"})
    );
}

#[tokio::test]
async fn a_repeated_background_error_is_reported_once_and_cleared_by_a_good_fetch() {
    let remote = Remote::new();
    let b = user_with_background("Bruno", &remote, 100).await;
    b.wait_status(10, |s| s.state == SyncState::Synced).await;
    let mut rx = b.engine.subscribe();

    // The remote turns into a repository without the project's branch: every fetch fails with
    // the same (non-network) error.
    let saved = remote.root.path().join("remote-saved.git");
    std::fs::rename(&remote.path, &saved).unwrap();
    git(
        remote.root.path(),
        &["init", "--bare", "-q", remote.path.to_str().unwrap()],
    );
    let st = b.wait_status(10, |s| s.state == SyncState::Error).await;
    assert!(st.error.is_some());
    // several more fetch attempts (100 ms apart) fail the same way
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let errors = drain(&mut rx)
        .into_iter()
        .filter(|e| matches!(e, EngineEvent::SyncError { .. }))
        .count();
    assert_eq!(
        errors, 1,
        "the same error is announced once, not at every fetch"
    );

    // The remote is back: a successful fetch with nothing to do clears the error state.
    std::fs::remove_dir_all(&remote.path).unwrap();
    std::fs::rename(&saved, &remote.path).unwrap();
    let st = b.wait_status(10, |s| s.state == SyncState::Synced).await;
    assert!(st.error.is_none(), "{st:#?}");
}
