mod common;
use common::*;
use rs_ork::*;

const ID_FILE: &str = "simple-model-rocket-24.12.ork";
const NOID_FILE: &str = "simple-model-rocket-13.04.ork";

fn find_comp<'a>(d: &'a OrkDiff, ty: &str) -> &'a ComponentChange {
    d.components
        .iter()
        .find(|c| c.component_type == ty)
        .unwrap_or_else(|| panic!("no change for {ty}: {:#?}", d.components))
}

fn param<'a>(c: &'a ComponentChange, key: &str) -> &'a ParamChange {
    c.params
        .iter()
        .find(|p| p.key == key)
        .unwrap_or_else(|| panic!("no param {key}: {:#?}", c.params))
}

// ---------------------------------------------------------------------------------------------
// Containers and validation
// ---------------------------------------------------------------------------------------------

#[test]
fn detects_container_from_magic_bytes() {
    assert_eq!(detect_container(&fixture(ID_FILE)), Some(Container::Zip));
    assert_eq!(
        detect_container(&fixture("three-stage-rocket-13.04-gzip.ork")),
        Some(Container::Gzip)
    );
    assert_eq!(
        detect_container(&fixture("simple-model-rocket-12.03-plainxml.ork")),
        Some(Container::Xml)
    );
    assert_eq!(
        detect_container(b"\xEF\xBB\xBF  <?xml version='1.0'?><openrocket/>"),
        Some(Container::Xml)
    );
    assert_eq!(detect_container(b"hello world, not a rocket"), None);
    assert_eq!(detect_container(b""), None);
}

