//! `Rocket Sync.exe --self-test <file.json>`: checks the installation without a window, without
//! sign-in and without network, writes a JSON report and exits with 0 (ok) or 1.

use crate::config::AppConfig;
use crate::secrets::SecretStore;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The report (camelCase).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestReport {
    pub ok: bool,
    pub app_version: String,
    pub git_path: Option<String>,
    pub git_version: Option<String>,
    pub webview2_version: Option<String>,
    pub config_ok: bool,
    pub data_dir_writable: bool,
    pub credential_store_ok: bool,
    pub errors: Vec<String>,
}

/// What the checks look at.
pub struct SelfTestInputs<'a> {
    pub app_version: String,
    pub git_path: PathBuf,
    pub data_dir: PathBuf,
    pub webview2_version: Option<String>,
    pub store: &'a dyn SecretStore,
}

fn probe_data_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cartella dati {}: {e}", dir.display()))?;
    let probe = dir.join(format!(".selftest-{}", std::process::id()));
    std::fs::write(&probe, b"ok").map_err(|e| format!("cartella dati {} non scrivibile: {e}", dir.display()))?;
    let back = std::fs::read(&probe).map_err(|e| format!("cartella dati non leggibile: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    if back == b"ok" {
        Ok(())
    } else {
        Err("lettura di prova nella cartella dati non coerente".into())
    }
}

