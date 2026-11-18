#![allow(dead_code)]
//! Helpers shared by the integration tests: fixture loading and variant generation by editing the
//! XML inside the container.

use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Cursor, Read, Write};

pub fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/ork")
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

pub fn all_fixtures() -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<_> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".ork"))
        .collect();
    v.sort();
    v.into_iter().map(|n| (n.clone(), fixture(&n))).collect()
}

/// The XML text inside a ZIP/GZIP/XML `.ork`.
pub fn xml_of(bytes: &[u8]) -> String {
    if bytes.starts_with(b"PK") {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            if f.name().unwrap().ends_with(".ork") {
                let mut s = String::new();
                f.read_to_string(&mut s).unwrap();
                return s;
            }
        }
        panic!("no .ork entry");
    } else if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut s = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut s)
            .unwrap();
        s
    } else {
        String::from_utf8(bytes.to_vec()).unwrap()
    }
}

/// Rebuilds the container with a new XML, keeping the other ZIP entries (decals) untouched.
pub fn with_xml(original: &[u8], new_xml: &str) -> Vec<u8> {
    if original.starts_with(b"PK") {
        let mut z = zip::ZipArchive::new(Cursor::new(original)).unwrap();
        let mut out = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut out);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for i in 0..z.len() {
                let mut f = z.by_index(i).unwrap();
                let name = f.name().unwrap().to_string();
                if f.is_dir() {
                    continue;
                }
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                if name.ends_with(".ork") {
                    data = new_xml.as_bytes().to_vec();
                }
                w.start_file(name, opts).unwrap();
                w.write_all(&data).unwrap();
            }
            w.finish().unwrap();
        }
        out.into_inner()
    } else if original.starts_with(&[0x1f, 0x8b]) {
        gzip(new_xml.as_bytes())
    } else {
        new_xml.as_bytes().to_vec()
    }
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// Replaces exactly one occurrence of `from` (panics if not found).
pub fn replace1(xml: &str, from: &str, to: &str) -> String {
    assert!(xml.contains(from), "pattern not found: {from}");
    xml.replacen(from, to, 1)
}

/// Variant of `original` where `edit` is applied to the XML.
pub fn variant(original: &[u8], edit: impl FnOnce(&str) -> String) -> Vec<u8> {
    let xml = xml_of(original);
    with_xml(original, &edit(&xml))
}