#[test]
fn every_fixture_validates_and_has_no_uninterpreted_elements() {
    for (name, bytes) in all_fixtures() {
        let s = validate(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(s.component_count > 5, "{name}");
        assert!(s.simulation_count >= 1, "{name}");
        let doc = parse(&bytes).unwrap();
        for c in &doc.components {
            assert_eq!(
                c.uninterpreted_elements, 0,
                "{name}: «{}» has uninterpreted elements",
                c.name
            );
        }
        // Diffing a file with itself never reports anything.
        let d = diff(&name, Some(&bytes), Some(&bytes));
        assert!(d.is_empty(), "{name}: {d:#?}");
        assert!(d.parse_error.is_none());
    }
}

#[test]
fn summaries_of_known_fixtures() {
    let s = validate(&fixture(ID_FILE)).unwrap();
    assert_eq!(s.container, Container::Zip);
    assert_eq!(s.creator.as_deref(), Some("OpenRocket 24.12"));
    assert_eq!(s.format_version.as_deref(), Some("1.10"));
    assert_eq!(s.rocket_name.as_deref(), Some("A simple model rocket"));
    assert_eq!(
        (s.stage_count, s.component_count, s.simulation_count),
        (1, 12, 5)
    );

    let s = validate(&fixture("three-stage-rocket-13.04.ork")).unwrap();
    assert_eq!(s.stage_count, 3);
    assert_eq!(s.rocket_name.as_deref(), Some("Three-staged rocket"));

    let s = validate(&fixture("parallel-booster-staging-24.12.ork")).unwrap();
    assert_eq!(s.stage_count, 2); // sustainer + parallel booster
}

#[test]
fn zip_gzip_and_plain_xml_of_the_same_content_are_equivalent() {
    let zip = fixture("three-stage-rocket-13.04.ork");
    let gz = fixture("three-stage-rocket-13.04-gzip.ork");
    let xml = with_xml(&gz, &xml_of(&zip));
    let plain = xml_of(&zip).into_bytes();
    assert_eq!(validate(&plain).unwrap().container, Container::Xml);
    for other in [&gz, &plain, &xml] {
        let d = diff("a.ork", Some(&zip), Some(other));
        // Only the attached decal images (not stored in GZIP/XML) can differ.
        assert!(
            d.components.is_empty()
                && d.simulations.is_empty()
                && d.motor_configurations.is_empty()
        );
        assert!(
            d.uninterpreted
                .iter()
                .all(|u| u.section.starts_with("Immagini allegate")),
            "{d:#?}"
        );
    }
    assert_eq!(
        normalized_xml(&zip, false).unwrap(),
        normalized_xml(&gz, false).unwrap()
    );
}

#[test]
fn truncated_files_are_rejected() {
    let cases = [
        fixture(ID_FILE),
        fixture("three-stage-rocket-13.04.ork"),
        fixture("three-stage-rocket-13.04-gzip.ork"),
        fixture("simple-model-rocket-12.03-plainxml.ork"),
    ];
    for bytes in cases {
        let len = bytes.len();
        for cut in [len - 5, len - 25, len * 3 / 4, len / 2, len / 10, 40, 12] {
            let part = &bytes[..cut];
            let r = validate(part);
            assert!(r.is_err(), "truncated at {cut}/{len} was accepted");
        }
        assert!(validate(&bytes).is_ok());
    }
}

#[test]
fn rejects_garbage_empty_and_foreign_formats() {
    assert!(matches!(validate(b""), Err(OrkError::Unsupported(_))));
    assert!(matches!(
        validate(b"just text"),
        Err(OrkError::Unsupported(_))
    ));
    assert!(validate(b"<?xml version='1.0'?><RockSimDoc></RockSimDoc>").is_err());
    assert!(validate(b"<?xml version='1.0'?><html></html>").is_err());
    assert!(validate(b"<?xml version='1.0'?><openrocket version='1.0'></openrocket>").is_err()); // no <rocket>
    assert!(validate(b"<openrocket><rocket><name>x</name></openrocket>").is_err()); // mismatched tags
                                                                                    // Corrupted ZIP payload (CRC mismatch).
    let mut bytes = fixture("three-stage-rocket-13.04.ork");
    let mid = bytes.len() / 3;
    bytes[mid] ^= 0xFF;
    assert!(validate(&bytes).is_err());
    // Invalid gzip stream.
    let mut gz = fixture("three-stage-rocket-13.04-gzip.ork");
    let mid = gz.len() / 2;
    gz[mid] ^= 0xFF;
    assert!(validate(&gz).is_err());
}

#[test]
fn plain_xml_with_bom_and_entities() {
    let xml = "\u{feff}<?xml version='1.0' encoding='utf-8'?>\n<openrocket version=\"1.6\" creator=\"x\">\
        <rocket><name>R &amp; D &#233;</name></rocket><simulations/></openrocket>";
    let s = validate(xml.as_bytes()).unwrap();
    assert_eq!(s.rocket_name.as_deref(), Some("R & D é"));
}

// ---------------------------------------------------------------------------------------------
// Component diffs
// ---------------------------------------------------------------------------------------------

/// Replaces the content of the first `<tag>..</tag>` with `value`.
fn set_first(xml: &str, tag: &str, value: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let i = xml.find(&open).unwrap_or_else(|| panic!("no <{tag}>")) + open.len();
    let j = xml[i..].find(&close).unwrap() + i;
    format!("{}{}{}", &xml[..i], value, &xml[j..])
}

fn fin_count_and_chord(original: &[u8]) -> Vec<u8> {
    variant(original, |x| {
        let mut x = x.to_string();
        x = x.replacen("<fincount>3</fincount>", "<fincount>4</fincount>", 1);
        if x.contains("<instancecount>3</instancecount>") {
            x = x.replacen(
                "<instancecount>3</instancecount>",
                "<instancecount>4</instancecount>",
                1,
            );
        }
        set_first(&x, "rootchord", "0.095")
    })
}

#[test]
fn fin_count_and_root_chord_with_ids() {
    let a = fixture(ID_FILE);
    let b = fin_count_and_chord(&a);
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert!(d.parse_error.is_none());
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let c = find_comp(&d, "trapezoidfinset");
    assert_eq!(c.kind, ComponentChangeKind::Modified);
    assert_eq!(c.type_label, "Pinne trapezoidali");
    assert_eq!(c.name, "Trapezoidal fin set");
    assert_eq!(
        c.path,
        vec!["Sustainer".to_string(), "Body tube".to_string()]
    );
    let n = param(c, "instancecount");
    assert_eq!(n.label, "Numero di pinne");
    assert_eq!(n.before.as_ref().unwrap().display, "3");
    assert_eq!(n.after.as_ref().unwrap().display, "4");
    let rc = param(c, "rootchord");
    assert_eq!(rc.before.as_ref().unwrap().display, "50,8 mm");
    assert_eq!(rc.after.as_ref().unwrap().display, "95 mm");
    assert_eq!(rc.after.as_ref().unwrap().unit.as_deref(), Some("mm"));
    assert_eq!(rc.after.as_ref().unwrap().raw, "0.095");
    assert!(d.simulations.is_empty() && d.motor_configurations.is_empty());
    assert!(d.uninterpreted.is_empty(), "{:#?}", d.uninterpreted);
    let lines = changelog_lines(&d);
    assert_eq!(
        lines,
        vec!["Pinne trapezoidali «Trapezoidal fin set»: numero di pinne 3 → 4; corda alla radice 50,8 → 95 mm"]
    );
}

#[test]
fn fin_changes_without_ids_match_by_path_type_and_name() {
    let a = fixture(NOID_FILE);
    let b = fin_count_and_chord(&a);
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let c = find_comp(&d, "trapezoidfinset");
    assert_eq!(c.kind, ComponentChangeKind::Modified);
    assert_eq!(
        param(c, "instancecount").after.as_ref().unwrap().display,
        "4"
    );
}

#[test]
fn spec_example_changelog_line() {
    // "Pinne trapezoidali «Pinne»: numero di pinne 3 → 4; corda alla radice 80 → 95 mm"
    let a = variant(&fixture(ID_FILE), |x| {
        let x = replace1(x, "<name>Trapezoidal fin set</name>", "<name>Pinne</name>");
        replace1(
            &x,
            "<rootchord>0.0508</rootchord>",
            "<rootchord>0.08</rootchord>",
        )
    });
    let b = variant(&a, |x| {
        let x = x
            .replacen(
                "<instancecount>3</instancecount>",
                "<instancecount>4</instancecount>",
                1,
            )
            .replacen("<fincount>3</fincount>", "<fincount>4</fincount>", 1);
        replace1(
            &x,
            "<rootchord>0.08</rootchord>",
            "<rootchord>0.095</rootchord>",
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(
        changelog_lines(&d),
        vec!["Pinne trapezoidali «Pinne»: numero di pinne 3 → 4; corda alla radice 80 → 95 mm"]
    );
}

const PARACHUTE: &str = r#"
              <parachute>
                <name>Paracadute principale</name>
                <id>aaaaaaaa-0000-4000-8000-000000000001</id>
                <axialoffset method="top">0.0</axialoffset>
                <position type="top">0.0</position>
                <packedlength>0.1</packedlength>
                <packedradius>0.02</packedradius>
                <radialposition>0.0</radialposition>
                <radialdirection>0.0</radialdirection>
                <cd>auto</cd>
                <material type="surface" density="0.067">Ripstop nylon</material>
                <deployevent>apogee</deployevent>
                <deployaltitude>200.0</deployaltitude>
                <deploydelay>0.0</deploydelay>
                <diameter>0.9</diameter>
                <linecount>6</linecount>
                <linelength>0.5</linelength>
                <linematerial type="line" density="0.0010">Elastic cord (round 2 mm, 1/16 in)</linematerial>
              </parachute>
"#;

#[test]
fn added_parachute_is_reported_with_headline() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        // insert right after the Body tube's <subcomponents> opening tag
        let marker = "<subcomponents>\n              <parachute>";
        if x.contains(marker) {
            x.replacen(
                "<subcomponents>\n              <parachute>",
                &format!("<subcomponents>{PARACHUTE}              <parachute>"),
                1,
            )
        } else {
            let i = x.find("<name>Body tube</name>").unwrap();
            let j = x[i..].find("<subcomponents>").unwrap() + i + "<subcomponents>".len();
            format!("{}{}{}", &x[..j], PARACHUTE, &x[j..])
        }
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let c = &d.components[0];
    assert_eq!(c.kind, ComponentChangeKind::Added);
    assert_eq!(c.name, "Paracadute principale");
    assert_eq!(c.path, vec!["Sustainer", "Body tube"]);
    assert_eq!(
        param(c, "diameter").after.as_ref().unwrap().display,
        "900 mm"
    );
    assert!(param(c, "diameter").before.is_none());
    assert_eq!(
        changelog_lines(&d),
        vec!["Aggiunto: Paracadute «Paracadute principale» (Ø 900 mm)"]
    );
    assert_eq!(
        d.after.as_ref().unwrap().component_count,
        d.before.as_ref().unwrap().component_count + 1
    );
    // And the reverse is a removal.
    let r = diff("Razzo.ork", Some(&b), Some(&a));
    assert_eq!(r.components.len(), 1);
    assert_eq!(r.components[0].kind, ComponentChangeKind::Removed);
    assert_eq!(
        changelog_lines(&r),
        vec!["Rimosso: Paracadute «Paracadute principale» (Ø 900 mm)"]
    );
}

#[test]
fn rename_with_ids_and_without() {
    for (file, name) in [(ID_FILE, "Body tube"), (NOID_FILE, "Body tube")] {
        let a = fixture(file);
        let b = variant(&a, |x| {
            replace1(x, &format!("<name>{name}</name>"), "<name>Fusoliera</name>")
        });
        let d = diff("Razzo.ork", Some(&a), Some(&b));
        assert_eq!(d.components.len(), 1, "{file}: {:#?}", d.components);
        let c = &d.components[0];
        assert_eq!(c.kind, ComponentChangeKind::Modified, "{file}");
        assert_eq!(c.name, "Fusoliera");
        let p = param(c, "name");
        assert_eq!(p.before.as_ref().unwrap().display, name);
        assert_eq!(p.after.as_ref().unwrap().display, "Fusoliera");
        // Children of the renamed tube are not reported as moved/added.
        assert_eq!(
            changelog_lines(&d),
            vec!["Tubo «Fusoliera»: rinominato da «Body tube» a «Fusoliera»"]
        );
    }
}

#[test]
fn ambiguous_rename_without_ids_is_not_guessed() {
    // The 13.04 file has two centering rings with the same name: renaming one cannot be matched
    // safely by name, but since exactly one candidate remains on each side it is paired.
    let a = fixture(NOID_FILE);
    let b = variant(&a, |x| {
        // rename BOTH rings differently -> two unmatched on each side -> removed + added
        let x = replace1(x, "<name>Centering ring</name>", "<name>Anello A</name>");
        replace1(&x, "<name>Centering ring</name>", "<name>Anello B</name>")
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    let added = d
        .components
        .iter()
        .filter(|c| c.kind == ComponentChangeKind::Added)
        .count();
    let removed = d
        .components
        .iter()
        .filter(|c| c.kind == ComponentChangeKind::Removed)
        .count();
    assert_eq!((added, removed), (2, 2), "{:#?}", d.components);
}

#[test]
fn materials_finish_and_legacy_duplicates() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        let x = replace1(
            x,
            "<material type=\"bulk\" density=\"1050.0\" group=\"Plastics\">Polystyrene</material>",
            "<material type=\"bulk\" density=\"1200.0\" group=\"Plastics\">ABS</material>",
        );
        replace1(&x, "<length>0.1</length>", "<length>0.12</length>")
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    let c = find_comp(&d, "nosecone");
    assert_eq!(
        param(c, "material").after.as_ref().unwrap().display,
        "ABS (1200 kg/m³)"
    );
    assert_eq!(
        param(c, "length").before.as_ref().unwrap().display,
        "100 mm"
    );
    assert_eq!(param(c, "length").after.as_ref().unwrap().display, "120 mm");
}

#[test]
fn moving_a_component_to_another_parent_is_detected_with_ids() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        let start = x.find("<launchlug>").unwrap();
        let end = x.find("</launchlug>").unwrap() + "</launchlug>".len();
        let block = x[start..end].to_string();
        let mut y = format!("{}{}", &x[..start], &x[end..]);
        // insert into the inner tube's subcomponents
        let i = y.find("<name>Inner Tube</name>").unwrap();
        let j = y[i..].find("<subcomponents>").unwrap() + i + "<subcomponents>".len();
        y.insert_str(j, &block);
        y
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let c = &d.components[0];
    assert_eq!(c.kind, ComponentChangeKind::Moved);
    assert_eq!(c.component_type, "launchlug");
    assert_eq!(c.path, vec!["Sustainer", "Body tube", "Inner Tube"]);
    let p = param(c, "parent");
    assert_eq!(p.before.as_ref().unwrap().display, "Sustainer › Body tube");
    assert_eq!(
        p.after.as_ref().unwrap().display,
        "Sustainer › Body tube › Inner Tube"
    );
}

#[test]
fn reordering_siblings_is_a_move() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        // swap the two centering rings' blocks
        let first = x.find("<centeringring>").unwrap();
        let first_end =
            x[first..].find("</centeringring>").unwrap() + first + "</centeringring>".len();
        let second = x[first_end..].find("<centeringring>").unwrap() + first_end;
        let second_end =
            x[second..].find("</centeringring>").unwrap() + second + "</centeringring>".len();
        format!(
            "{}{}{}{}{}",
            &x[..first],
            &x[second..second_end],
            &x[first_end..second],
            &x[first..first_end],
            &x[second_end..]
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    assert_eq!(d.components[0].kind, ComponentChangeKind::Moved);
    assert!(d.components[0].params.iter().any(|p| p.key == "order"));
}

// ---------------------------------------------------------------------------------------------
// Configurations and simulations
// ---------------------------------------------------------------------------------------------

#[test]
fn motor_configuration_change() {
    for file in [ID_FILE, NOID_FILE] {
        let a = fixture(file);
        let b = variant(&a, |x| {
            replace1(
                x,
                "<designation>A8</designation>",
                "<designation>A10</designation>",
            )
        });
        let d = diff("Razzo.ork", Some(&a), Some(&b));
        assert_eq!(
            d.motor_configurations.len(),
            1,
            "{file}: {:#?}",
            d.motor_configurations
        );
        let c = &d.motor_configurations[0];
        assert_eq!(c.kind, ChangeKind::Modified);
        assert_eq!(c.name, "A10-3");
        let p = &c.params[0];
        assert!(p.label.starts_with("Motore in «"));
        assert_eq!(p.before.as_ref().unwrap().display, "Estes A8, ritardo 3 s");
        assert_eq!(p.after.as_ref().unwrap().display, "Estes A10, ritardo 3 s");
        let lines = changelog_lines(&d);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].starts_with("Configurazione motori «A10-3»: motore in «"),
            "{}",
            lines[0]
        );
    }
}

#[test]
fn simulation_condition_change_keeps_flight_data_untouched() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        let x = replace1(
            x,
            "<windaverage>2.0</windaverage>",
            "<windaverage>4.0</windaverage>",
        );
        let x = replace1(&x, "<speed>2.0</speed>", "<speed>4.0</speed>");
        replace1(
            &x,
            "<launchrodlength>1.0</launchrodlength>",
            "<launchrodlength>1.5</launchrodlength>",
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert!(d.components.is_empty());
    assert_eq!(d.simulations.len(), 1, "{:#?}", d.simulations);
    let s = &d.simulations[0];
    assert_eq!(s.kind, ChangeKind::Modified);
    assert_eq!(s.name, "Simulation 1");
    assert!(!s.data_updated);
    assert!(s.results.is_empty());
    let wind = s.conditions.iter().find(|p| p.key == "windspeed").unwrap();
    assert_eq!(wind.before.as_ref().unwrap().display, "2 m/s");
    assert_eq!(wind.after.as_ref().unwrap().display, "4 m/s");
    let rod = s
        .conditions
        .iter()
        .find(|p| p.key == "launchrodlength")
        .unwrap();
    assert_eq!(rod.after.as_ref().unwrap().display, "1500 mm");
    let lines = changelog_lines(&d);
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].starts_with("Simulazione «Simulation 1»: "),
        "{}",
        lines[0]
    );
    assert!(
        lines[0].contains("velocità media del vento 2 → 4 m/s"),
        "{}",
        lines[0]
    );
}

