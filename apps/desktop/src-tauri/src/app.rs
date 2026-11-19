//! Application start-up: plugins, tray, window behaviour and the background services.

use crate::commands::{self, AppState};
use crate::config::AppConfig;
use crate::events::{self, EventSink};
use crate::platform::{BoxFut, Platform, UpdateInfo};
use crate::secrets::{system_store, SecretStore};
use crate::settings::AppSettings;
use crate::shell::{app_error, Shell, ShellParts};
use crate::{auth::AuthService, enrich::ShellInspector, logging, paths};
use rs_core::{Engine, EngineConfig, ErrorCode};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_updater::UpdaterExt as _;

impl EventSink for AppHandle {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        if let Err(e) = Emitter::emit(self, name, payload) {
            tracing::warn!(event = name, error = %e, "emit failed");
        }
    }
}

/// [`Platform`] on top of Tauri and its plugins.
struct TauriPlatform {
    app: AppHandle,
    config: AppConfig,
}

impl TauriPlatform {
    fn updater(&self) -> Result<tauri_plugin_updater::Updater, String> {
        let endpoint = url::Url::parse(&self.config.updater_endpoint).map_err(|e| e.to_string())?;
        self.app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .pubkey(self.config.updater_pubkey.clone())
            .build()
            .map_err(|e| e.to_string())
    }
}

impl Platform for TauriPlatform {
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    }
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
    fn home_dir(&self) -> Option<PathBuf> {
        self.app.path().home_dir().ok()
    }
    fn pick_folder(&self, default: Option<&Path>) -> Option<PathBuf> {
        let mut b = self.app.dialog().file().set_title("Scegli la cartella del progetto");
        if let Some(d) = default.filter(|d| d.is_dir()) {
            b = b.set_directory(d);
        }
        b.blocking_pick_folder().and_then(|p| p.into_path().ok())
    }
    fn set_autostart(&self, enabled: bool) -> Result<(), String> {
        let m = self.app.autolaunch();
        if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
    }
    fn check_update(&self) -> BoxFut<'_, Result<UpdateInfo, String>> {
        Box::pin(async move {
            let updater = self.updater()?;
            match updater.check().await.map_err(|e| e.to_string())? {
                Some(u) => Ok(UpdateInfo {
                    available: true,
                    version: Some(u.version.clone()),
                    notes: u.body.clone(),
                }),
                None => Ok(UpdateInfo::default()),
            }
        })
    }
    fn install_update(&self) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async move {
            let updater = self.updater()?;
            let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
                return Ok(());
            };
            update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
            self.app.restart();
        })
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Apri Rocket Sync", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sincronizza tutto ora", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sync, &quit])?;
    let mut b = TrayIconBuilder::new()
        .tooltip("Rocket Sync")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "sync" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(shell) = app.state::<AppState>().try_shell() {
                        shell.sync_all().await;
                    }
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(shell) = app.state::<AppState>().try_shell() {
                        if let Ok(e) = shell.engine() {
                            e.shutdown().await;
                        }
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Builds the services: engine (with startup recovery), authentication, settings.
async fn build_shell(app: AppHandle, minimize_flag: Arc<std::sync::atomic::AtomicBool>) -> Arc<Shell> {
    let data_dir = paths::data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    logging::init(&data_dir);
    let (config, warn) = AppConfig::load(&data_dir);
    if let Some(w) = warn {
        tracing::warn!("{w}");
    }
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Rocket Sync starting");
    let store = rs_store::Store::open(&data_dir.join("rocketsync.db")).unwrap_or_else(|e| {
        tracing::error!(error = %e, "cannot open the local database");
        rs_store::Store::open_in_memory().expect("in-memory database")
    });
    let settings = AppSettings::load(&store);
    minimize_flag.store(settings.minimize_to_tray, Ordering::SeqCst);
    let settings = Arc::new(RwLock::new(settings));
    let secrets: Arc<dyn SecretStore> = Arc::new(system_store());
    let auth = Arc::new(AuthService::new(config.clone(), secrets.clone()));
    let platform: Arc<dyn Platform> = Arc::new(TauriPlatform { app: app.clone(), config: config.clone() });

    let git_path = paths::git_path();
    let git_version = rs_git::Git::new(rs_git::GitConfig { git_path: git_path.clone(), ..Default::default() })
        .version()
        .ok()
        .map(|v| v.to_string());

    let mut cfg = EngineConfig::new(&data_dir);
    cfg.git.git_path = git_path;
    // The same executable answers git's credential prompts (see askpass.rs).
    cfg.git.askpass = std::env::current_exe().ok();
    cfg.git.extra_env = vec![(crate::askpass::ENV_FLAG.to_string(), "1".to_string())];
    cfg.inspector = Arc::new(ShellInspector::default());
    #[cfg(windows)]
    {
        cfg.detector = Arc::new(rs_core::WindowsEditorDetector);
    }
    cfg.client_version = env!("CARGO_PKG_VERSION").to_string();
    cfg.timing.fetch_interval = Duration::from_secs(settings.read().map(|s| s.fetch_interval_seconds).unwrap_or(60) as u64);

    let engine = match Engine::new(cfg).await {
        Ok(engine) => {
            let sink: Arc<dyn EventSink> = Arc::new(app.clone());
            tokio::spawn(events::forward(engine.subscribe(), sink, platform.clone(), settings.clone()));
            engine.set_identity(auth.identity());
            if let Err(e) = engine.start().await {
                tracing::error!(error = %e, "engine start failed");
            }
            Ok(engine)
        }
        Err(e) => {
            tracing::error!(error = %e, "engine not started");
            Err(e.to_app_error())
        }
    };

    Arc::new(Shell::new(ShellParts {
        engine,
        auth,
        secrets,
        store,
        platform,
        data_dir,
        config,
        git_version,
        settings,
        remote_base: std::env::var("ROCKETSYNC_REMOTE_BASE").ok().filter(|v| !v.trim().is_empty()),
    }))
}

/// Keeps the GitHub token fresh while the application runs.
fn spawn_token_refresher(shell: Arc<Shell>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            if let Err(e) = shell.auth.ensure_github_token().await {
                if e.code != ErrorCode::AuthRequired {
                    tracing::info!(error = %e, "github token refresh skipped");
                }
            }
        }
    });
}

