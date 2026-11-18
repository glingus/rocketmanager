//! Catalogue of component types and parameters: Italian labels, units, headline parameters.
//!
//! Element names and meanings come from OpenRocket's `*Saver.java` classes
//! (`core/src/main/java/info/openrocket/core/file/openrocket/savers`). All values are SI in the file.

use crate::units::*;

#[derive(Debug, Clone, Copy)]
pub struct PSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    /// If set, the parameter is shown when a component is added/removed, with this prefix.
    pub headline: Option<&'static str>,
}

const fn p(key: &'static str, label: &'static str, kind: Kind) -> PSpec {
    PSpec {
        key,
        label,
        kind,
        headline: None,
    }
}

const fn ph(key: &'static str, label: &'static str, kind: Kind, prefix: &'static str) -> PSpec {
    PSpec {
        key,
        label,
        kind,
        headline: Some(prefix),
    }
}

/// Known component element names -> (label, label for the instance count).
pub fn type_label(element: &str) -> Option<&'static str> {
    Some(match element {
        "rocket" => "Razzo",
        "stage" => "Stadio",
        "parallelstage" => "Stadio parallelo (booster)",
        "podset" => "Gruppo di componenti (pod)",
        "nosecone" => "Ogiva",
        "bodytube" => "Tubo",
        "transition" => "Transizione",
        "trapezoidfinset" => "Pinne trapezoidali",
        "ellipticalfinset" => "Pinne ellittiche",
        "freeformfinset" => "Pinne libere",
        "tubefinset" => "Pinne tubolari",
        "innertube" => "Tubo interno",
        "tubecoupler" => "Giunto",
        "centeringring" => "Anello di centraggio",
        "bulkhead" => "Paratia",
        "engineblock" => "Blocco motore",
        "launchlug" => "Anello di guida (launch lug)",
        "railbutton" => "Rail button",
        "parachute" => "Paracadute",
        "streamer" => "Streamer",
        "shockcord" => "Cavo elastico (shock cord)",
        "masscomponent" => "Massa",
        _ => return None,
    })
}

pub fn count_label(element: &str) -> &'static str {
    match element {
        "trapezoidfinset" | "ellipticalfinset" | "freeformfinset" | "tubefinset" => {
            "Numero di pinne"
        }
        "parallelstage" => "Numero di booster",
        "podset" => "Numero di pod",
        _ => "Numero di copie",
    }
}

/// True for the elements that are components (children of `<subcomponents>` or the rocket itself).
pub fn is_stage_like(element: &str) -> bool {
    matches!(element, "stage" | "parallelstage")
}

const MASS_OBJECT: &[PSpec] = &[
    p("packedlength", "Lunghezza da ripiegato", Kind::Length),
    p("packedradius", "Diametro da ripiegato", Kind::Diameter),
];

const FIN_COMMON: &[PSpec] = &[
    p("thickness", "Spessore delle pinne", Kind::Length),
    p(
        "crosssection",
        "Sezione delle pinne",
        Kind::Enum(CROSS_SECTION),
    ),
    p("cant", "Angolo di cant", Kind::AngleDeg),
    p("tabheight", "Altezza della linguetta", Kind::Length),
    p("tablength", "Lunghezza della linguetta", Kind::Length),
    p("filletradius", "Raggio del raccordo", Kind::Length),
];

const GENERIC: &[PSpec] = &[
    p("radialposition", "Distanza dall'asse", Kind::Length),
    p("instanceseparation", "Distanza tra le copie", Kind::Length),
    p("overridemass", "Massa forzata", Kind::Mass),
    p(
        "overridesubcomponentsmass",
        "Massa forzata anche ai sottocomponenti",
        Kind::Bool,
    ),
    p("overridecg", "Baricentro forzato", Kind::Length),
    p(
        "overridesubcomponentscg",
        "Baricentro forzato anche ai sottocomponenti",
        Kind::Bool,
    ),
    p(
        "overridecd",
        "Coefficiente di resistenza forzato",
        Kind::Number,
    ),
    p(
        "overridesubcomponentscd",
        "Resistenza forzata anche ai sottocomponenti",
        Kind::Bool,
    ),
    p("finish", "Finitura superficiale", Kind::Enum(FINISH)),
];

