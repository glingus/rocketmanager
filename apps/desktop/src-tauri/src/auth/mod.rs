//! Sign-in with Supabase (GitHub provider), PKCE flow with a loopback redirect, and the
//! credentials derived from it.
//!
//! * The Supabase session and the **GitHub token** (`provider_token` + `provider_refresh_token`)
//!   are stored in Credential Manager; the GitHub token is never sent to the interface.
//! * The GitHub token is renewed through the `github-token-refresh` Edge Function.
//! * The Git identity is the display name plus the GitHub noreply address, from `GET /user`.

pub mod callback;
pub mod pkce;
pub mod supabase;

use crate::config::AppConfig;
use crate::secrets::SecretStore;
use rs_core::{AppError, ErrorCode, Identity};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use supabase::{fetch_github_user, AuthError, SupabaseClient};

const KEY_SESSION: &str = "auth.session";
const KEY_GITHUB: &str = "auth.github";
const KEY_PROFILE: &str = "auth.profile";
/// Renew the Supabase session when it expires within this many seconds. Generous, because the
/// interface takes its access token from here (`auth_status`) and must never hold an expired one.
const SESSION_REFRESH_MARGIN: i64 = 5 * 60;
/// Renew the GitHub token when it expires within this many seconds.
const GITHUB_REFRESH_MARGIN: i64 = 15 * 60;
/// GitHub App user tokens last 8 hours (minus a safety margin) when expiry is enabled.
const GITHUB_TOKEN_LIFETIME: i64 = 8 * 3600 - 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredGithub {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProfile {
    github_id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

/// `AuthStatus.user` of the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub github_login: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// `AuthStatus.supabaseSession` of the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseSession {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

/// `AuthStatus` of the contract. Never contains the GitHub token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub signed_in: bool,
    pub user: Option<AuthUser>,
    pub supabase_session: Option<SupabaseSession>,
}

impl AuthStatus {
    pub fn signed_out() -> Self {
        Self {
            signed_in: false,
            user: None,
            supabase_session: None,
        }
    }
}

/// Maps an authentication failure to the contract's `AppError`.
pub fn auth_error_to_app(e: &AuthError) -> AppError {
    let (code, retryable) = match e {
        AuthError::Network(_) => (ErrorCode::Network, true),
        AuthError::Rejected(_) | AuthError::Cancelled(_) => (ErrorCode::AuthFailed, false),
        AuthError::RefreshTokenInvalid(_) => (ErrorCode::AuthRequired, false),
        AuthError::NotConfigured | AuthError::Invalid(_) => (ErrorCode::Internal, false),
    };
    AppError {
        code,
        message: match e {
            AuthError::Network(_) => {
                "Impossibile raggiungere il server di accesso. Controlla la connessione.".into()
            }
            AuthError::Rejected(m) => format!("Accesso non riuscito: {m}."),
            AuthError::RefreshTokenInvalid(_) => "La sessione è scaduta: accedi di nuovo.".into(),
            AuthError::Cancelled(_) => "Accesso annullato o scaduto. Riprova.".into(),
            AuthError::NotConfigured | AuthError::Invalid(_) => e.to_string(),
        },
        detail: Some(e.to_string()),
        retryable,
    }
}

/// The GitHub token of the signed-in user (used by the askpass helper).
pub fn load_github_token(store: &dyn SecretStore) -> Option<String> {
    let s = store.get(KEY_GITHUB).ok().flatten()?;
    serde_json::from_str::<StoredGithub>(&s)
        .ok()
        .map(|g| g.access_token)
}

#[cfg(test)]
pub fn save_github_token_for_tests(store: &dyn SecretStore, token: &str) {
    let g = StoredGithub {
        access_token: token.to_string(),
        refresh_token: None,
        expires_at: None,
    };
    store
        .set(KEY_GITHUB, &serde_json::to_string(&g).unwrap())
        .unwrap();
}

fn identity_of(p: &StoredProfile) -> Identity {
    let name = p
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&p.login)
        .to_string();
    Identity {
        name,
        email: format!("{}+{}@users.noreply.github.com", p.github_id, p.login),
    }
}

fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp())
}

