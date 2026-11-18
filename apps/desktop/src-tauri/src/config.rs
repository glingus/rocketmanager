//! Build-time and run-time configuration.
//!
//! Defaults come from environment variables captured at build time (`option_env!`); a
//! `config.json` file in the app data folder overrides any of them. No secret lives here: the
//! Supabase anon key is public by design (Row Level Security protects the data).

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Application configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// `https://<project>.supabase.co`
    pub supabase_url: String,
    /// Public (anon) API key.
    pub supabase_anon_key: String,
    /// GitHub organisation that owns the project repositories.
    pub github_org: String,
    /// Updater endpoint (may contain `{{target}}`, `{{arch}}`, `{{current_version}}`).
    pub updater_endpoint: String,
    /// Public key (minisign, base64) that verifies the update signatures.
    pub updater_pubkey: String,
}

/// Same fields as [`AppConfig`], all optional: what `config.json` may override.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Overrides {
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
    github_org: Option<String>,
    updater_endpoint: Option<String>,
    updater_pubkey: Option<String>,
}

impl AppConfig {
    /// Values captured when the binary was built.
    pub fn from_build() -> Self {
        Self {
            supabase_url: option_env!("ROCKETSYNC_SUPABASE_URL").unwrap_or("").to_string(),
            supabase_anon_key: option_env!("ROCKETSYNC_SUPABASE_ANON_KEY").unwrap_or("").to_string(),
            github_org: option_env!("ROCKETSYNC_GITHUB_ORG").unwrap_or("").to_string(),
            updater_endpoint: option_env!("ROCKETSYNC_UPDATER_ENDPOINT").unwrap_or("").to_string(),
            updater_pubkey: option_env!("ROCKETSYNC_UPDATER_PUBKEY").unwrap_or("").to_string(),
        }
    }

    /// Applies `overrides_json` (the content of `config.json`) on top of `self`.
    pub fn with_overrides(mut self, overrides_json: &str) -> Result<Self, serde_json::Error> {
        let o: Overrides = serde_json::from_str(overrides_json)?;
        let pick = |dst: &mut String, v: Option<String>| {
            if let Some(v) = v {
                let v = v.trim().to_string();
                if !v.is_empty() {
                    *dst = v;
                }
            }
        };
        pick(&mut self.supabase_url, o.supabase_url);
        pick(&mut self.supabase_anon_key, o.supabase_anon_key);
        pick(&mut self.github_org, o.github_org);
        pick(&mut self.updater_endpoint, o.updater_endpoint);
        pick(&mut self.updater_pubkey, o.updater_pubkey);
        self.supabase_url = self.supabase_url.trim_end_matches('/').to_string();
        Ok(self)
    }

    /// Build-time values plus the optional `config.json` of `data_dir`. A malformed file is
    /// reported (the caller logs it) and ignored.
    pub fn load(data_dir: &Path) -> (Self, Option<String>) {
        let base = Self::from_build();
        let file = data_dir.join("config.json");
        match std::fs::read_to_string(&file) {
            Ok(text) => match base.clone().with_overrides(&text) {
                Ok(c) => (c, None),
                Err(e) => (
                    base,
                    Some(format!("config.json non valido ({e}): uso la configurazione di compilazione")),
                ),
            },
            Err(_) => (base.with_overrides("{}").unwrap_or_default(), None),
        }
    }

    /// Whether sign-in can work.
    pub fn auth_configured(&self) -> bool {
        !self.supabase_url.is_empty() && !self.supabase_anon_key.is_empty()
    }

    /// Hosts allowed by the CSP for Supabase, e.g. `https://x.supabase.co` and `wss://x.supabase.co`.
    pub fn supabase_origins(&self) -> Option<(String, String)> {
        let u = url::Url::parse(&self.supabase_url).ok()?;
        let host = u.host_str()?;
        Some((format!("https://{host}"), format!("wss://{host}")))
    }

    /// The configuration without the keys, for diagnostics.
    pub fn redacted(&self) -> serde_json::Value {
        serde_json::json!({
            "supabaseUrl": self.supabase_url,
            "supabaseAnonKey": if self.supabase_anon_key.is_empty() { "" } else { "***" },
            "githubOrg": self.github_org,
            "updaterEndpoint": self.updater_endpoint,
            "updaterPubkey": if self.updater_pubkey.is_empty() { "" } else { "***" },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_win_but_empty_values_do_not() {
        let base = AppConfig {
            supabase_url: "https://a.supabase.co/".into(),
            supabase_anon_key: "k".into(),
            github_org: "org".into(),
            ..Default::default()
        };
        let c = base
            .with_overrides(r#"{"supabaseUrl":"https://b.supabase.co/","githubOrg":"  ","updaterEndpoint":"https://u/x.json"}"#)
            .unwrap();
        assert_eq!(c.supabase_url, "https://b.supabase.co");
        assert_eq!(c.github_org, "org");
        assert_eq!(c.updater_endpoint, "https://u/x.json");
        assert!(c.auth_configured());
        assert_eq!(c.supabase_origins().unwrap().1, "wss://b.supabase.co");
        assert_eq!(c.redacted()["supabaseAnonKey"], "***");
    }

    #[test]
    fn config_file_is_read_and_bad_json_is_reported() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("config.json"), r#"{"githubOrg":"squadra"}"#).unwrap();
        let (c, warn) = AppConfig::load(d.path());
        assert_eq!(c.github_org, "squadra");
        assert!(warn.is_none());
        std::fs::write(d.path().join("config.json"), "{ not json").unwrap();
        let (_, warn) = AppConfig::load(d.path());
        assert!(warn.unwrap().contains("config.json"));
        let e = tempfile::tempdir().unwrap();
        assert!(AppConfig::load(e.path()).1.is_none());
    }
}
