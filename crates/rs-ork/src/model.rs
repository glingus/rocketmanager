//! Semantic model extracted from the XML tree: a flat list of components with their interpreted
//! parameters, motor configurations, simulations, and everything that could not be interpreted.

use crate::catalog::{self, PSpec};
use crate::container::{self, Attachment};
use crate::error::OrkError;
use crate::types::{Container, OrkSummary};
use crate::units::{self, fmt_num, hex_color, parse_f64, render, translate, Kind};
use crate::xml::{canonical, fnv1a, parse_dom, Node, ParseOpts};
use std::collections::HashSet;

/// An interpreted parameter with its display value.
#[derive(Debug, Clone)]
pub(crate) struct ParamVal {
    /// Stable key; config-scoped parameters carry `@<configid>` in `full_key()`.
    pub key: String,
    pub label: String,
    pub raw: String,
    pub display: String,
    pub unit: Option<String>,
    /// String used to decide whether two values are the same.
    pub cmp: String,
    /// Flight configuration the value is scoped to (deployment/separation overrides).
    pub cfg: Option<String>,
    /// The value equals what OpenRocket assumes when the element is absent.
    pub is_default: bool,
}

impl ParamVal {
    pub fn full_key(&self) -> String {
        match &self.cfg {
            Some(c) => format!("{}@{}", self.key, c),
            None => self.key.clone(),
        }
    }
}

/// A piece of XML that was not interpreted.
#[derive(Debug, Clone)]
pub(crate) struct Unk {
    pub canon: String,
    pub sample: String,
}

#[derive(Debug, Clone)]
pub(crate) struct FlatComp {
    pub element: String,
    pub label: String,
    pub name: String,
    pub id: Option<String>,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub params: Vec<ParamVal>,
    pub unknown: Vec<Unk>,
}

