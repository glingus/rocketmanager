//! The command layer against a real engine, real git and a local bare remote (no window).

use rocket_sync_lib::auth::AuthService;
use rocket_sync_lib::config::AppConfig;
use rocket_sync_lib::enrich::ShellInspector;
use rocket_sync_lib::events::{self, EventSink};
use rocket_sync_lib::platform::{BoxFut, Platform, UpdateInfo};
use rocket_sync_lib::secrets::{memory_store, SecretStore};
use rocket_sync_lib::settings::AppSettings;
use rocket_sync_lib::shell::{Shell, ShellParts};
use rs_core::{
    AppError, ConflictSide, Engine, EngineConfig, ErrorCode, FileResolution, Identity,
    ResolutionChoice, SyncState, Timing,
};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const SIMPLE: &[u8] =
    include_bytes!("../../../../tests/fixtures/ork/simple-model-rocket-24.12.ork");
const OTHER: &[u8] = include_bytes!("../../../../tests/fixtures/ork/two-stage-rocket-22.02.ork");
const THIRD: &[u8] = include_bytes!("../../../../tests/fixtures/ork/tube-fin-rocket-22.02.ork");

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Server")
        .env("GIT_AUTHOR_EMAIL", "s@example.com")
        .env("GIT_COMMITTER_NAME", "Server")
        .env("GIT_COMMITTER_EMAIL", "s@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `<base>/team/razzo.git` with the initial commit of a Rocket Sync project.
struct Hosting {
    root: tempfile::TempDir,
}

impl Hosting {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("base/team/razzo.git");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare", "-b", "main", "."]);
        let seed = root.path().join("seed");
        std::fs::create_dir_all(seed.join(".rocketsync")).unwrap();
        git(&seed, &["init", "-b", "main", "."]);
        std::fs::write(seed.join(".gitattributes"), "*.ork binary\n* -text\n").unwrap();
        std::fs::write(seed.join(".gitignore"), ".rocketsync/local/\n*.tmp\n").unwrap();
        std::fs::write(
            seed.join(".rocketsync/project.json"),
            "{\"projectId\":\"p1\",\"schema\":1}\n",
        )
        .unwrap();
        git(&seed, &["add", "-A"]);
        git(
            &seed,
            &[
                "commit",
                "-m",
                "v0 — Progetto creato\n\nRocket-Sync-Version: 0\nRocket-Sync-Kind: init\n",
            ],
        );
        git(
            &seed,
            &["push", &format!("file://{}", bare.display()), "main"],
        );
        Self { root }
    }
    fn base(&self) -> String {
        format!("file://{}", self.root.path().join("base").display())
    }
}

#[derive(Default)]
struct TestPlatform {
    opened: Mutex<Vec<String>>,
    launched: Mutex<Vec<String>>,
    notified: Mutex<Vec<(String, String)>>,
    autostart: Mutex<Vec<bool>>,
    home: Mutex<Option<PathBuf>>,
    picked: Mutex<Option<PathBuf>>,
    update: Mutex<Option<UpdateInfo>>,
    installed: Mutex<bool>,
    quit_choice: Mutex<Option<rocket_sync_lib::platform::QuitChoice>>,
    quit_messages: Mutex<Vec<String>>,
}

impl Platform for TestPlatform {
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.opened
            .lock()
            .unwrap()
            .push(path.to_string_lossy().into_owned());
        Ok(())
    }
    fn open_with(&self, exe: &Path, file: &Path) -> Result<(), String> {
        self.launched
            .lock()
            .unwrap()
            .push(format!("{} {}", exe.display(), file.display()));
        Ok(())
    }
    fn notify(&self, t: &str, b: &str) -> Result<(), String> {
        self.notified.lock().unwrap().push((t.into(), b.into()));
        Ok(())
    }
    fn home_dir(&self) -> Option<PathBuf> {
        self.home.lock().unwrap().clone()
    }
    fn pick_folder(&self, _: Option<&Path>) -> Option<PathBuf> {
        self.picked.lock().unwrap().clone()
    }
    fn set_autostart(&self, on: bool) -> Result<(), String> {
        self.autostart.lock().unwrap().push(on);
        Ok(())
    }
    fn confirm_quit(&self, message: &str) -> rocket_sync_lib::platform::QuitChoice {
        self.quit_messages.lock().unwrap().push(message.to_string());
        self.quit_choice
            .lock()
            .unwrap()
            .unwrap_or(rocket_sync_lib::platform::QuitChoice::Cancel)
    }
    fn check_update(&self) -> BoxFut<'_, Result<UpdateInfo, String>> {
        Box::pin(async move { Ok(self.update.lock().unwrap().clone().unwrap_or_default()) })
    }
    fn install_update(&self) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async move {
            *self.installed.lock().unwrap() = true;
            Ok(())
        })
    }
}