/// Runs the application.
pub fn run() {
    let state = AppState::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            let minimize = app.state::<AppState>().minimize_to_tray.clone();
            tauri::async_runtime::spawn(async move {
                let shell = build_shell(handle.clone(), minimize.clone()).await;
                // `--minimized` (autostart): stay in the tray if the user wants that.
                if std::env::args().any(|a| a == "--minimized") && minimize.load(Ordering::SeqCst) {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                spawn_token_refresher(shell.clone());
                handle.state::<AppState>().set_shell(shell);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.minimize_to_tray.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::auth_sign_in,
            commands::auth_sign_out,
            commands::secure_store_get,
            commands::secure_store_set,
            commands::secure_store_delete,
            commands::list_local_projects,
            commands::suggest_project_folder,
            commands::check_folder,
            commands::pick_folder,
            commands::link_project,
            commands::unlink_project,
            commands::get_project_status,
            commands::publish,
            commands::sync_now,
            commands::update_now,
            commands::discard_changes,
            commands::answer_stale_save,
            commands::notify_remote_changed,
            commands::get_publish_policy,
            commands::set_publish_policy,
            commands::list_versions,
            commands::get_version,
            commands::compare_versions,
            commands::export_version,
            commands::open_version_copy,
            commands::restore_version,
            commands::list_conflicts,
            commands::get_conflict,
            commands::open_conflict_copy,
            commands::resolve_conflict,
            commands::list_snapshots,
            commands::export_snapshot,
            commands::get_app_info,
            commands::open_in_openrocket,
            commands::open_folder,
            commands::get_app_settings,
            commands::set_app_settings,
            commands::export_diagnostics,
            commands::check_for_update,
            commands::install_update,
            commands::notify_desktop,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            let _ = app_error(ErrorCode::Internal, e.to_string());
            eprintln!("errore nell'avvio di Rocket Sync: {e}");
            std::process::exit(1);
        });
}
