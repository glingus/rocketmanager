//! Typed errors of the git wrapper.

use crate::redact::redact;
use std::fmt;

/// Coarse classification of a failure, useful to decide whether to retry or what to tell the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
    GitMissing,
    NotARepository,
    Network,
    AuthFailed,
    NonFastForward,
    LockHeld,
    Conflict,
    Timeout,
    Cancelled,
    UnsupportedVersion,
    Io,
    Parse,
    Other,
}

/// Error returned by every fallible operation of this crate.
///
/// All `stderr` texts are already passed through [`redact`], so they are safe to log.
#[derive(Debug, Clone, thiserror::Error)]
pub enum GitError {
    /// The git binary could not be started.
    #[error("git non trovato o non eseguibile: {0}")]
    GitMissing(String),
    /// The folder is not a git repository.
    #[error("la cartella non è un repository Git")]
    NotARepository { stderr: String },
    /// Network or remote-reachability failure (transient).
    #[error("errore di rete durante l'operazione Git")]
    Network { stderr: String },
    /// Credentials missing or rejected.
    #[error("autenticazione non riuscita")]
    AuthFailed { stderr: String },
    /// The remote refused an update that is not a fast-forward.
    #[error("il server ha rifiutato l'invio perché ci sono novità (non fast-forward)")]
    NonFastForward { stderr: String },
    /// `index.lock` present, or a file locked by another process (antivirus, sharing violation).
    #[error("un file o l'indice di Git è bloccato da un altro processo")]
    LockHeld { stderr: String },
    /// Git reported a content conflict.
    #[error("conflitto di contenuto rilevato da Git")]
    Conflict { stderr: String },
    /// The command exceeded its timeout and was killed.
    #[error("comando Git scaduto dopo {seconds} s: {command}")]
    Timeout { command: String, seconds: u64 },
    /// The command was cancelled by the caller.
    #[error("operazione Git annullata")]
    Cancelled,
    /// The installed git is too old.
    #[error("versione di Git non supportata: trovata {found}, richiesta almeno {required}")]
    UnsupportedVersion { found: String, required: String },
    /// Local I/O failure while preparing or running a command.
    #[error("errore di I/O: {0}")]
    Io(String),
    /// Output of git could not be parsed.
    #[error("output di Git non interpretabile: {0}")]
    Parse(String),
    /// Any other non-zero exit.
    #[error("comando Git fallito (codice {code:?}): {stderr}")]
    Other { code: Option<i32>, stderr: String },
}

impl GitError {
    /// Classification of the error.
    pub fn kind(&self) -> GitErrorKind {
        match self {
            GitError::GitMissing(_) => GitErrorKind::GitMissing,
            GitError::NotARepository { .. } => GitErrorKind::NotARepository,
            GitError::Network { .. } => GitErrorKind::Network,
            GitError::AuthFailed { .. } => GitErrorKind::AuthFailed,
            GitError::NonFastForward { .. } => GitErrorKind::NonFastForward,
            GitError::LockHeld { .. } => GitErrorKind::LockHeld,
            GitError::Conflict { .. } => GitErrorKind::Conflict,
            GitError::Timeout { .. } => GitErrorKind::Timeout,
            GitError::Cancelled => GitErrorKind::Cancelled,
            GitError::UnsupportedVersion { .. } => GitErrorKind::UnsupportedVersion,
            GitError::Io(_) => GitErrorKind::Io,
            GitError::Parse(_) => GitErrorKind::Parse,
            GitError::Other { .. } => GitErrorKind::Other,
        }
    }

    /// Whether an automatic retry makes sense (lock held, network).
    pub fn is_transient(&self) -> bool {
        matches!(self.kind(), GitErrorKind::LockHeld | GitErrorKind::Network)
    }

    /// The (redacted) stderr of git, when there is one.
    pub fn stderr(&self) -> Option<&str> {
        match self {
            GitError::NotARepository { stderr }
            | GitError::Network { stderr }
            | GitError::AuthFailed { stderr }
            | GitError::NonFastForward { stderr }
            | GitError::LockHeld { stderr }
            | GitError::Conflict { stderr }
            | GitError::Other { stderr, .. } => Some(stderr),
            _ => None,
        }
    }

    pub(crate) fn io(e: impl fmt::Display) -> Self {
        GitError::Io(redact(&e.to_string()))
    }
}

