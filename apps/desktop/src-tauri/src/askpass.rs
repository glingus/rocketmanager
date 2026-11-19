//! Git credential helper (`GIT_ASKPASS`): the same executable, started with
//! `ROCKETSYNC_ASKPASS=1`, answers git's prompts and exits *before* Tauri is initialised.
//!
//! * `Username for '…'` → `x-access-token`
//! * `Password for '…'` → the GitHub token read from Credential Manager
//!
//! The token never appears on a command line, in a URL or in `.git/config`.

use crate::secrets::SecretStore;

/// Environment variable that switches the executable into askpass mode.
pub const ENV_FLAG: &str = "ROCKETSYNC_ASKPASS";
/// User name GitHub expects together with an app/user token.
pub const USERNAME: &str = "x-access-token";

/// What git is asking for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    Username,
    Password,
    Other,
}

/// Classifies a prompt text such as `Username for 'https://github.com': `.
pub fn classify(prompt: &str) -> Prompt {
    let p = prompt.trim_start().to_ascii_lowercase();
    if p.starts_with("username") {
        Prompt::Username
    } else if p.starts_with("password") {
        Prompt::Password
    } else {
        Prompt::Other
    }
}

/// The answer to a prompt, or `None` if there is none (unknown prompt, missing token).
pub fn answer(prompt: &str, token: Option<&str>) -> Option<String> {
    match classify(prompt) {
        Prompt::Username => Some(USERNAME.to_string()),
        Prompt::Password => token.filter(|t| !t.is_empty()).map(str::to_string),
        Prompt::Other => None,
    }
}

/// Whether this process was started as the askpass helper.
pub fn requested() -> bool {
    std::env::var(ENV_FLAG).map(|v| v == "1").unwrap_or(false)
}

/// Runs the helper: prints the answer and returns the exit code. `args` are the process
/// arguments after the program name (git passes the prompt as the first one).
pub fn run(args: &[String], store: &dyn SecretStore, out: &mut dyn std::io::Write) -> i32 {
    let Some(prompt) = args.first() else {
        return 2;
    };
    let token = if classify(prompt) == Prompt::Password {
        crate::auth::load_github_token(store)
    } else {
        None
    };
    match answer(prompt, token.as_deref()) {
        Some(a) => {
            if writeln!(out, "{a}").is_err() {
                return 1;
            }
            0
        }
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::memory_store;

    #[test]
    fn classifies_prompts() {
        assert_eq!(
            classify("Username for 'https://github.com': "),
            Prompt::Username
        );
        assert_eq!(
            classify("Password for 'https://x-access-token@github.com': "),
            Prompt::Password
        );
        assert_eq!(classify("password:"), Prompt::Password);
        assert_eq!(classify("Enter passphrase for key"), Prompt::Other);
    }

    #[test]
    fn answers_username_and_password() {
        assert_eq!(
            answer("Username for 'https://github.com': ", None).as_deref(),
            Some("x-access-token")
        );
        assert_eq!(
            answer("Password for 'x': ", Some("ghu_abc")).as_deref(),
            Some("ghu_abc")
        );
        assert_eq!(answer("Password for 'x': ", None), None);
        assert_eq!(answer("Password for 'x': ", Some("")), None);
        assert_eq!(answer("Something else", Some("t")), None);
    }

    #[test]
    fn run_reads_the_token_from_the_store() {
        let store = memory_store();
        crate::auth::save_github_token_for_tests(&store, "ghu_secret");
        let mut out = Vec::new();
        assert_eq!(
            run(
                &["Password for 'https://github.com': ".into()],
                &store,
                &mut out
            ),
            0
        );
        assert_eq!(String::from_utf8(out).unwrap(), "ghu_secret\n");
        let mut out = Vec::new();
        assert_eq!(
            run(
                &["Username for 'https://github.com': ".into()],
                &store,
                &mut out
            ),
            0
        );
        assert_eq!(String::from_utf8(out).unwrap(), "x-access-token\n");
        // no prompt / unknown prompt / no token
        assert_eq!(run(&[], &store, &mut Vec::new()), 2);
        assert_eq!(run(&["Boh".into()], &store, &mut Vec::new()), 1);
        let empty = memory_store();
        let mut out = Vec::new();
        assert_eq!(run(&["Password for x".into()], &empty, &mut out), 1);
        assert!(out.is_empty());
    }
}
