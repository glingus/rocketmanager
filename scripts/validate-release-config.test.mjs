import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateAll, validateAnonKey, validateOrg, validatePubkey, validateReleasesRepo, validateSupabaseUrl,
} from './validate-release-config.mjs';
import { generateKeyPair } from './updater-keys/minisign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OFFICIAL_PUB = readFileSync(join(here, 'updater-keys/fixtures/official.key.pub'), 'utf8');
const jwt = (payload) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLWRpLXByb3ZhLWxvbmdh`;

test('UPDATER_PUBKEY: accetta le chiavi pubbliche vere (CLI ufficiale e nostro script), anche con spazi/a-capo finali', () => {
  assert.equal(validatePubkey(OFFICIAL_PUB), null);
  assert.equal(validatePubkey(`  ${OFFICIAL_PUB}\n`), null);
  assert.equal(validatePubkey(generateKeyPair('x').publicKey), null);
});

test('UPDATER_PUBKEY: rifiuta la chiave publishable di Supabase messa per errore (il caso reale) e altri valori', () => {
  const err = validatePubkey('sb_publishable_Dr84FTOT5rWwjBdfZ4o80w_8JMuNWGe');
  assert.match(err, /UPDATER_PUBKEY/);
  assert.match(err, /contenuto del file \.key\.pub/);
  assert.match(err, /publishable/);
  assert.ok(!err.includes('Dr84FTOT'), 'il valore non viene ripetuto');
  assert.match(validatePubkey(''), /manca/);
  assert.match(validatePubkey(undefined), /manca/);
  assert.match(validatePubkey('eyJhbGciOiJIUzI1NiJ9.e30.c2ln'), /JWT/);
  assert.match(validatePubkey('https://example.test/x'), /indirizzo web/);
  assert.match(validatePubkey('-----BEGIN PRIVATE KEY-----\nAAAA'), /a-capo/);
  // base64 valido ma di altro: non inizia con il commento minisign
  assert.match(validatePubkey(Buffer.from('ciao a tutti').toString('base64')), /non è una chiave pubblica dell'updater/);
  // la CHIAVE PRIVATA (stesso aspetto, stesso prefisso base64 diverso) non va accettata come pubblica
  assert.match(validatePubkey(readFileSync(join(here, 'updater-keys/fixtures/official.key'), 'utf8')), /non è una chiave pubblica/);
  // box giusta ma payload non di 42 byte / senza "Ed"
  const badLen = Buffer.from('untrusted comment: minisign public key: 0123456789ABCDEF\nQUJD\n').toString('base64');
  assert.match(validatePubkey(badLen), /UPDATER_PUBKEY: /);
  const noEd = Buffer.from(`untrusted comment: minisign public key: 0000000000000000\n${Buffer.alloc(42).toString('base64')}\n`).toString('base64');
  assert.match(validatePubkey(noEd), /UPDATER_PUBKEY: /);
});

test('SUPABASE_ANON_KEY: JWT anon e sb_publishable_ sì; backslash iniziale, spazi, segrete e service_role no', () => {
  assert.equal(validateAnonKey(jwt({ role: 'anon', iss: 'supabase' })), null);
  assert.equal(validateAnonKey(jwt({ iss: 'supabase' })), null);
  assert.equal(validateAnonKey('sb_publishable_Dr84FTOT5rWwjBdfZ4o80w_8JMuNWGe'), null);

  const bs = validateAnonKey('\\' + jwt({ role: 'anon' })); // il caso visto nei log: "\***"
  assert.match(bs, /backslash/);
  assert.ok(!bs.includes('eyJ'));
  assert.match(validateAnonKey('\\sb_publishable_Dr84FTOT5rWwjBdfZ4o80w_8JMuNWGe'), /backslash/);
  assert.match(validateAnonKey('"' + jwt({ role: 'anon' }) + '"'), /virgolette/);
  assert.match(validateAnonKey(jwt({ role: 'anon' }) + '\n'), /spazi o a-capo/);
  assert.match(validateAnonKey(' ' + jwt({ role: 'anon' })), /spazi o a-capo/);
  assert.match(validateAnonKey('sb_secret_abcdefghijklmnop'), /SEGRETA/);
  assert.match(validateAnonKey(jwt({ role: 'service_role' })), /service_role/);
  assert.match(validateAnonKey(jwt({ role: 'authenticated' })), /anon/);
  assert.match(validateAnonKey('eyJnonunjwt'), /JWT/);
  assert.match(validateAnonKey('qualcosa'), /eyJ.*sb_publishable_/);
  assert.match(validateAnonKey(''), /manca/);
});

test('SUPABASE_URL, PROJECTS_ORG, RELEASES_REPO', () => {
  assert.equal(validateSupabaseUrl('https://dgqwiduoyfwauwgeemfk.supabase.co'), null);
  assert.match(validateSupabaseUrl('https://dgqwiduoyfwauwgeemfk.supabase.co/'), /senza "\/"/);
  assert.match(validateSupabaseUrl('http://x.supabase.co'), /https/);
  assert.match(validateSupabaseUrl('https://evil.example/.supabase.co'), /https/);
  assert.match(validateSupabaseUrl(''), /manca/);
  assert.equal(validateOrg('rocketvisor-team'), null);
  for (const bad of ['', '-x', 'x-', 'a b', 'a/b', 'x'.repeat(40)]) assert.notEqual(validateOrg(bad), null, bad);
  assert.equal(validateReleasesRepo('team/rocketsync-releases'), null);
  for (const bad of ['', 'solo', 'a/b/c', 'a b/c']) assert.notEqual(validateReleasesRepo(bad), null, bad);
});

test('CLI: esce con 1 e annotazioni ::error:: senza ripetere i valori; con tutto valido esce con 0', () => {
  const good = {
    RELEASES_REPO: 'team/rel', UPDATER_PUBKEY: OFFICIAL_PUB, SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_ANON_KEY: jwt({ role: 'anon' }), PROJECTS_ORG: 'rocket-org',
  };
  const run = (env) => spawnSync(process.execPath, [join(here, 'validate-release-config.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = run(good);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run({ ...good, UPDATER_PUBKEY: 'sb_publishable_Dr84FTOT5rWwjBdfZ4o80w_8JMuNWGe', SUPABASE_ANON_KEY: '\\' + good.SUPABASE_ANON_KEY });
  assert.equal(bad.status, 1);
  assert.equal((bad.stdout.match(/^::error::/gm) ?? []).length, 2);
  assert.match(bad.stdout, /UPDATER_PUBKEY deve essere il contenuto del file \.key\.pub|UPDATER_PUBKEY non è/);
  assert.ok(!(bad.stdout + bad.stderr).includes('Dr84FTOT'), 'nessun valore nei log');
  assert.equal(validateAll({}).length, 5, 'con tutto mancante: cinque errori');
});

test('il workflow di release usa questo controllo, setup-node dopo pnpm e nessuna cache pnpm senza pnpm', () => {
  const wf = readFileSync(join(here, '..', '.github/workflows/release.yml'), 'utf8');
  assert.match(wf, /node scripts\/validate-release-config\.mjs/);
  // ogni `actions/setup-node` con `cache: pnpm` (o senza package-manager-cache: false) è preceduto da pnpm/action-setup nello stesso job
  for (const file of ['release.yml', 'ci.yml']) {
    const text = readFileSync(join(here, '..', '.github/workflows', file), 'utf8');
    const jobs = text.split(/\n  (?=[a-z][\w-]*:\n    (?:name|runs-on):)/);
    for (const job of jobs) {
      const steps = job.split(/\n      - /).slice(1);
      let pnpmReady = false;
      for (const s of steps) {
        if (s.startsWith('uses: pnpm/action-setup')) pnpmReady = true;
        if (s.startsWith('uses: actions/setup-node')) {
          const explicitNonPnpm = /cache: npm/.test(s) || /package-manager-cache: false/.test(s);
          assert.ok(pnpmReady || explicitNonPnpm, `${file}: setup-node prima di pnpm/action-setup senza disattivare la cache automatica:\n${s}`);
        }
      }
    }
  }
});
