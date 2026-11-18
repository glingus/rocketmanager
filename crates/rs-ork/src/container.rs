//! Container detection and extraction of the OpenRocket XML.
//!
//! OpenRocket's own loader (`GeneralRocketLoader`) decides from the first bytes:
//! `1f 8b` -> GZIP, `PK` -> ZIP (first entry named `*.ork`), anything else -> plain XML.

use crate::error::OrkError;
use crate::types::Container;
use flate2::read::GzDecoder;
use std::io::{Cursor, Read};

/// Safety limit for decompressed content (a zip bomb would otherwise exhaust memory).
pub const MAX_DECOMPRESSED_BYTES: u64 = 1 << 30;

/// Identifies the container from the magic bytes. `None` if it does not look like an `.ork`.
pub fn detect_container(bytes: &[u8]) -> Option<Container> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return Some(Container::Gzip);
    }
    if bytes.len() >= 2 && bytes[0] == b'P' && bytes[1] == b'K' {
        return Some(Container::Zip);
    }
    let body = strip_bom(bytes);
    let first = body.iter().copied().find(|b| !b.is_ascii_whitespace());
    if first == Some(b'<') {
        return Some(Container::Xml);
    }
    None
}

pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

/// An auxiliary file stored next to the rocket XML in a ZIP (decals, textures).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Attachment {
    pub name: String,
    pub size: u64,
    pub crc32: u32,
}

pub(crate) struct Extracted {
    pub container: Container,
    pub xml: Vec<u8>,
    pub attachments: Vec<Attachment>,
}

fn is_rocket_entry(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".ork") || n.ends_with(".rkt") || n.ends_with(".cdx1")
}

fn map_io(e: std::io::Error, what: &str) -> OrkError {
    match e.kind() {
        std::io::ErrorKind::UnexpectedEof => {
            OrkError::Incomplete(format!("{what} troncato (fine del file inattesa)"))
        }
        _ => OrkError::Incomplete(format!("{what} danneggiato ({e})")),
    }
}

fn read_limited<R: Read>(mut r: R) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let n = (&mut r)
        .take(MAX_DECOMPRESSED_BYTES + 1)
        .read_to_end(&mut out)?;
    if n as u64 > MAX_DECOMPRESSED_BYTES {
        return Err(std::io::Error::other("too large"));
    }
    Ok(out)
}

/// Extracts the XML bytes (and attachments metadata). Verifies integrity: every ZIP entry is read
/// to the end (CRC32 check) and GZIP streams must reach their trailer.
pub(crate) fn extract(bytes: &[u8]) -> Result<Extracted, OrkError> {
    let container = detect_container(bytes).ok_or_else(|| {
        OrkError::Unsupported("il file non è un progetto OpenRocket (.ork)".into())
    })?;
    match container {
        Container::Xml => Ok(Extracted {
            container,
            xml: strip_bom(bytes).to_vec(),
            attachments: Vec::new(),
        }),
        Container::Gzip => {
            let xml = read_limited(GzDecoder::new(bytes)).map_err(|e| {
                if e.to_string() == "too large" {
                    OrkError::TooLarge
                } else {
                    map_io(e, "Archivio GZIP")
                }
            })?;
            Ok(Extracted {
                container,
                xml: strip_bom(&xml).to_vec(),
                attachments: Vec::new(),
            })
        }
        Container::Zip => {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
                .map_err(|e| OrkError::Incomplete(format!("archivio ZIP non leggibile ({e})")))?;
            let mut xml: Option<Vec<u8>> = None;
            let mut attachments = Vec::new();
            let mut total: u64 = 0;
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|e| {
                    OrkError::Incomplete(format!("voce {i} dell'archivio ZIP non leggibile ({e})"))
                })?;
                if entry.is_dir() {
                    continue;
                }
                let name = entry.name().map(|n| n.into_owned()).unwrap_or_default();
                let size = entry.size();
                let crc32 = entry.crc32();
                total = total.saturating_add(size);
                if total > MAX_DECOMPRESSED_BYTES {
                    return Err(OrkError::TooLarge);
                }
                let data = read_limited(&mut entry).map_err(|e| {
                    if e.to_string() == "too large" {
                        OrkError::TooLarge
                    } else {
                        map_io(e, &format!("«{name}» nell'archivio ZIP"))
                    }
                })?;
                if xml.is_none() && is_rocket_entry(&name) {
                    xml = Some(strip_bom(&data).to_vec());
                } else {
                    attachments.push(Attachment { name, size, crc32 });
                }
            }
            let xml = xml.ok_or_else(|| {
                OrkError::Unsupported("l'archivio ZIP non contiene un file .ork".into())
            })?;
            attachments.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(Extracted {
                container,
                xml,
                attachments,
            })
        }
    }
}
