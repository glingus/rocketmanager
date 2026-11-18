//! Redaction of credentials from text that may end up in logs or error messages.

use regex::Regex;
use std::sync::OnceLock;

struct Rules {
    userinfo: Regex,
    gh_tokens: Regex,
    auth_header: Regex,
    access_token: Regex,
    kv_secret: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // https://user:password@host  /  https://token@host
        userinfo: Regex::new(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s@]+@").expect("static regex"),
        gh_tokens: Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b")
            .expect("static regex"),
        auth_header: Regex::new(r"(?i)(authorization:\s*(?:bearer|basic|token)\s+)\S+")
            .expect("static regex"),
        access_token: Regex::new(r"(?i)(x-access-token:)[^@\s]+").expect("static regex"),
        kv_secret: Regex::new(r"(?i)\b(password|passwd|token|secret|api[_-]?key)=\S+")
            .expect("static regex"),
    })
}

/// Replaces anything that looks like a credential with `***`.
///
/// The function is deliberately aggressive: it is used on command lines and on the stderr of
/// git before they are logged or returned in an error.
pub fn redact(input: &str) -> String {
    let r = rules();
    let s = r.userinfo.replace_all(input, "${1}***@");
    let s = r.gh_tokens.replace_all(&s, "***");
    let s = r.auth_header.replace_all(&s, "${1}***");
    let s = r.access_token.replace_all(&s, "${1}***");
    let s = r.kv_secret.replace_all(&s, "${1}=***");
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_url_userinfo() {
        assert_eq!(
            redact("fatal: unable to access 'https://x-access-token:abc123@github.com/o/r.git/'"),
            "fatal: unable to access 'https://***@github.com/o/r.git/'"
        );
        assert_eq!(
            redact("https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r"),
            "https://***@github.com/o/r"
        );
    }

    #[test]
    fn redacts_tokens_and_headers() {
        let t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        assert_eq!(redact(&format!("token {t} end")), "token *** end");
        assert_eq!(
            redact("github_pat_11ABCDEFG0123456789_abcdefghijklmnop"),
            "***"
        );
        assert_eq!(
            redact("Authorization: Bearer secretvalue"),
            "Authorization: Bearer ***"
        );
        assert_eq!(redact("password=hunter2 ok"), "password=*** ok");
    }

    #[test]
    fn leaves_plain_text_alone() {
        let s = "On branch main, nothing to commit (file:///tmp/remote.git)";
        assert_eq!(redact(s), s);
    }
}
