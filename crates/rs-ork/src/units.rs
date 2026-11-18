//! Value kinds, unit conversion (OpenRocket stores SI units) and Italian formatting.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Int,
    Number,
    Bool,
    /// metres -> millimetres
    Length,
    /// radius in metres (possibly "auto" / "auto 0.0125") -> diameter in millimetres
    Diameter,
    /// kilograms -> grams
    Mass,
    /// degrees (stored as degrees)
    AngleDeg,
    /// radians -> degrees
    AngleRad,
    /// m/s
    Speed,
    /// m/s^2
    Accel,
    /// seconds
    Time,
    /// metres (kept in metres: altitudes, apogee)
    Altitude,
    /// kelvin -> degrees Celsius
    Temperature,
    /// pascal -> hectopascal
    Pressure,
    /// fraction -> percent
    Percent,
    /// drag coefficient, "auto" or number
    Cd,
    /// translated enumeration
    Enum(&'static [(&'static str, &'static str)]),
}

/// Formats a number with at most `max_dec` decimals, Italian decimal comma, no trailing zeros.
pub fn fmt_num(v: f64, max_dec: usize) -> String {
    if !v.is_finite() {
        return v.to_string();
    }
    let mut s = format!("{:.*}", max_dec, v);
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    if s == "-0" {
        s = "0".into();
    }
    s.replace('.', ",")
}