struct Fixture {
    shell: Shell,
    platform: Arc<TestPlatform>,
    secrets: Arc<dyn SecretStore>,
    tmp: tempfile::TempDir,
}

async fn fixture(name: &str, hosting: Option<&Hosting>, config: AppConfig) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let data_dir = tmp.path().join("data");
    let mut cfg = EngineConfig::new(&data_dir);
    cfg.inspector = Arc::new(ShellInspector::default());
    cfg.timing = Timing::fast();
    cfg.background = false;
    cfg.watch = false;
    cfg.git.retry = rs_core::RetryPolicy {
        attempts: 2,
        base_delay: Duration::from_millis(2),
    };
    let engine = Engine::open(cfg).await.unwrap();
    engine.set_identity(Some(Identity {
        name: name.into(),
        email: format!("1+{}@users.noreply.github.com", name.to_lowercase()),
    }));
    let platform = Arc::new(TestPlatform::default());
    *platform.home.lock().unwrap() = Some(tmp.path().join("home"));
    let secrets: Arc<dyn SecretStore> = Arc::new(memory_store());
    let shell = Shell::new(ShellParts {
        engine: Ok(engine),
        auth: Arc::new(AuthService::new(config.clone(), secrets.clone())),
        secrets: secrets.clone(),
        store: rs_store::Store::open_in_memory().unwrap(),
        platform: platform.clone(),
        data_dir,
        config,
        git_version: Some("2.43.0".into()),
        settings: Arc::new(RwLock::new(AppSettings::default())),
        remote_base: hosting.map(|h| h.base()),
    });
    Fixture {
        shell,
        platform,
        secrets,
        tmp,
    }
}

fn folder(f: &Fixture) -> PathBuf {
    f.tmp.path().join("progetto")
}

async fn link(f: &Fixture) {
    f.shell
        .link_project("p1", "team/razzo", &folder(f).to_string_lossy())
        .await
        .unwrap();
}

