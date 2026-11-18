//! Property-style tests over every real fixture: whatever single edit we make, exactly that edit
//! (and nothing else) must be reported.

mod common;
use common::*;
use rs_ork::*;

/// Byte ranges of the `<tag>..</tag>` contents inside the `<rocket>` part of the XML.
fn tag_ranges(xml: &str, tag: &str) -> Vec<(usize, usize)> {
    let end = xml.find("</rocket>").unwrap();
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(i) = xml[pos..end].find(&open) {
        let s = pos + i + open.len();
        let e = xml[s..].find(&close).unwrap() + s;
        out.push((s, e));
        pos = e;
    }
    out
}

#[test]
fn renaming_any_single_component_reports_exactly_one_rename() {
    for (file, bytes) in all_fixtures() {
        let xml = xml_of(&bytes);
        let ranges = tag_ranges(&xml, "name");
        assert!(ranges.len() > 5, "{file}");
        for (n, (s, e)) in ranges.iter().enumerate().take(30) {
            let renamed = format!("{}RINOMINATO {n}{}", &xml[..*s], &xml[*e..]);
            let after = with_xml(&bytes, &renamed);
            let d = diff(&file, Some(&bytes), Some(&after));
            assert!(d.parse_error.is_none(), "{file} #{n}");
            if d.components.is_empty() {
                // `<name>` inside a `<motorconfiguration>`: the configuration's own name.
                assert_eq!(d.motor_configurations.len(), 1, "{file} #{n}: {d:#?}");
                assert_eq!(d.motor_configurations[0].params[0].key, "name");
                continue;
            }
            assert_eq!(
                d.components.len(),
                1,
                "{file} #{n} ({}): {:#?}",
                &xml[*s..*e],
                d.components
            );
            let c = &d.components[0];
            assert_eq!(c.kind, ComponentChangeKind::Modified, "{file} #{n}");
            assert_eq!(c.name, format!("RINOMINATO {n}"));
            assert!(c.params.iter().any(|p| p.key == "name"), "{file} #{n}");
            assert!(
                d.simulations.is_empty() && d.motor_configurations.is_empty(),
                "{file} #{n}"
            );
            assert!(
                d.uninterpreted.is_empty(),
                "{file} #{n}: {:#?}",
                d.uninterpreted
            );
        }
    }
}

#[test]
fn changing_any_single_length_reports_exactly_one_parameter() {
    for (file, bytes) in all_fixtures() {
        let xml = xml_of(&bytes);
        let ranges = tag_ranges(&xml, "length");
        for (n, (s, e)) in ranges.iter().enumerate().take(30) {
            let old: f64 = xml[*s..*e].parse().unwrap();
            let edited = format!("{}{}{}", &xml[..*s], old + 0.0123, &xml[*e..]);
            let after = with_xml(&bytes, &edited);
            let d = diff(&file, Some(&bytes), Some(&after));
            if d.components.is_empty() {
                // The length of a motor (inside a motor mount) is reported as a motor change.
                assert_eq!(
                    d.motor_configurations.len(),
                    1,
                    "{file} length #{n}: {d:#?}"
                );
                assert!(d.motor_configurations[0].params[0]
                    .after
                    .as_ref()
                    .unwrap()
                    .display
                    .contains("definizione del motore diversa"));
                continue;
            }
            assert_eq!(
                d.components.len(),
                1,
                "{file} length #{n}: {:#?}",
                d.components
            );
            let c = &d.components[0];
            assert_eq!(c.kind, ComponentChangeKind::Modified, "{file} #{n}");
            assert_eq!(c.params.len(), 1, "{file} #{n}: {:#?}", c.params);
            assert_eq!(c.params[0].key, "length");
            // 12.3 mm more
            let b: f64 = c.params[0]
                .before
                .as_ref()
                .unwrap()
                .display
                .replace(',', ".")
                .trim_end_matches(" mm")
                .parse()
                .unwrap();
            let a: f64 = c.params[0]
                .after
                .as_ref()
                .unwrap()
                .display
                .replace(',', ".")
                .trim_end_matches(" mm")
                .parse()
                .unwrap();
            assert!((a - b - 12.3).abs() < 0.011, "{file} #{n}: {b} -> {a}");
        }
    }
}

#[test]
fn deleting_any_leaf_component_reports_exactly_one_removal() {
    for (file, bytes) in all_fixtures() {
        let xml = xml_of(&bytes);
        // Remove the first leaf `centeringring`/`bulkhead`/`masscomponent`/`launchlug`/`parachute`
        for tag in [
            "centeringring",
            "bulkhead",
            "masscomponent",
            "launchlug",
            "parachute",
            "shockcord",
        ] {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            let Some(i) = xml.find(&open) else { continue };
            let j = xml[i..].find(&close).unwrap() + i + close.len();
            let edited = format!("{}{}", &xml[..i], &xml[j..]);
            let after = with_xml(&bytes, &edited);
            let d = diff(&file, Some(&bytes), Some(&after));
            let removed: Vec<_> = d
                .components
                .iter()
                .filter(|c| c.kind == ComponentChangeKind::Removed)
                .collect();
            assert_eq!(removed.len(), 1, "{file} {tag}: {:#?}", d.components);
            assert_eq!(removed[0].component_type, tag);
            // Nothing else is reported as added.
            assert!(
                !d.components
                    .iter()
                    .any(|c| c.kind == ComponentChangeKind::Added),
                "{file} {tag}: {:#?}",
                d.components
            );
        }
    }
}

#[test]
fn names_with_markup_characters_roundtrip() {
    let bytes = fixture("simple-model-rocket-24.12.ork");
    let xml = xml_of(&bytes);
    let edited = xml.replacen(
        "<name>Body tube</name>",
        "<name>Tubo &lt;A&gt; &amp; «B» \"x\"</name>",
        1,
    );
    let after = with_xml(&bytes, &edited);
    let d = diff("a.ork", Some(&bytes), Some(&after));
    assert_eq!(d.components[0].name, "Tubo <A> & «B» \"x\"");
    // And it survives normalization.
    let n = normalized_xml(&after, true).unwrap();
    assert!(n.contains("<name>Tubo &lt;A&gt; &amp; «B» \"x\"</name>"));
}
