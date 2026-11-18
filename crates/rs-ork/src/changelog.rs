//! Italian changelog lines generated from an [`OrkDiff`].

use crate::catalog;
use crate::types::*;
use crate::units::lc_first;

fn split_unit(v: &DisplayValue) -> Option<(&str, &str)> {
    let u = v.unit.as_deref()?;
    let num = v.display.strip_suffix(u)?.trim_end();
    Some((num, u))
}

fn join_unit(num: &str, unit: &str) -> String {
    if unit == "°" {
        format!("{num}{unit}")
    } else {
        format!("{num} {unit}")
    }
}

/// "3 → 4", or "80 → 95 mm" when both sides share a unit.
fn transition(b: &DisplayValue, a: &DisplayValue) -> String {
    if b.unit == a.unit {
        if let (Some((bn, bu)), Some((an, _))) = (split_unit(b), split_unit(a)) {
            return format!("{bn} → {}", join_unit(an, bu));
        }
    }
    format!("{} → {}", b.display, a.display)
}

fn param_piece(p: &ParamChange) -> String {
    if p.key == "name" {
        return match (&p.before, &p.after) {
            (Some(b), Some(a)) => format!("rinominato da «{}» a «{}»", b.display, a.display),
            _ => "nome modificato".to_string(),
        };
    }
    let label = lc_first(&p.label);
    match (&p.before, &p.after) {
        (Some(b), Some(a)) => format!("{label} {}", transition(b, a)),
        (None, Some(a)) => format!("{label} impostato a {}", a.display),
        (Some(b), None) => format!("{label} rimosso (era {})", b.display),
        (None, None) => label,
    }
}

fn pieces(params: &[ParamChange]) -> String {
    params
        .iter()
        .map(param_piece)
        .collect::<Vec<_>>()
        .join("; ")
}

fn headline(c: &ComponentChange) -> String {
    let mut parts: Vec<String> = Vec::new();
    for p in &c.params {
        let v = match (&p.after, &p.before) {
            (Some(v), _) | (None, Some(v)) => v,
            _ => continue,
        };
        if p.key == "subcomponents" {
            parts.push(format!("con {}", v.display));
        } else if let Some(prefix) = catalog::headline_prefix(&c.component_type, &p.key) {
            parts.push(format!("{prefix}{}", v.display));
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

fn plural(n: u32, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn summary_text(s: &OrkSummary) -> String {
    let name = s.rocket_name.clone().unwrap_or_default();
    format!(
        "razzo «{}» ({}, {}, {})",
        name,
        plural(s.stage_count, "stadio", "stadi"),
        plural(s.component_count, "componente", "componenti"),
        plural(s.simulation_count, "simulazione", "simulazioni"),
    )
}

/// Changelog lines (Italian, without the "• " prefix) describing what changed.
pub fn changelog_lines(d: &OrkDiff) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(e) = &d.parse_error {
        out.push(format!("File non leggibile: {e}"));
        return out;
    }
    match (&d.before, &d.after) {
        (None, Some(a)) => {
            out.push(format!("Aggiunto: {}", summary_text(a)));
            return out;
        }
        (Some(b), None) => {
            out.push(format!("Rimosso: {}", summary_text(b)));
            return out;
        }
        _ => {}
    }

    for c in &d.components {
        match c.kind {
            ComponentChangeKind::Added => out.push(format!(
                "Aggiunto: {} «{}»{}",
                c.type_label,
                c.name,
                headline(c)
            )),
            ComponentChangeKind::Removed => out.push(format!(
                "Rimosso: {} «{}»{}",
                c.type_label,
                c.name,
                headline(c)
            )),
            ComponentChangeKind::Modified => out.push(format!(
                "{} «{}»: {}",
                c.type_label,
                c.name,
                pieces(&c.params)
            )),
            ComponentChangeKind::Moved => {
                let mut how = String::new();
                for p in &c.params {
                    if let (Some(b), Some(a)) = (&p.before, &p.after) {
                        if p.key == "parent" {
                            how = format!(" (da {} a {})", b.display, a.display);
                        } else if p.key == "order" {
                            how = format!(" (posizione {} → {})", b.display, a.display);
                        }
                    }
                }
                out.push(format!("Spostato: {} «{}»{}", c.type_label, c.name, how));
                let rest: Vec<ParamChange> = c
                    .params
                    .iter()
                    .filter(|p| p.key != "parent" && p.key != "order")
                    .cloned()
                    .collect();
                if !rest.is_empty() {
                    out.push(format!("{} «{}»: {}", c.type_label, c.name, pieces(&rest)));
                }
            }
        }
    }
    for c in &d.motor_configurations {
        match c.kind {
            ChangeKind::Added => out.push(format!("Aggiunta configurazione motori «{}»", c.name)),
            ChangeKind::Removed => out.push(format!("Rimossa configurazione motori «{}»", c.name)),
            ChangeKind::Modified => out.push(format!(
                "Configurazione motori «{}»: {}",
                c.name,
                pieces(&c.params)
            )),
        }
    }
    for s in &d.simulations {
        match s.kind {
            ChangeKind::Added => {
                let apogee = s
                    .results
                    .iter()
                    .find(|p| p.key == "maxaltitude")
                    .and_then(|p| p.after.as_ref())
                    .map(|v| format!(" (apogeo {})", v.display))
                    .unwrap_or_default();
                out.push(format!("Aggiunta simulazione «{}»{}", s.name, apogee));
            }
            ChangeKind::Removed => out.push(format!("Rimossa simulazione «{}»", s.name)),
            ChangeKind::Modified => {
                let mut parts: Vec<String> = Vec::new();
                if !s.conditions.is_empty() {
                    parts.push(pieces(&s.conditions));
                }
                if !s.results.is_empty() {
                    parts.push(pieces(&s.results));
                }
                if s.data_updated {
                    parts.push("dati di volo ricalcolati".to_string());
                }
                out.push(format!("Simulazione «{}»: {}", s.name, parts.join("; ")));
            }
        }
    }
    for u in &d.uninterpreted {
        let what = if u.count == 1 {
            "1 modifica non interpretata".to_string()
        } else {
            format!("{} modifiche non interpretate", u.count)
        };
        match &u.sample {
            Some(s) => out.push(format!("{}: {} (es. {})", u.section, what, s)),
            None => out.push(format!("{}: {}", u.section, what)),
        }
    }
    if out.is_empty() {
        out.push("Salvato di nuovo senza modifiche rilevabili al progetto".to_string());
    }
    out
}
