//! Rendering and parsing of the commit messages of Rocket Sync (`docs/protocollo-sync.md` §3).

use crate::hooks::is_generic_line;
use crate::types::{ChangelogGroup, VersionKind};
use rs_git::parse_message;

/// Separator between the version number and the title (U+2014 with spaces).
pub(crate) const TITLE_SEP: &str = " — ";

/// Everything that goes into a version commit message.
#[derive(Debug, Clone)]
pub(crate) struct VersionMessage {
    /// `None` renders `v?` and the trailer `pending`.
    pub number: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub changelog: Vec<ChangelogGroup>,
    pub kind: VersionKind,
    pub client: String,
    pub restored_from: Option<i64>,
    pub restored_paths: Vec<String>,
    pub conflict_id: Option<String>,
    pub resolution: Vec<(String, String)>,
}

impl VersionMessage {
    pub(crate) fn new(kind: VersionKind, title: impl Into<String>, client: &str) -> Self {
        Self {
            number: None,
            title: title.into(),
            description: None,
            changelog: Vec::new(),
            kind,
            client: client.to_string(),
            restored_from: None,
            restored_paths: Vec::new(),
            conflict_id: None,
            resolution: Vec::new(),
        }
    }

    pub(crate) fn kind_str(kind: VersionKind) -> &'static str {
        match kind {
            VersionKind::Init => "init",
            VersionKind::Publish => "publish",
            VersionKind::Restore => "restore",
            VersionKind::ConflictResolution => "conflict-resolution",
        }
    }

    fn kind_parse(s: &str) -> VersionKind {
        match s {
            "init" => VersionKind::Init,
            "restore" => VersionKind::Restore,
            "conflict-resolution" => VersionKind::ConflictResolution,
            _ => VersionKind::Publish,
        }
    }

    pub(crate) fn render(&self) -> String {
        let num = match self.number {
            Some(n) => n.to_string(),
            None => "?".to_string(),
        };
        let title = one_line(&self.title);
        let mut out = format!("v{num}{TITLE_SEP}{title}\n");
        if let Some(d) = self.description.as_deref().map(str::trim) {
            if !d.is_empty() {
                out.push('\n');
                out.push_str(d);
                out.push('\n');
            }
        }
        for g in &self.changelog {
            if g.lines.is_empty() {
                continue;
            }
            out.push('\n');
            out.push_str(&one_line(&g.path));
            out.push('\n');
            for l in &g.lines {
                out.push_str("• ");
                out.push_str(&one_line(l));
                out.push('\n');
            }
        }
        out.push('\n');
        let version = match self.number {
            Some(n) => n.to_string(),
            None => "pending".to_string(),
        };
        out.push_str(&format!("Rocket-Sync-Version: {version}\n"));
        out.push_str(&format!(
            "Rocket-Sync-Kind: {}\n",
            Self::kind_str(self.kind)
        ));
        out.push_str(&format!("Rocket-Sync-Client: {}\n", one_line(&self.client)));
        if let Some(n) = self.restored_from {
            out.push_str(&format!("Rocket-Sync-Restored-From: {n}\n"));
        }
        if !self.restored_paths.is_empty() {
            let v: Vec<String> = self.restored_paths.iter().map(|p| enc(p)).collect();
            out.push_str(&format!("Rocket-Sync-Restored-Paths: {}\n", v.join(";")));
        }
        if let Some(id) = &self.conflict_id {
            out.push_str(&format!("Rocket-Sync-Conflict: {}\n", one_line(id)));
        }
        if !self.resolution.is_empty() {
            let v: Vec<String> = self
                .resolution
                .iter()
                .map(|(p, c)| format!("{}={}", enc(p), c))
                .collect();
            out.push_str(&format!("Rocket-Sync-Resolution: {}\n", v.join(";")));
        }
        out
    }
}

