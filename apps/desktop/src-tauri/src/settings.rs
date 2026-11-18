//! Application settings (`AppSettings` of the contract), stored in the local database.

use rs_store::Store;
use serde::{Deserialize, Serialize};

/// `AppSettings` of the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub autostart: bool,
    pub desktop_notifications: bool,
    pub minimize_to_tray: bool,
    pub fetch_interval_seconds: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            autostart: false,
            desktop_notifications: true,
            minimize_to_tray: true,
            fetch_interval_seconds: 60,
        }
    }
}

pub const MIN_FETCH_SECONDS: u32 = 15;
pub const MAX_FETCH_SECONDS: u32 = 3600;

impl AppSettings {
    /// Clamps values to what the engine supports.
    pub fn normalized(mut self) -> Self {
        self.fetch_interval_seconds = self.fetch_interval_seconds.clamp(MIN_FETCH_SECONDS, MAX_FETCH_SECONDS);
        self
    }

    pub fn load(store: &Store) -> Self {
        store
            .get_json::<AppSettings>("app", "settings")
            .ok()
            .flatten()
            .unwrap_or_default()
            .normalized()
    }

    pub fn save(&self, store: &Store) -> Result<(), rs_store::StoreError> {
        store.set_json("app", "settings", self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip_and_clamping() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(AppSettings::load(&s), AppSettings::default());
        let custom = AppSettings { autostart: true, desktop_notifications: false, minimize_to_tray: false, fetch_interval_seconds: 5 };
        custom.save(&s).unwrap();
        let back = AppSettings::load(&s);
        assert!(back.autostart && !back.desktop_notifications && !back.minimize_to_tray);
        assert_eq!(back.fetch_interval_seconds, MIN_FETCH_SECONDS);
        assert_eq!(
            serde_json::to_value(AppSettings::default()).unwrap(),
            serde_json::json!({"autostart": false, "desktopNotifications": true, "minimizeToTray": true, "fetchIntervalSeconds": 60})
        );
    }
}
