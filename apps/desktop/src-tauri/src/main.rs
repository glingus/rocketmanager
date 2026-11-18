// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Git credential helper: answer and exit before anything else is initialised.
    if rocket_sync_lib::askpass::requested() {
        let store = rocket_sync_lib::secrets::system_store();
        let code = rocket_sync_lib::askpass::run(&args, &store, &mut std::io::stdout());
        std::process::exit(code);
    }
    // Installer / CI check: no window, no sign-in, no network.
    if let Some(code) = rocket_sync_lib::selftest::handle_cli(&args) {
        std::process::exit(code);
    }
    rocket_sync_lib::run();
}
