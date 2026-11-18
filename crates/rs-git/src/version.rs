//! Git version detection.

use crate::error::GitError;
use crate::exec::{Cmd, Git};
use std::fmt;

/// Minimum supported git version.
///
/// The spec asks for 2.38 (`merge-tree --write-tree`); Rocket Sync also needs
/// `merge-tree --merge-base` (2.40) to replay a version on top of a different base.
pub const MIN_GIT_VERSION: GitVersion = GitVersion {
    major: 2,
    minor: 40,
    patch: 0,
};

/// Parsed `git --version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl fmt::Display for GitVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl GitVersion {
    /// Parses output such as `git version 2.43.0` or `git version 2.45.1.windows.1`.
    pub fn parse(s: &str) -> Option<Self> {
        let rest = s.trim().strip_prefix("git version ")?;
        let mut it = rest.split(|c: char| !c.is_ascii_digit());
        let major = it.next()?.parse().ok()?;
        let minor = it.next()?.parse().ok()?;
        let patch = it.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        Some(Self {
            major,
            minor,
            patch,
        })
    }
}

impl Git {
    /// Version of the configured binary.
    pub fn version(&self) -> Result<GitVersion, GitError> {
        let o = self.run(None, Cmd::new(["--version"]).no_retry())?;
        let text = o.stdout_trimmed();
        GitVersion::parse(&text).ok_or_else(|| GitError::Parse(format!("versione di git: {text}")))
    }

    /// Fails with [`GitError::UnsupportedVersion`] if the binary is older than [`MIN_GIT_VERSION`].
    pub fn ensure_min_version(&self) -> Result<GitVersion, GitError> {
        let v = self.version()?;
        if v < MIN_GIT_VERSION {
            return Err(GitError::UnsupportedVersion {
                found: v.to_string(),
                required: MIN_GIT_VERSION.to_string(),
            });
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(
            GitVersion::parse("git version 2.43.0"),
            Some(GitVersion {
                major: 2,
                minor: 43,
                patch: 0
            })
        );
        assert_eq!(
            GitVersion::parse("git version 2.45.1.windows.1\n"),
            Some(GitVersion {
                major: 2,
                minor: 45,
                patch: 1
            })
        );
        assert!(GitVersion::parse("hello").is_none());
        assert!(
            GitVersion {
                major: 2,
                minor: 39,
                patch: 9
            } < MIN_GIT_VERSION
        );
    }
}
