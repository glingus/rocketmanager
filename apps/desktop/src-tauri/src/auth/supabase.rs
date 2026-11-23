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
    /// The server refused the request (bad code, expired session, missing rights...).
    #[error("{0}")]
    Rejected(String),
    /// The refresh token is dead (used, revoked, expired): only a new sign-in helps.
    /// The only error that may make the caller delete stored credentials.
    #[error("{0}")]
    RefreshTokenInvalid(String),
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
    // Edge Functions answer `{ error: { code, message } }`, Supabase Auth `{ error, error_description }`.
    if let Some(s) = body.pointer("/error/message").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    for k in ["error_description", "msg", "message", "error"] {
        if let Some(s) = body.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    format!("errore HTTP {status}")
}

/// Machine-readable error code, in any of the shapes Supabase Auth and the Edge Functions use.
fn error_code(body: &serde_json::Value) -> Option<String> {
    ["/error/code", "/error_code", "/code", "/error"]
        .iter()
        .find_map(|p| body.pointer(p).and_then(|v| v.as_str()))
        .map(str::to_string)
}

/// Codes meaning "this refresh token can never work again".
const DEAD_REFRESH_CODES: &[&str] = &[
    "bad_refresh_token",
    "refresh_token_not_found",
    "refresh_token_already_used",
    "session_not_found",
    "session_expired",
];

/// Classifies a failed HTTP answer. Server trouble (5xx, 429) is transient and must never cost
/// the user their stored credentials; only a dead refresh token does.
fn classify_failure(status: u16, body: &serde_json::Value) -> AuthError {
    let msg = error_message(body, status);
    if status >= 500 || status == 429 {
        return AuthError::Network(msg);
    }
    let code = error_code(body).unwrap_or_default();
    let desc = msg.to_ascii_lowercase();
    if DEAD_REFRESH_CODES.contains(&code.as_str())
        || (code == "invalid_grant" && desc.contains("refresh token"))
    {
        return AuthError::RefreshTokenInvalid(msg);
    }
    AuthError::Rejected(msg)
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
            return Err(classify_failure(status.as_u16(), &json));
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
        let edge = serde_json::json!({"error": {"code": "bad_refresh_token", "message": "Token di rinnovo non valido"}});
        assert_eq!(error_message(&edge, 401), "Token di rinnovo non valido");
    }

    #[test]
    fn only_a_dead_refresh_token_is_fatal() {
        let j = |v: serde_json::Value| v;
        // server trouble: transient
        assert!(matches!(
            classify_failure(
                502,
                &j(serde_json::json!({"error": {"code": "github_oauth_error", "message": "x"}}))
            ),
            AuthError::Network(_)
        ));
        assert!(matches!(
            classify_failure(503, &serde_json::Value::Null),
            AuthError::Network(_)
        ));
        assert!(matches!(
            classify_failure(429, &serde_json::Value::Null),
            AuthError::Network(_)
        ));
        // dead refresh tokens (Edge Function and Supabase Auth shapes)
        assert!(matches!(
            classify_failure(
                401,
                &j(serde_json::json!({"error": {"code": "bad_refresh_token", "message": "x"}}))
            ),
            AuthError::RefreshTokenInvalid(_)
        ));
        assert!(matches!(
            classify_failure(
                400,
                &j(
                    serde_json::json!({"code": 400, "error_code": "refresh_token_already_used", "msg": "Invalid Refresh Token: Already Used"})
                )
            ),
            AuthError::RefreshTokenInvalid(_)
        ));
        assert!(matches!(
            classify_failure(
                400,
                &j(
                    serde_json::json!({"error": "invalid_grant", "error_description": "Invalid Refresh Token: Refresh Token Not Found"})
                )
            ),
            AuthError::RefreshTokenInvalid(_)
        ));
        // an expired session JWT on the Edge Function is not a dead GitHub token
        assert!(matches!(
            classify_failure(
                401,
                &j(
                    serde_json::json!({"error": {"code": "unauthenticated", "message": "Sessione non valida o scaduta"}})
                )
            ),
            AuthError::Rejected(_)
        ));
        // a bad authorization code at sign-in
        assert!(matches!(
            classify_failure(
                400,
                &j(
                    serde_json::json!({"error": "invalid_grant", "error_description": "Codice scaduto"})
                )
            ),
            AuthError::Rejected(_)
        ));
    }
}
