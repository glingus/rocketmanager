//! Public data types. They serialize (camelCase) exactly as specified in
//! `docs/contratto-ipc.md` section 3.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Zip,
    Gzip,
    Xml,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrkSummary {
    pub container: Container,
    pub creator: Option<String>,
    pub format_version: Option<String>,
    pub rocket_name: Option<String>,
    pub stage_count: u32,
    pub component_count: u32,
    pub simulation_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayValue {
    pub raw: String,
    pub display: String,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamChange {
    pub key: String,
    pub label: String,
    pub before: Option<DisplayValue>,
    pub after: Option<DisplayValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentChangeKind {
    Added,
    Removed,
    Modified,
    Moved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Removed,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentChange {
    pub kind: ComponentChangeKind,
    pub component_type: String,
    pub type_label: String,
    pub name: String,
    pub path: Vec<String>,
    pub params: Vec<ParamChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    pub kind: ChangeKind,
    pub name: String,
    pub params: Vec<ParamChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationChange {
    pub kind: ChangeKind,
    pub name: String,
    pub conditions: Vec<ParamChange>,
    pub results: Vec<ParamChange>,
    pub data_updated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninterpretedChange {
    pub section: String,
    pub count: u32,
    pub sample: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrkDiff {
    pub path: String,
    pub before: Option<OrkSummary>,
    pub after: Option<OrkSummary>,
    pub components: Vec<ComponentChange>,
    pub motor_configurations: Vec<ConfigChange>,
    pub simulations: Vec<SimulationChange>,
    pub uninterpreted: Vec<UninterpretedChange>,
    pub parse_error: Option<String>,
}

impl OrkDiff {
    /// True when nothing at all was detected (no semantic change, nothing uninterpreted).
    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
            && self.motor_configurations.is_empty()
            && self.simulations.is_empty()
            && self.uninterpreted.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapItem {
    pub component_path: Vec<String>,
    pub component_name: String,
    pub key: Option<String>,
    pub label: String,
    pub mine: Option<DisplayValue>,
    pub theirs: Option<DisplayValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrkThreeWay {
    pub path: String,
    pub mine: OrkDiff,
    pub theirs: OrkDiff,
    pub overlapping: Vec<OverlapItem>,
    pub independent: bool,
}
