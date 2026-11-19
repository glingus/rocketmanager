//! HTTP calls to Supabase Auth, to the `github-token-refresh` Edge Function and to the GitHub API.

use crate::config::AppConfig;
use serde::Deserialize;

/// Errors of the authentication layer.
#[derive(Debug, Clone, thiserror::Error)]
pub enum AuthError {
    /// Supabase is not configured (no URL or anon key).
    #[error("Rocket Sync non è configurato per l'accesso: mancano l'indirizzo o la chiave pubblica di Supabase")]
    NotConfigured,
    /// The server could not be reached.
    #[error("impossibile raggiungere il server: {0}")]
    Network(String),
    /// The server refused the request (bad code, bad or expired refresh token...).
    #[error("{0}")]
    Rejected(String),
    /// The answer could not be understood.
    #[error("risposta non valida dal server: {0}")]
    Invalid(String),
    /// The user did not complete the browser flow.
    #[error("accesso annullato o scaduto: {0}")]
    Cancelled(String),
}

fn net(e: reqwest::Error) -> AuthError {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        AuthError::Network(e.without_url().to_string())
    } else {
        AuthError::Invalid(e.without_url().to_string())
    }
}

/// Session returned by `/auth/v1/token`.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub provider_token: Option<String>,
    #[serde(default)]
    pub provider_refresh_token: Option<String>,
}

/// Tokens returned by the `github-token-refresh` Edge Function.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub refresh_token_expires_at: Option<String>,
}

/// `GET /user` of the GitHub API (only what is needed).
#[derive(Debug, Clone, Deserialize)]
pub struct GithubUser {
    pub id: i64,
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

fn error_message(body: &serde_json::Value, status: u16) -> String {
    for k in ["error_description", "msg", "message", "error"] {
        if let Some(s) = body.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    format!("errore HTTP {status}")
}

/// Client of one Supabase project.
#[derive(Clone)]
pub struct SupabaseClient {
    base: String,
    anon: String,
    http: reqwest::Client,
}

impl SupabaseClient {
    pub fn new(cfg: &AppConfig, http: reqwest::Client) -> Result<Self, AuthError> {
        if !cfg.auth_configured() {
            return Err(AuthError::NotConfigured);
        }
        Ok(Self {
            base: cfg.supabase_url.trim_end_matches('/').to_string(),
            anon: cfg.supabase_anon_key.clone(),
            http,
        })
    }

    /// The URL to open in the system browser.
    pub fn authorize_url(&self, redirect_to: &str, code_challenge: &str) -> String {
        url::Url::parse_with_params(
            &format!("{}/auth/v1/authorize", self.base),
            &[
                ("provider", "github"),
                ("redirect_to", redirect_to),
                ("code_challenge", code_challenge),
                ("code_challenge_method", "s256"),
            ],
        )
        .map(|u| u.to_string())
        .unwrap_or_default()
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        url: &str,
        bearer: Option<&str>,
        body: serde_json::Value,
    ) -> Result<T, AuthError> {
        let mut req = self.http.post(url).header("apikey", &self.anon).json(&body);
        if let Some(b) = bearer {
            req = req.bearer_auth(b);
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(AuthError::Rejected(error_message(&json, status.as_u16())));
        }
        serde_json::from_value(json).map_err(|e| AuthError::Invalid(e.to_string()))
    }

    /// Exchanges the authorization code (PKCE flow).
    pub async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
    ) -> Result<TokenResponse, AuthError> {
        self.post_json(
            &format!("{}/auth/v1/token?grant_type=pkce", self.base),
            None,
            serde_json::json!({"auth_code": code, "code_verifier": verifier}),
        )
        .await
    }

    /// Renews the Supabase session.
    pub async fn refresh_session(&self, refresh_token: &str) -> Result<TokenResponse, AuthError> {
        self.post_json(
            &format!("{}/auth/v1/token?grant_type=refresh_token", self.base),
            None,
            serde_json::json!({"refresh_token": refresh_token}),
        )
        .await
    }

    /// Renews the GitHub user token through the Edge Function (the client secret stays on the server).
    pub async fn refresh_github_token(
        &self,
        access_jwt: &str,
        refresh_token: &str,
    ) -> Result<GithubTokens, AuthError> {
        self.post_json(
            &format!("{}/functions/v1/github-token-refresh", self.base),
            Some(access_jwt),
            serde_json::json!({"refreshToken": refresh_token}),
        )
        .await
    }

    /// Ends the session on the server (best effort).
    pub async fn logout(&self, access_jwt: &str) {
        let _ = self
            .http
            .post(format!("{}/auth/v1/logout", self.base))
            .header("apikey", &self.anon)
            .bearer_auth(access_jwt)
            .send()
            .await;
    }
}

/// `GET <api>/user` with the GitHub token.
pub async fn fetch_github_user(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
) -> Result<GithubUser, AuthError> {
    let resp = http
        .get(format!("{}/user", api_base.trim_end_matches('/')))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "RocketSync")
        .bearer_auth(token)
        .send()
        .await
        .map_err(net)?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AuthError::Rejected(format!(
            "GitHub ha rifiutato il token: {}",
            error_message(&json, status.as_u16())
        )));
    }
    serde_json::from_value(json).map_err(|e| AuthError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> SupabaseClient {
        let cfg = AppConfig {
            supabase_url: "https://abc.supabase.co".into(),
            supabase_anon_key: "anon".into(),
            ..Default::default()
        };
        SupabaseClient::new(&cfg, reqwest::Client::new()).unwrap()
    }

    #[test]
    fn authorize_url_has_the_expected_parameters() {
        let u = url::Url::parse(&client().authorize_url("http://127.0.0.1:53682/callback", "CHAL"))
            .unwrap();
        assert_eq!(u.host_str(), Some("abc.supabase.co"));
        assert_eq!(u.path(), "/auth/v1/authorize");
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["provider"], "github");
        assert_eq!(q["redirect_to"], "http://127.0.0.1:53682/callback");
        assert_eq!(q["code_challenge"], "CHAL");
        assert_eq!(q["code_challenge_method"], "s256");
    }

    #[test]
    fn missing_configuration_is_reported() {
        assert!(matches!(
            SupabaseClient::new(&AppConfig::default(), reqwest::Client::new()),
            Err(AuthError::NotConfigured)
        ));
    }

    #[test]
    fn error_messages_are_extracted() {
        let j =
            serde_json::json!({"error": "invalid_grant", "error_description": "Codice scaduto"});
        assert_eq!(error_message(&j, 400), "Codice scaduto");
        assert_eq!(
            error_message(&serde_json::json!({"msg": "boh"}), 400),
            "boh"
        );
        assert_eq!(
            error_message(&serde_json::Value::Null, 502),
            "errore HTTP 502"
        );
    }
}