async fn wait_valid(f: &Fixture, n: usize) {
    for _ in 0..100 {
        let st = f.shell.get_project_status("p1").await.unwrap();
        if st.changed_files.len() >= n
            && st
                .changed_files
                .iter()
                .all(|c| c.valid.is_some() && c.stable)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("files never became stable and validated");
}

#[tokio::test]
async fn publish_history_and_semantic_comparison_through_the_command_layer() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    assert_eq!(f.shell.list_local_projects().unwrap().len(), 1);

    std::fs::write(folder(&f).join("Razzo.ork"), SIMPLE).unwrap();
    std::fs::write(folder(&f).join("Note.txt"), "uno\ndue\n").unwrap();
    wait_valid(&f, 2).await;
    let st = f
        .shell
        .publish("p1", Some("Primo".into()), None, None)
        .await
        .unwrap();
    assert_eq!(st.state, SyncState::Synced, "{st:#?}");
    assert_eq!(st.head_version, Some(1));

    // second version: another rocket and edited notes
    std::fs::write(folder(&f).join("Razzo.ork"), OTHER).unwrap();
    std::fs::write(folder(&f).join("Note.txt"), "uno\ndue modificato\n").unwrap();
    wait_valid(&f, 2).await;
    f.shell
        .publish("p1", Some("Secondo".into()), None, None)
        .await
        .unwrap();

    let versions = f.shell.list_versions("p1", Some(10), None).await.unwrap();
    assert_eq!(versions[0].number, Some(2));
    // changelog produced by rs-ork through the adapter, in Italian
    let g = versions[0]
        .changelog
        .iter()
        .find(|g| g.path == "Razzo.ork")
        .unwrap();
    assert!(g.interpreted, "{g:?}");
    assert!(!g.lines.is_empty());

    let cmp = f
        .shell
        .compare_versions("p1", &versions[1].sha, &versions[0].sha)
        .await
        .unwrap();
    let razzo = cmp
        .files
        .iter()
        .find(|c| c.file.path == "Razzo.ork")
        .unwrap();
    let ork = razzo.ork.as_ref().expect("semantic diff of the .ork");
    assert!(ork["parseError"].is_null(), "{ork}");
    assert!(ork["before"]["componentCount"].as_u64().unwrap() > 0);
    assert!(ork["after"]["rocketName"].is_string());
    assert!(!ork["components"].as_array().unwrap().is_empty());
    assert!(razzo.text_diff.is_none());
    let note = cmp
        .files
        .iter()
        .find(|c| c.file.path == "Note.txt")
        .unwrap();
    let d = note.text_diff.as_deref().unwrap();
    assert!(
        d.contains("-due\n") && d.contains("+due modificato\n"),
        "{d}"
    );
    let json = serde_json::to_value(&cmp).unwrap();
    assert!(json["files"][0].get("textDiff").is_some() && json["files"][0].get("before").is_none());

    // export and a copy to open
    let dest = f.tmp.path().join("export");
    let out = f
        .shell
        .export_version(
            "p1",
            &versions[1].sha,
            Some(vec!["Razzo.ork".into()]),
            &dest.to_string_lossy(),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&out[0]).unwrap(), SIMPLE);
    f.shell
        .open_version_copy("p1", &versions[1].sha, "Razzo.ork")
        .await
        .unwrap();
    assert_eq!(
        f.platform.opened.lock().unwrap().len(),
        1,
        "no OpenRocket installed: default application"
    );

    // policy and snapshots go through as well
    f.shell
        .set_publish_policy("p1", rs_core::PublishPolicy::Manual)
        .unwrap();
    assert_eq!(
        f.shell.get_publish_policy("p1").unwrap(),
        rs_core::PublishPolicy::Manual
    );
    f.shell.unlink_project("p1").await.unwrap();
    assert!(f.shell.list_local_projects().unwrap().is_empty());
}

#[tokio::test]
async fn conflict_has_a_semantic_three_way_diff_for_ork_files() {
    let h = Hosting::new();
    let a = fixture("Anna", Some(&h), AppConfig::default()).await;
    let b = fixture("Bruno", Some(&h), AppConfig::default()).await;
    link(&a).await;
    link(&b).await;
    std::fs::write(folder(&a).join("Razzo.ork"), SIMPLE).unwrap();
    wait_valid(&a, 1).await;
    a.shell
        .publish("p1", Some("Base".into()), None, None)
        .await
        .unwrap();
    b.shell.sync_now("p1").await.unwrap();

    std::fs::write(folder(&a).join("Razzo.ork"), OTHER).unwrap();
    std::fs::write(folder(&b).join("Razzo.ork"), THIRD).unwrap();
    wait_valid(&a, 1).await;
    wait_valid(&b, 1).await;
    a.shell
        .publish("p1", Some("Anna".into()), None, None)
        .await
        .unwrap();
    let st = b
        .shell
        .publish("p1", Some("Bruno".into()), None, None)
        .await
        .unwrap();
    assert_eq!(st.state, SyncState::Conflict);

    let conflicts = b.shell.list_conflicts("p1", false).await.unwrap();
    assert_eq!(conflicts.len(), 1);
    let c = b.shell.get_conflict("p1", &conflicts[0].id).await.unwrap();
    let tw = c.files[0]
        .three_way
        .as_ref()
        .expect("threeWay filled by rs-ork");
    assert_eq!(tw["path"], "Razzo.ork");
    assert!(tw["mine"]["after"]["rocketName"].is_string(), "{tw}");
    assert!(tw["theirs"]["parseError"].is_null());
    assert!(tw["independent"].is_boolean());
    assert!(tw["overlapping"].is_array());
    let j = serde_json::to_value(&c).unwrap();
    assert_eq!(j["files"][0]["kind"], "bothModified");

    // copies of the other sides open in OpenRocket (here: default application); "ours" is refused
    b.shell
        .open_conflict_copy("p1", &c.id, "Razzo.ork", ConflictSide::Theirs)
        .await
        .unwrap();
    b.shell
        .open_conflict_copy("p1", &c.id, "Razzo.ork", ConflictSide::Base)
        .await
        .unwrap();
    assert_eq!(
        b.shell
            .open_conflict_copy("p1", &c.id, "Razzo.ork", ConflictSide::Ours)
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidPath
    );

    let st = b
        .shell
        .resolve_conflict(
            "p1",
            &c.id,
            vec![FileResolution {
                path: "Razzo.ork".into(),
                choice: ResolutionChoice::Theirs,
            }],
        )
        .await
        .unwrap();
    assert_eq!(st.state, SyncState::Synced);
    assert_eq!(std::fs::read(folder(&b).join("Razzo.ork")).unwrap(), OTHER);
}