#[test]
fn simulation_results_and_flight_data() {
    let a = fixture(ID_FILE);
    // New results and a changed data point in simulation 1.
    let b = variant(&a, |x| {
        let x = replace1(x, "maxaltitude=\"50.59\"", "maxaltitude=\"62.3\"");
        replace1(&x, "<datapoint>", "<datapoint>9.99,")
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    let s = &d.simulations[0];
    assert!(s.data_updated);
    let ap = s.results.iter().find(|p| p.key == "maxaltitude").unwrap();
    assert_eq!(ap.label, "Apogeo");
    assert_eq!(ap.before.as_ref().unwrap().display, "50,59 m");
    assert_eq!(ap.after.as_ref().unwrap().display, "62,3 m");
    let lines = changelog_lines(&d);
    assert!(lines[0].contains("apogeo 50,59 → 62,3 m"), "{}", lines[0]);
    assert!(
        lines[0].contains("dati di volo ricalcolati"),
        "{}",
        lines[0]
    );

    // Only the data points differ.
    let c = variant(&a, |x| replace1(x, "<datapoint>", "<datapoint>7,"));
    let d = diff("Razzo.ork", Some(&a), Some(&c));
    assert_eq!(d.simulations.len(), 1);
    assert!(d.simulations[0].data_updated);
    assert!(d.simulations[0].conditions.is_empty() && d.simulations[0].results.is_empty());
}

#[test]
fn added_and_removed_simulations() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        let start = x.rfind("<simulation ").unwrap();
        let end = x.rfind("</simulation>").unwrap() + "</simulation>".len();
        format!("{}{}", &x[..start], &x[end..])
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.simulations.len(), 1);
    assert_eq!(d.simulations[0].kind, ChangeKind::Removed);
    assert_eq!(d.after.as_ref().unwrap().simulation_count, 4);
    let r = diff("Razzo.ork", Some(&b), Some(&a));
    assert_eq!(r.simulations[0].kind, ChangeKind::Added);
    assert!(changelog_lines(&r)[0].starts_with("Aggiunta simulazione «"));
}

