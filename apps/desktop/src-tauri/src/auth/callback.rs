//! Loopback HTTP server that receives the OAuth redirect (`http://127.0.0.1:<port>/callback?code=…`).

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Fixed list of ports tried in order. **All** the corresponding redirect URLs
/// (`http://127.0.0.1:<port>/callback`) must be registered in the Supabase Auth settings
/// (URL Configuration → Redirect URLs).
pub const REDIRECT_PORTS: std::ops::RangeInclusive<u16> = 53682..=53691;
/// Path of the redirect URL.
pub const CALLBACK_PATH: &str = "/callback";

/// Result of the browser redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Callback {
    /// Authorization code to exchange.
    Code(String),
    /// The provider or Supabase reported an error (`error_description` or `error`).
    Error(String),
}

/// Why waiting for the redirect failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CallbackError {
    #[error("nessuna porta locale libera tra {0} e {1}")]
    NoFreePort(u16, u16),
    #[error("tempo scaduto: il browser non è tornato a Rocket Sync")]
    Timeout,
    #[error("errore di rete locale: {0}")]
    Io(String),
}

/// Binds the first free port of [`REDIRECT_PORTS`] on the loopback interface only.
pub async fn bind_loopback() -> Result<(TcpListener, u16), CallbackError> {
    for port in REDIRECT_PORTS {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((l, port));
        }
    }
    Err(CallbackError::NoFreePort(
        *REDIRECT_PORTS.start(),
        *REDIRECT_PORTS.end(),
    ))
}

/// Redirect URL for a port.
pub fn redirect_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// Parses the request line of an HTTP request (`GET /callback?code=abc HTTP/1.1`).
///
/// Returns `None` if it is not a `GET` of [`CALLBACK_PATH`]; otherwise the callback outcome or
/// `Some(Err(..))`-like [`Callback::Error`] when neither `code` nor an error is present.
pub fn parse_request_line(line: &str) -> Option<Callback> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != CALLBACK_PATH {
        return None;
    }
    let mut code = None;
    let mut err = None;
    let mut err_desc = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "error" => err = Some(v.into_owned()),
            "error_description" => err_desc = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(c) = code.filter(|c| !c.is_empty()) {
        return Some(Callback::Code(c));
    }
    Some(Callback::Error(err_desc.or(err).unwrap_or_else(|| {
        "risposta di accesso senza codice".to_string()
    })))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The page shown in the browser (Italian).
pub fn response_page(result: &Callback) -> String {
    let (title, body) = match result {
        Callback::Code(_) => (
            "Accesso completato".to_string(),
            "Puoi tornare a Rocket Sync. Questa scheda del browser si può chiudere.".to_string(),
        ),
        Callback::Error(e) => (
            "Accesso non riuscito".to_string(),
            format!(
                "Qualcosa non ha funzionato: {}. Torna a Rocket Sync e riprova.",
                html_escape(e)
            ),
        ),
    };
    format!(
        "<!doctype html><html lang=\"it\"><head><meta charset=\"utf-8\"><title>{title} · Rocket Sync</title>\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<style>body{{font-family:'Segoe UI',system-ui,sans-serif;background:#e6ddca;color:#2c1e14;display:grid;place-items:center;min-height:100vh;margin:0}}\
main{{background:#fefbf4;border:1px solid #b9a98c;border-top:6px solid #6e2717;border-radius:8px;padding:32px 40px;max-width:30rem}}\
h1{{margin:0 0 12px;font-size:1.4rem;color:#6e2717}}p{{margin:0;line-height:1.5}}</style></head>\
<body><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Serves requests until the redirect arrives (other paths, e.g. `/favicon.ico`, get a 404).
pub async fn wait_for_callback(
    listener: TcpListener,
    timeout: Duration,
) -> Result<Callback, CallbackError> {
    let fut = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|e| CallbackError::Io(e.to_string()))?;
            let head =
                match tokio::time::timeout(Duration::from_secs(5), read_head(&mut stream)).await {
                    Ok(Ok(h)) => h,
                    _ => continue,
                };
            let first = head.lines().next().unwrap_or("");
            match parse_request_line(first) {
                Some(cb) => {
                    respond(&mut stream, "200 OK", &response_page(&cb)).await;
                    return Ok(cb);
                }
                None => {
                    respond(
                        &mut stream,
                        "404 Not Found",
                        "<!doctype html><title>404</title>",
                    )
                    .await
                }
            }
        }
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(CallbackError::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_code_error_and_ignores_other_requests() {
        assert_eq!(
            parse_request_line("GET /callback?code=abc%20123&state=x HTTP/1.1"),
            Some(Callback::Code("abc 123".into()))
        );
        assert_eq!(
            parse_request_line(
                "GET /callback?error=access_denied&error_description=Accesso+negato HTTP/1.1"
            ),
            Some(Callback::Error("Accesso negato".into()))
        );
        assert_eq!(
            parse_request_line("GET /callback?error=access_denied HTTP/1.1"),
            Some(Callback::Error("access_denied".into()))
        );
        assert!(matches!(
            parse_request_line("GET /callback HTTP/1.1"),
            Some(Callback::Error(_))
        ));
        assert_eq!(parse_request_line("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(parse_request_line("POST /callback?code=x HTTP/1.1"), None);
        assert_eq!(parse_request_line("garbage"), None);
    }

    #[test]
    fn pages_are_italian_and_escape_text() {
        let ok = response_page(&Callback::Code("c".into()));
        assert!(ok.contains("Puoi tornare a Rocket Sync"));
        let err = response_page(&Callback::Error("<script>x</script>".into()));
        assert!(!err.contains("<script>x"));
        assert!(err.contains("&lt;script&gt;"));
    }

    #[tokio::test]
    async fn server_returns_the_code_and_answers_the_browser() {
        let (listener, port) = bind_loopback().await.unwrap();
        assert!(REDIRECT_PORTS.contains(&port));
        let server = tokio::spawn(wait_for_callback(listener, Duration::from_secs(5)));
        // a stray request first
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).await.unwrap();
        assert!(resp.starts_with("HTTP/1.1 404"));
        // the real redirect
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"GET /callback?code=the-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).await.unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(resp.contains("Puoi tornare a Rocket Sync"));
        assert_eq!(
            server.await.unwrap().unwrap(),
            Callback::Code("the-code".into())
        );
    }

    #[tokio::test]
    async fn server_times_out_and_ports_are_skipped_when_busy() {
        let (l1, p1) = bind_loopback().await.unwrap();
        let (l2, p2) = bind_loopback().await.unwrap();
        assert_ne!(p1, p2, "a busy port is skipped");
        assert_eq!(
            wait_for_callback(l1, Duration::from_millis(50))
                .await
                .unwrap_err(),
            CallbackError::Timeout
        );
        drop(l2);
    }
}