/// A parsed version commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedVersion {
    /// Number from the trailer (`None` when pending or absent).
    pub number: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub changelog: Vec<ChangelogGroup>,
    pub kind: VersionKind,
    pub restored_from: Option<i64>,
    pub conflict_id: Option<String>,
}

pub(crate) fn parse_version_message(raw: &str) -> ParsedVersion {
    let m = parse_message(raw);
    let number = m
        .trailer("Rocket-Sync-Version")
        .and_then(|v| v.trim().parse::<i64>().ok());
    let title = title_from_subject(&m.subject);
    let kind = m
        .trailer("Rocket-Sync-Kind")
        .map(VersionMessage::kind_parse)
        .unwrap_or(VersionKind::Publish);

    let mut description: Vec<String> = Vec::new();
    let mut changelog: Vec<ChangelogGroup> = Vec::new();
    for p in &m.paragraphs {
        let lines: Vec<&str> = p.split('\n').collect();
        let is_group = lines.len() >= 2 && lines[1..].iter().all(|l| l.starts_with("• "));
        if is_group {
            let items: Vec<String> = lines[1..]
                .iter()
                .map(|l| l.trim_start_matches("• ").to_string())
                .collect();
            let interpreted = !items.iter().all(|l| is_generic_line(l));
            changelog.push(ChangelogGroup {
                path: lines[0].to_string(),
                lines: items,
                interpreted,
            });
        } else if changelog.is_empty() {
            description.push(p.clone());
        } else {
            // Text after the changelog: keep it with the description rather than dropping it.
            description.push(p.clone());
        }
    }
    ParsedVersion {
        number,
        title,
        description: if description.is_empty() {
            None
        } else {
            Some(description.join("\n\n"))
        },
        changelog,
        kind,
        restored_from: m
            .trailer("Rocket-Sync-Restored-From")
            .and_then(|v| v.trim().parse().ok()),
        conflict_id: m.trailer("Rocket-Sync-Conflict").map(str::to_string),
    }
}