// ---------------------------------------------------------------------------------------------
// Whole-file cases, uninterpreted content
// ---------------------------------------------------------------------------------------------

#[test]
fn truncated_side_gives_parse_error_and_no_fake_diff() {
    let a = fixture(ID_FILE);
    let cut = &a[..a.len() / 2];
    let d = diff("Razzo.ork", Some(&a), Some(cut));
    let err = d.parse_error.clone().expect("parse error");
    assert!(err.contains("successiva"), "{err}");
    assert!(d.components.is_empty() && d.simulations.is_empty());
    assert!(d.before.is_some() && d.after.is_none());
    let d = diff("Razzo.ork", Some(cut), Some(&a));
    assert!(d.parse_error.unwrap().contains("precedente"));
    assert!(
        changelog_lines(&diff("x.ork", Some(cut), Some(&a)))[0].starts_with("File non leggibile")
    );
}

#[test]
fn added_and_removed_files() {
    let a = fixture(ID_FILE);
    let d = diff("Razzo.ork", None, Some(&a));
    assert!(d.before.is_none() && d.after.is_some() && d.components.is_empty());
    assert_eq!(
        changelog_lines(&d),
        vec!["Aggiunto: razzo «A simple model rocket» (1 stadio, 12 componenti, 5 simulazioni)"]
    );
    let d = diff("Razzo.ork", Some(&a), None);
    assert_eq!(
        changelog_lines(&d),
        vec!["Rimosso: razzo «A simple model rocket» (1 stadio, 12 componenti, 5 simulazioni)"]
    );
    assert!(diff("x.ork", None, None).is_empty());
}