impl FlatComp {
    pub fn display_name(&self) -> String {
        if self.name.is_empty() {
            self.label.clone()
        } else {
            self.name.clone()
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct MotorUse {
    pub mount: usize,
    pub config: String,
    pub manufacturer: String,
    pub designation: String,
    pub delay: String,
    /// Digest, type, diameter and length as stored: identifies the motor definition used.
    pub definition: String,
    pub ignition_event: Option<String>,
    pub ignition_delay: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub id: String,
    pub name: Option<String>,
    pub stages: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub(crate) struct Sim {
    pub name: String,
    pub config_id: Option<String>,
    pub conditions: Vec<ParamVal>,
    pub results: Vec<ParamVal>,
    pub flight_fp: u64,
    pub unknown: Vec<Unk>,
}

#[derive(Debug, Clone)]
pub(crate) struct Misc {
    pub section: String,
    pub items: Vec<Unk>,
}

#[derive(Debug, Clone)]
pub(crate) struct Doc {
    pub summary: OrkSummary,
    pub comps: Vec<FlatComp>,
    pub configs: Vec<Config>,
    pub motors: Vec<MotorUse>,
    pub sims: Vec<Sim>,
    pub misc: Vec<Misc>,
    pub attachments: Vec<Attachment>,
}

impl Doc {
    /// Ancestor names of a component, from the stage down (root rocket excluded), component excluded.
    pub fn path_of(&self, idx: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = self.comps[idx].parent;
        while let Some(p) = cur {
            if p != 0 {
                out.push(self.comps[p].display_name());
            }
            cur = self.comps[p].parent;
        }
        out.reverse();
        out
    }

    pub fn descendants(&self, idx: usize) -> usize {
        self.comps[idx]
            .children
            .iter()
            .map(|c| 1 + self.descendants(*c))
            .sum()
    }

    pub fn config(&self, id: &str) -> Option<&Config> {
        self.configs.iter().find(|c| c.id == id)
    }

    pub fn motors_of(&self, id: &str) -> Vec<&MotorUse> {
        self.motors.iter().filter(|m| m.config == id).collect()
    }

    /// Human-readable configuration name: explicit name, else the motor list (e.g. "A8-3").
    pub fn config_name(&self, id: &str) -> String {
        if let Some(Config { name: Some(n), .. }) = self.config(id) {
            if !n.is_empty() {
                return n.clone();
            }
        }
        let motors = self.motors_of(id);
        if motors.is_empty() {
            return "senza motori".to_string();
        }
        motors
            .iter()
            .map(|m| motor_short(m))
            .collect::<Vec<_>>()
            .join(" + ")
    }
}

pub(crate) fn motor_short(m: &MotorUse) -> String {
    let delay = match m.delay.trim().to_ascii_lowercase().as_str() {
        "none" => "P".to_string(),
        d => match parse_f64(d) {
            Some(v) => fmt_num(v, 1),
            None => d.to_string(),
        },
    };
    format!("{}-{}", m.designation, delay)
}

pub(crate) fn motor_display(m: &MotorUse) -> String {
    let who = if m.manufacturer.is_empty() {
        m.designation.clone()
    } else {
        format!("{} {}", m.manufacturer, m.designation)
    };
    let delay = match m.delay.trim().to_ascii_lowercase().as_str() {
        "none" => "senza ritardo (tappato)".to_string(),
        d => match parse_f64(d) {
            Some(v) => format!("ritardo {} s", fmt_num(v, 1)),
            None => format!("ritardo {d}"),
        },
    };
    format!("{who}, {delay}")
}

fn param(spec_key: &str, label: &str, raw: &str, kind: Kind) -> ParamVal {
    let r = render(kind, raw);
    // "auto <cached value>": the cached value follows the parent component, only "auto" matters.
    let cmp = if kind == Kind::Diameter && raw.trim().to_ascii_lowercase().starts_with("auto") {
        "auto".to_string()
    } else {
        format!("{}|{}", r.display, r.unit.clone().unwrap_or_default())
    };
    ParamVal {
        key: spec_key.to_string(),
        label: label.to_string(),
        raw: raw.trim().to_string(),
        cmp,
        display: r.display,
        unit: r.unit,
        cfg: None,
        is_default: catalog::is_default_value(spec_key, raw),
    }
}

fn text_param(key: &str, label: &str, raw: &str, display: String) -> ParamVal {
    ParamVal {
        key: key.to_string(),
        label: label.to_string(),
        raw: raw.to_string(),
        cmp: display.clone(),
        display,
        unit: None,
        cfg: None,
        is_default: catalog::is_default_value(key, raw),
    }
}

fn unk(node: &Node, prefix: &str) -> Unk {
    let sample = match (node.name.as_str(), node.attr("extensionid")) {
        ("extension", Some(id)) => format!("<extension {id}>"),
        _ => format!("<{}{}>", prefix, node.name),
    };
    Unk {
        canon: format!("{prefix}{}", canonical(node)),
        sample,
    }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

pub(crate) fn load(bytes: &[u8]) -> Result<Doc, OrkError> {
    let extracted = container::extract(bytes)?;
    load_xml(extracted.container, &extracted.xml, extracted.attachments)
}

pub(crate) fn load_xml(
    container: Container,
    xml: &[u8],
    attachments: Vec<Attachment>,
) -> Result<Doc, OrkError> {
    let root = parse_dom(
        xml,
        ParseOpts {
            keep_flight_points: false,
        },
    )?;
    if root.name == "RockSimDoc" || root.name == "RASAeroDoc" {
        return Err(OrkError::Unsupported(
            "è un file RockSim/RASAero, non un progetto OpenRocket".into(),
        ));
    }
    if root.name != "openrocket" {
        return Err(OrkError::Structure(format!(
            "l'elemento radice è «{}» invece di «openrocket»",
            root.name
        )));
    }
    let rocket = root
        .child("rocket")
        .ok_or_else(|| OrkError::Structure("manca l'elemento «rocket»".into()))?;

    let mut doc = Doc {
        summary: OrkSummary {
            container,
            creator: root.attr("creator").map(str::to_string),
            format_version: root.attr("version").map(str::to_string),
            rocket_name: rocket.child_text("name").map(str::to_string),
            stage_count: 0,
            component_count: 0,
            simulation_count: 0,
        },
        comps: Vec::new(),
        configs: Vec::new(),
        motors: Vec::new(),
        sims: Vec::new(),
        misc: Vec::new(),
        attachments,
    };

    add_component(rocket, None, &mut doc);
    doc.configs = read_configs(rocket, &mut doc.misc);
    // Configurations referenced only by motors (no <motorconfiguration> element).
    let mut known: HashSet<String> = doc.configs.iter().map(|c| c.id.clone()).collect();
    let extra: Vec<String> = doc
        .motors
        .iter()
        .map(|m| m.config.clone())
        .filter(|c| known.insert(c.clone()))
        .collect();
    for id in extra {
        doc.configs.push(Config {
            id,
            name: None,
            stages: Vec::new(),
        });
    }

    for child in &root.children {
        match child.name.as_str() {
            "rocket" => {}
            "simulations" => {
                let mut stray = Vec::new();
                for s in &child.children {
                    if s.name == "simulation" {
                        let sim = read_sim(s, &doc);
                        doc.sims.push(sim);
                    } else {
                        stray.push(unk(s, ""));
                    }
                }
                if !stray.is_empty() {
                    doc.misc.push(Misc {
                        section: "Simulazioni".into(),
                        items: stray,
                    });
                }
            }
            "datatypes" => doc.misc.push(Misc {
                section: "Espressioni personalizzate".into(),
                items: child.children.iter().map(|c| unk(c, "")).collect(),
            }),
            "photostudio" => doc.misc.push(Misc {
                section: "Impostazioni di PhotoStudio".into(),
                items: items_of(child),
            }),
            "docprefs" => doc.misc.push(Misc {
                section: "Preferenze del documento".into(),
                items: items_of(child),
            }),
            _ => doc.misc.push(Misc {
                section: "Altri elementi del file".into(),
                items: vec![unk(child, "")],
            }),
        }
    }

    doc.summary.stage_count = doc
        .comps
        .iter()
        .filter(|c| catalog::is_stage_like(&c.element))
        .count() as u32;
    doc.summary.component_count = doc.comps.len().saturating_sub(1) as u32;
    doc.summary.simulation_count = doc.sims.len() as u32;
    Ok(doc)
}

fn items_of(node: &Node) -> Vec<Unk> {
    let mut v: Vec<Unk> = node.children.iter().map(|c| unk(c, "")).collect();
    if !node.text.is_empty() {
        v.push(Unk {
            canon: format!("#text:{}", node.text),
            sample: "<testo>".into(),
        });
    }
    v
}

fn add_component(node: &Node, parent: Option<usize>, doc: &mut Doc) -> usize {
    let idx = doc.comps.len();
    let element = node.name.clone();
    let label = catalog::type_label(&element)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Componente non riconosciuto «{element}»"));
    doc.comps.push(FlatComp {
        element: element.clone(),
        label,
        name: node.child_text("name").unwrap_or("").to_string(),
        id: node
            .child_text("id")
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        parent,
        children: Vec::new(),
        params: Vec::new(),
        unknown: Vec::new(),
    });
    if let Some(p) = parent {
        doc.comps[p].children.push(idx);
    }
    let (params, unknown, motors) = extract_params(node, idx);
    doc.comps[idx].params = params;
    doc.comps[idx].unknown = unknown;
    doc.motors.extend(motors);
    if let Some(sub) = node.child("subcomponents") {
        for c in &sub.children {
            add_component(c, Some(idx), doc);
        }
    }
    idx
}

fn first<'a>(node: &'a Node, names: &[&str]) -> Option<&'a Node> {
    names.iter().find_map(|n| node.child(n))
}

fn extract_params(node: &Node, idx: usize) -> (Vec<ParamVal>, Vec<Unk>, Vec<MotorUse>) {
    let element = node.name.as_str();
    let mut params: Vec<ParamVal> = Vec::new();
    let mut unknown: Vec<Unk> = Vec::new();
    let mut motors: Vec<MotorUse> = Vec::new();
    let mut consumed: HashSet<&str> = HashSet::new();
    for n in ["name", "id", "subcomponents"] {
        consumed.insert(n);
    }

    // Instance count (modern `instancecount`, legacy `fincount`).
    if let Some(n) = first(node, &["instancecount", "fincount"]) {
        params.push(param(
            "instancecount",
            catalog::count_label(element),
            &n.text,
            Kind::Int,
        ));
    }
    consumed.insert("instancecount");
    consumed.insert("fincount");

    // Simple parameters from the catalogue.
    let specs: Vec<PSpec> = catalog::simple_params(element);
    for s in &specs {
        if let Some(n) = node.child(s.key) {
            params.push(param(s.key, s.label, &n.text, s.kind));
            consumed.insert(s.key);
        }
    }

    // Axial position: `axialoffset method=` (modern) or `position type=` (legacy). When absent
    // OpenRocket means "after the previous component".
    if element != "rocket" {
        let (method, value) = match first(node, &["axialoffset", "position"]) {
            Some(n) => (
                n.attr("method")
                    .or_else(|| n.attr("type"))
                    .unwrap_or("after")
                    .to_ascii_lowercase(),
                n.text.clone(),
            ),
            None => ("after".to_string(), "0".to_string()),
        };
        let display = if method == "after" {
            translate(units::AXIAL_METHOD, "after")
        } else {
            format!(
                "{} {}",
                render(Kind::Length, &value).display,
                translate(units::AXIAL_METHOD, &method)
            )
        };
        params.push(text_param(
            "axialoffset",
            "Posizione assiale",
            &format!("{method}:{}", value.trim()),
            display,
        ));
    }
    consumed.insert("axialoffset");
    consumed.insert("position");

    // Rotation around the axis.
    if let Some(n) = first(node, &["angleoffset", "rotation", "radialdirection"]) {
        let r = render(Kind::AngleDeg, &n.text);
        let method = n.attr("method").unwrap_or("relative");
        let display = if method == "relative" || n.attr("method").is_none() {
            r.display.clone()
        } else {
            format!("{} ({})", r.display, translate(units::ANGLE_METHOD, method))
        };
        let mut pv = text_param(
            "angleoffset",
            "Angolo di rotazione",
            &format!("{method}:{}", n.text.trim()),
            display,
        );
        pv.unit = r.unit;
        params.push(pv);
    }
    for n in ["angleoffset", "rotation", "radialdirection"] {
        consumed.insert(n);
    }

    if let Some(n) = node.child("radiusoffset") {
        let method = n.attr("method").unwrap_or("relative");
        let display = format!(
            "{}, {}",
            render(Kind::Length, &n.text).display,
            translate(units::RADIUS_METHOD, method)
        );
        let mut pv = text_param(
            "radiusoffset",
            "Distanza radiale",
            &format!("{method}:{}", n.text.trim()),
            display,
        );
        pv.is_default = catalog::is_default_value("radiusoffset", &n.text);
        params.push(pv);
    }
    consumed.insert("radiusoffset");

    // Materials.
    for (key, label) in [
        ("material", "Materiale"),
        ("filletmaterial", "Materiale del raccordo"),
        ("linematerial", "Materiale dei cordini"),
    ] {
        if let Some(n) = node.child(key) {
            let density = n.attr("density").unwrap_or("");
            let unit = match n.attr("type") {
                Some("surface") => "kg/m²",
                Some("line") => "kg/m",
                _ => "kg/m³",
            };
            let display = match parse_f64(density) {
                Some(d) => format!("{} ({} {})", n.text, fmt_num(d, 4), unit),
                None => n.text.clone(),
            };
            params.push(text_param(
                key,
                label,
                &format!("{}|{}|{}", n.text, n.attr("type").unwrap_or(""), density),
                display,
            ));
        }
        consumed.insert(key);
    }

    // Appearance.
    for (key, label, inside) in [
        ("appearance", "Aspetto", false),
        ("insideappearance", "Aspetto interno", true),
        ("inside-appearance", "Aspetto interno", true),
    ] {
        if let Some(n) = node.child(key) {
            let out_key = if inside {
                "insideappearance"
            } else {
                "appearance"
            };
            params.push(appearance_param(n, out_key, label, inside));
        }
        consumed.insert(key);
    }
    if let Some(n) = node.child("color") {
        let c = hex_color(
            n.attr("red").unwrap_or("0"),
            n.attr("green").unwrap_or("0"),
            n.attr("blue").unwrap_or("0"),
        );
        params.push(text_param("color", "Colore della linea", &canonical(n), c));
    }
    consumed.insert("color");
    if let Some(n) = node.child("linestyle") {
        params.push(text_param(
            "linestyle",
            "Stile della linea",
            &n.text,
            n.text.clone(),
        ));
    }
    consumed.insert("linestyle");

    if let Some(n) = node.child("preset") {
        let display = format!(
            "{} {}",
            n.attr("manufacturer").unwrap_or(""),
            n.attr("partno").unwrap_or("")
        )
        .trim()
        .to_string();
        params.push(text_param(
            "preset",
            "Componente da catalogo",
            &canonical(n),
            display,
        ));
    }
    consumed.insert("preset");
    if let Some(n) = node.child("comment") {
        params.push(text_param("comment", "Commento", &n.text, n.text.clone()));
    }
    consumed.insert("comment");

    // Free-form fin outline.
    if let Some(n) = node.child("finpoints") {
        let pts: Vec<(String, String)> = n
            .children_named("point")
            .map(|p| {
                (
                    p.attr("x").unwrap_or("0").to_string(),
                    p.attr("y").unwrap_or("0").to_string(),
                )
            })
            .collect();
        let shown: Vec<String> = pts
            .iter()
            .map(|(x, y)| {
                let f = |s: &str| fmt_num(parse_f64(s).unwrap_or(0.0) * 1000.0, 2);
                format!("({}; {})", f(x), f(y))
            })
            .collect();
        let raw = pts
            .iter()
            .map(|(x, y)| format!("{x},{y}"))
            .collect::<Vec<_>>()
            .join(";");
        let mut display = format!("{} punti: {} mm", pts.len(), shown.join(" "));
        if pts.len() == 1 {
            display = format!("1 punto: {} mm", shown.join(" "));
        }
        params.push(text_param(
            "finpoints",
            "Profilo delle pinne",
            &raw,
            display,
        ));
        for c in &n.children {
            if c.name != "point" {
                unknown.push(unk(c, "finpoints/"));
            }
        }
    }
    consumed.insert("finpoints");

    // Fin tab position: two elements (modern `top|middle|bottom`, legacy `front|center|end`).
    let tabs: Vec<&Node> = node.children_named("tabposition").collect();
    if !tabs.is_empty() {
        let pick = tabs
            .iter()
            .find(|t| matches!(t.attr("relativeto"), Some("top" | "middle" | "bottom")))
            .unwrap_or(&tabs[0]);
        let method = pick.attr("relativeto").unwrap_or("middle");
        let display = format!(
            "{} {}",
            render(Kind::Length, &pick.text).display,
            translate(units::TAB_METHOD, method)
        );
        params.push(text_param(
            "tabposition",
            "Posizione della linguetta",
            &format!("{method}:{}", pick.text),
            display,
        ));
    }
    consumed.insert("tabposition");

    // Recovery device deployment (default + per-configuration overrides).
    let deploy_keys: [(&str, &str, Kind); 3] = [
        (
            "deployevent",
            "Evento di apertura",
            Kind::Enum(units::DEPLOY_EVENT),
        ),
        ("deployaltitude", "Quota di apertura", Kind::Altitude),
        ("deploydelay", "Ritardo di apertura", Kind::Time),
    ];
    let sep_keys: [(&str, &str, Kind); 3] = [
        (
            "separationevent",
            "Evento di separazione dello stadio",
            Kind::Enum(units::SEPARATION_EVENT),
        ),
        (
            "separationaltitude",
            "Quota di separazione dello stadio",
            Kind::Altitude,
        ),
        (
            "separationdelay",
            "Ritardo di separazione dello stadio",
            Kind::Time,
        ),
    ];
    for (keys, container) in [
        (&deploy_keys, "deploymentconfiguration"),
        (&sep_keys, "separationconfiguration"),
    ] {
        for (k, label, kind) in keys.iter() {
            if let Some(n) = node.child(k) {
                params.push(param(k, label, &n.text, *kind));
            }
            consumed.insert(*k);
        }
        for cfg in node.children_named(container) {
            let id = cfg.attr("configid").unwrap_or("").to_string();
            for (k, label, kind) in keys.iter() {
                if let Some(n) = cfg.child(k) {
                    let mut pv = param(k, label, &n.text, *kind);
                    pv.cfg = Some(id.clone());
                    params.push(pv);
                }
            }
            for c in &cfg.children {
                if !keys.iter().any(|(k, _, _)| *k == c.name) {
                    unknown.push(unk(c, &format!("{container}/")));
                }
            }
        }
        consumed.insert(container);
    }

    // Motor mount.
    if let Some(mm) = node.child("motormount") {
        for (k, label, kind) in [
            (
                "ignitionevent",
                "Evento di accensione predefinito",
                Kind::Enum(units::IGNITION_EVENT),
            ),
            (
                "ignitiondelay",
                "Ritardo di accensione predefinito",
                Kind::Time,
            ),
            ("overhang", "Sporgenza del motore", Kind::Length),
        ] {
            if let Some(n) = mm.child(k) {
                params.push(param(&format!("motormount.{k}"), label, &n.text, kind));
            }
        }
        let mut ignitions: Vec<(String, String, String)> = Vec::new();
        for ic in mm.children_named("ignitionconfiguration") {
            ignitions.push((
                ic.attr("configid").unwrap_or("").to_string(),
                ic.child_text("ignitionevent").unwrap_or("").to_string(),
                ic.child_text("ignitiondelay").unwrap_or("").to_string(),
            ));
        }
        let default_event = mm.child_text("ignitionevent").map(str::to_string);
        let default_delay = mm.child_text("ignitiondelay").map(str::to_string);
        for m in mm.children_named("motor") {
            let cfg = m.attr("configid").unwrap_or("").to_string();
            let ign = ignitions.iter().find(|(c, _, _)| *c == cfg);
            motors.push(MotorUse {
                mount: idx,
                config: cfg,
                manufacturer: m.child_text("manufacturer").unwrap_or("").to_string(),
                designation: m.child_text("designation").unwrap_or("").to_string(),
                delay: m.child_text("delay").unwrap_or("").to_string(),
                definition: ["type", "digest", "diameter", "length"]
                    .iter()
                    .map(|k| m.child_text(k).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("|"),
                ignition_event: ign
                    .map(|i| i.1.clone())
                    .filter(|s| !s.is_empty())
                    .or_else(|| default_event.clone()),
                ignition_delay: ign
                    .map(|i| i.2.clone())
                    .filter(|s| !s.is_empty())
                    .or_else(|| default_delay.clone()),
            });
            for c in &m.children {
                if !matches!(
                    c.name.as_str(),
                    "type"
                        | "manufacturer"
                        | "digest"
                        | "designation"
                        | "diameter"
                        | "length"
                        | "delay"
                ) {
                    unknown.push(unk(c, "motormount/motor/"));
                }
            }
        }
        for c in &mm.children {
            if !matches!(
                c.name.as_str(),
                "ignitionevent" | "ignitiondelay" | "overhang" | "motor" | "ignitionconfiguration"
            ) {
                unknown.push(unk(c, "motormount/"));
            }
        }
    }
    consumed.insert("motormount");

    // Rocket: flight configurations are handled at document level.
    if element == "rocket" {
        consumed.insert("motorconfiguration");
        consumed.insert("flightconfiguration");
    }

    for c in &node.children {
        if !consumed.contains(c.name.as_str()) {
            unknown.push(unk(c, ""));
        }
    }
    (params, unknown, motors)
}

fn appearance_param(n: &Node, key: &str, label: &str, inside: bool) -> ParamVal {
    let mut parts: Vec<String> = Vec::new();
    if inside {
        for (k, l) in [
            ("edgessameasinside", "bordi come l'interno"),
            ("insidesameasoutside", "interno come l'esterno"),
        ] {
            if let Some(c) = n.child(k) {
                parts.push(format!("{l}: {}", render(Kind::Bool, &c.text).display));
            }
        }
    }
    if let Some(paint) = n.child("paint") {
        parts.push(format!(
            "colore {}",
            hex_color(
                paint.attr("red").unwrap_or("0"),
                paint.attr("green").unwrap_or("0"),
                paint.attr("blue").unwrap_or("0")
            )
        ));
        if let Some(a) = paint.attr("alpha") {
            if a.trim() != "255" {
                parts.push(format!("opacità {a}/255"));
            }
        }
    }
    if let Some(s) = n.child("shine") {
        parts.push(format!(
            "lucentezza {}",
            fmt_num(parse_f64(&s.text).unwrap_or(0.0), 3)
        ));
    }
    if let Some(d) = n.child("decal") {
        let xy = |name: &str| -> String {
            d.child(name)
                .map(|c| {
                    format!(
                        "({}; {})",
                        fmt_num(parse_f64(c.attr("x").unwrap_or("0")).unwrap_or(0.0), 3),
                        fmt_num(parse_f64(c.attr("y").unwrap_or("0")).unwrap_or(0.0), 3)
                    )
                })
                .unwrap_or_default()
        };
        parts.push(format!(
            "decalcomania «{}» (rotazione {}°, bordo {}, centro {}, spostamento {}, scala {})",
            d.attr("name").unwrap_or(""),
            fmt_num(
                parse_f64(d.attr("rotation").unwrap_or("0")).unwrap_or(0.0),
                2
            ),
            d.attr("edgemode").unwrap_or(""),
            xy("center"),
            xy("offset"),
            xy("scale")
        ));
    }
    let known = [
        "paint",
        "shine",
        "decal",
        "edgessameasinside",
        "insidesameasoutside",
    ];
    let extra: Vec<String> = n
        .children
        .iter()
        .filter(|c| !known.contains(&c.name.as_str()))
        .map(canonical)
        .collect();
    let mut display = parts.join(", ");
    if !extra.is_empty() {
        display.push_str(&format!(" [+{} elementi aggiuntivi]", extra.len()));
        display.push_str(&extra.join(""));
    }
    text_param(key, label, &canonical(n), display)
}

fn read_configs(rocket: &Node, misc: &mut Vec<Misc>) -> Vec<Config> {
    let mut out = Vec::new();
    let mut stray: Vec<Unk> = Vec::new();
    for n in &rocket.children {
        if n.name != "motorconfiguration" && n.name != "flightconfiguration" {
            continue;
        }
        let id = n.attr("configid").unwrap_or("").to_string();
        let name = n
            .child_text("name")
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let stages = n
            .children_named("stage")
            .map(|s| {
                (
                    s.attr("number").unwrap_or("").to_string(),
                    s.attr("active").unwrap_or("true").to_string(),
                )
            })
            .collect();
        for c in &n.children {
            if c.name != "name" && c.name != "stage" {
                stray.push(unk(c, "motorconfiguration/"));
            }
        }
        out.push(Config { id, name, stages });
    }
    if !stray.is_empty() {
        misc.push(Misc {
            section: "Configurazioni di volo".into(),
            items: stray,
        });
    }
    out
}

fn read_sim(s: &Node, doc: &Doc) -> Sim {
    let name = s.child_text("name").unwrap_or("").to_string();
    let mut conditions: Vec<ParamVal> = Vec::new();
    let mut results: Vec<ParamVal> = Vec::new();
    let mut unknown: Vec<Unk> = Vec::new();
    let mut config_id: Option<String> = None;
    let mut fp = fnv1a("flight");
    let mut has_data = false;

    if let Some(st) = s.attr("status") {
        results.push(param(
            "status",
            "Stato della simulazione",
            st,
            Kind::Enum(units::SIM_STATUS),
        ));
    }

    for c in &s.children {
        match c.name.as_str() {
            "name" => {}
            "simulator" => conditions.push(text_param(
                "simulator",
                "Metodo di simulazione",
                &c.text,
                c.text.clone(),
            )),
            "calculator" => conditions.push(text_param(
                "calculator",
                "Calcolo aerodinamico",
                &c.text,
                c.text.clone(),
            )),
            "conditions" => read_conditions(c, doc, &mut conditions, &mut unknown, &mut config_id),
            "flightdata" => {
                for (k, v) in &c.attrs {
                    if let Some(spec) = catalog::SIM_RESULTS.iter().find(|p| p.key == k) {
                        results.push(param(spec.key, spec.label, v, spec.kind));
                    } else {
                        unknown.push(Unk {
                            canon: format!("flightdata@{k}={v}"),
                            sample: format!("<flightdata {k}=…>"),
                        });
                    }
                }
                let mut warns: Vec<String> = Vec::new();
                for ch in &c.children {
                    match ch.name.as_str() {
                        "databranch" => {
                            has_data = true;
                            fp ^= fnv1a(&canonical(ch)).rotate_left(7);
                            fp = fp.wrapping_mul(0x100000001b3);
                        }
                        "warning" => {
                            let d = ch
                                .child_text("description")
                                .map(str::to_string)
                                .unwrap_or_else(|| ch.text.clone());
                            warns.push(d);
                        }
                        _ => unknown.push(unk(ch, "flightdata/")),
                    }
                }
                warns.sort();
                let display = if warns.is_empty() {
                    "nessuno".to_string()
                } else {
                    format!("{}: {}", warns.len(), warns.join("; "))
                };
                results.push(text_param(
                    "warnings",
                    "Avvisi della simulazione",
                    &warns.join("\n"),
                    display,
                ));
            }
            _ => unknown.push(unk(c, "")),
        }
    }
    let _ = has_data;
    Sim {
        name,
        config_id,
        conditions,
        results,
        flight_fp: fp,
        unknown,
    }
}

fn read_conditions(
    c: &Node,
    doc: &Doc,
    out: &mut Vec<ParamVal>,
    unknown: &mut Vec<Unk>,
    config_id: &mut Option<String>,
) {
    let multilevel_active = c
        .child_text("windmodeltype")
        .map(|t| t.trim().eq_ignore_ascii_case("multilevel"))
        .unwrap_or(false);
    let avg_wind = c
        .children_named("wind")
        .find(|w| w.attr("model") == Some("average"));
    let multi_wind = c
        .children_named("wind")
        .find(|w| w.attr("model") == Some("multilevel"));

    if let Some(n) = c.child("configid") {
        *config_id = Some(n.text.trim().to_string());
        let name = doc.config_name(n.text.trim());
        let mut pv = text_param("configid", "Configurazione di volo", &n.text, name);
        pv.cmp = n.text.trim().to_string();
        out.push(pv);
    }
    for spec in catalog::SIM_CONDITIONS {
        if let Some(n) = c.child(spec.key) {
            out.push(param(spec.key, spec.label, &n.text, spec.kind));
        }
    }
    // Wind speed / direction: modern `<wind model="average">` or legacy flat elements.
    let speed = avg_wind
        .and_then(|w| w.child_text("speed"))
        .or_else(|| c.child_text("windaverage"));
    if let Some(v) = speed {
        out.push(param(
            "windspeed",
            "Velocità media del vento",
            v,
            Kind::Speed,
        ));
    }
    let dir = avg_wind
        .and_then(|w| w.child_text("direction"))
        .or_else(|| c.child_text("winddirection"));
    if let Some(v) = dir {
        out.push(param(
            "winddirection",
            "Direzione del vento",
            v,
            Kind::AngleRad,
        ));
    }
    if multilevel_active {
        if let Some(w) = multi_wind {
            let levels: Vec<String> = w
                .children_named("windlevel")
                .map(|l| {
                    format!(
                        "{} m: {} m/s, {}",
                        fmt_num(
                            parse_f64(l.attr("altitude").unwrap_or("0")).unwrap_or(0.0),
                            1
                        ),
                        fmt_num(parse_f64(l.attr("speed").unwrap_or("0")).unwrap_or(0.0), 2),
                        render(Kind::AngleRad, l.attr("direction").unwrap_or("0")).display
                    )
                })
                .collect();
            out.push(text_param(
                "windlevels",
                "Vento a più quote",
                &canonical(w),
                format!("{} livelli ({})", levels.len(), levels.join("; ")),
            ));
        }
    }
    if let Some(a) = c.child("atmosphere") {
        let model = a.attr("model").unwrap_or("isa");
        let display = if model == "isa" {
            "atmosfera standard (ISA)".to_string()
        } else {
            let t = a
                .child_text("basetemperature")
                .map(|v| render(Kind::Temperature, v).display)
                .unwrap_or_default();
            let p = a
                .child_text("basepressure")
                .map(|v| render(Kind::Pressure, v).display)
                .unwrap_or_default();
            format!("atmosfera personalizzata (temperatura {t}, pressione {p})")
        };
        out.push(text_param(
            "atmosphere",
            "Atmosfera",
            &canonical(a),
            display,
        ));
    }
    let consumed = [
        "configid",
        "windaverage",
        "windturbulence",
        "winddirection",
        "wind",
        "windmodeltype",
        "atmosphere",
    ];
    for ch in &c.children {
        let name = ch.name.as_str();
        if consumed.contains(&name) || catalog::SIM_CONDITIONS.iter().any(|p| p.key == name) {
            continue;
        }
        unknown.push(unk(ch, "conditions/"));
    }
    // `extension` elements are siblings of <conditions>; handled by the caller via unknown.
}
