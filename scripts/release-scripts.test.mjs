// Test (node --test scripts/) degli script di release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLatestJson, PLATFORMS } from './make-latest-json.mjs';
import { tagVersion, workspaceVersion, mismatches, collectVersions } from './check-release-version.mjs';

const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVT\n';

test('latest.json ha il formato dell\'updater di Tauri 2', () => {
  const j = buildLatestJson({
    version: 'v0.2.0', repo: 'team/rocketsync-releases', signature: SIG,
    notes: '  Pinne nuove  ', pubDate: '2026-11-18T10:00:00Z',
  });
  assert.equal(j.version, '0.2.0');
  assert.equal(j.notes, 'Pinne nuove');
  assert.equal(j.pub_date, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(Object.keys(j.platforms), PLATFORMS);
  for (const p of Object.values(j.platforms)) {
    assert.equal(p.url, 'https://github.com/team/rocketsync-releases/releases/download/v0.2.0/RocketSync-setup.exe');
    assert.equal(p.signature, SIG.trim());
  }
});

test('rifiuta dati non validi', () => {
  const ok = { version: '1.0.0', repo: 'a/b', signature: SIG };
  assert.throws(() => buildLatestJson({ ...ok, version: 'uno' }), /Versione/);
  assert.throws(() => buildLatestJson({ ...ok, repo: 'solo-nome' }), /Repository/);
  assert.throws(() => buildLatestJson({ ...ok, repo: 'a/b/../c' }), /Repository/);
  assert.throws(() => buildLatestJson({ ...ok, signature: '  \n' }), /Firma/);
  assert.throws(() => buildLatestJson({ ...ok, asset: 'a b.exe' }), /Nome del file/);
  assert.throws(() => buildLatestJson({ ...ok, tag: 'v1/../x' }), /Tag/);
  assert.throws(() => buildLatestJson({ ...ok, pubDate: 'ieri' }), /Data/);
});

test('la CLI scrive il file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-latest-'));
  writeFileSync(join(dir, 'x.sig'), SIG);
  const out = join(dir, 'latest.json');
  const r = spawnSync(process.execPath, ['scripts/make-latest-json.mjs', '--version', '0.1.0', '--repo', 'a/b', '--sig', join(dir, 'x.sig'), '--notes', 'Prima', '--out', out, '--pub-date', '2026-01-01T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.platforms['windows-x86_64'].url, 'https://github.com/a/b/releases/download/v0.1.0/RocketSync-setup.exe');
  const bad = spawnSync(process.execPath, ['scripts/make-latest-json.mjs', '--version', '0.1.0'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Manca --repo/);
});

test('il tag e le versioni nei file coincidono', () => {
  assert.equal(tagVersion('v1.2.3'), '1.2.3');
  assert.equal(tagVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
  for (const bad of ['1.2.3', 'v1.2', 'vx', '', undefined, 'v1.2.3 ']) assert.throws(() => tagVersion(bad));
  assert.equal(workspaceVersion('[workspace]\nmembers=[]\n\n[workspace.package]\nversion = "0.3.1"\nedition = "2021"\n\n[profile.release]\n'), '0.3.1');
  assert.throws(() => workspaceVersion('[package]\nversion = "1.0.0"\n'));
  assert.deepEqual(mismatches('v0.1.0', { a: '0.1.0', b: '0.1.0' }), []);
  assert.equal(mismatches('v0.2.0', { a: '0.1.0', b: '0.2.0' }).length, 1);
});

test('le versioni del repository sono leggibili e coerenti tra loro', () => {
  const v = collectVersions();
  assert.equal(Object.keys(v).length, 3);
  assert.equal(new Set(Object.values(v)).size, 1, JSON.stringify(v));
});
