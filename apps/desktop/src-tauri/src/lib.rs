mod app;
pub mod askpass;
pub mod auth;
pub mod commands;
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

pub use app::run;

#[cfg(test)]
mod consistency {
    //! The list of commands exists in three places (build.rs, the capability, the invoke handler)
    //! and in the contract: they must not drift apart.

    fn names_in(text: &str, start: &str, end: &str, prefix: &str, suffix: &str) -> Vec<String> {
        let s = text.split_once(start).unwrap().1;
        let s = s.split_once(end).unwrap().0;
        s.lines()
            .filter_map(|l| {
                l.trim()
                    .strip_prefix(prefix)
                    .and_then(|r| r.strip_suffix(suffix))
            })
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn command_lists_agree() {
        let build = include_str!("../build.rs");
        let from_build = names_in(build, "COMMANDS: &[&str] = &[", "];", "\"", "\",");
        assert_eq!(from_build.len(), 42, "{from_build:?}");

        let app = include_str!("app.rs");
        let from_handler = names_in(app, "generate_handler![", "])", "commands::", ",");
        assert_eq!(from_build, from_handler);

        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
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
        assert_eq!(
            others,
            vec!["core:event:allow-listen", "core:event:allow-unlisten"]
        );
    }

    #[test]
    fn every_command_of_the_contract_exists() {
        let contract = include_str!("../../../../docs/contratto-ipc.md");
        let build = include_str!("../build.rs");
        let have = names_in(build, "COMMANDS: &[&str] = &[", "];", "\"", "\",");
        // commands are listed in tables as | `name` | ...
        let mut in_contract: Vec<String> = Vec::new();
        for l in contract.lines().filter(|l| l.starts_with("| `")) {
            // first table cell: every `token` in it is a command
            let cell = l.trim_start_matches('|').split('|').next().unwrap_or("");
            for (i, tok) in cell.split('`').enumerate() {
                if i % 2 == 1 && tok.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                    in_contract.push(tok.to_string());
                }
            }
        }
        in_contract.sort();
        in_contract.dedup();
        for c in &in_contract {
            assert!(have.contains(c), "contract command {c} is not implemented");
        }
        for h in &have {
            assert!(
                in_contract.contains(h),
                "command {h} is not in the contract"
            );
        }
    }
}
