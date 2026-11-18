//! Error type of the crate. Messages are in Italian because they are shown to the user
//! (e.g. "il file non è completo") through `FileInspector::validate`.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrkError {
    /// The bytes are not an OpenRocket file (unknown signature, RockSim file, ...).
    Unsupported(String),
    /// The container or the XML is cut off / damaged (typical of a file still being written).
    Incomplete(String),
    /// The XML is syntactically wrong.
    Xml(String),
    /// The structure is valid XML but it is not a valid OpenRocket document.
    Structure(String),
    /// Decompressed content exceeds the safety limit.
    TooLarge,
}

impl fmt::Display for OrkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OrkError::Unsupported(m) => write!(f, "Formato non supportato: {m}"),
            OrkError::Incomplete(m) => write!(f, "File incompleto o danneggiato: {m}"),
            OrkError::Xml(m) => write!(f, "XML non valido: {m}"),
            OrkError::Structure(m) => write!(f, "Struttura del progetto non valida: {m}"),
            OrkError::TooLarge => {
                write!(f, "Il contenuto decompresso supera il limite di sicurezza")
            }
        }
    }
}

impl std::error::Error for OrkError {}
