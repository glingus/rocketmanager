//! Secret storage: Windows Credential Manager through `keyring`.
//!
//! Credential Manager limits one secret to ~2.5 KB, less than a Supabase session JSON, so values
//! are split into chunks. [`SecretStore`] is a trait so the logic can be tested with
//! [`MemoryStore`]; on platforms without a native keyring (development on Linux) the `keyring`
//! crate itself provides an in-process store, which keeps nothing after the process exits.

use std::collections::HashMap;
use std::sync::Mutex;

/// Service name under which every entry is stored.
pub const SERVICE: &str = "it.rocketsync.app";
const CHUNK_CHARS: usize = 800;

/// Errors of the secret store.
#[derive(Debug, Clone, thiserror::Error)]
#[error("archivio delle credenziali: {0}")]
pub struct SecretError(pub String);

/// Minimal key/value interface for secrets.
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SecretError>;
    fn delete(&self, key: &str) -> Result<(), SecretError>;
}

/// One entry of a backend, with a size limit.
pub trait RawEntries: Send + Sync {
    fn read(&self, name: &str) -> Result<Option<String>, SecretError>;
    fn write(&self, name: &str, value: &str) -> Result<(), SecretError>;
    fn remove(&self, name: &str) -> Result<(), SecretError>;
}

/// Splits values into chunks over a [`RawEntries`] backend.
pub struct Chunked<R: RawEntries> {
    raw: R,
}

impl<R: RawEntries> Chunked<R> {
    pub fn new(raw: R) -> Self {
        Self { raw }
    }

    fn count_of(&self, key: &str) -> Result<Option<usize>, SecretError> {
        Ok(self
            .raw
            .read(&format!("{key}#n"))?
            .and_then(|s| s.parse::<usize>().ok()))
    }
}

fn split_chunks(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars.chunks(CHUNK_CHARS).map(|c| c.iter().collect()).collect()
}

impl<R: RawEntries> SecretStore for Chunked<R> {
    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        let Some(n) = self.count_of(key)? else {
            return Ok(None);
        };
        let mut out = String::new();
        for i in 0..n {
            match self.raw.read(&format!("{key}#{i}"))? {
                Some(c) => out.push_str(&c),
                None => return Ok(None), // torn write: treat as absent
            }
        }
        Ok(Some(out))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        let old = self.count_of(key)?.unwrap_or(0);
        let chunks = split_chunks(value);
        for (i, c) in chunks.iter().enumerate() {
            self.raw.write(&format!("{key}#{i}"), c)?;
        }
        self.raw.write(&format!("{key}#n"), &chunks.len().to_string())?;
        for i in chunks.len()..old {
            self.raw.remove(&format!("{key}#{i}"))?;
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        let n = self.count_of(key)?.unwrap_or(0);
        self.raw.remove(&format!("{key}#n"))?;
        for i in 0..n {
            self.raw.remove(&format!("{key}#{i}"))?;
        }
        Ok(())
    }
}

/// Credential Manager (Windows) / Keychain (macOS) entries.
pub struct KeyringRaw {
    service: String,
}

impl KeyringRaw {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }
    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, name).map_err(|e| SecretError(e.to_string()))
    }
}

impl RawEntries for KeyringRaw {
    fn read(&self, name: &str) -> Result<Option<String>, SecretError> {
        match self.entry(name)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }
    fn write(&self, name: &str, value: &str) -> Result<(), SecretError> {
        self.entry(name)?
            .set_password(value)
            .map_err(|e| SecretError(e.to_string()))
    }
    fn remove(&self, name: &str) -> Result<(), SecretError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }
}

/// The store used by the application.
pub fn system_store() -> Chunked<KeyringRaw> {
    Chunked::new(KeyringRaw::new(SERVICE))
}

/// In-memory backend with an optional per-entry size limit (tests).
#[derive(Default)]
pub struct MemoryRaw {
    map: Mutex<HashMap<String, String>>,
    limit: Option<usize>,
}

impl MemoryRaw {
    pub fn with_limit(limit: usize) -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            limit: Some(limit),
        }
    }
    pub fn names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.map.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        v.sort();
        v
    }
}

impl RawEntries for MemoryRaw {
    fn read(&self, name: &str) -> Result<Option<String>, SecretError> {
        Ok(self.map.lock().map_err(|_| SecretError("lock".into()))?.get(name).cloned())
    }
    fn write(&self, name: &str, value: &str) -> Result<(), SecretError> {
        if let Some(l) = self.limit {
            if value.chars().count() > l {
                return Err(SecretError(format!("valore di {} caratteri oltre il limite {l}", value.chars().count())));
            }
        }
        self.map
            .lock()
            .map_err(|_| SecretError("lock".into()))?
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn remove(&self, name: &str) -> Result<(), SecretError> {
        self.map.lock().map_err(|_| SecretError("lock".into()))?.remove(name);
        Ok(())
    }
}

/// Convenience: a chunked in-memory store behaving like the real one (limit 1000 chars per entry).
pub fn memory_store() -> Chunked<MemoryRaw> {
    Chunked::new(MemoryRaw::with_limit(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_values_are_chunked_and_roundtrip() {
        let s = memory_store();
        let big: String = (0..5000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        s.set("auth.session", &big).unwrap();
        assert_eq!(s.get("auth.session").unwrap().as_deref(), Some(big.as_str()));
        // shrinking removes the unused chunks
        s.set("auth.session", "corto").unwrap();
        assert_eq!(s.get("auth.session").unwrap().as_deref(), Some("corto"));
        assert_eq!(s.raw.names(), vec!["auth.session#0".to_string(), "auth.session#n".to_string()]);
        s.delete("auth.session").unwrap();
        assert_eq!(s.get("auth.session").unwrap(), None);
        assert!(s.raw.names().is_empty());
        // empty value and non-ASCII
        s.set("k", "").unwrap();
        assert_eq!(s.get("k").unwrap().as_deref(), Some(""));
        s.set("k", &"è→".repeat(900)).unwrap();
        assert_eq!(s.get("k").unwrap().unwrap().chars().count(), 1800);
    }

    #[test]
    fn torn_write_reads_as_absent() {
        let s = memory_store();
        s.set("x", &"y".repeat(2000)).unwrap();
        s.raw.remove("x#1").unwrap();
        assert_eq!(s.get("x").unwrap(), None);
    }
}
