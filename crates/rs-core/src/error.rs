//! Errors of the engine and their conversion into the `AppError` of the IPC contract.

use rs_git::{GitError, GitErrorKind};
use rs_store::StoreError;
use serde::{Deserialize, Serialize};

/// `ErrorCode` of the IPC contract (`docs/contratto-ipc.md` §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Network,
    AuthRequired,
    AuthFailed,
    NotLinked,
    FolderNotEmpty,
    FolderInSyncedDrive,
    FileNotStable,
    FileInvalid,
    FileTooLarge,
    BlockedByEditor,
    ConflictOpen,
    LocalChangesPresent,
    NonFastForward,
    LockHeld,
    NotFound,
    InvalidPath,
    GitMissing,
    Internal,
}

/// `AppError` of the IPC contract: what the interface receives when a command fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    /// In Italian, ready to show to the user.
    pub message: String,
    /// Technical detail for diagnostics (already redacted).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    pub retryable: bool,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Error type of every engine command.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CoreError {
    #[error("Git: {0}")]
    Git(#[from] GitError),
    #[error("database locale: {0}")]
    Store(String),
    #[error("errore di I/O: {0}")]
    Io(String),
    #[error("progetto non collegato: {0}")]
    NotLinked(String),
    #[error("la cartella non è vuota o contiene già un repository: {0}")]
    FolderNotEmpty(String),
    #[error("la cartella si trova in un disco sincronizzato ({0})")]
    FolderInSyncedDrive(String),
    #[error("file non stabili: {}", .0.join(", "))]
    FileNotStable(Vec<String>),
    #[error("file non valido {path}: {reason}")]
    FileInvalid { path: String, reason: String },
    #[error("file troppo grande {path}: {size} byte")]
    FileTooLarge { path: String, size: u64 },
    #[error("file aperti in OpenRocket: {}", .0.join(", "))]
    BlockedByEditor(Vec<String>),
    #[error("c'è un conflitto aperto")]
    ConflictOpen,
    #[error("modifiche locali sui file: {}", .0.join(", "))]
    LocalChangesPresent(Vec<String>),
    #[error("non trovato: {0}")]
    NotFound(String),
    #[error("percorso non valido: {0}")]
    InvalidPath(String),
    #[error("accesso richiesto")]
    AuthRequired,
    #[error("nessuna modifica da pubblicare")]
    NothingToPublish,
    #[error("argomento non valido: {0}")]
    InvalidArgument(String),
    #[error("salvataggio sospetto da chiarire: {}", .0.join(", "))]
    StaleSavePending(Vec<String>),
    #[error("arresto simulato ({0})")]
    InjectedCrash(String),
    #[error("{0}")]
    Internal(String),
}

impl From<StoreError> for CoreError {
    fn from(e: StoreError) -> Self {
        CoreError::Store(e.to_string())
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Io(e.to_string())
    }
}

impl CoreError {
    /// Contract code of this error.
    pub fn code(&self) -> ErrorCode {
        match self {
            CoreError::Git(g) => match g.kind() {
                GitErrorKind::Network | GitErrorKind::Timeout => ErrorCode::Network,
                GitErrorKind::AuthFailed => ErrorCode::AuthFailed,
                GitErrorKind::NonFastForward => ErrorCode::NonFastForward,
                GitErrorKind::LockHeld => ErrorCode::LockHeld,
                GitErrorKind::GitMissing | GitErrorKind::UnsupportedVersion => ErrorCode::GitMissing,
                _ => ErrorCode::Internal,
            },
            CoreError::NotLinked(_) => ErrorCode::NotLinked,
            CoreError::FolderNotEmpty(_) => ErrorCode::FolderNotEmpty,
            CoreError::FolderInSyncedDrive(_) => ErrorCode::FolderInSyncedDrive,
            CoreError::FileNotStable(_) => ErrorCode::FileNotStable,
            CoreError::FileInvalid { .. } => ErrorCode::FileInvalid,
            CoreError::FileTooLarge { .. } => ErrorCode::FileTooLarge,
            CoreError::BlockedByEditor(_) => ErrorCode::BlockedByEditor,
            CoreError::ConflictOpen | CoreError::StaleSavePending(_) => ErrorCode::ConflictOpen,
            CoreError::LocalChangesPresent(_) => ErrorCode::LocalChangesPresent,
            CoreError::NotFound(_) | CoreError::NothingToPublish => ErrorCode::NotFound,
            CoreError::InvalidPath(_) => ErrorCode::InvalidPath,
            CoreError::AuthRequired => ErrorCode::AuthRequired,
            CoreError::Store(_)
            | CoreError::Io(_)
            | CoreError::InvalidArgument(_)
            | CoreError::InjectedCrash(_)
            | CoreError::Internal(_) => ErrorCode::Internal,
        }
    }

    /// Whether retrying later may succeed.
    pub fn retryable(&self) -> bool {
        match self {
            CoreError::Git(g) => matches!(
                g.kind(),
                GitErrorKind::Network | GitErrorKind::Timeout | GitErrorKind::LockHeld | GitErrorKind::NonFastForward
            ),
            CoreError::FileNotStable(_) | CoreError::BlockedByEditor(_) => true,
            _ => false,
        }
    }

