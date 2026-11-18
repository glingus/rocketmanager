//! Minimal DOM on top of `quick-xml`, plus a stable pretty-printer.

use crate::error::OrkError;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;

const MAX_DEPTH: usize = 256;

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    /// Concatenated, trimmed character data.
    pub text: String,
    /// Fingerprint of a `databranch` subtree whose content was not kept.
    pub fingerprint: Option<u64>,
    /// Number of `datapoint` elements in a skipped `databranch`.
    pub skipped_points: u32,
}

impl Node {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// Text of the first child with the given name.
    pub fn child_text(&self, name: &str) -> Option<&str> {
        self.child(name).map(|c| c.text.as_str())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ParseOpts {
    /// When false, `databranch` content (thousands of data points) is hashed instead of stored.
    pub keep_flight_points: bool,
}

struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf29ce484222325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= *b as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
    fn sep(&mut self) {
        self.write(&[0xff]);
    }
}

/// 64-bit FNV-1a hash (stable across runs, unlike `DefaultHasher`).
pub fn fnv1a(text: &str) -> u64 {
    let mut h = Fnv::new();
    h.write(text.as_bytes());
    h.0
}

fn resolve_ref(content: &str, out: &mut String) -> Result<(), OrkError> {
    if let Some(num) = content.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix('x') {
            u32::from_str_radix(hex, 16)
        } else {
            num.parse::<u32>()
        };
        match code.ok().and_then(char::from_u32) {
            Some(c) => out.push(c),
            None => {
                return Err(OrkError::Xml(format!(
                    "riferimento a carattere non valido «&{content};»"
                )))
            }
        }
        return Ok(());
    }
    match content {
        "lt" => out.push('<'),
        "gt" => out.push('>'),
        "amp" => out.push('&'),
        "quot" => out.push('"'),
        "apos" => out.push('\''),
        other => return Err(OrkError::Xml(format!("entità sconosciuta «&{other};»"))),
    }
    Ok(())
}

fn start_to_node(e: &BytesStart<'_>) -> Result<Node, OrkError> {
    let name = e.name().as_ref().to_string();
    let mut attrs = Vec::new();
    for a in e.attributes() {
        let a = a.map_err(|err| OrkError::Xml(format!("attributo non valido ({err})")))?;
        let key = a.key.as_ref().to_string();
        let value = a
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|err| OrkError::Xml(format!("valore di attributo non valido ({err})")))?
            .into_owned();
        attrs.push((key, value));
    }
    Ok(Node {
        name,
        attrs,
        ..Default::default()
    })
}

/// Parses a complete XML document into a tree. Fails on truncated or malformed XML.
pub fn parse_dom(bytes: &[u8], opts: ParseOpts) -> Result<Node, OrkError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| OrkError::Xml("il file non è codificato in UTF-8".into()))?;
    let mut reader = Reader::from_str(text);
    {
        let cfg = reader.config_mut();
        cfg.check_end_names = true;
        cfg.expand_empty_elements = false;
    }
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    // Skipping state for databranch content.
    let mut skip_depth: usize = 0;
    let mut skip_hash = Fnv::new();
    let mut skip_points: u32 = 0;

    loop {
        let pos = reader.buffer_position();
        let ev = reader
            .read_event()
            .map_err(|e| OrkError::Xml(format!("posizione {pos}: {e}")))?;
        if skip_depth > 0 {
            match &ev {
                Event::Start(e) => {
                    skip_depth += 1;
                    skip_hash.write(e.as_ref().as_bytes());
                    skip_hash.sep();
                    if e.name().as_ref() == "datapoint" {
                        skip_points += 1;
                    }
                }
                Event::Empty(e) => {
                    skip_hash.write(e.as_ref().as_bytes());
                    skip_hash.sep();
                }
                Event::Text(t) => {
                    skip_hash.write(t.as_ref().as_bytes());
                    skip_hash.sep();
                }
                Event::End(_) => {
                    skip_depth -= 1;
                    if skip_depth == 0 {
                        // Close the databranch node itself.
                        let mut node = stack.pop().expect("databranch node on stack");
                        node.fingerprint = Some(skip_hash.0);
                        node.skipped_points = skip_points;
                        match stack.last_mut() {
                            Some(parent) => parent.children.push(node),
                            None => root = Some(node),
                        }
                        skip_hash = Fnv::new();
                        skip_points = 0;
                    }
                }
                Event::Eof => {
                    return Err(OrkError::Incomplete(
                        "XML troncato (fine del file inattesa)".into(),
                    ))
                }
                _ => {}
            }
            continue;
        }
        match ev {
            Event::Start(e) => {
                if stack.len() >= MAX_DEPTH {
                    return Err(OrkError::Xml("annidamento troppo profondo".into()));
                }
                if root.is_some() && stack.is_empty() {
                    return Err(OrkError::Xml("più di un elemento radice".into()));
                }
                let node = start_to_node(&e)?;
                let is_branch = !opts.keep_flight_points && node.name == "databranch";
                stack.push(node);
                if is_branch {
                    skip_depth = 1;
                }
            }
            Event::Empty(e) => {
                let node = start_to_node(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => {
                        if root.is_some() {
                            return Err(OrkError::Xml("più di un elemento radice".into()));
                        }
                        root = Some(node);
                    }
                }
            }
            Event::End(_) => {
                let mut node = stack
                    .pop()
                    .ok_or_else(|| OrkError::Xml("tag di chiusura inatteso".into()))?;
                node.text = node.text.trim().to_string();
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.xml_content(XmlVersion::Implicit1_0));
                }
            }
            Event::CData(c) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(c.as_ref());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(top) = stack.last_mut() {
                    resolve_ref(&r, &mut top.text)?;
                }
            }
            Event::Eof => {
                if !stack.is_empty() {
                    return Err(OrkError::Incomplete(
                        "XML troncato: ci sono elementi non chiusi".into(),
                    ));
                }
                break;
            }
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }
    root.ok_or_else(|| OrkError::Xml("documento vuoto".into()))
}

fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

fn escape_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            '\t' => out.push_str("&#9;"),
            _ => out.push(c),
        }
    }
}

fn write_node(n: &Node, depth: usize, strip_flight: bool, out: &mut String) {
    if strip_flight && n.name == "databranch" {
        return;
    }
    for _ in 0..depth {
        out.push_str("  ");
    }
    out.push('<');
    out.push_str(&n.name);
    for (k, v) in &n.attrs {
        out.push(' ');
        out.push_str(k);
        out.push_str("=\"");
        escape_attr(v, out);
        out.push('"');
    }
    let kept: Vec<&Node> = n
        .children
        .iter()
        .filter(|c| !(strip_flight && c.name == "databranch"))
        .collect();
    if kept.is_empty() {
        if n.text.is_empty() {
            out.push_str("/>\n");
        } else {
            out.push('>');
            escape_text(&n.text, out);
            out.push_str("</");
            out.push_str(&n.name);
            out.push_str(">\n");
        }
        return;
    }
    out.push_str(">\n");
    for c in kept {
        write_node(c, depth + 1, strip_flight, out);
    }
    if !n.text.is_empty() {
        for _ in 0..=depth {
            out.push_str("  ");
        }
        escape_text(&n.text, out);
        out.push('\n');
    }
    for _ in 0..depth {
        out.push_str("  ");
    }
    out.push_str("</");
    out.push_str(&n.name);
    out.push_str(">\n");
}

/// Stable, indented serialization of a tree.
pub fn to_indented(root: &Node, strip_flight: bool) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    write_node(root, 0, strip_flight, &mut out);
    out
}

/// Compact canonical serialization used to compare "uninterpreted" subtrees.
pub fn canonical(n: &Node) -> String {
    let mut s = String::new();
    canonical_into(n, &mut s);
    s
}

fn canonical_into(n: &Node, s: &mut String) {
    s.push('<');
    s.push_str(&n.name);
    for (k, v) in &n.attrs {
        s.push(' ');
        s.push_str(k);
        s.push('=');
        s.push('"');
        s.push_str(v);
        s.push('"');
    }
    s.push('>');
    s.push_str(&n.text);
    if let Some(fp) = n.fingerprint {
        s.push_str(&format!("#{fp:x}"));
    }
    for c in &n.children {
        canonical_into(c, s);
    }
    s.push_str("</");
    s.push_str(&n.name);
    s.push('>');
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTS: ParseOpts = ParseOpts {
        keep_flight_points: true,
    };

    #[test]
    fn parses_entities_cdata_and_mixed_text() {
        let n = parse_dom(
            b"<a x=\"1&amp;2\"><b>t&lt;&#65;&#x42;</b><c><![CDATA[<raw>]]></c>tail</a>",
            OPTS,
        )
        .unwrap();
        assert_eq!(n.attr("x"), Some("1&2"));
        assert_eq!(n.child_text("b"), Some("t<AB"));
        assert_eq!(n.child_text("c"), Some("<raw>"));
        assert_eq!(n.text, "tail");
    }

    #[test]
    fn rejects_malformed_documents() {
        for bad in [
            "<a><b></a>",
            "<a>",
            "<a></a><b></b>",
            "",
            "plain",
            "<a>&bogus;</a>",
            "<a attr=1></a>",
        ] {
            assert!(parse_dom(bad.as_bytes(), OPTS).is_err(), "accepted: {bad}");
        }
        assert!(parse_dom(
            &[b'<', b'a', b'>', 0xff, 0xfe, b'<', b'/', b'a', b'>'],
            OPTS
        )
        .is_err());
    }

    #[test]
    fn databranch_is_fingerprinted_not_stored() {
        let xml = b"<f><databranch name=\"s\"><datapoint>1,2</datapoint><datapoint>3,4</datapoint></databranch></f>";
        let lite = parse_dom(
            xml,
            ParseOpts {
                keep_flight_points: false,
            },
        )
        .unwrap();
        let b = lite.child("databranch").unwrap();
        assert!(b.children.is_empty());
        assert_eq!(b.skipped_points, 2);
        let fp = b.fingerprint.unwrap();
        let other = parse_dom(
            b"<f><databranch name=\"s\"><datapoint>1,2</datapoint><datapoint>3,5</datapoint></databranch></f>",
            ParseOpts {
                keep_flight_points: false,
            },
        )
        .unwrap();
        assert_ne!(other.child("databranch").unwrap().fingerprint.unwrap(), fp);
        let full = parse_dom(xml, OPTS).unwrap();
        assert_eq!(full.child("databranch").unwrap().children.len(), 2);
        assert!(
            to_indented(&lite, true).contains("<f/>")
                || !to_indented(&lite, true).contains("databranch")
        );
    }

    #[test]
    fn indented_output_is_stable() {
        let n = parse_dom(b"<a  y='2' x='1'><b/><c>x &amp; y</c></a>", OPTS).unwrap();
        assert_eq!(
            to_indented(&n, false),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<a y=\"2\" x=\"1\">\n  <b/>\n  <c>x &amp; y</c>\n</a>\n"
        );
    }

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv1a(""), 0xcbf29ce484222325);
        assert_eq!(fnv1a("a"), 0xaf63dc4c8601ec8c);
    }
}
