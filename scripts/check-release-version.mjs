#!/usr/bin/env node
// Controlla che il tag della release (es. v0.2.0) coincida con le versioni dichiarate nei file:
//   apps/desktop/src-tauri/tauri.conf.json, Cargo.toml (workspace.package) e apps/desktop/package.json.
//   node scripts/check-release-version.mjs v0.2.0
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function tagVersion(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? '');
  if (!m) throw new Error(`Il tag deve avere la forma vMAGGIORE.MINORE.PATCH (ricevuto: ${tag})`);
  return m[1];
}

export function workspaceVersion(cargoToml) {
  const section = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/.exec(cargoToml);
  const m = section && /^\s*version\s*=\s*"([^"]+)"/m.exec(section[1]);
  if (!m) throw new Error('Versione non trovata in [workspace.package] di Cargo.toml');
  return m[1];
}

export function collectVersions(root = ROOT) {
  const read = (...p) => readFileSync(join(root, ...p), 'utf8');
  return {
    'Cargo.toml (workspace.package)': workspaceVersion(read('Cargo.toml')),
    'apps/desktop/src-tauri/tauri.conf.json': JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).version,
    'apps/desktop/package.json': JSON.parse(read('apps/desktop/package.json')).version,
  };
}

export function mismatches(tag, versions) {
  const want = tagVersion(tag);
  return Object.entries(versions).filter(([, v]) => v !== want).map(([file, v]) => `${file}: ${v ?? '(assente)'} (atteso ${want})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const bad = mismatches(process.argv[2], collectVersions());
    if (bad.length) {
      console.error('Le versioni non coincidono con il tag:\n  ' + bad.join('\n  '));
      process.exit(1);
    }
    console.log(`Versione ${tagVersion(process.argv[2])}: coerente in tutti i file.`);
  } catch (e) {
    console.error(`Errore: ${e.message}`);
    process.exit(1);
  }
}
