mod common;
use common::*;
use rs_ork::*;
use std::io::{Cursor, Read, Write};

/// Rewrites a ZIP with a different entry order, compression method and timestamps.
fn rewrite_zip(
    original: &[u8],
    reverse: bool,
    stored: bool,
    year: u16,
    tweak: impl Fn(&str, Vec<u8>) -> Vec<u8>,
) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(Cursor::new(original)).unwrap();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        if f.is_dir() {
            continue;
        }
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        entries.push((name.clone(), tweak(&name, data)));
    }
    if reverse {
        entries.reverse();
    }
    let method = if stored {
        zip::CompressionMethod::Stored
    } else {
        zip::CompressionMethod::Deflated
    };
    let ts = zip::DateTime::from_date_and_time(year, 6, 15, 12, 30, 40).unwrap();
    let mut out = Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut out);
        for (name, data) in entries {
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(method)
                .last_modified_time(ts);
            w.start_file(name, opts).unwrap();
            w.write_all(&data).unwrap();
        }
        w.finish().unwrap();
    }
    out.into_inner()
}

#[test]
fn same_content_with_different_zip_bytes_is_equal() {
    for name in [
        "simple-model-rocket-24.12.ork",
        "simple-model-rocket-13.04.ork",
        "presets-22.02.ork",
        "parallel-booster-staging-24.12.ork",
    ] {
        let a = fixture(name);
        for (reverse, stored, year) in [
            (false, false, 2001),
            (true, false, 2010),
            (false, true, 1999),
            (true, true, 2025),
        ] {
            let b = rewrite_zip(&a, reverse, stored, year, |_, d| d);
            assert_ne!(a, b, "{name}: the rewrite must change the bytes");
            assert!(
                content_equal(&a, &b),
                "{name} reverse={reverse} stored={stored}"
            );
            assert!(content_equal(&b, &a));
        }
    }
}

#[test]
fn one_changed_byte_in_rocket_ork_is_not_equal() {
    let a = fixture("simple-model-rocket-24.12.ork");
    let b = rewrite_zip(&a, false, false, 2020, |name, mut d| {
        if name.ends_with(".ork") {
            let i = d.iter().position(|c| *c == b'0').unwrap();
            d[i] = b'1';
        }
        d
    });
    assert!(!content_equal(&a, &b));
    // A changed decal is also a change.
    let c = rewrite_zip(&a, false, false, 2020, |name, mut d| {
        if name.ends_with(".png") {
            d.push(0);
        }
        d
    });
    assert!(!content_equal(&a, &c));
    // A removed entry too.
    let mut z = zip::ZipArchive::new(Cursor::new(&a)).unwrap();
    assert!(z.len() > 1);
    let d = {
        let mut out = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut out);
            let f = z.by_index(0).unwrap();
            let name = f.name().unwrap().to_string();
            drop(f);
            let mut data = Vec::new();
            z.by_index(0).unwrap().read_to_end(&mut data).unwrap();
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(&data).unwrap();
            w.finish().unwrap();
        }
        out.into_inner()
    };
    assert!(!content_equal(&a, &d));
}

#[test]
fn gzip_compares_the_decompressed_stream() {
    let xml = xml_of(&fixture("three-stage-rocket-13.04.ork"));
    let a = gzip(xml.as_bytes());
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(xml.as_bytes()).unwrap();
    let b = e.finish().unwrap();
    assert_ne!(a, b);
    assert!(content_equal(&a, &b));
    let c = gzip(xml.replacen("<length>", "<length> ", 1).as_bytes());
    assert!(!content_equal(&a, &c));
}

#[test]
fn plain_xml_compares_bytes_and_containers_must_match() {
    let xml = fixture("simple-model-rocket-12.03-plainxml.ork");
    assert!(content_equal(&xml, &xml.clone()));
    let mut other = xml.clone();
    other.push(b'\n');
    assert!(!content_equal(&xml, &other));
    // Same XML in a different container is not "the same file".
    let gz = gzip(&xml);
    assert!(!content_equal(&xml, &gz));
    let zip = with_xml(
        &fixture("three-stage-rocket-13.04.ork"),
        &xml_of(&fixture("three-stage-rocket-13.04.ork")),
    );
    let gz2 = gzip(xml_of(&zip).as_bytes());
    assert!(!content_equal(&zip, &gz2));
}

#[test]
fn unreadable_files_fall_back_to_a_byte_comparison() {
    let a = fixture("simple-model-rocket-24.12.ork");
    let cut = &a[..a.len() / 2];
    assert!(content_equal(cut, cut)); // identical bytes
    assert!(!content_equal(cut, &a[..a.len() / 2 + 1]));
    assert!(!content_equal(cut, &a));
    assert!(!content_equal(b"", b"x"));
    assert!(content_equal(b"", b""));
    // A corrupted ZIP (CRC) next to a good one is simply "different".
    let mut bad = a.clone();
    let mid = bad.len() / 3;
    bad[mid] ^= 0xff;
    assert!(!content_equal(&a, &bad));
}

#[test]
fn inspector_content_equal() {
    let insp = OrkInspector::new();
    let a = fixture("simple-model-rocket-24.12.ork");
    let b = rewrite_zip(&a, true, true, 2003, |_, d| d);
    assert!(insp.content_equal("Razzo.ork", &a, &b));
    assert!(insp.content_equal("sub/RAZZO.ORK", &a, &b));
    // Non-.ork files: plain byte comparison, even when the bytes would be "equal" as ZIP content.
    assert!(!insp.content_equal("archivio.zip", &a, &b));
    assert!(insp.content_equal("note.txt", b"x", b"x"));
    assert!(!insp.content_equal("note.txt", b"x", b"y"));
}
