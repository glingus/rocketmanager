#!/usr/bin/env node
// Genera latest.json nel formato "static JSON" dell'updater di Tauri 2.
// https://v2.tauri.app/plugin/updater/#static-json-file
//
//   node scripts/make-latest-json.mjs --version 0.2.0 --repo owner/releases --tag v0.2.0 \
//        --sig RocketSync-setup.exe.sig [--asset RocketSync-setup.exe] [--notes "testo"] \
//        [--notes-file note.md] [--pub-date 2026-11-18T10:00:00Z] [--out latest.json]
//
// Nessuna dipendenza. `buildLatestJson` è esportata per i test.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ASSET = /^[A-Za-z0-9._-]+$/;

/** Piattaforme dell'updater coperte dall'unico installer NSIS x64. */
export const PLATFORMS = ['windows-x86_64', 'windows-x86_64-nsis'];

export function buildLatestJson({ version, repo, tag, signature, asset = 'RocketSync-setup.exe', notes = '', pubDate }) {
  const v = String(version).replace(/^v/, '');
  if (!SEMVER.test(v)) throw new Error(`Versione non valida: ${version}`);
  if (!REPO.test(repo ?? '')) throw new Error(`Repository non valido (atteso owner/nome): ${repo}`);
  if (!ASSET.test(asset)) throw new Error(`Nome del file non valido: ${asset}`);
  const t = tag ?? `v${v}`;
  if (!/^[A-Za-z0-9._-]+$/.test(t)) throw new Error(`Tag non valido: ${t}`);
  const sig = String(signature ?? '').trim();
  if (!sig) throw new Error('Firma (.sig) mancante o vuota');
  if (/\s/.test(sig) && !/^[A-Za-z0-9+/=\s]+$/.test(sig)) throw new Error('La firma contiene caratteri inattesi');
  const date = pubDate ? new Date(pubDate) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`Data non valida: ${pubDate}`);
  const url = `https://github.com/${repo}/releases/download/${t}/${asset}`;
  const platforms = {};
  for (const p of PLATFORMS) platforms[p] = { signature: sig, url };
  return { version: v, notes: String(notes).trim(), pub_date: date.toISOString(), platforms };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Argomento inatteso: ${a}`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`Manca il valore di --${key}`);
    out[key] = val;
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const k of ['version', 'repo', 'sig']) if (!a[k]) throw new Error(`Manca --${k}`);
  const notes = a['notes-file'] ? readFileSync(a['notes-file'], 'utf8') : (a.notes ?? '');
  const json = buildLatestJson({
    version: a.version,
    repo: a.repo,
    tag: a.tag,
    signature: readFileSync(a.sig, 'utf8'),
    asset: a.asset,
    notes,
    pubDate: a['pub-date'],
  });
  const text = JSON.stringify(json, null, 2) + '\n';
  if (a.out) writeFileSync(a.out, text);
  else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (e) {
    console.error(`Errore: ${e.message}`);
    process.exit(1);
  }
}
