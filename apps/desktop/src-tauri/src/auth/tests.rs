//! End-to-end tests of the sign-in logic against local fake HTTP servers.

use super::*;
use crate::secrets::memory_store;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

type Handler = dyn Fn(&Req) -> (u16, String) + Send + Sync;

/// Starts a fake HTTP server; returns its base URL and the recorded requests.
pub async fn fake_server(handler: Arc<Handler>) -> (String, Arc<Mutex<Vec<Req>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { break };
            let handler = handler.clone();
            let log = log2.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end;
                loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        head_end = p + 4;
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or("").to_string();
                let mut it = first.split_whitespace();
                let (method, path) = (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string());
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
                    .collect();
                let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
                let req = Req { method, path, headers, body };
                log.lock().unwrap().push(req.clone());
                let (status, resp) = handler(&req);
                let out = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp}",
                    resp.len()
                );
                let _ = s.write_all(out.as_bytes()).await;
                let _ = s.shutdown().await;
            });
        }
    });
    (base, log)
}

fn cfg(base: &str) -> AppConfig {
    AppConfig {
        supabase_url: base.to_string(),
        supabase_anon_key: "anon-key".into(),
        ..Default::default()
    }
}

fn clock(t: i64) -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(move || t)
}

fn github_user_server() -> (Arc<Handler>, &'static str) {
    (
        Arc::new(|r: &Req| {
            assert_eq!(r.path, "/user");
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer ghu_first"));
            (200, r#"{"id":42,"login":"octocat","name":"Mona Lisa","avatar_url":"https://a/x.png"}"#.to_string())
        }),
        "",
    )
}

#[tokio::test]
async fn full_pkce_sign_in_stores_credentials_and_hides_the_github_token() {
    // fake GitHub API
    let (gh_handler, _) = github_user_server();
    let (gh_base, _) = fake_server(gh_handler).await;
    // fake Supabase: checks that the verifier matches the challenge that was put in the URL
    let challenge_seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let cs = challenge_seen.clone();
    let (sb_base, sb_log) = fake_server(Arc::new(move |r: &Req| {
        if r.path.starts_with("/auth/v1/token?grant_type=pkce") {
            assert_eq!(r.headers.get("apikey").map(String::as_str), Some("anon-key"));
            let body: serde_json::Value = serde_json::from_str(&r.body).unwrap();
            assert_eq!(body["auth_code"], "the-auth-code");
            let verifier = body["code_verifier"].as_str().unwrap();
            assert_eq!(Some(pkce::challenge(verifier)), *cs.lock().unwrap(), "verifier must match the challenge");
            (
                200,
                r#"{"access_token":"sb-access","refresh_token":"sb-refresh","expires_in":3600,"provider_token":"ghu_first","provider_refresh_token":"ghr_first","user":{"id":"u1"}}"#.to_string(),
            )
        } else {
            (404, "{}".to_string())
        }
    }))
    .await;

    let store = Arc::new(memory_store());
    let svc = AuthService::new(cfg(&sb_base), store.clone()).with_test_hooks(&gh_base, clock(1_000_000));
    let challenge_seen2 = challenge_seen.clone();
    let status = svc
        .sign_in(move |url| {
            // the "system browser": check the URL and follow the redirect to the loopback server
            let u = url::Url::parse(url).unwrap();
            let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
            assert_eq!(q["provider"], "github");
            assert_eq!(q["code_challenge_method"], "s256");
            assert!(q["redirect_to"].starts_with("http://127.0.0.1:536") && q["redirect_to"].ends_with("/callback"));
            *challenge_seen2.lock().unwrap() = Some(q["code_challenge"].clone());
            let redirect = format!("{}?code=the-auth-code", q["redirect_to"]);
            tokio::spawn(async move {
                let u = url::Url::parse(&redirect).unwrap();
                let mut s = tokio::net::TcpStream::connect((u.host_str().unwrap(), u.port().unwrap())).await.unwrap();
                s.write_all(format!("GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", u.path(), u.query().unwrap()).as_bytes()).await.unwrap();
                let mut resp = String::new();
                s.read_to_string(&mut resp).await.unwrap();
                assert!(resp.contains("Puoi tornare a Rocket Sync"));
            });
            Ok(())
        })
        .await
        .unwrap();

    assert!(status.signed_in);
    assert_eq!(status.user.as_ref().unwrap().github_login, "octocat");
    assert_eq!(status.user.as_ref().unwrap().name, "Mona Lisa");
    let s = status.supabase_session.as_ref().unwrap();
    assert_eq!((s.access_token.as_str(), s.refresh_token.as_str(), s.expires_at), ("sb-access", "sb-refresh", 1_003_600));
    // JSON given to the interface: no GitHub token anywhere
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains("ghu_") && !json.contains("ghr_"), "{json}");
    assert!(json.contains("\"signedIn\":true") && json.contains("\"githubLogin\":\"octocat\""));
    // credentials are in the store; the askpass helper can read the token
    assert_eq!(load_github_token(store.as_ref()).as_deref(), Some("ghu_first"));
    let id = svc.identity().unwrap();
    assert_eq!(id.name, "Mona Lisa");
    assert_eq!(id.email, "42+octocat@users.noreply.github.com");
    assert_eq!(sb_log.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn identity_falls_back_to_the_login_when_the_profile_has_no_name() {
    let p = StoredProfile { github_id: 7, login: "luca".into(), name: Some("  ".into()), avatar_url: None };
    let i = identity_of(&p);
    assert_eq!(i.name, "luca");
    assert_eq!(i.email, "7+luca@users.noreply.github.com");
}

#[tokio::test]
async fn callback_error_and_unreachable_server_map_to_contract_errors() {
    let store = Arc::new(memory_store());
    // user denies access in the browser
    let (sb_base, _) = fake_server(Arc::new(|_| (200, "{}".into()))).await;
    let svc = AuthService::new(cfg(&sb_base), store.clone());
    let err = svc
        .sign_in(|url| {
            let q: HashMap<String, String> = url::Url::parse(url).unwrap().query_pairs().into_owned().collect();
            let redirect = q["redirect_to"].clone();
            tokio::spawn(async move {
                let u = url::Url::parse(&redirect).unwrap();
                let mut s = tokio::net::TcpStream::connect((u.host_str().unwrap(), u.port().unwrap())).await.unwrap();
                s.write_all(b"GET /callback?error=access_denied&error_description=Accesso+negato HTTP/1.1\r\n\r\n").await.unwrap();
                let mut r = String::new();
                let _ = s.read_to_string(&mut r).await;
            });
            Ok(())
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(err.message.contains("Accesso negato"), "{}", err.message);

    // the browser cannot be opened
    let err = svc.sign_in(|_| Err("nessun browser".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    // the flag is released after a failure
    assert!(!svc.signing_in.load(Ordering::SeqCst));

    // Supabase down: the exchange fails with a network error
    let svc = AuthService::new(cfg("http://127.0.0.1:9"), store.clone());
    let e = auth_error_to_app(&AuthError::Network("x".into()));
    assert_eq!(e.code, ErrorCode::Network);
    assert!(e.retryable);
    let _ = svc;

    // not configured
    let svc = AuthService::new(AppConfig::default(), store);
    let err = svc.sign_in(|_| Ok(())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert!(err.message.contains("Supabase"));
}

fn seed(store: &dyn SecretStore, session_exp: i64, gh_exp: Option<i64>) {
    store
        .set(KEY_SESSION, &serde_json::to_string(&StoredSession { access_token: "sb-access".into(), refresh_token: "sb-refresh".into(), expires_at: session_exp }).unwrap())
        .unwrap();
    store
        .set(KEY_GITHUB, &serde_json::to_string(&StoredGithub { access_token: "ghu_old".into(), refresh_token: Some("ghr_old".into()), expires_at: gh_exp }).unwrap())
        .unwrap();
    store
        .set(KEY_PROFILE, &serde_json::to_string(&StoredProfile { github_id: 1, login: "a".into(), name: None, avatar_url: None }).unwrap())
        .unwrap();
}

#[tokio::test]
async fn github_token_is_renewed_through_the_edge_function() {
    let (sb_base, log) = fake_server(Arc::new(|r: &Req| {
        assert_eq!(r.path, "/functions/v1/github-token-refresh");
        assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer sb-access"));
        let b: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(b["refreshToken"], "ghr_old");
        (200, r#"{"accessToken":"ghu_new","refreshToken":"ghr_new","expiresAt":"2030-01-01T00:00:00.000Z","refreshTokenExpiresAt":null}"#.to_string())
    }))
    .await;
    let store = Arc::new(memory_store());
    seed(store.as_ref(), 9_999_999_999, Some(1_000_100)); // expires in 100 s
    let svc = AuthService::new(cfg(&sb_base), store.clone()).with_test_hooks("http://unused", clock(1_000_000));
    svc.ensure_github_token().await.unwrap();
    assert_eq!(load_github_token(store.as_ref()).as_deref(), Some("ghu_new"));
    assert_eq!(log.lock().unwrap().len(), 1);
    // now far from expiry: no call
    svc.ensure_github_token().await.unwrap();
    assert_eq!(log.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn dead_github_refresh_token_requires_a_new_sign_in() {
    let (sb_base, _) = fake_server(Arc::new(|_| (401, r#"{"code":"bad_refresh_token","message":"Il token di rinnovo non è valido"}"#.to_string()))).await;
    let store = Arc::new(memory_store());
    seed(store.as_ref(), 9_999_999_999, Some(1_000_001));
    let svc = AuthService::new(cfg(&sb_base), store.clone()).with_test_hooks("http://unused", clock(1_000_000));
    let e = svc.ensure_github_token().await.unwrap_err();
    assert_eq!(e.code, ErrorCode::AuthRequired);
    assert!(load_github_token(store.as_ref()).is_none());
    // without any token: authRequired as well
    let e = svc.ensure_github_token().await.unwrap_err();
    assert_eq!(e.code, ErrorCode::AuthRequired);
}

#[tokio::test]
async fn expired_session_is_renewed_and_a_rejected_refresh_signs_out() {
    let calls = Arc::new(Mutex::new(0));
    let c2 = calls.clone();
    let (sb_base, _) = fake_server(Arc::new(move |r: &Req| {
        assert!(r.path.starts_with("/auth/v1/token?grant_type=refresh_token"));
        let mut n = c2.lock().unwrap();
        *n += 1;
        if *n == 1 {
            (200, r#"{"access_token":"sb-access-2","refresh_token":"sb-refresh-2","expires_in":3600}"#.to_string())
        } else {
            (400, r#"{"error":"invalid_grant","error_description":"Refresh token revocato"}"#.to_string())
        }
    }))
    .await;
    let store = Arc::new(memory_store());
    seed(store.as_ref(), 999_000, None); // expired
    let svc = AuthService::new(cfg(&sb_base), store.clone()).with_test_hooks("http://unused", clock(1_000_000));
    let st = svc.status().await.unwrap();
    assert!(st.signed_in);
    assert_eq!(st.supabase_session.unwrap().access_token, "sb-access-2");
    // expire it again: the server now rejects the refresh token
    let s = StoredSession { access_token: "x".into(), refresh_token: "y".into(), expires_at: 1 };
    store.set(KEY_SESSION, &serde_json::to_string(&s).unwrap()).unwrap();
    let st = svc.status().await.unwrap();
    assert!(!st.signed_in);
    assert!(load_github_token(store.as_ref()).is_none(), "every credential removed");
    assert!(svc.identity().is_none());
}

#[tokio::test]
async fn offline_keeps_the_stored_session_and_sign_out_clears_everything() {
    let store = Arc::new(memory_store());
    seed(store.as_ref(), 1, None);
    let svc = AuthService::new(cfg("http://127.0.0.1:9"), store.clone()).with_test_hooks("http://unused", clock(1_000_000));
    let st = svc.status().await.unwrap();
    assert!(st.signed_in, "offline: do not sign the user out");
    assert!(svc.identity().is_some());
    svc.sign_out().await;
    assert_eq!(svc.status().await.unwrap(), AuthStatus::signed_out());
    assert!(load_github_token(store.as_ref()).is_none());
}