/// Sign-in service.
pub struct AuthService {
    cfg: AppConfig,
    store: Arc<dyn SecretStore>,
    http: reqwest::Client,
    github_api: String,
    signing_in: AtomicBool,
    /// One renewal at a time: refresh tokens are single-use, so two concurrent renewals with the
    /// same token make the second one fail (and look like a dead token).
    refresh_lock: tokio::sync::Mutex<()>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AuthService {
    pub fn new(cfg: AppConfig, store: Arc<dyn SecretStore>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("RocketSync")
            .build()
            .unwrap_or_default();
        Self {
            cfg,
            store,
            http,
            github_api: "https://api.github.com".into(),
            signing_in: AtomicBool::new(false),
            refresh_lock: tokio::sync::Mutex::new(()),
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        }
    }

    /// Test hooks: other GitHub API base and clock.
    #[cfg(test)]
    pub fn with_test_hooks(
        mut self,
        github_api: &str,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        self.github_api = github_api.to_string();
        self.now = now;
        self
    }

    fn client(&self) -> Result<SupabaseClient, AuthError> {
        SupabaseClient::new(&self.cfg, self.http.clone())
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn read<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Option<T> {
        self.store
            .get(key)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    fn write<T: Serialize>(&self, key: &str, v: &T) -> Result<(), AuthError> {
        let s = serde_json::to_string(v).map_err(|e| AuthError::Invalid(e.to_string()))?;
        self.store
            .set(key, &s)
            .map_err(|e| AuthError::Invalid(e.to_string()))
    }

    fn clear(&self) {
        for k in [KEY_SESSION, KEY_GITHUB, KEY_PROFILE] {
            let _ = self.store.delete(k);
        }
    }

    /// The Git identity of the signed-in user.
    pub fn identity(&self) -> Option<Identity> {
        let p: StoredProfile = self.read(KEY_PROFILE)?;
        let _: StoredSession = self.read(KEY_SESSION)?;
        Some(identity_of(&p))
    }

    fn status_from_store(&self) -> AuthStatus {
        let Some(s) = self.read::<StoredSession>(KEY_SESSION) else {
            return AuthStatus::signed_out();
        };
        let user = self.read::<StoredProfile>(KEY_PROFILE).map(|p| AuthUser {
            name: identity_of(&p).name,
            github_login: p.login,
            avatar_url: p.avatar_url,
        });
        AuthStatus {
            signed_in: true,
            user,
            supabase_session: Some(SupabaseSession {
                access_token: s.access_token,
                refresh_token: s.refresh_token,
                expires_at: s.expires_at,
            }),
        }
    }

    /// Current status; renews a Supabase session that is about to expire. This shell is the only
    /// owner of the session: the interface takes its access token from here and never refreshes it.
    pub async fn status(&self) -> Result<AuthStatus, AppError> {
        match self.fresh_session().await {
            Ok(_) | Err(AuthError::NotConfigured) => {}
            Err(AuthError::RefreshTokenInvalid(_)) => {
                // The session is dead for good: the user has to sign in again.
                self.clear();
            }
            Err(e) => tracing::info!(error = %e, "session renewal postponed"), // offline, server trouble
        }
        Ok(self.status_from_store())
    }

    /// The stored session, renewed first if it expires within [`SESSION_REFRESH_MARGIN`].
    /// `None` when signed out. Serialized with every other renewal.
    async fn fresh_session(&self) -> Result<Option<StoredSession>, AuthError> {
        let _guard = self.refresh_lock.lock().await;
        self.fresh_session_locked().await
    }

    /// Same as [`Self::fresh_session`]; the caller holds `refresh_lock`. The session is re-read
    /// here, after the lock, so a renewal done meanwhile by someone else is reused, not repeated.
    async fn fresh_session_locked(&self) -> Result<Option<StoredSession>, AuthError> {
        let Some(s) = self.read::<StoredSession>(KEY_SESSION) else {
            return Ok(None);
        };
        if s.expires_at > self.now() + SESSION_REFRESH_MARGIN {
            return Ok(Some(s));
        }
        let t = self.client()?.refresh_session(&s.refresh_token).await?;
        let renewed = self.session_from(&t);
        self.write(KEY_SESSION, &renewed)?;
        Ok(Some(renewed))
    }

    fn session_from(&self, t: &supabase::TokenResponse) -> StoredSession {
        StoredSession {
            access_token: t.access_token.clone(),
            refresh_token: t.refresh_token.clone(),
            expires_at: t
                .expires_at
                .or_else(|| t.expires_in.map(|e| self.now() + e))
                .unwrap_or_else(|| self.now() + 3600),
        }
    }

    /// Interactive sign-in. `open_browser` receives the URL to open in the system browser.
    pub async fn sign_in<F>(&self, open_browser: F) -> Result<AuthStatus, AppError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        if self.signing_in.swap(true, Ordering::SeqCst) {
            return Err(auth_error_to_app(&AuthError::Cancelled(
                "un accesso è già in corso".into(),
            )));
        }
        let r = self.sign_in_inner(open_browser).await;
        self.signing_in.store(false, Ordering::SeqCst);
        r.map_err(|e| auth_error_to_app(&e))
    }

    async fn sign_in_inner<F>(&self, open_browser: F) -> Result<AuthStatus, AuthError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        let client = self.client()?;
        let verifier = pkce::generate_verifier();
        let challenge = pkce::challenge(&verifier);
        let (listener, port) = callback::bind_loopback()
            .await
            .map_err(|e| AuthError::Cancelled(e.to_string()))?;
        let url = client.authorize_url(&callback::redirect_url(port), &challenge);
        open_browser(&url)
            .map_err(|e| AuthError::Cancelled(format!("impossibile aprire il browser ({e})")))?;
        let cb = callback::wait_for_callback(listener, Duration::from_secs(300))
            .await
            .map_err(|e| AuthError::Cancelled(e.to_string()))?;
        let code = match cb {
            callback::Callback::Code(c) => c,
            callback::Callback::Error(e) => return Err(AuthError::Rejected(e)),
        };
        let t = client.exchange_code(&code, &verifier).await?;
        let gh_token = t.provider_token.clone().filter(|p| !p.is_empty()).ok_or_else(|| {
            AuthError::Rejected(
                "GitHub non ha restituito il token di accesso: controlla il collegamento tra Supabase e la GitHub App".into(),
            )
        })?;
        let user = fetch_github_user(&self.http, &self.github_api, &gh_token).await?;
        let session = self.session_from(&t);
        let github = StoredGithub {
            access_token: gh_token,
            expires_at: t
                .provider_refresh_token
                .as_ref()
                .map(|_| self.now() + GITHUB_TOKEN_LIFETIME),
            refresh_token: t.provider_refresh_token.clone(),
        };
        let profile = StoredProfile {
            github_id: user.id,
            login: user.login,
            name: user.name,
            avatar_url: user.avatar_url,
        };
        self.write(KEY_SESSION, &session)?;
        self.write(KEY_GITHUB, &github)?;
        self.write(KEY_PROFILE, &profile)?;
        Ok(self.status_from_store())
    }

    /// Ends the session: server side (best effort) and every stored credential.
    pub async fn sign_out(&self) {
        if let (Ok(c), Some(s)) = (self.client(), self.read::<StoredSession>(KEY_SESSION)) {
            c.logout(&s.access_token).await;
        }
        self.clear();
    }

    /// Renews the GitHub token if it is about to expire. Call before network operations.
    pub async fn ensure_github_token(&self) -> Result<(), AppError> {
        self.refresh_github_token_if(None).await
    }

    /// Refreshes the GitHub token now, whatever its stored expiry says (GitHub refused it).
    /// Returns `Ok(true)` when a new token is in place (refreshed here, or meanwhile by another
    /// caller), `Ok(false)` when there is nothing to refresh with (a token without a refresh
    /// token: only a new sign-in helps).
    pub async fn force_refresh_github_token(&self) -> Result<bool, AppError> {
        let Some(refused) = self.read::<StoredGithub>(KEY_GITHUB) else {
            return Ok(false);
        };
        if refused.refresh_token.is_none() {
            return Ok(false);
        }
        self.refresh_github_token_if(Some(&refused.access_token))
            .await
            .map(|()| true)
    }

    /// `refused`: the token GitHub turned down (forced refresh); `None` for the periodic check,
    /// which refreshes only near the stored expiry.
    async fn refresh_github_token_if(&self, refused: Option<&str>) -> Result<(), AppError> {
        let _guard = self.refresh_lock.lock().await;
        // Read after the lock: another caller may have refreshed while we waited.
        let Some(g) = self.read::<StoredGithub>(KEY_GITHUB) else {
            return Err(AppError {
                code: ErrorCode::AuthRequired,
                message: "Accedi con GitHub per continuare.".into(),
                detail: None,
                retryable: false,
            });
        };
        let Some(rt) = g.refresh_token.clone() else {
            return Ok(()); // no refresh token: the token does not expire (or only a sign-in helps)
        };
        let due = match refused {
            // Already replaced since GitHub refused it: nothing left to do.
            Some(old) => old == g.access_token,
            // Without a known expiry the token is refreshed only on demand.
            None => g
                .expires_at
                .is_some_and(|exp| exp <= self.now() + GITHUB_REFRESH_MARGIN),
        };
        if !due {
            return Ok(());
        }
        let client = self.client().map_err(|e| auth_error_to_app(&e))?;
        let session = match self.fresh_session_locked().await {
            Ok(Some(s)) => s,
            Ok(None) => {
                return Err(AppError {
                    code: ErrorCode::AuthRequired,
                    message: "La sessione è scaduta: accedi di nuovo.".into(),
                    detail: None,
                    retryable: false,
                })
            }
            Err(e) => return Err(auth_error_to_app(&e)),
        };
        match client
            .refresh_github_token(&session.access_token, &rt)
            .await
        {
            Ok(t) => {
                let new = StoredGithub {
                    access_token: t.access_token,
                    refresh_token: t.refresh_token.or(Some(rt)),
                    expires_at: t.expires_at.as_deref().and_then(parse_iso),
                };
                self.write(KEY_GITHUB, &new)
                    .map_err(|e| auth_error_to_app(&e))?;
                Ok(())
            }
            Err(AuthError::RefreshTokenInvalid(m)) => {
                // The GitHub refresh token is dead: only a new sign-in can fix it.
                let _ = self.store.delete(KEY_GITHUB);
                Err(AppError {
                    code: ErrorCode::AuthRequired,
                    message: "L'accesso a GitHub è scaduto: accedi di nuovo.".into(),
                    detail: Some(m),
                    retryable: false,
                })
            }
            // Anything else (server trouble, expired session JWT...) keeps the stored tokens.
            Err(e) => Err(auth_error_to_app(&e)),
        }
    }
}

#[cfg(test)]
mod tests;