/// Title from a subject such as `v13 — Aggiornate pinne` or `v? — Titolo`.
pub(crate) fn title_from_subject(subject: &str) -> String {
    if let Some(rest) = subject.strip_prefix('v') {
        if let Some((head, title)) = rest.split_once(TITLE_SEP) {
            if head == "?" || head.chars().all(|c| c.is_ascii_digit()) && !head.is_empty() {
                return title.to_string();
            }
        }
    }
    subject.to_string()
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

fn enc(s: &str) -> String {
    s.replace('%', "%25")
        .replace(';', "%3B")
        .replace('=', "%3D")
}

/// Decodes the `Rocket-Sync-Resolution` / `Rocket-Sync-Restored-Paths` encoding.
#[allow(dead_code)]
pub(crate) fn dec(s: &str) -> String {
    s.replace("%3D", "=")
        .replace("%3B", ";")
        .replace("%25", "%")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::UNINTERPRETED_SUFFIX;

    #[test]
    fn render_and_parse_roundtrip() {
        let mut m = VersionMessage::new(VersionKind::Publish, "Aggiornate pinne", "0.1.0");
        m.number = Some(13);
        m.description = Some("Prima riga\n\nSeconda parte".into());
        m.changelog = vec![
            ChangelogGroup {
                path: "Razzo.ork".into(),
                lines: vec!["Pinne: 3 → 4".into(), "Aggiunto: Paracadute".into()],
                interpreted: true,
            },
            ChangelogGroup {
                path: "note.txt".into(),
                lines: vec![format!("Modificato {UNINTERPRETED_SUFFIX}")],
                interpreted: false,
            },
        ];
        let text = m.render();
        assert!(text.starts_with("v13 — Aggiornate pinne\n\nPrima riga"));
        assert!(text.contains(
            "Rocket-Sync-Version: 13\nRocket-Sync-Kind: publish\nRocket-Sync-Client: 0.1.0\n"
        ));
        let p = parse_version_message(&text);
        assert_eq!(p.number, Some(13));
        assert_eq!(p.title, "Aggiornate pinne");
        assert_eq!(
            p.description.as_deref(),
            Some("Prima riga\n\nSeconda parte")
        );
        assert_eq!(p.changelog, m.changelog);
        assert_eq!(p.kind, VersionKind::Publish);
    }

    #[test]
    fn pending_and_special_trailers() {
        let mut m = VersionMessage::new(VersionKind::ConflictResolution, "Risolto", "0.1.0");
        m.conflict_id = Some("20260101-abcdef".into());
        m.resolution = vec![("a;b=c.ork".into(), "mine".into())];
        let text = m.render();
        assert!(text.starts_with("v? — Risolto\n"));
        assert!(text.contains("Rocket-Sync-Version: pending"));
        assert!(text.contains("Rocket-Sync-Resolution: a%3Bb%3Dc.ork=mine"));
        let p = parse_version_message(&text);
        assert_eq!(p.number, None);
        assert_eq!(p.kind, VersionKind::ConflictResolution);
        assert_eq!(p.conflict_id.as_deref(), Some("20260101-abcdef"));
        assert_eq!(dec("a%3Bb%3Dc"), "a;b=c");

        let mut r =
            VersionMessage::new(VersionKind::Restore, "Ripristinata la versione 2", "0.1.0");
        r.restored_from = Some(2);
        let p = parse_version_message(&r.render());
        assert_eq!(p.restored_from, Some(2));
    }

    #[test]
    fn foreign_subjects() {
        assert_eq!(title_from_subject("fix typo"), "fix typo");
        assert_eq!(title_from_subject("v5 — ok"), "ok");
        assert_eq!(title_from_subject("v? — ok"), "ok");
        assert_eq!(title_from_subject("vendor — ok"), "vendor — ok");
    }
}

/// Rewrites the number of a version commit message: subject (`v<N> — …`) and the
/// `Rocket-Sync-Version` trailer. `None` produces `v?` / `pending`.
pub(crate) fn set_number(raw: &str, number: Option<i64>) -> String {
    let num = number.map(|n| n.to_string());
    let subj_num = num.clone().unwrap_or_else(|| "?".into());
    let trailer_val = num.unwrap_or_else(|| "pending".into());
    let mut out = String::with_capacity(raw.len() + 16);
    let mut first = true;
    let mut replaced_trailer = false;
    for line in raw.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        if first {
            first = false;
            let title = title_from_subject(body);
            out.push_str(&format!("v{subj_num}{TITLE_SEP}{title}{nl}"));
        } else if body.starts_with("Rocket-Sync-Version:") && !replaced_trailer {
            replaced_trailer = true;
            out.push_str(&format!("Rocket-Sync-Version: {trailer_val}{nl}"));
        } else {
            out.push_str(line);
        }
    }
    if !replaced_trailer {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("\nRocket-Sync-Version: {trailer_val}\n"));
    }
    out
}

#[cfg(test)]
mod set_number_tests {
    use super::*;

    #[test]
    fn renumbers_subject_and_trailer() {
        let mut m = VersionMessage::new(VersionKind::Publish, "Titolo", "0.1.0");
        m.number = Some(7);
        let r = set_number(&m.render(), None);
        assert!(r.starts_with("v? — Titolo\n"));
        assert!(r.contains("Rocket-Sync-Version: pending\n"));
        assert!(r.contains("Rocket-Sync-Kind: publish"));
        let r2 = set_number(&r, Some(9));
        assert!(r2.starts_with("v9 — Titolo\n"));
        assert!(r2.contains("Rocket-Sync-Version: 9\n"));
        let foreign = set_number("fix\n", Some(3));
        assert!(foreign.starts_with("v3 — fix"));
        assert!(foreign.ends_with("Rocket-Sync-Version: 3\n"));
    }
}