fn probe_credentials(store: &dyn SecretStore) -> Result<(), String> {
    let key = format!("selftest.{}", std::process::id());
    let value = "rocketsync-self-test-\u{e8}";
    store.set(&key, value).map_err(|e| e.to_string())?;
    let got = store.get(&key).map_err(|e| e.to_string());
    let _ = store.delete(&key);
    match got? {
        Some(v) if v == value => {}
        other => return Err(format!("lettura di prova non coerente: {other:?}")),
    }
    match store.get(&key) {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err("la voce di prova non è stata cancellata".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Runs every check; never needs a login or the network.
pub fn run(inputs: &SelfTestInputs<'_>) -> SelfTestReport {
    let mut errors = Vec::new();

    // git: present and recent enough
    let git = rs_git::Git::new(rs_git::GitConfig {
        git_path: inputs.git_path.clone(),
        ..rs_git::GitConfig::default()
    });
    let git_version = match git.ensure_min_version() {
        Ok(v) => Some(v.to_string()),
        Err(e) => {
            errors.push(format!("git ({}): {e}", inputs.git_path.display()));
            None
        }
    };

    // data folder
    let data_dir_writable = match probe_data_dir(&inputs.data_dir) {
        Ok(()) => true,
        Err(e) => {
            errors.push(e);
            false
        }
    };

    // config.json (only if the data folder is usable)
    let config_ok = if data_dir_writable {
        match AppConfig::load(&inputs.data_dir).1 {
            None => true,
            Some(w) => {
                errors.push(w);
                false
            }
        }
    } else {
        false
    };

    // credential store
    let credential_store_ok = match probe_credentials(inputs.store) {
        Ok(()) => true,
        Err(e) => {
            errors.push(format!("archivio delle credenziali: {e}"));
            false
        }
    };

    SelfTestReport {
        ok: errors.is_empty(),
        app_version: inputs.app_version.clone(),
        git_path: Some(inputs.git_path.to_string_lossy().into_owned()),
        git_version,
        webview2_version: inputs.webview2_version.clone(),
        config_ok,
        data_dir_writable,
        credential_store_ok,
        errors,
    }
}

/// The WebView2 runtime version (Windows only).
pub fn webview2_version() -> Option<String> {
    #[cfg(windows)]
    {
        tauri::webview_version().ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// `["--self-test", "<file>"]` → the output path.
pub fn parse_args(args: &[String]) -> Option<PathBuf> {
    let i = args.iter().position(|a| a == "--self-test")?;
    args.get(i + 1).filter(|p| !p.starts_with("--")).map(PathBuf::from)
}

/// Handles the command line: `Some(exit code)` if it was a self-test request.
pub fn handle_cli(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--self-test") {
        return None;
    }
    let Some(out) = parse_args(args) else {
        eprintln!("uso: --self-test <file.json>");
        return Some(2);
    };
    let store = crate::secrets::system_store();
    let report = run(&SelfTestInputs {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        git_path: crate::paths::git_path(),
        data_dir: crate::paths::data_dir(),
        webview2_version: webview2_version(),
        store: &store,
    });
    let json = serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into());
    if let Some(parent) = out.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&out, json) {
        eprintln!("impossibile scrivere {}: {e}", out.display());
        return Some(1);
    }
    Some(if report.ok { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{memory_store, RawEntries, SecretError};
    use std::sync::Arc;

    fn git_path() -> PathBuf {
        PathBuf::from("git")
    }

    #[test]
    fn healthy_installation_is_ok_and_json_is_camel_case() {
        let d = tempfile::tempdir().unwrap();
        let store = memory_store();
        let r = run(&SelfTestInputs {
            app_version: "1.2.3".into(),
            git_path: git_path(),
            data_dir: d.path().join("dati"),
            webview2_version: None,
            store: &store,
        });
        assert!(r.ok, "{r:#?}");
        assert!(r.config_ok && r.data_dir_writable && r.credential_store_ok);
        assert!(r.git_version.is_some());
        assert!(r.errors.is_empty());
        let j = serde_json::to_value(&r).unwrap();
        for k in ["ok", "appVersion", "gitPath", "gitVersion", "webview2Version", "configOk", "dataDirWritable", "credentialStoreOk", "errors"] {
            assert!(j.get(k).is_some(), "missing {k}");
        }
        assert_eq!(j["appVersion"], "1.2.3");
        assert!(j["webview2Version"].is_null());
        // the probe left nothing behind
        assert_eq!(std::fs::read_dir(d.path().join("dati")).unwrap().count(), 0);
    }

    #[test]
    fn every_failure_is_reported() {
        let d = tempfile::tempdir().unwrap();
        // data dir is a file
        let blocked = d.path().join("file");
        std::fs::write(&blocked, b"x").unwrap();
        // credential store that refuses everything
        struct Broken;
        impl SecretStore for Broken {
            fn get(&self, _: &str) -> Result<Option<String>, SecretError> { Err(SecretError("rotto".into())) }
            fn set(&self, _: &str, _: &str) -> Result<(), SecretError> { Err(SecretError("rotto".into())) }
            fn delete(&self, _: &str) -> Result<(), SecretError> { Ok(()) }
        }
        let r = run(&SelfTestInputs {
            app_version: "1".into(),
            git_path: PathBuf::from("/nonexistent/git"),
            data_dir: blocked.join("dati"),
            webview2_version: Some("120.0".into()),
            store: &Broken,
        });
        assert!(!r.ok);
        assert!(!r.data_dir_writable && !r.config_ok && !r.credential_store_ok);
        assert!(r.git_version.is_none());
        assert_eq!(r.errors.len(), 3 + 0, "{:#?}", r.errors);
        assert_eq!(r.webview2_version.as_deref(), Some("120.0"));
    }

    #[test]
    fn a_broken_config_file_makes_the_test_fail() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("config.json"), "{ no").unwrap();
        let store = memory_store();
        let r = run(&SelfTestInputs {
            app_version: "1".into(),
            git_path: git_path(),
            data_dir: d.path().to_path_buf(),
            webview2_version: None,
            store: &store,
        });
        assert!(!r.ok && !r.config_ok && r.data_dir_writable);
        assert!(r.errors[0].contains("config.json"));
    }

    #[test]
    fn credential_store_that_loses_values_is_detected() {
        struct Forgetful(Arc<crate::secrets::MemoryRaw>);
        impl SecretStore for Forgetful {
            fn get(&self, _: &str) -> Result<Option<String>, SecretError> { Ok(None) }
            fn set(&self, k: &str, v: &str) -> Result<(), SecretError> { self.0.write(k, v) }
            fn delete(&self, _: &str) -> Result<(), SecretError> { Ok(()) }
        }
        let d = tempfile::tempdir().unwrap();
        let r = run(&SelfTestInputs {
            app_version: "1".into(),
            git_path: git_path(),
            data_dir: d.path().to_path_buf(),
            webview2_version: None,
            store: &Forgetful(Arc::new(crate::secrets::MemoryRaw::default())),
        });
        assert!(!r.credential_store_ok && !r.ok);
    }

    #[test]
    fn command_line_parsing_and_exit_codes() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&a(&["--self-test", "out.json"])), Some(PathBuf::from("out.json")));
        assert_eq!(parse_args(&a(&["--minimized", "--self-test", "x.json"])), Some(PathBuf::from("x.json")));
        assert_eq!(parse_args(&a(&["--self-test"])), None);
        assert_eq!(parse_args(&a(&["--self-test", "--other"])), None);
        assert_eq!(handle_cli(&a(&["--minimized"])), None);
        assert_eq!(handle_cli(&a(&["--self-test"])), Some(2));
    }

    #[test]
    fn cli_writes_the_report_and_returns_the_exit_code() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("sub/report.json");
        std::env::set_var("ROCKETSYNC_DATA_DIR", d.path().join("data"));
        let code = handle_cli(&["--self-test".to_string(), out.to_string_lossy().into_owned()]).unwrap();
        std::env::remove_var("ROCKETSYNC_DATA_DIR");
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(v["ok"].as_bool().unwrap(), code == 0, "{v}");
        assert!(v["errors"].is_array());
    }
}