#[test]
fn unknown_elements_are_reported_as_uninterpreted_never_as_understood() {
    let a = fixture(ID_FILE);
    let b = variant(&a, |x| {
        replace1(
            x,
            "<name>Nose cone</name>",
            "<name>Nose cone</name>\n<fancyfeature mode=\"x\">42</fancyfeature>",
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert!(d.components.is_empty(), "{:#?}", d.components);
    assert_eq!(d.uninterpreted.len(), 1);
    assert_eq!(d.uninterpreted[0].section, "Componenti");
    assert_eq!(d.uninterpreted[0].count, 1);
    assert!(d.uninterpreted[0]
        .sample
        .as_ref()
        .unwrap()
        .contains("fancyfeature"));
    let lines = changelog_lines(&d);
    assert!(
        lines[0].contains("1 modifica non interpretata"),
        "{}",
        lines[0]
    );

    // Document-level sections.
    let c = variant(&a, |x| {
        let i = x.find("<docprefs>").expect("docprefs");
        let j = x[i..].find("</docprefs>").unwrap() + i;
        format!("{}<newpref x=\"1\"/>{}", &x[..j], &x[j..])
    });
    let d = diff("Razzo.ork", Some(&a), Some(&c));
    assert_eq!(d.uninterpreted.len(), 1, "{:#?}", d);
    assert_eq!(d.uninterpreted[0].section, "Preferenze del documento");
}

#[test]
fn changed_decal_image_is_reported_as_uninterpreted() {
    let a = fixture(ID_FILE);
    // Rebuild the zip with a different decal payload.
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&a)).unwrap();
    let mut out = std::io::Cursor::new(Vec::new());
    {
        use std::io::{Read, Write};
        let mut w = zip::ZipWriter::new(&mut out);
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            let name = f.name().unwrap().to_string();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            if name.ends_with("BodyStripe.png") {
                data.push(0);
            }
            w.start_file(name, opts).unwrap();
            w.write_all(&data).unwrap();
        }
        w.finish().unwrap();
    }
    let b = out.into_inner();
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.uninterpreted.len(), 1, "{d:#?}");
    assert!(d.uninterpreted[0].section.starts_with("Immagini allegate"));
    assert_eq!(
        d.uninterpreted[0].sample.as_deref(),
        Some("decals/BodyStripe.png")
    );
}