    /// Whether this is a network-reachability problem (the project goes `offline`, not `error`).
    pub fn is_network(&self) -> bool {
        matches!(self, CoreError::Git(g) if matches!(g.kind(), GitErrorKind::Network | GitErrorKind::Timeout))
    }

    /// Message in Italian suitable for the user.
    pub fn user_message(&self) -> String {
        match self {
            CoreError::Git(g) => match g.kind() {
                GitErrorKind::Network | GitErrorKind::Timeout => {
                    "Impossibile raggiungere il server. Controlla la connessione: riproverò appena possibile.".into()
                }
                GitErrorKind::AuthFailed => {
                    "Accesso a GitHub non riuscito. Esci e accedi di nuovo.".into()
                }
                GitErrorKind::NonFastForward => {
                    "Un collega ha pubblicato nel frattempo. Riprova tra un istante.".into()
                }
                GitErrorKind::LockHeld => {
                    "Un altro programma sta usando i file del progetto. Riprova tra qualche secondo.".into()
                }
                GitErrorKind::GitMissing => "Git non è disponibile: reinstalla Rocket Sync.".into(),
                GitErrorKind::UnsupportedVersion => {
                    "La versione di Git inclusa è troppo vecchia: reinstalla Rocket Sync.".into()
                }
                GitErrorKind::NotARepository => {
                    "La cartella del progetto non contiene più i dati di sincronizzazione.".into()
                }
                GitErrorKind::Cancelled => "Operazione annullata.".into(),
                _ => "Operazione di sincronizzazione non riuscita.".into(),
            },
            CoreError::Store(_) => "Errore nel database locale di Rocket Sync.".into(),
            CoreError::Io(_) => "Errore di lettura o scrittura sul disco.".into(),
            CoreError::NotLinked(_) => "Questo progetto non è collegato a una cartella.".into(),
            CoreError::FolderNotEmpty(_) => {
                "La cartella scelta contiene già un repository diverso da quello del progetto.".into()
            }
            CoreError::FolderInSyncedDrive(d) => format!(
                "La cartella si trova in {d}: scegline una fuori dai dischi sincronizzati per evitare conflitti."
            ),
            CoreError::FileNotStable(p) => format!(
                "Il file è ancora in fase di salvataggio, riprova tra qualche secondo ({}).",
                p.join(", ")
            ),
            CoreError::FileInvalid { path, reason } => {
                format!("Il file «{path}» non è completo o leggibile: {reason}")
            }
            CoreError::FileTooLarge { path, .. } => {
                format!("Il file «{path}» supera il limite di 100 MB e non può essere pubblicato.")
            }
            CoreError::BlockedByEditor(p) => format!(
                "Chiudi OpenRocket (file aperti: {}) e riprova.",
                p.join(", ")
            ),
            CoreError::ConflictOpen => {
                "C'è un conflitto da risolvere: finché è aperto non si può pubblicare né aggiornare.".into()
            }
            CoreError::LocalChangesPresent(p) => format!(
                "Ci sono modifiche non pubblicate su: {}. Pubblicale o scartale prima di continuare.",
                p.join(", ")
            ),
            CoreError::NotFound(w) => format!("Elemento non trovato: {w}."),
            CoreError::InvalidPath(p) => format!("Percorso non valido: {p}."),
            CoreError::AuthRequired => "Accedi con GitHub per continuare.".into(),
            CoreError::NothingToPublish => "Non ci sono modifiche da pubblicare.".into(),
            CoreError::InvalidArgument(m) => format!("Richiesta non valida: {m}."),
            CoreError::StaleSavePending(p) => format!(
                "Prima di pubblicare chiarisci il salvataggio sospetto su: {}.",
                p.join(", ")
            ),
            CoreError::InjectedCrash(_) | CoreError::Internal(_) => {
                "Errore interno di Rocket Sync.".into()
            }
        }
    }

    /// Conversion to the contract's `AppError`.
    pub fn to_app_error(&self) -> AppError {
        AppError {
            code: self.code(),
            message: self.user_message(),
            detail: Some(self.to_string()),
            retryable: self.retryable(),
        }
    }
}

impl From<CoreError> for AppError {
    fn from(e: CoreError) -> Self {
        e.to_app_error()
    }
}

impl From<&CoreError> for AppError {
    fn from(e: &CoreError) -> Self {
        e.to_app_error()
    }
}

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_to_contract_codes() {
        let e = CoreError::Git(GitError::Network { stderr: "x".into() });
        let a = e.to_app_error();
        assert_eq!(a.code, ErrorCode::Network);
        assert!(a.retryable);
        assert!(a.message.contains("server"));
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["code"], "network");
        assert_eq!(v["retryable"], true);
        assert_eq!(CoreError::ConflictOpen.code(), ErrorCode::ConflictOpen);
        assert_eq!(
            serde_json::to_value(ErrorCode::LocalChangesPresent).unwrap(),
            "localChangesPresent"
        );
        assert_eq!(CoreError::FileInvalid { path: "a".into(), reason: "r".into() }.code(), ErrorCode::FileInvalid);
    }
}
