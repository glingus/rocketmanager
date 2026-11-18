pub mod askpass;
pub mod auth;
pub mod config;
pub mod diagnostics;
pub mod enrich;
pub mod events;
pub mod logging;
pub mod openrocket;
pub mod paths;
pub mod platform;
pub mod secrets;
pub mod selftest;
pub mod settings;
pub mod shell;
mod app;
pub mod commands;

pub use app::run;

#[cfg(test)]
mod consistency {
    //! The list of commands exists in three places (build.rs, the capability, the invoke handler)
    //! and in the contract: they must not drift apart.

    fn names_in(text: &str, start: &str, end: &str, prefix: &str, suffix: &str) -> Vec<String> {
        let s = text.split_once(start).unwrap().1;
        let s = s.split_once(end).unwrap().0;
        s.lines()
            .filter_map(|l| l.trim().strip_prefix(prefix).and_then(|r| r.strip_suffix(suffix)))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn command_lists_agree() {
        let build = include_str!("../build.rs");
        let from_build = names_in(build, "COMMANDS: &[&str] = &[", "];", "\"", "\",");
        assert_eq!(from_build.len(), 43, "{from_build:?}");

        let app = include_str!("app.rs");
        let from_handler = names_in(app, "generate_handler![", "])", "commands::", ",");
        assert_eq!(from_build, from_handler);

        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<String> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .filter_map(|p| p.strip_prefix("allow-"))
            .map(|p| p.replace('-', "_"))
            .collect();
        assert_eq!(from_build, granted);
        // only event listening from the core: no fs/shell/http/opener permission for the interface
        let others: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .filter(|p| !p.starts_with("allow-"))
            .collect();
        assert_eq!(others, vec!["core:event:allow-listen", "core:event:allow-unlisten"]);
    }

    #[test]
    fn every_command_of_the_contract_exists() {
        let contract = include_str!("../../../../docs/contratto-ipc.md");
        let build = include_str!("../build.rs");
        let have = names_in(build, "COMMANDS: &[&str] = &[", "];", "\"", "\",");
        // commands are listed in tables as | `name` | ...
        let mut in_contract: Vec<String> = contract
            .lines()
            .filter_map(|l| l.strip_prefix("| `"))
            .filter_map(|l| l.split_once('`').map(|(n, _)| n.to_string()))
            .filter(|n| n.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '/' || c == ' '))
            .flat_map(|n| n.split(" / ").map(str::to_string).collect::<Vec<_>>())
            .filter(|n| n.contains('_') && !n.starts_with("project-"))
            .collect();
        in_contract.sort();
        in_contract.dedup();
        for c in &in_contract {
            assert!(have.contains(c), "contract command {c} is not implemented");
        }
        for h in &have {
            assert!(in_contract.contains(h), "command {h} is not in the contract");
        }
    }
}