/// Parses an OpenRocket number (accepts Java `E` notation and a leading `+`).
pub fn parse_f64(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Result of rendering a raw value: display text and unit.
pub struct Rendered {
    pub display: String,
    pub unit: Option<String>,
}

fn with_unit(v: f64, dec: usize, unit: &str) -> Rendered {
    let num = fmt_num(v, dec);
    let sep = if unit == "°" { "" } else { " " };
    Rendered {
        display: format!("{num}{sep}{unit}"),
        unit: Some(unit.to_string()),
    }
}

fn plain(raw: &str) -> Rendered {
    Rendered {
        display: raw.trim().to_string(),
        unit: None,
    }
}

pub fn render(kind: Kind, raw: &str) -> Rendered {
    let raw_t = raw.trim();
    match kind {
        Kind::Text => plain(raw_t),
        Kind::Int => match parse_f64(raw_t) {
            Some(v) => Rendered {
                display: fmt_num(v, 0),
                unit: None,
            },
            None => plain(raw_t),
        },
        Kind::Number => match parse_f64(raw_t) {
            Some(v) => Rendered {
                display: fmt_num(v, 4),
                unit: None,
            },
            None => plain(raw_t),
        },
        Kind::Bool => Rendered {
            display: match raw_t.to_ascii_lowercase().as_str() {
                "true" => "sì".into(),
                "false" => "no".into(),
                _ => raw_t.to_string(),
            },
            unit: None,
        },
        Kind::Length => match parse_f64(raw_t) {
            Some(v) => with_unit(v * 1000.0, 2, "mm"),
            None if raw_t.eq_ignore_ascii_case("filled") => plain("pieno"),
            None => plain(raw_t),
        },
        Kind::Diameter => {
            if raw_t.eq_ignore_ascii_case("auto") {
                return Rendered {
                    display: "automatico".into(),
                    unit: None,
                };
            }
            if let Some(rest) = raw_t.strip_prefix("auto ") {
                return match parse_f64(rest) {
                    Some(v) => Rendered {
                        display: format!("automatico ({} mm)", fmt_num(v * 2000.0, 2)),
                        unit: None,
                    },
                    None => plain(raw_t),
                };
            }
            match parse_f64(raw_t) {
                Some(v) => with_unit(v * 2000.0, 2, "mm"),
                None => plain(raw_t),
            }
        }
        Kind::Mass => match parse_f64(raw_t) {
            Some(v) => with_unit(v * 1000.0, 2, "g"),
            None => plain(raw_t),
        },
        Kind::AngleDeg => match parse_f64(raw_t) {
            Some(v) => with_unit(v, 2, "°"),
            None => plain(raw_t),
        },
        Kind::AngleRad => match parse_f64(raw_t) {
            Some(v) => with_unit(v.to_degrees(), 2, "°"),
            None => plain(raw_t),
        },
        Kind::Speed => match parse_f64(raw_t) {
            Some(v) => with_unit(v, 2, "m/s"),
            None => plain(raw_t),
        },
        Kind::Accel => match parse_f64(raw_t) {
            Some(v) => with_unit(v, 2, "m/s²"),
            None => plain(raw_t),
        },
        Kind::Time => match parse_f64(raw_t) {
            Some(v) => with_unit(v, 3, "s"),
            None => plain(raw_t),
        },
        Kind::Altitude => match parse_f64(raw_t) {
            Some(v) => with_unit(v, 2, "m"),
            None => plain(raw_t),
        },
        Kind::Temperature => match parse_f64(raw_t) {
            Some(v) => with_unit(v - 273.15, 2, "°C"),
            None => plain(raw_t),
        },
        Kind::Pressure => match parse_f64(raw_t) {
            Some(v) => with_unit(v / 100.0, 2, "hPa"),
            None => plain(raw_t),
        },
        Kind::Percent => match parse_f64(raw_t) {
            Some(v) => with_unit(v * 100.0, 2, "%"),
            None => plain(raw_t),
        },
        Kind::Cd => {
            if raw_t.eq_ignore_ascii_case("auto") {
                Rendered {
                    display: "automatico".into(),
                    unit: None,
                }
            } else {
                match parse_f64(raw_t) {
                    Some(v) => Rendered {
                        display: fmt_num(v, 3),
                        unit: None,
                    },
                    None => plain(raw_t),
                }
            }
        }
        Kind::Enum(map) => {
            let key = raw_t.to_ascii_lowercase();
            let shown = map
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
                .unwrap_or_else(|| raw_t.to_string());
            Rendered {
                display: shown,
                unit: None,
            }
        }
    }
}

/// Color `#RRGGBB` from decimal components.
pub fn hex_color(r: &str, g: &str, b: &str) -> String {
    let c = |s: &str| s.trim().parse::<u8>().unwrap_or(0);
    format!("#{:02X}{:02X}{:02X}", c(r), c(g), c(b))
}

pub const FINISH: &[(&str, &str)] = &[
    ("rough", "ruvida"),
    ("unfinished", "grezza"),
    ("normal", "normale"),
    ("smooth", "liscia"),
    ("polished", "lucidata"),
];

pub const SHAPE: &[(&str, &str)] = &[
    ("conical", "conica"),
    ("ogive", "ogivale"),
    ("ellipsoid", "ellissoidale"),
    ("powerseries", "a serie di potenza"),
    ("parabolic", "parabolica"),
    ("haack", "Haack"),
];

pub const CROSS_SECTION: &[(&str, &str)] = &[
    ("square", "quadrata"),
    ("rounded", "arrotondata"),
    ("airfoil", "a profilo alare"),
];

pub const MASS_TYPE: &[(&str, &str)] = &[
    ("altimeter", "altimetro"),
    ("battery", "batteria"),
    ("flightcomputer", "computer di volo"),
    ("deploymentcharge", "carica di espulsione"),
    ("recoveryhardware", "componenti di recupero"),
    ("payload", "carico utile"),
    ("launchlug", "anello di guida"),
    ("other", "altro"),
];

pub const REFERENCE_TYPE: &[(&str, &str)] = &[
    ("maximum", "diametro massimo"),
    ("nosecone", "base dell'ogiva"),
    ("custom", "personalizzato"),
];

pub const CLUSTER: &[(&str, &str)] = &[
    ("single", "singolo"),
    ("double", "doppio"),
    ("triple", "triplo"),
    ("quad", "a quattro"),
    ("quintuple", "a cinque"),
    ("sextuple", "a sei"),
];

pub const DEPLOY_EVENT: &[(&str, &str)] = &[
    ("launch", "al lancio"),
    ("ejection", "alla carica di espulsione"),
    ("apogee", "all'apogeo"),
    ("altitude", "a una quota"),
    ("never", "mai"),
    (
        "lowerstageseparation",
        "alla separazione dello stadio inferiore",
    ),
];

pub const SEPARATION_EVENT: &[(&str, &str)] = &[
    ("ignition", "all'accensione"),
    ("launch", "al lancio"),
    ("burnout", "a fine spinta"),
    ("ejection", "alla carica di espulsione"),
    ("never", "mai"),
    (
        "lowerstageseparation",
        "alla separazione dello stadio inferiore",
    ),
];

pub const IGNITION_EVENT: &[(&str, &str)] = &[
    ("automatic", "automatica"),
    ("launch", "al lancio"),
    (
        "ejectioncharge",
        "alla carica di espulsione dello stadio precedente",
    ),
    ("burnout", "a fine spinta dello stadio precedente"),
    ("never", "mai"),
];

pub const AXIAL_METHOD: &[(&str, &str)] = &[
    ("top", "dall'inizio del componente padre"),
    ("middle", "dal centro del componente padre"),
    ("bottom", "dalla fine del componente padre"),
    ("absolute", "assoluta dalla punta del razzo"),
    ("after", "dopo il componente precedente"),
];

pub const RADIUS_METHOD: &[(&str, &str)] = &[
    ("relative", "relativa al padre"),
    ("surface", "dalla superficie del padre"),
    ("free", "libera"),
];

pub const ANGLE_METHOD: &[(&str, &str)] = &[("relative", "relativo"), ("absolute", "assoluto")];

pub const TAB_METHOD: &[(&str, &str)] = &[
    ("top", "dall'inizio della radice"),
    ("front", "dall'inizio della radice"),
    ("middle", "dal centro della radice"),
    ("center", "dal centro della radice"),
    ("bottom", "dalla fine della radice"),
    ("end", "dalla fine della radice"),
];

pub const SIM_STATUS: &[(&str, &str)] = &[
    ("uptodate", "aggiornata"),
    ("outdated", "da rieseguire"),
    ("loaded", "caricata da file"),
    ("external", "dati esterni"),
    ("notsimulated", "non eseguita"),
];

pub const GEODETIC: &[(&str, &str)] = &[
    ("flat", "piatta"),
    ("spherical", "sferica"),
    ("wgs84", "WGS84"),
];

pub const WIND_MODEL: &[(&str, &str)] = &[
    ("average", "medio"),
    ("multilevel", "a più quote"),
    ("pinkpsd", "spettro di turbolenza"),
];

pub fn translate(map: &'static [(&'static str, &'static str)], raw: &str) -> String {
    let key = raw.trim().to_ascii_lowercase();
    map.iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| (*v).to_string())
        .unwrap_or_else(|| raw.trim().to_string())
}