/// Maps the stderr of a failed git invocation to a typed error.
pub(crate) fn classify(stderr_raw: &str, code: Option<i32>) -> GitError {
    let stderr = redact(stderr_raw.trim());
    let l = stderr.to_lowercase();
    let has = |needle: &str| l.contains(needle);

    if has("[remote rejected]")
        && (has("atomic transaction failed")
            || has("failed to update ref")
            || has("cannot lock ref"))
    {
        // Another client updated the same ref on the server at the same moment: same as a
        // rejected non-fast-forward, the caller refetches and retries.
        return GitError::NonFastForward { stderr };
    }
    if has("but expected") {
        // `update-ref` with an old-value guard that no longer matches: not a lock problem.
        return GitError::Other { code, stderr };
    }
    if has("index.lock")
        || has("another git process seems to be running")
        || (has("unable to create") && has(".lock") && has("file exists"))
        || has("could not lock")
        || has("cannot lock ref")
        || has("sharing violation")
        || has("access is denied")
        || has("unlink of file")
        || (has("permission denied") && !has("publickey"))
        || has("unable to unlink")
        || has("being used by another process")
    {
        return GitError::LockHeld { stderr };
    }
    if has("not a git repository") {
        return GitError::NotARepository { stderr };
    }
    if has("authentication failed")
        || has("could not read username")
        || has("could not read password")
        || has("terminal prompts disabled")
        || has("invalid credentials")
        || has("permission denied (publickey")
        || has("the requested url returned error: 401")
        || has("the requested url returned error: 403")
        || has("http 401")
        || has("http 403")
        || has("repository not found")
        || has("bad credentials")
    {
        return GitError::AuthFailed { stderr };
    }
    if has("non-fast-forward")
        || has("fetch first")
        || has("stale info")
        || has("tip of your current branch is behind")
        || (has("[rejected]") && has("failed to push"))
    {
        return GitError::NonFastForward { stderr };
    }
    if has("could not resolve host")
        || has("unable to access")
        || has("connection reset")
        || has("connection refused")
        || has("connection timed out")
        || has("timed out")
        || has("could not read from remote repository")
        || has("does not appear to be a git repository")
        || has("early eof")
        || has("rpc failed")
        || has("ssl connect")
        || has("ssl certificate")
        || has("openssl")
        || has("gnutls")
        || has("schannel")
        || has("failed to connect")
        || has("network is unreachable")
        || has("remote end hung up")
        || has("the remote end hung up")
        || has("broken pipe")
    {
        return GitError::Network { stderr };
    }
    if l.contains("conflict") && l.contains("merge") {
        return GitError::Conflict { stderr };
    }
    GitError::Other { code, stderr }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_failures() {
        assert_eq!(
            classify(
                "fatal: Unable to create '/r/.git/index.lock': File exists.",
                Some(128)
            )
            .kind(),
            GitErrorKind::LockHeld
        );
        assert_eq!(
            classify(
                "fatal: not a git repository (or any of the parent directories): .git",
                Some(128)
            )
            .kind(),
            GitErrorKind::NotARepository
        );
        assert_eq!(
            classify(
                "fatal: Authentication failed for 'https://github.com/o/r.git/'",
                Some(128)
            )
            .kind(),
            GitErrorKind::AuthFailed
        );
        assert_eq!(
            classify("fatal: could not read Username for 'https://github.com': terminal prompts disabled", Some(128)).kind(),
            GitErrorKind::AuthFailed
        );
        assert_eq!(
            classify(
                " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
                Some(1)
            )
            .kind(),
            GitErrorKind::NonFastForward
        );
        assert_eq!(
            classify(
                "fatal: unable to access 'https://x/': Could not resolve host: x",
                Some(128)
            )
            .kind(),
            GitErrorKind::Network
        );
        assert_eq!(
            classify("fatal: '/nope' does not appear to be a git repository\nfatal: Could not read from remote repository.", Some(128)).kind(),
            GitErrorKind::Network
        );
        assert_eq!(
            classify("remote: error: cannot lock ref 'refs/heads/main': is at a but expected b\n ! [remote rejected] x -> main (atomic transaction failed)", Some(1)).kind(),
            GitErrorKind::NonFastForward
        );
        assert_eq!(
            classify("fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': is at a but expected b", Some(128)).kind(),
            GitErrorKind::Other
        );
        assert_eq!(
            classify("fatal: something odd", Some(1)).kind(),
            GitErrorKind::Other
        );
    }

    #[test]
    fn stderr_is_redacted() {
        let e = classify(
            "fatal: unable to access 'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/': Could not resolve host",
            Some(128),
        );
        let s = e.stderr().unwrap();
        assert!(!s.contains("ghp_"), "{s}");
    }
}