#[tokio::test]
async fn invalid_ork_is_refused_by_the_real_inspector() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    std::fs::write(folder(&f).join("Rotto.ork"), &SIMPLE[..SIMPLE.len() / 2]).unwrap();
    for _ in 0..100 {
        let st = f.shell.get_project_status("p1").await.unwrap();
        if st.changed_files.iter().any(|c| c.valid == Some(false)) {
            let e = f.shell.publish("p1", None, None, None).await.unwrap_err();
            assert_eq!(e.code, ErrorCode::FileInvalid);
            assert!(e.message.contains("Rotto.ork"));
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("file never judged invalid");
}

#[tokio::test]
async fn engine_failure_is_reported_as_git_missing_but_the_rest_works() {
    let f = fixture("Anna", None, AppConfig::default()).await;
    let e = AppError {
        code: ErrorCode::GitMissing,
        message: "Git non è disponibile: reinstalla Rocket Sync.".into(),
        detail: None,
        retryable: false,
    };
    let shell = Shell::new(ShellParts {
        engine: Err(e),
        auth: f.shell.auth.clone(),
        secrets: f.secrets.clone(),
        store: rs_store::Store::open_in_memory().unwrap(),
        platform: f.platform.clone(),
        data_dir: f.tmp.path().join("d2"),
        config: AppConfig::default(),
        git_version: None,
        settings: Arc::new(RwLock::new(AppSettings::default())),
        remote_base: None,
    });
    assert_eq!(
        shell.list_local_projects().unwrap_err().code,
        ErrorCode::GitMissing
    );
    assert_eq!(
        shell.get_project_status("p").await.unwrap_err().code,
        ErrorCode::GitMissing
    );
    assert_eq!(
        shell.publish("p", None, None, None).await.unwrap_err().code,
        ErrorCode::GitMissing
    );
    assert_eq!(
        shell.check_folder("/tmp").unwrap_err().message,
        "Git non è disponibile: reinstalla Rocket Sync."
    );
    // things that do not need the engine keep working
    assert_eq!(shell.get_app_info().git_version, None);
    assert_eq!(shell.get_app_settings(), AppSettings::default());
    assert!(!shell.auth_status().await.unwrap().signed_in);
}

#[tokio::test]
async fn app_info_settings_secure_store_and_folders() {
    let f = fixture("Anna", None, AppConfig::default()).await;
    let info = serde_json::to_value(f.shell.get_app_info()).unwrap();
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["gitVersion"], "2.43.0");
    assert_eq!(info["openRocket"]["found"], false);
    assert!(info["openRocket"]["path"].is_null());

    // settings: clamped, persisted in the shell, autostart forwarded
    let mut s = f.shell.get_app_settings();
    s.autostart = true;
    s.fetch_interval_seconds = 1;
    f.shell.set_app_settings(s).unwrap();
    assert_eq!(f.shell.get_app_settings().fetch_interval_seconds, 15);
    assert_eq!(*f.platform.autostart.lock().unwrap(), vec![true]);
    f.shell
        .set_app_settings(f.shell.get_app_settings())
        .unwrap();
    assert_eq!(
        f.platform.autostart.lock().unwrap().len(),
        1,
        "unchanged autostart is not touched again"
    );

    // notifications obey the setting
    f.shell.notify_desktop("Titolo", "Testo").unwrap();
    assert_eq!(f.platform.notified.lock().unwrap().len(), 1);
    let mut s = f.shell.get_app_settings();
    s.desktop_notifications = false;
    f.shell.set_app_settings(s).unwrap();
    f.shell.notify_desktop("Titolo", "Testo").unwrap();
    assert_eq!(f.platform.notified.lock().unwrap().len(), 1);

    // secure store: namespaced, key-validated
    f.shell
        .secure_store_set("sb-session", &"x".repeat(3000))
        .unwrap();
    assert_eq!(
        f.shell
            .secure_store_get("sb-session")
            .unwrap()
            .unwrap()
            .len(),
        3000
    );
    assert!(f.secrets.get("auth.github").unwrap().is_none());
    assert_eq!(
        f.secrets.get("store.sb-session").unwrap().unwrap().len(),
        3000
    );
    f.shell.secure_store_delete("sb-session").unwrap();
    assert_eq!(f.shell.secure_store_get("sb-session").unwrap(), None);
    for bad in ["", "../auth.github", "a b", "x/y"] {
        assert_eq!(
            f.shell.secure_store_get(bad).unwrap_err().code,
            ErrorCode::InvalidPath,
            "{bad:?}"
        );
    }

    // suggested folder: under <home>/RocketSync, unique, safe name
    let s1 = f.shell.suggest_project_folder("Experimental: Rocket?");
    assert!(
        s1.ends_with("RocketSync/Experimental_ Rocket_")
            || s1.ends_with("RocketSync\\Experimental_ Rocket_"),
        "{s1}"
    );
    std::fs::create_dir_all(&s1).unwrap();
    assert!(f
        .shell
        .suggest_project_folder("Experimental: Rocket?")
        .ends_with("Rocket_ (2)"));
    let c = f.shell.check_folder(&s1).unwrap();
    assert!(c.exists && c.empty && c.writable);

    // folder picker goes through the platform on a blocking thread
    *f.platform.picked.lock().unwrap() = Some(PathBuf::from("/tmp/scelta"));
    assert_eq!(
        f.shell.pick_folder(None).await.unwrap().as_deref(),
        Some("/tmp/scelta")
    );
    *f.platform.picked.lock().unwrap() = None;
    assert_eq!(
        f.shell.pick_folder(Some("/tmp".into())).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn open_in_openrocket_and_open_folder_are_safe() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    std::fs::write(folder(&f).join("Razzo.ork"), SIMPLE).unwrap();
    // OpenRocket "installed": launched with the file as argument
    let fake_exe = f.tmp.path().join("OpenRocket.exe");
    std::fs::write(&fake_exe, b"").unwrap();
    std::env::set_var("ROCKETSYNC_OPENROCKET", &fake_exe);
    let info = f.shell.get_app_info();
    assert!(info.open_rocket.found);
    f.shell.open_in_openrocket("p1", "Razzo.ork").await.unwrap();
    std::env::remove_var("ROCKETSYNC_OPENROCKET");
    let launched = f.platform.launched.lock().unwrap().clone();
    assert_eq!(launched.len(), 1);
    assert!(
        launched[0].contains("OpenRocket.exe") && launched[0].ends_with("Razzo.ork"),
        "{launched:?}"
    );

    for bad in [
        "../x.ork",
        "/etc/passwd",
        "a/../../b.ork",
        ".git/config",
        "C:\\x.ork",
        "",
    ] {
        assert_eq!(
            f.shell
                .open_in_openrocket("p1", bad)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidPath,
            "{bad:?}"
        );
    }
    assert_eq!(
        f.shell
            .open_in_openrocket("p1", "Manca.ork")
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        f.shell
            .open_in_openrocket("nope", "Razzo.ork")
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotLinked
    );

    // only directories can be opened as folders (a file would be executed)
    assert_eq!(
        f.shell
            .open_folder(&folder(&f).join("Razzo.ork").to_string_lossy())
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    f.shell.open_folder(&folder(&f).to_string_lossy()).unwrap();
    assert_eq!(f.platform.opened.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn updater_is_gated_by_configuration_and_waits_for_idle() {
    let f = fixture("Anna", None, AppConfig::default()).await;
    let u = f.shell.check_for_update().await.unwrap();
    assert!(!u.available);
    assert_eq!(
        f.shell.install_update().await.unwrap_err().code,
        ErrorCode::Internal
    );

    let cfg = AppConfig {
        updater_endpoint: "https://example.invalid/latest.json".into(),
        updater_pubkey: "k".into(),
        ..Default::default()
    };
    let g = fixture("Anna", None, cfg).await;
    *g.platform.update.lock().unwrap() = Some(UpdateInfo {
        available: true,
        version: Some("0.2.0".into()),
        notes: Some("Novità".into()),
    });
    let u = g.shell.check_for_update().await.unwrap();
    assert_eq!(
        serde_json::to_value(&u).unwrap(),
        serde_json::json!({"available": true, "version": "0.2.0", "notes": "Novità"})
    );
    g.shell.install_update().await.unwrap();
    assert!(*g.platform.installed.lock().unwrap());
    assert_eq!(
        serde_json::to_value(UpdateInfo::default()).unwrap(),
        serde_json::json!({"available": false})
    );
}

#[tokio::test]
async fn diagnostics_archive_has_everything_and_no_secrets() {
    let h = Hosting::new();
    let f = fixture(
        "Anna",
        Some(&h),
        AppConfig {
            supabase_url: "https://x.supabase.co".into(),
            supabase_anon_key: "ANONKEYVALUE".into(),
            ..Default::default()
        },
    )
    .await;
    link(&f).await;
    std::fs::write(folder(&f).join("Note.txt"), "ciao").unwrap();
    wait_valid(&f, 1).await;
    f.shell.publish("p1", None, None, None).await.unwrap();
    // a token sitting in the credential store must never be exported
    f.secrets
        .set(
            "auth.github",
            "{\"access_token\":\"ghu_SECRETSECRETSECRET1234\"}",
        )
        .unwrap();
    tracing::info!("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in a log line");
    let path = f.shell.export_diagnostics().await.unwrap();
    let mut z = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let names: Vec<String> = (0..z.len())
        .map(|i| z.by_index(i).unwrap().name().to_string())
        .collect();
    for want in [
        "info.json",
        "git-commands.txt",
        "log/rocketsync.log",
        "projects/p1/status.json",
        "projects/p1/journal.json",
        "projects/p1/versions.json",
        "projects/p1/conflicts.json",
    ] {
        assert!(
            names.contains(&want.to_string()),
            "{want} missing in {names:?}"
        );
    }
    let mut all = String::new();
    for n in &names {
        z.by_name(n).unwrap().read_to_string(&mut all).unwrap();
    }
    assert!(
        all.contains("merge-tree") || all.contains("push"),
        "command log present"
    );
    assert!(
        !all.contains("ghu_SECRET") && !all.contains("ghp_abc") && !all.contains("ANONKEYVALUE"),
        "secret leaked"
    );
    assert!(all.contains("\"supabaseAnonKey\": \"***\""));
}

#[derive(Default)]
struct VecSink(Mutex<Vec<(String, serde_json::Value)>>);
impl EventSink for VecSink {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((name.to_string(), payload));
    }
}

#[tokio::test]
async fn engine_events_reach_the_interface_with_contract_names() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    let sink = Arc::new(VecSink::default());
    let rx = f.shell.engine().unwrap().subscribe();
    let settings = f.shell.settings.clone();
    let task = tokio::spawn(events::forward(
        rx,
        sink.clone(),
        f.platform.clone(),
        settings,
    ));
    link(&f).await;
    std::fs::write(folder(&f).join("Note.txt"), "ciao").unwrap();
    wait_valid(&f, 1).await;
    f.shell
        .publish("p1", Some("Titolo".into()), None, None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    task.abort();
    let ev = sink.0.lock().unwrap().clone();
    let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
    assert!(
        names.contains(&"project-status")
            && names.contains(&"version-published")
            && names.contains(&"operation-progress"),
        "{names:?}"
    );
    let vp = ev.iter().find(|(n, _)| n == "version-published").unwrap();
    assert_eq!(vp.1["number"], 1);
    assert_eq!(vp.1["title"], "Titolo");
    assert_eq!(vp.1["projectId"], "p1");
    let ps = ev.iter().find(|(n, _)| n == "project-status").unwrap();
    assert!(ps.1.get("changedFiles").is_some() && ps.1.get("openConflictIds").is_some());
    let op = ev.iter().find(|(n, _)| n == "operation-progress").unwrap();
    for k in ["projectId", "op", "step", "percent", "message"] {
        assert!(op.1.get(k).is_some(), "{k}");
    }
}

#[tokio::test]
async fn auth_status_without_configuration_is_signed_out_and_json_matches_the_contract() {
    let f = fixture("Anna", None, AppConfig::default()).await;
    let st = f.shell.auth_status().await.unwrap();
    assert_eq!(
        serde_json::to_value(&st).unwrap(),
        serde_json::json!({"signedIn": false, "user": null, "supabaseSession": null})
    );
    let e = f.shell.auth_sign_in().await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    assert!(e.message.contains("Supabase"));
    assert!(
        f.platform.opened.lock().unwrap().is_empty(),
        "no browser is opened without configuration"
    );
    f.shell.auth_sign_out().await.unwrap();
}

// ---- quitting with unpublished work ----------------------------------------------------------

use rocket_sync_lib::platform::QuitChoice;
use rocket_sync_lib::shell::{quit_items, quit_message, resolve_remote_base, QuitOutcome};

#[test]
fn remote_base_override_is_accepted_only_in_development() {
    assert_eq!(
        resolve_remote_base(true, Some(" file:///srv ".into())),
        (Some("file:///srv".into()), None)
    );
    let (v, warn) = resolve_remote_base(false, Some("file:///srv".into()));
    assert_eq!(v, None);
    assert!(warn.unwrap().contains("ROCKETSYNC_REMOTE_BASE"));
    assert_eq!(resolve_remote_base(false, None), (None, None));
    assert_eq!(resolve_remote_base(false, Some("  ".into())), (None, None));
    assert_eq!(resolve_remote_base(true, Some(String::new())), (None, None));
}

#[tokio::test]
async fn quit_decision_logic_picks_the_right_projects_and_text() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    assert!(
        quit_items(&[f.shell.get_project_status("p1").await.unwrap()]).is_empty(),
        "clean project: no dialog"
    );

    std::fs::write(folder(&f).join("Note.txt"), "ciao").unwrap();
    std::fs::write(folder(&f).join("Rotto.ork"), &SIMPLE[..SIMPLE.len() / 2]).unwrap();
    wait_valid(&f, 2).await;
    let st = f.shell.get_project_status("p1").await.unwrap();
    let items = quit_items(&[st]);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "progetto");
    assert_eq!(
        items[0].paths,
        vec!["Note.txt".to_string()],
        "the truncated .ork is not publishable"
    );
    assert!(!items[0].has_pending && !items[0].in_conflict);
    assert_eq!(
        quit_message(&items),
        "Ci sono modifiche non pubblicate in progetto. Vuoi pubblicarle prima di uscire?"
    );
    let two = vec![
        items[0].clone(),
        rocket_sync_lib::shell::QuitItem {
            name: "Altro".into(),
            ..items[0].clone()
        },
    ];
    assert!(quit_message(&two).contains("in progetto, Altro."));
    assert_eq!(
        QuitChoice::from_label(rocket_sync_lib::platform::QUIT_PUBLISH),
        QuitChoice::Publish
    );
    assert_eq!(
        QuitChoice::from_label(rocket_sync_lib::platform::QUIT_EXIT),
        QuitChoice::ExitWithoutPublishing
    );
    assert_eq!(
        QuitChoice::from_label(rocket_sync_lib::platform::QUIT_CANCEL),
        QuitChoice::Cancel
    );
    assert_eq!(
        QuitChoice::from_label("chiusa con la X"),
        QuitChoice::Cancel
    );
}

#[tokio::test]
async fn quitting_asks_and_publishes_only_when_told_to() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    // nothing to lose: no dialog at all
    assert_eq!(f.shell.prepare_quit().await, QuitOutcome::Proceed);
    assert!(f.platform.quit_messages.lock().unwrap().is_empty());

    std::fs::write(folder(&f).join("Note.txt"), "ciao").unwrap();
    wait_valid(&f, 1).await;
    // Annulla: stay open, nothing published
    *f.platform.quit_choice.lock().unwrap() = Some(QuitChoice::Cancel);
    assert_eq!(f.shell.prepare_quit().await, QuitOutcome::Cancelled);
    assert_eq!(
        f.platform.quit_messages.lock().unwrap()[0],
        "Ci sono modifiche non pubblicate in progetto. Vuoi pubblicarle prima di uscire?"
    );
    assert_eq!(
        f.shell
            .get_project_status("p1")
            .await
            .unwrap()
            .changed_files
            .len(),
        1
    );
    // Esci senza pubblicare: quit, the change stays on the PC
    *f.platform.quit_choice.lock().unwrap() = Some(QuitChoice::ExitWithoutPublishing);
    assert_eq!(f.shell.prepare_quit().await, QuitOutcome::Proceed);
    assert_eq!(
        f.shell
            .get_project_status("p1")
            .await
            .unwrap()
            .changed_files
            .len(),
        1
    );
    assert!(git(
        &h.root.path().join("base/team/razzo.git"),
        &["tag", "--list"]
    )
    .is_empty());
    // Pubblica ed esci: published, then quit
    *f.platform.quit_choice.lock().unwrap() = Some(QuitChoice::Publish);
    assert_eq!(f.shell.prepare_quit().await, QuitOutcome::Proceed);
    let st = f.shell.get_project_status("p1").await.unwrap();
    assert_eq!(st.state, SyncState::Synced);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(
        git(
            &h.root.path().join("base/team/razzo.git"),
            &["tag", "--list"]
        ),
        "v1"
    );
}

