//! Debug CLI: `ork-cli summary <file>`, `ork-cli diff <a> <b> [--json]`, `ork-cli normalize <file>`.

use rs_ork::{changelog_lines, diff, normalized_xml, parse};
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!(
        "Uso:\n  ork-cli summary <file> [--json]\n  ork-cli diff <a> <b> [--json]\n  ork-cli normalize <file> [--keep-flight-data]"
    );
    ExitCode::from(2)
}

fn read(path: &str) -> Result<Vec<u8>, ExitCode> {
    std::fs::read(path).map_err(|e| {
        eprintln!("Impossibile leggere «{path}»: {e}");
        ExitCode::from(1)
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|a| a == "--json");
    let keep = args.iter().any(|a| a == "--keep-flight-data");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    match (pos.first().map(|s| s.as_str()), pos.len()) {
        (Some("summary"), 2) => {
            let bytes = match read(pos[1]) {
                Ok(b) => b,
                Err(c) => return c,
            };
            match parse(&bytes) {
                Ok(doc) => {
                    if json {
                        println!("{}", serde_json::to_string_pretty(&doc).unwrap());
                    } else {
                        let s = &doc.summary;
                        println!("Contenitore:   {:?}", s.container);
                        println!("Creato da:     {}", s.creator.as_deref().unwrap_or("?"));
                        println!(
                            "Versione fmt:  {}",
                            s.format_version.as_deref().unwrap_or("?")
                        );
                        println!("Razzo:         {}", s.rocket_name.as_deref().unwrap_or("?"));
                        println!(
                            "Stadi {} · componenti {} · simulazioni {}",
                            s.stage_count, s.component_count, s.simulation_count
                        );
                        println!("\nComponenti:");
                        for c in &doc.components {
                            let indent = "  ".repeat(c.path.len() + 1);
                            let id = c.id.as_deref().map(|i| &i[..i.len().min(8)]).unwrap_or("-");
                            println!(
                                "{indent}{} «{}» [id {id}] ({} parametri, {} elementi non interpretati)",
                                c.type_label,
                                c.name,
                                c.params.len(),
                                c.uninterpreted_elements
                            );
                        }
                        println!("\nConfigurazioni motori:");
                        for c in &doc.motor_configurations {
                            println!("  {} ({})", c.name, c.motors.join(", "));
                        }
                        println!("\nSimulazioni:");
                        for s in &doc.simulations {
                            let ap = s
                                .results
                                .iter()
                                .find(|p| p.key == "maxaltitude")
                                .map(|p| p.value.display.clone())
                                .unwrap_or_default();
                            println!("  {} (apogeo {ap})", s.name);
                        }
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::from(1)
                }
            }
        }
        (Some("diff"), 3) => {
            let (a, b) = match (read(pos[1]), read(pos[2])) {
                (Ok(a), Ok(b)) => (a, b),
                (Err(c), _) | (_, Err(c)) => return c,
            };
            let d = diff(pos[2], Some(&a), Some(&b));
            if json {
                println!("{}", serde_json::to_string_pretty(&d).unwrap());
            } else {
                for l in changelog_lines(&d) {
                    println!("• {l}");
                }
            }
            ExitCode::SUCCESS
        }
        (Some("normalize"), 2) => {
            let bytes = match read(pos[1]) {
                Ok(b) => b,
                Err(c) => return c,
            };
            match normalized_xml(&bytes, !keep) {
                Ok(s) => {
                    print!("{s}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::from(1)
                }
            }
        }
        _ => usage(),
    }
}