fn specific(element: &str) -> Vec<PSpec> {
    let mut v: Vec<PSpec> = Vec::new();
    match element {
        "rocket" => v.extend([
            p("designer", "Progettista", Kind::Text),
            p("revision", "Revisione", Kind::Text),
            p("kitname", "Nome del kit", Kind::Text),
            p("designtype", "Tipo di progetto", Kind::Text),
            p(
                "referencetype",
                "Riferimento per i calcoli",
                Kind::Enum(REFERENCE_TYPE),
            ),
            p("customreference", "Lunghezza di riferimento", Kind::Length),
        ]),
        "nosecone" => v.extend([
            ph("length", "Lunghezza", Kind::Length, "lunghezza "),
            p("thickness", "Spessore della parete", Kind::Length),
            p("shape", "Forma", Kind::Enum(SHAPE)),
            p("shapeparameter", "Parametro di forma", Kind::Number),
            p("shapeclipped", "Forma troncata", Kind::Bool),
            p("aftradius", "Diametro alla base", Kind::Diameter),
            p("aftshoulderradius", "Diametro della spalla", Kind::Diameter),
            p("aftshoulderlength", "Lunghezza della spalla", Kind::Length),
            p(
                "aftshoulderthickness",
                "Spessore della spalla",
                Kind::Length,
            ),
            p("aftshouldercapped", "Spalla chiusa", Kind::Bool),
            p("isflipped", "Ogiva capovolta", Kind::Bool),
        ]),
        "bodytube" => v.extend([
            ph("length", "Lunghezza", Kind::Length, "lunghezza "),
            p("radius", "Diametro esterno", Kind::Diameter),
            p("thickness", "Spessore della parete", Kind::Length),
        ]),
        "transition" => v.extend([
            ph("length", "Lunghezza", Kind::Length, "lunghezza "),
            p("thickness", "Spessore della parete", Kind::Length),
            p("shape", "Forma", Kind::Enum(SHAPE)),
            p("shapeparameter", "Parametro di forma", Kind::Number),
            p("shapeclipped", "Forma troncata", Kind::Bool),
            p("foreradius", "Diametro anteriore", Kind::Diameter),
            p("aftradius", "Diametro posteriore", Kind::Diameter),
            p(
                "foreshoulderradius",
                "Diametro della spalla anteriore",
                Kind::Diameter,
            ),
            p(
                "foreshoulderlength",
                "Lunghezza della spalla anteriore",
                Kind::Length,
            ),
            p(
                "foreshoulderthickness",
                "Spessore della spalla anteriore",
                Kind::Length,
            ),
            p("foreshouldercapped", "Spalla anteriore chiusa", Kind::Bool),
            p(
                "aftshoulderradius",
                "Diametro della spalla posteriore",
                Kind::Diameter,
            ),
            p(
                "aftshoulderlength",
                "Lunghezza della spalla posteriore",
                Kind::Length,
            ),
            p(
                "aftshoulderthickness",
                "Spessore della spalla posteriore",
                Kind::Length,
            ),
            p("aftshouldercapped", "Spalla posteriore chiusa", Kind::Bool),
        ]),
        "trapezoidfinset" => {
            v.extend([
                p("rootchord", "Corda alla radice", Kind::Length),
                p("tipchord", "Corda all'estremità", Kind::Length),
                p("sweeplength", "Freccia (sweep)", Kind::Length),
                p("height", "Altezza", Kind::Length),
            ]);
            v.extend_from_slice(FIN_COMMON);
        }
        "ellipticalfinset" => {
            v.extend([
                p("rootchord", "Corda alla radice", Kind::Length),
                p("height", "Altezza", Kind::Length),
            ]);
            v.extend_from_slice(FIN_COMMON);
        }
        "freeformfinset" => v.extend_from_slice(FIN_COMMON),
        "tubefinset" => v.extend([
            p("radius", "Diametro esterno del tubo", Kind::Diameter),
            p("length", "Lunghezza", Kind::Length),
            p("thickness", "Spessore", Kind::Length),
        ]),
        "innertube" => v.extend([
            ph("length", "Lunghezza", Kind::Length, "lunghezza "),
            p("outerradius", "Diametro esterno", Kind::Diameter),
            p("thickness", "Spessore della parete", Kind::Length),
            p(
                "clusterconfiguration",
                "Configurazione a grappolo",
                Kind::Enum(CLUSTER),
            ),
            p("clusterscale", "Scala del grappolo", Kind::Number),
            p("clusterrotation", "Rotazione del grappolo", Kind::AngleDeg),
        ]),
        "tubecoupler" | "engineblock" => v.extend([
            p("length", "Lunghezza", Kind::Length),
            p("outerradius", "Diametro esterno", Kind::Diameter),
            p("thickness", "Spessore della parete", Kind::Length),
        ]),
        "centeringring" => v.extend([
            p("length", "Spessore", Kind::Length),
            p("outerradius", "Diametro esterno", Kind::Diameter),
            p("innerradius", "Diametro interno", Kind::Diameter),
        ]),
        "bulkhead" => v.extend([
            p("length", "Spessore", Kind::Length),
            p("outerradius", "Diametro esterno", Kind::Diameter),
        ]),
        "launchlug" => v.extend([
            p("radius", "Diametro esterno", Kind::Diameter),
            p("length", "Lunghezza", Kind::Length),
            p("thickness", "Spessore", Kind::Length),
        ]),
        "railbutton" => v.extend([
            p("outerdiameter", "Diametro esterno", Kind::Length),
            p("innerdiameter", "Diametro interno", Kind::Length),
            p("height", "Altezza totale", Kind::Length),
            p("baseheight", "Altezza della base", Kind::Length),
            p("flangeheight", "Altezza della flangia", Kind::Length),
            p("screwheight", "Altezza della vite", Kind::Length),
        ]),
        "masscomponent" => {
            v.extend([
                ph("mass", "Massa", Kind::Mass, ""),
                p("masscomponenttype", "Tipo di massa", Kind::Enum(MASS_TYPE)),
            ]);
            v.extend_from_slice(MASS_OBJECT);
        }
        "parachute" => {
            v.extend([
                ph("diameter", "Diametro", Kind::Length, "Ø "),
                p("linecount", "Numero di cordini", Kind::Int),
                p("linelength", "Lunghezza dei cordini", Kind::Length),
                p("cd", "Coefficiente di resistenza (Cd)", Kind::Cd),
            ]);
            v.extend_from_slice(MASS_OBJECT);
        }
        "streamer" => {
            v.extend([
                ph(
                    "striplength",
                    "Lunghezza della striscia",
                    Kind::Length,
                    "lunghezza ",
                ),
                p("stripwidth", "Larghezza della striscia", Kind::Length),
                p("cd", "Coefficiente di resistenza (Cd)", Kind::Cd),
            ]);
            v.extend_from_slice(MASS_OBJECT);
        }
        "shockcord" => {
            v.push(ph(
                "cordlength",
                "Lunghezza del cavo",
                Kind::Length,
                "lunghezza ",
            ));
            v.extend_from_slice(MASS_OBJECT);
        }
        _ => {}
    }
    v
}