#[tokio::test]
async fn quit_publish_failures_keep_the_app_open() {
    let h = Hosting::new();
    let f = fixture("Anna", Some(&h), AppConfig::default()).await;
    link(&f).await;
    std::fs::write(folder(&f).join("Note.txt"), "ciao").unwrap();
    wait_valid(&f, 1).await;
    f.shell.engine().unwrap().set_identity(None); // publishing now fails with authRequired
    *f.platform.quit_choice.lock().unwrap() = Some(QuitChoice::Publish);
    match f.shell.prepare_quit().await {
        QuitOutcome::PublishFailed(errs) => {
            assert_eq!(errs.len(), 1);
            assert!(errs[0].starts_with("progetto: "), "{errs:?}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn public_config_command_reads_build_values_and_config_json_without_the_engine() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(
        d.path().join("config.json"),
        r#"{"supabaseUrl":"https://x.supabase.co/","supabaseAnonKey":"anon-123","githubOrg":"squadra","updaterPubkey":"SEGRETO-NO"}"#,
    )
    .unwrap();
    std::env::set_var("ROCKETSYNC_DATA_DIR", d.path());
    let r = rocket_sync_lib::commands::get_public_config();
    std::env::remove_var("ROCKETSYNC_DATA_DIR");
    let v = serde_json::to_value(r.unwrap()).unwrap();
    assert_eq!(v["supabaseUrl"], "https://x.supabase.co");
    assert_eq!(v["supabaseAnonKey"], "anon-123");
    assert_eq!(v["githubOrg"], "squadra");
    assert_eq!(
        v.as_object().unwrap().len(),
        3,
        "nothing else is exposed: {v}"
    );
}