/// `lc_first("Numero di pinne")` -> `"numero di pinne"`, but acronyms such as `"CG"` are kept.
pub fn lc_first(label: &str) -> String {
    let mut it = label.chars();
    match (it.next(), it.next()) {
        (Some(a), Some(b)) if a.is_uppercase() && b.is_lowercase() => {
            let mut s: String = a.to_lowercase().collect();
            s.push(b);
            s.push_str(it.as_str());
            s
        }
        _ => label.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_with_italian_decimal_comma() {
        assert_eq!(fmt_num(50.8, 2), "50,8");
        assert_eq!(fmt_num(95.0, 2), "95");
        assert_eq!(fmt_num(-0.0001, 2), "0");
        assert_eq!(fmt_num(0.052000000000000005 * 1000.0, 2), "52");
        assert_eq!(fmt_num(1.005, 2), "1"); // rounding to 2 decimals trims trailing zeros
        assert_eq!(fmt_num(1.23456, 3), "1,235");
    }

    #[test]
    fn converts_units() {
        let r = render(Kind::Length, "0.0508");
        assert_eq!(
            (r.display.as_str(), r.unit.as_deref()),
            ("50,8 mm", Some("mm"))
        );
        assert_eq!(render(Kind::Mass, "0.0094").display, "9,4 g");
        assert_eq!(render(Kind::AngleRad, "1.5707963267948966").display, "90°");
        assert_eq!(render(Kind::AngleDeg, "45.0").display, "45°");
        assert_eq!(render(Kind::Speed, "2.0").display, "2 m/s");
        assert_eq!(render(Kind::Temperature, "293.15").display, "20 °C");
        assert_eq!(render(Kind::Pressure, "101325").display, "1013,25 hPa");
        assert_eq!(render(Kind::Percent, "0.1").display, "10 %");
        assert_eq!(render(Kind::Diameter, "0.0125").display, "25 mm");
        assert_eq!(
            render(Kind::Diameter, "auto 0.0125").display,
            "automatico (25 mm)"
        );
        assert_eq!(render(Kind::Diameter, "auto").display, "automatico");
        assert_eq!(render(Kind::Length, "filled").display, "pieno");
        assert_eq!(render(Kind::Bool, "true").display, "sì");
        assert_eq!(render(Kind::Int, "3.0").display, "3");
        assert_eq!(render(Kind::Enum(SHAPE), "OGIVE").display, "ogivale");
        assert_eq!(render(Kind::Enum(SHAPE), "mystery").display, "mystery");
        assert_eq!(render(Kind::Length, "5.55E-17").display, "0 mm");
        // Unparseable numbers are shown as they are, never invented.
        assert_eq!(render(Kind::Length, "boh").display, "boh");
    }

    #[test]
    fn lowercases_labels_but_keeps_acronyms() {
        assert_eq!(lc_first("Numero di pinne"), "numero di pinne");
        assert_eq!(lc_first("CG forzato"), "CG forzato");
        assert_eq!(lc_first("Ø"), "Ø");
    }
}