/// All simple parameters (single child element with scalar text) of a component type.
pub fn simple_params(element: &str) -> Vec<PSpec> {
    let mut v = specific(element);
    v.extend_from_slice(GENERIC);
    v
}

/// Headline prefix for the parameter `key` of a component type, if any.
pub fn headline_prefix(element: &str, key: &str) -> Option<&'static str> {
    specific(element)
        .into_iter()
        .find(|s| s.key == key)
        .and_then(|s| s.headline)
}

/// Simple-parameter children of `<conditions>` in a simulation.
pub const SIM_CONDITIONS: &[PSpec] = &[
    p(
        "launchrodlength",
        "Lunghezza della lanciatoia",
        Kind::Length,
    ),
    p(
        "launchintowind",
        "Lanciatoia orientata controvento",
        Kind::Bool,
    ),
    p(
        "launchrodangle",
        "Inclinazione della lanciatoia",
        Kind::AngleDeg,
    ),
    p(
        "launchroddirection",
        "Direzione della lanciatoia",
        Kind::AngleDeg,
    ),
    p(
        "windturbulence",
        "Intensità di turbolenza del vento",
        Kind::Percent,
    ),
    p("windmodeltype", "Modello di vento", Kind::Enum(WIND_MODEL)),
    p("launchaltitude", "Quota di lancio", Kind::Altitude),
    p("launchlatitude", "Latitudine di lancio", Kind::AngleDeg),
    p("launchlongitude", "Longitudine di lancio", Kind::AngleDeg),
    p(
        "geodeticmethod",
        "Modello della Terra",
        Kind::Enum(GEODETIC),
    ),
    p("timestep", "Passo di simulazione", Kind::Time),
    p("maxtime", "Durata massima simulata", Kind::Time),
];

/// Attributes of `<flightdata>` -> results.
pub const SIM_RESULTS: &[PSpec] = &[
    ph("maxaltitude", "Apogeo", Kind::Altitude, "apogeo "),
    p("maxvelocity", "Velocità massima", Kind::Speed),
    p("maxacceleration", "Accelerazione massima", Kind::Accel),
    p("maxmach", "Numero di Mach massimo", Kind::Number),
    p("timetoapogee", "Tempo all'apogeo", Kind::Time),
    p("flighttime", "Durata del volo", Kind::Time),
    p(
        "groundhitvelocity",
        "Velocità di discesa all'impatto con il suolo",
        Kind::Speed,
    ),
    p(
        "launchrodvelocity",
        "Velocità di uscita dalla lanciatoia",
        Kind::Speed,
    ),
    p(
        "deploymentvelocity",
        "Velocità all'apertura del paracadute",
        Kind::Speed,
    ),
    p("optimumdelay", "Ritardo ottimale del motore", Kind::Time),
];

/// True when `raw` is the value OpenRocket assumes when the element is absent from the file.
/// A parameter that exists on only one side and holds its default value is not a change
/// (e.g. `<instancecount>1</instancecount>` appeared in newer file versions).
pub fn is_default_value(key: &str, raw: &str) -> bool {
    let t = raw.trim();
    let num = t.parse::<f64>().ok();
    match key {
        "instancecount" => num == Some(1.0),
        "instanceseparation" | "filletradius" => num == Some(0.0),
        "isflipped" => t == "false",
        "designtype" => t.eq_ignore_ascii_case("original"),
        "masscomponenttype" => t == "masscomponent",
        "launchintowind" => t == "true",
        "windmodeltype" => t.eq_ignore_ascii_case("average"),
        "maxtime" => num == Some(1200.0),
        "radiusoffset" => num == Some(0.0),
        _ => false,
    }
}
