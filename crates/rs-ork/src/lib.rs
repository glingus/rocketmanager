//! rs-ork: reading, validation, semantic diff and changelog for OpenRocket `.ork` files.
//!
//! See `docs/formato-ork.md` for the file format and `docs/contratto-ipc.md` (section 3) for the
//! serialized shape of the diff types.

mod catalog;
mod changelog;
mod container;
mod diff;
mod error;
mod inspector;
mod model;
mod types;
mod units;
mod xml;

pub use changelog::changelog_lines;
pub use container::detect_container;
pub use error::OrkError;
pub use inspector::OrkInspector;
pub use types::*;

use serde::{Deserialize, Serialize};

/// Reads the whole file and checks that it is complete and structurally an OpenRocket document.
///
/// Rejects truncated ZIP/GZIP archives (checksum verified on every entry) and XML that is cut
/// off: this is the "OpenRocket has finished writing" check.
pub fn validate(bytes: &[u8]) -> Result<OrkSummary, OrkError> {
    model::load(bytes).map(|d| d.summary)
}

/// A component with its interpreted parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedComponent {
    pub id: Option<String>,
    pub component_type: String,
    pub type_label: String,
    pub name: String,
    /// Names of the ancestors, from the stage down.
    pub path: Vec<String>,
    pub params: Vec<ParsedParam>,
    /// Number of child elements that were not interpreted.
    pub uninterpreted_elements: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedParam {
    pub key: String,
    pub label: String,
    pub value: DisplayValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConfig {
    pub id: String,
    pub name: String,
    pub motors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSimulation {
    pub name: String,
    pub conditions: Vec<ParsedParam>,
    pub results: Vec<ParsedParam>,
}

/// Interpreted view of a document (everything not listed here is uninterpreted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrkDocument {
    pub summary: OrkSummary,
    pub components: Vec<ParsedComponent>,
    pub motor_configurations: Vec<ParsedConfig>,
    pub simulations: Vec<ParsedSimulation>,
}

fn parsed_params(ps: &[model::ParamVal]) -> Vec<ParsedParam> {
    ps.iter()
        .map(|p| ParsedParam {
            key: p.full_key(),
            label: p.label.clone(),
            value: DisplayValue {
                raw: p.raw.clone(),
                display: p.display.clone(),
                unit: p.unit.clone(),
            },
        })
        .collect()
}

/// Parses a file into its interpreted view.
pub fn parse(bytes: &[u8]) -> Result<OrkDocument, OrkError> {
    let d = model::load(bytes)?;
    let components = d
        .comps
        .iter()
        .enumerate()
        .map(|(i, c)| ParsedComponent {
            id: c.id.clone(),
            component_type: c.element.clone(),
            type_label: c.label.clone(),
            name: c.display_name(),
            path: d.path_of(i),
            params: parsed_params(&c.params),
            uninterpreted_elements: c.unknown.len() as u32,
        })
        .collect();
    let motor_configurations = d
        .configs
        .iter()
        .map(|c| ParsedConfig {
            id: c.id.clone(),
            name: d.config_name(&c.id),
            motors: d
                .motors_of(&c.id)
                .iter()
                .map(|m| model::motor_display(m))
                .collect(),
        })
        .collect();
    let simulations = d
        .sims
        .iter()
        .map(|s| ParsedSimulation {
            name: s.name.clone(),
            conditions: parsed_params(&s.conditions),
            results: parsed_params(&s.results),
        })
        .collect();
    Ok(OrkDocument {
        summary: d.summary.clone(),
        components,
        motor_configurations,
        simulations,
    })
}

fn empty_diff(path: &str) -> OrkDiff {
    OrkDiff {
        path: path.to_string(),
        before: None,
        after: None,
        components: Vec::new(),
        motor_configurations: Vec::new(),
        simulations: Vec::new(),
        uninterpreted: Vec::new(),
        parse_error: None,
    }
}

/// Semantic difference between two versions of the same file.
///
/// - `before = None`: file added; `after = None`: file removed. In both cases only the summary
///   of the existing side is given (the lists stay empty).
/// - If a side cannot be read, `parse_error` explains which and the lists are empty.
pub fn diff(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> OrkDiff {
    let b = before.map(model::load);
    let a = after.map(model::load);
    let mut out = empty_diff(path);
    let mut errors: Vec<String> = Vec::new();
    let (mut bd, mut ad) = (None, None);
    match b {
        Some(Ok(d)) => {
            out.before = Some(d.summary.clone());
            bd = Some(d);
        }
        Some(Err(e)) => errors.push(format!("la versione precedente non è leggibile ({e})")),
        None => {}
    }
    match a {
        Some(Ok(d)) => {
            out.after = Some(d.summary.clone());
            ad = Some(d);
        }
        Some(Err(e)) => errors.push(format!("la versione successiva non è leggibile ({e})")),
        None => {}
    }
    if !errors.is_empty() {
        out.parse_error = Some(errors.join("; "));
        return out;
    }
    if let (Some(b), Some(a)) = (&bd, &ad) {
        return diff::compute(path, b, a).diff;
    }
    out
}

/// Differences of `mine` and `theirs` against the common ancestor `base`, and the parameters
/// changed by both sides (to different values).
///
/// `independent` is `true` only when every file is readable and there is no overlap. A file that
/// cannot be read makes the result "not independent" (nothing can be asserted).
pub fn three_way(path: &str, base: &[u8], mine: &[u8], theirs: &[u8]) -> OrkThreeWay {
    let bl = model::load(base);
    let ml = model::load(mine);
    let tl = model::load(theirs);
    match (&bl, &ml, &tl) {
        (Ok(b), Ok(m), Ok(t)) => {
            let im = diff::compute(path, b, m);
            let it = diff::compute(path, b, t);
            let overlapping = diff::overlaps(b, &im, &it);
            OrkThreeWay {
                path: path.to_string(),
                independent: overlapping.is_empty(),
                mine: im.diff,
                theirs: it.diff,
                overlapping,
            }
        }
        _ => OrkThreeWay {
            path: path.to_string(),
            mine: diff(path, Some(base), Some(mine)),
            theirs: diff(path, Some(base), Some(theirs)),
            overlapping: Vec::new(),
            independent: false,
        },
    }
}

/// Stable, indented XML of the document, for a raw textual diff.
///
/// `strip_flight_data` drops the `<databranch>` elements (thousands of data points); the summary
/// attributes of `<flightdata>` (apogee, ...) are kept. The container is irrelevant.
pub fn normalized_xml(bytes: &[u8], strip_flight_data: bool) -> Result<String, OrkError> {
    let ex = container::extract(bytes)?;
    let root = xml::parse_dom(
        &ex.xml,
        xml::ParseOpts {
            keep_flight_points: !strip_flight_data,
        },
    )?;
    Ok(xml::to_indented(&root, strip_flight_data))
}
