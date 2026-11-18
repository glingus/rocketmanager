//! Parsing of commit messages with `git interpret-trailers`-style trailers.

/// Parsed commit message: subject, free-form paragraphs and the trailers of the last paragraph.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedMessage {
    /// First line.
    pub subject: String,
    /// Paragraphs between the subject and the trailer block (blank-line separated, trimmed).
    pub paragraphs: Vec<String>,
    /// Trailers in order of appearance, as `(key, value)`.
    pub trailers: Vec<(String, String)>,
}

impl ParsedMessage {
    /// First value of a trailer, matched case-insensitively.
    pub fn trailer(&self, key: &str) -> Option<&str> {
        self.trailers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

fn is_trailer_line(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once(':')?;
    if k.is_empty()
        || !k
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some((k, v.trim()))
}

/// Parses a raw commit message.
///
/// The trailer block is the last paragraph when *every* line of it is `Key: value`
/// (continuation lines starting with whitespace are folded into the previous value).
pub fn parse_message(raw: &str) -> ParsedMessage {
    let text = raw.replace("\r\n", "\n");
    let text = text.trim_end_matches('\n');
    let mut paragraphs: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            if !cur.is_empty() {
                paragraphs.push(cur.join("\n"));
                cur.clear();
            }
        } else {
            cur.push(line);
        }
    }
    if !cur.is_empty() {
        paragraphs.push(cur.join("\n"));
    }
    if paragraphs.is_empty() {
        return ParsedMessage::default();
    }
    let subject_par = paragraphs.remove(0);
    // A subject paragraph with several lines: first line is the subject, the rest is body.
    let (subject, rest_of_first) = match subject_par.split_once('\n') {
        Some((s, r)) => (s.to_string(), Some(r.to_string())),
        None => (subject_par, None),
    };
    if let Some(r) = rest_of_first {
        paragraphs.insert(0, r);
    }

    let mut trailers = Vec::new();
    if let Some(last) = paragraphs.last() {
        let mut parsed: Vec<(String, String)> = Vec::new();
        let mut ok = true;
        for line in last.split('\n') {
            if line.starts_with(' ') || line.starts_with('\t') {
                if let Some((_, v)) = parsed.last_mut() {
                    v.push(' ');
                    v.push_str(line.trim());
                    continue;
                }
                ok = false;
                break;
            }
            match is_trailer_line(line) {
                Some((k, v)) => parsed.push((k.to_string(), v.to_string())),
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && !parsed.is_empty() {
            trailers = parsed;
            paragraphs.pop();
        }
    }
    ParsedMessage {
        subject,
        paragraphs,
        trailers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subject_body_and_trailers() {
        let m = parse_message(
            "v13 — Aggiornate pinne\n\nDescrizione libera.\n\nRazzo.ork\n• Pinne: 3 → 4\n\nRocket-Sync-Version: 13\nRocket-Sync-Kind: publish\nRocket-Sync-Client: 0.1.0\n",
        );
        assert_eq!(m.subject, "v13 — Aggiornate pinne");
        assert_eq!(m.paragraphs.len(), 2);
        assert_eq!(m.paragraphs[0], "Descrizione libera.");
        assert_eq!(m.trailer("rocket-sync-version"), Some("13"));
        assert_eq!(m.trailer("Rocket-Sync-Kind"), Some("publish"));
        assert_eq!(m.trailers.len(), 3);
    }

    #[test]
    fn body_that_is_not_trailers_stays_body() {
        let m = parse_message("Titolo\n\nQuesto non è: un trailer\naltra riga");
        assert!(m.trailers.is_empty());
        assert_eq!(m.paragraphs.len(), 1);
    }

    #[test]
    fn subject_only() {
        let m = parse_message("solo oggetto\n");
        assert_eq!(m.subject, "solo oggetto");
        assert!(m.paragraphs.is_empty());
    }
}