#[test]
fn json_shape_matches_the_ipc_contract() {
    let a = fixture(ID_FILE);
    let b = fin_count_and_chord(&a);
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    let v = serde_json::to_value(&d).unwrap();
    let keys = |v: &serde_json::Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(&v),
        [
            "after",
            "before",
            "components",
            "motorConfigurations",
            "parseError",
            "path",
            "simulations",
            "uninterpreted"
        ]
    );
    assert!(v["parseError"].is_null());
    assert_eq!(
        keys(&v["before"]),
        [
            "componentCount",
            "container",
            "creator",
            "formatVersion",
            "rocketName",
            "simulationCount",
            "stageCount"
        ]
    );
    assert_eq!(v["before"]["container"], "zip");
    let c = &v["components"][0];
    assert_eq!(
        keys(c),
        [
            "componentType",
            "kind",
            "name",
            "params",
            "path",
            "typeLabel"
        ]
    );
    assert_eq!(c["kind"], "modified");
    assert_eq!(keys(&c["params"][0]), ["after", "before", "key", "label"]);
    assert_eq!(keys(&c["params"][0]["before"]), ["display", "raw", "unit"]);
    // Added file: before is null.
    let v = serde_json::to_value(diff("x.ork", None, Some(&a))).unwrap();
    assert!(v["before"].is_null());

    let sim = diff(
        "Razzo.ork",
        Some(&a),
        Some(&variant(&a, |x| {
            replace1(
                x,
                "<launchrodlength>1.0</launchrodlength>",
                "<launchrodlength>2.0</launchrodlength>",
            )
        })),
    );
    let v = serde_json::to_value(&sim).unwrap();
    assert_eq!(
        keys(&v["simulations"][0]),
        ["conditions", "dataUpdated", "kind", "name", "results"]
    );

    let tw = three_way("Razzo.ork", &a, &b, &a);
    let v = serde_json::to_value(&tw).unwrap();
    assert_eq!(
        keys(&v),
        ["independent", "mine", "overlapping", "path", "theirs"]
    );
    let unc = UninterpretedChange {
        section: "s".into(),
        count: 1,
        sample: None,
    };
    assert_eq!(
        keys(&serde_json::to_value(&unc).unwrap()),
        ["count", "sample", "section"]
    );
    let o = OverlapItem {
        component_path: vec![],
        component_name: "n".into(),
        key: None,
        label: "l".into(),
        mine: None,
        theirs: None,
    };
    assert_eq!(
        keys(&serde_json::to_value(&o).unwrap()),
        [
            "componentName",
            "componentPath",
            "key",
            "label",
            "mine",
            "theirs"
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// Three-way
// ---------------------------------------------------------------------------------------------

fn tweak_chord(x: &str, to: &str) -> String {
    set_first(x, "rootchord", to)
}

#[test]
fn three_way_independent_changes() {
    for file in [ID_FILE, NOID_FILE] {
        let base = fixture(file);
        let mine = variant(&base, |x| tweak_chord(x, "0.09"));
        let theirs = variant(&base, |x| {
            replace1(x, "<length>0.1</length>", "<length>0.13</length>")
        });
        let tw = three_way("Razzo.ork", &base, &mine, &theirs);
        assert!(tw.independent, "{file}: {:#?}", tw.overlapping);
        assert!(tw.overlapping.is_empty());
        assert_eq!(tw.mine.components.len(), 1);
        assert_eq!(tw.theirs.components.len(), 1);
        assert_eq!(tw.mine.components[0].component_type, "trapezoidfinset");
        assert_eq!(tw.theirs.components[0].component_type, "nosecone");
    }
}

#[test]
fn three_way_same_parameter_different_values_overlaps() {
    for file in [ID_FILE, NOID_FILE] {
        let base = fixture(file);
        let mine = variant(&base, |x| tweak_chord(x, "0.09"));
        let theirs = variant(&base, |x| tweak_chord(x, "0.07"));
        let tw = three_way("Razzo.ork", &base, &mine, &theirs);
        assert!(!tw.independent);
        assert_eq!(tw.overlapping.len(), 1, "{:#?}", tw.overlapping);
        let o = &tw.overlapping[0];
        assert_eq!(o.key.as_deref(), Some("rootchord"));
        assert_eq!(o.label, "Corda alla radice");
        assert_eq!(o.component_name, "Trapezoidal fin set");
        assert_eq!(
            o.component_path.last().map(String::as_str),
            Some("Body tube")
        );
        assert_eq!(o.mine.as_ref().unwrap().display, "90 mm");
        assert_eq!(o.theirs.as_ref().unwrap().display, "70 mm");
    }
}

#[test]
fn three_way_identical_change_on_both_sides_is_not_an_overlap() {
    let base = fixture(ID_FILE);
    let mine = variant(&base, |x| tweak_chord(x, "0.09"));
    let theirs = variant(&base, |x| tweak_chord(x, "0.09"));
    let tw = three_way("Razzo.ork", &base, &mine, &theirs);
    assert!(tw.independent);
}

#[test]
fn three_way_removed_versus_modified() {
    let base = fixture(ID_FILE);
    let mine = variant(&base, |x| {
        let start = x.find("<launchlug>").unwrap();
        let end = x.find("</launchlug>").unwrap() + "</launchlug>".len();
        format!("{}{}", &x[..start], &x[end..])
    });
    let theirs = variant(&base, |x| {
        replace1(x, "<radius>0.0035</radius>", "<radius>0.005</radius>")
    });
    let tw = three_way("Razzo.ork", &base, &mine, &theirs);
    assert!(!tw.independent);
    assert_eq!(tw.overlapping.len(), 1, "{:#?}", tw.overlapping);
    let o = &tw.overlapping[0];
    assert!(o.key.is_none());
    assert!(o.mine.is_none());
    assert!(o.theirs.is_some());
    assert_eq!(o.component_name, "Launch lug");
}

#[test]
fn three_way_simulation_condition_overlap_and_independent_simulation_edits() {
    let base = fixture(ID_FILE);
    let mine = variant(&base, |x| {
        replace1(
            x,
            "<launchrodlength>1.0</launchrodlength>",
            "<launchrodlength>2.0</launchrodlength>",
        )
    });
    let theirs = variant(&base, |x| {
        replace1(
            x,
            "<launchrodlength>1.0</launchrodlength>",
            "<launchrodlength>3.0</launchrodlength>",
        )
    });
    let tw = three_way("Razzo.ork", &base, &mine, &theirs);
    assert!(!tw.independent);
    assert_eq!(tw.overlapping[0].key.as_deref(), Some("launchrodlength"));
    assert_eq!(tw.overlapping[0].component_path, vec!["Simulazioni"]);

    // Different simulations modified: independent.
    let theirs2 = variant(&base, |x| {
        let i = x.rfind("<launchrodlength>1.0</launchrodlength>").unwrap();
        format!(
            "{}<launchrodlength>3.0</launchrodlength>{}",
            &x[..i],
            &x[i + "<launchrodlength>1.0</launchrodlength>".len()..]
        )
    });
    let tw = three_way("Razzo.ork", &base, &mine, &theirs2);
    assert!(tw.independent, "{:#?}", tw.overlapping);
}

#[test]
fn three_way_both_added_same_component_overlaps_and_unreadable_is_not_independent() {
    let base = fixture(ID_FILE);
    let add = |x: &str| {
        let i = x.find("<name>Body tube</name>").unwrap();
        let j = x[i..].find("<subcomponents>").unwrap() + i + "<subcomponents>".len();
        format!("{}{}{}", &x[..j], PARACHUTE, &x[j..])
    };
    let mine = variant(&base, add);
    let theirs = variant(&base, |x| {
        add(x).replace(
            "aaaaaaaa-0000-4000-8000-000000000001",
            "bbbbbbbb-0000-4000-8000-000000000002",
        )
    });
    let tw = three_way("Razzo.ork", &base, &mine, &theirs);
    assert!(!tw.independent);
    assert_eq!(tw.overlapping[0].label, "Aggiunto da entrambe le parti");

    let bad = &base[..base.len() / 2];
    let tw = three_way("Razzo.ork", &base, &mine, bad);
    assert!(!tw.independent);
    assert!(tw.theirs.parse_error.is_some());
    assert!(tw.mine.parse_error.is_none());
}

// ---------------------------------------------------------------------------------------------
// Normalized XML and inspector
// ---------------------------------------------------------------------------------------------

#[test]
fn normalized_xml_is_stable_and_strips_flight_data() {
    let bytes = fixture(ID_FILE);
    let full = normalized_xml(&bytes, false).unwrap();
    let lite = normalized_xml(&bytes, true).unwrap();
    assert!(full.contains("<datapoint>"));
    assert!(!lite.contains("<datapoint>") && !lite.contains("<databranch"));
    assert!(lite.contains("<flightdata maxaltitude="));
    assert!(lite.len() < full.len() / 4);
    assert!(lite.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<openrocket"));
    // Idempotent: normalizing the normalized XML gives the same text.
    assert_eq!(normalized_xml(full.as_bytes(), false).unwrap(), full);
    assert_eq!(normalized_xml(lite.as_bytes(), true).unwrap(), lite);
    // Re-saving with different whitespace gives the same normalized text.
    let xml = xml_of(&bytes).replace("\n      <name>", "\n\n          <name>");
    let again = with_xml(&bytes, &xml);
    assert_eq!(normalized_xml(&again, true).unwrap(), lite);
    assert!(normalized_xml(&bytes[..bytes.len() / 2], true).is_err());
}

#[test]
fn inspector_matches_the_file_inspector_signature() {
    let insp = OrkInspector::new();
    let a = fixture(ID_FILE);
    assert_eq!(insp.validate("Razzo.ork", &a), Ok(()));
    let err = insp.validate("Razzo.ork", &a[..a.len() / 2]).unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(insp.validate("note.txt", b"anything"), Ok(()));

    let b = fin_count_and_chord(&a);
    let lines = insp.changelog("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(lines.len(), 1);
    assert!(lines[0].starts_with("Pinne trapezoidali «Trapezoidal fin set»: numero di pinne 3 → 4"));
    assert_eq!(
        insp.changelog("note.txt", None, Some(b"x")),
        vec!["Aggiunto"]
    );
    assert_eq!(
        insp.changelog("note.txt", Some(b"x"), None),
        vec!["Rimosso"]
    );
    assert_eq!(
        insp.changelog("note.txt", Some(b"x"), Some(b"y")),
        vec!["Modificato (contenuto non interpretato)"]
    );
    // Unreadable .ork: never pretends to understand.
    assert_eq!(
        insp.changelog("Razzo.ork", Some(&a), Some(&a[..100])),
        vec!["Modificato (contenuto non interpretato)"]
    );
    assert_eq!(insp.changelog("Razzo.ork", None, Some(&a)).len(), 1);
}

#[test]
fn real_fixtures_cross_version_diff_is_well_formed() {
    // Different OpenRocket versions of "A simple model rocket": no IDs -> IDs. Must not fail,
    // and most components must be matched by position/name (few adds/removes).
    let old = fixture(NOID_FILE);
    let new = fixture(ID_FILE);
    let d = diff("Razzo.ork", Some(&old), Some(&new));
    assert!(d.parse_error.is_none());
    let added = d
        .components
        .iter()
        .filter(|c| c.kind == ComponentChangeKind::Added)
        .count();
    let removed = d
        .components
        .iter()
        .filter(|c| c.kind == ComponentChangeKind::Removed)
        .count();
    assert_eq!((added, removed), (0, 0), "{:#?}", d.components);
    // Lines must be producible for every case.
    assert!(!changelog_lines(&d).is_empty());
}

// ---------------------------------------------------------------------------------------------
// Other component kinds, on real fixtures
// ---------------------------------------------------------------------------------------------

#[test]
fn deployment_override_per_configuration_is_labelled_with_the_configuration() {
    let a = fixture("two-stage-rocket-22.02.ork");
    let b = variant(&a, |x| {
        // first deployment override: altitude 152.4 -> 100
        replace1(
            x,
            "<deployaltitude>152.4</deployaltitude>",
            "<deployaltitude>100.0</deployaltitude>",
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&b));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let c = &d.components[0];
    assert_eq!(c.component_type, "parachute");
    let p = &c.params[0];
    assert!(p.key.starts_with("deployaltitude@"), "{}", p.key);
    assert!(
        p.label.starts_with("Quota di apertura (configurazione «"),
        "{}",
        p.label
    );
    assert_eq!(p.before.as_ref().unwrap().display, "152,4 m");
    assert_eq!(p.after.as_ref().unwrap().display, "100 m");
}

#[test]
fn stage_separation_and_freeform_fin_points() {
    let a = fixture("three-stage-rocket-13.04.ork");
    let c = variant(&a, |x| {
        replace1(
            x,
            "<point x=\"0.025\" y=\"0.03\"/>",
            "<point x=\"0.03\" y=\"0.035\"/>",
        )
    });
    let d = diff("Razzo.ork", Some(&a), Some(&c));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    let comp = &d.components[0];
    assert_eq!(comp.component_type, "freeformfinset");
    let p = param(comp, "finpoints");
    assert_eq!(p.label, "Profilo delle pinne");
    assert!(p.before.as_ref().unwrap().display.contains("(25; 30)"));
    assert!(p.after.as_ref().unwrap().display.contains("(30; 35)"));

    let e = variant(&a, |x| set_first(x, "separationdelay", "0.5"));
    let d = diff("Razzo.ork", Some(&a), Some(&e));
    assert_eq!(d.components.len(), 1, "{:#?}", d.components);
    assert_eq!(d.components[0].component_type, "stage");
    let p = param(&d.components[0], "separationdelay");
    assert_eq!(p.label, "Ritardo di separazione dello stadio");
    assert_eq!(p.after.as_ref().unwrap().display, "0,5 s");
}

#[test]
fn pods_tube_fins_and_presets_are_understood() {
    let pods = parse(&fixture("pods-airframes-22.02.ork")).unwrap();
    assert!(pods.components.iter().any(|c| c.component_type == "podset"));
    let tube = parse(&fixture("tube-fin-rocket-22.02.ork")).unwrap();
    assert!(tube
        .components
        .iter()
        .any(|c| c.component_type == "tubefinset"));
    let presets = parse(&fixture("two-stage-rocket-22.02.ork")).unwrap();
    assert!(presets.components.iter().any(|c| c
        .params
        .iter()
        .any(|p| p.key == "preset" && p.value.display.contains("LOC/Precision"))));
    let par = parse(&fixture("parallel-booster-staging-24.12.ork")).unwrap();
    let booster = par
        .components
        .iter()
        .find(|c| c.component_type == "parallelstage")
        .unwrap();
    assert_eq!(booster.type_label, "Stadio parallelo (booster)");
    assert!(booster.params.iter().any(|p| p.key == "separationevent"));
}

#[test]
fn parse_exposes_the_interpreted_model() {
    let doc = parse(&fixture(ID_FILE)).unwrap();
    assert_eq!(doc.components.len(), 13); // rocket + 12
    let fins = doc
        .components
        .iter()
        .find(|c| c.component_type == "trapezoidfinset")
        .unwrap();
    assert!(fins.id.is_some());
    assert_eq!(fins.path, vec!["Sustainer", "Body tube"]);
    let chord = fins.params.iter().find(|p| p.key == "rootchord").unwrap();
    assert_eq!(chord.value.display, "50,8 mm");
    assert_eq!(chord.value.raw, "0.0508");
    assert_eq!(doc.motor_configurations.len(), 5);
    assert_eq!(doc.motor_configurations[0].name, "A8-3");
    assert_eq!(doc.simulations[0].name, "Simulation 1");
    let apogee = doc.simulations[0]
        .results
        .iter()
        .find(|p| p.key == "maxaltitude")
        .unwrap();
    assert_eq!(apogee.value.display, "50,59 m");
}
