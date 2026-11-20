// node --test scripts/updater-keys/*.test.mjs
//
// Compatibilità con la CLI ufficiale di Tauri (tauri-cli 2.12.6):
//  - vettori generati dalla CLI ufficiale (fixtures/) decifrati dal nostro codice;
//  - firme prodotte dalla CLI ufficiale con una chiave del nostro script, verificate con la nostra
//    chiave pubblica;
//  - se la CLI ufficiale è disponibile (TAURI_CLI, oppure apps/desktop/node_modules/.bin/tauri) anche
//    prove "dal vivo" in entrambe le direzioni. Con REQUIRE_TAURI_CLI=1 la sua assenza è un errore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  blake2b, decryptSecretKey, generateKeyPair, MEMLIMIT, OPSLIMIT, parsePublicKey, scryptParams,
  secretMatchesPublic, verifySignature,
} from './minisign.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const fx = (n) => readFileSync(join(here, 'fixtures', n));
const fxs = (n) => fx(n).toString('utf8');
const SCRIPT = join(here, 'genera-chiavi.mjs');
const OFFICIAL_PW = 'rocketsync-test-password';
const SCRIPT_PW = 'rocketsync-test-password-2';

const cliCandidates = [process.env.TAURI_CLI, join(root, 'apps/desktop/node_modules/.bin/tauri')].filter(Boolean);
const TAURI = cliCandidates.find((p) => existsSync(p));
const live = (name, fn) =>
  test(name, { skip: !TAURI && process.env.REQUIRE_TAURI_CLI !== '1' ? 'CLI ufficiale di Tauri non trovata (pnpm install)' : false }, async (t) => {
    assert.ok(TAURI, 'REQUIRE_TAURI_CLI=1 ma la CLI ufficiale di Tauri non è installata');
    await fn(t);
  });
// `CI` è letta dalla CLI come booleano (--ci): se impostata a stringa vuota fa fallire clap.
const cliEnv = () => {
  const e = { ...process.env };
  delete e.CI;
  return e;
};
const tauri = (...args) => spawnSync(TAURI, args, { encoding: 'utf8', env: cliEnv() });

// ---- BLAKE2b ----------------------------------------------------------------------------------------

test('BLAKE2b-512 coincide con quello di OpenSSL (Node) per molte lunghezze', () => {
  for (const n of [0, 1, 2, 63, 64, 65, 127, 128, 129, 255, 256, 257, 1000, 4096]) {
    const data = Buffer.alloc(n, n % 251);
    const want = createHash('blake2b512').update(data).digest('hex');
    assert.equal(blake2b(data, 64).toString('hex'), want, `lunghezza ${n}`);
  }
});

test('BLAKE2b-256: vettori noti (RFC 7693 e implementazioni di riferimento)', () => {
  assert.equal(blake2b(Buffer.from('abc'), 32).toString('hex'), 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319');
  assert.equal(blake2b(Buffer.alloc(0), 32).toString('hex'), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
  assert.equal(
    blake2b(Buffer.from('abc'), 64).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
  assert.throws(() => blake2b(Buffer.alloc(1), 0));
  assert.throws(() => blake2b(Buffer.alloc(1), 65));
});

// ---- scrypt (pickparams di libsodium) -------------------------------------------------------------------

test('parametri scrypt: valori del crate minisign e di libsodium', () => {
  assert.deepEqual(scryptParams(MEMLIMIT, OPSLIMIT), { N: 32768, r: 8, p: 1 }); // quelli delle chiavi Tauri
  assert.deepEqual(scryptParams(16777216n, 524288n), { N: 16384, r: 8, p: 1 }); // libsodium "interactive"
  assert.deepEqual(scryptParams(1073741824n, 33554432n), { N: 1048576, r: 8, p: 1 }); // libsodium "sensitive"
  assert.throws(() => scryptParams(1n << 40n, 1n << 50n), /troppo alti/);
});

// ---- formato -----------------------------------------------------------------------------------------

test('le chiavi generate hanno esattamente il formato di `tauri signer generate`', () => {
  const k = generateKeyPair('una-password');
  const official = { sk: fxs('official.key'), pk: fxs('official.key.pub') };
  assert.equal(k.secretKey.length, official.sk.length); // 348 caratteri
  assert.equal(k.publicKey.length, official.pk.length); // 152 caratteri
  assert.match(k.secretKey, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(!k.secretKey.includes('\n') && !k.publicKey.includes('\n'), 'nessun a-capo nei file');

  const skText = Buffer.from(k.secretKey, 'base64').toString('utf8');
  const [c1, body, rest] = skText.split('\n');
  assert.equal(c1, 'untrusted comment: rsign encrypted secret key');
  assert.equal(rest, '');
  const raw = Buffer.from(body, 'base64');
  assert.equal(raw.length, 158);
  assert.equal(raw.subarray(0, 6).toString(), 'EdScB2');
  assert.equal(raw.readBigUInt64LE(38), 1048576n); // opslimit
  assert.equal(raw.readBigUInt64LE(46), 33554432n); // memlimit

  const pkText = Buffer.from(k.publicKey, 'base64').toString('utf8');
  assert.match(pkText, /^untrusted comment: minisign public key: [0-9A-F]{16}\n[A-Za-z0-9+/=]{56}\n$/);
  const pubRaw = Buffer.from(pkText.split('\n')[1], 'base64');
  assert.equal(pubRaw.length, 42);
  assert.equal(pubRaw.subarray(0, 2).toString(), 'Ed');
  // l'identificativo nel commento è il keynum letto come u64 little-endian, in esadecimale maiuscolo
  assert.equal(pkText.split('\n')[0].split(': ').pop(), pubRaw.subarray(2, 10).readBigUInt64LE().toString(16).toUpperCase().padStart(16, '0'));
  assert.equal(parsePublicKey(k.publicKey).keyId, k.keyId);

  // stessa struttura delle chiavi ufficiali (stesso commento, stessi parametri, stessa lunghezza)
  const offRaw = Buffer.from(Buffer.from(official.sk, 'base64').toString('utf8').split('\n')[1], 'base64');
  assert.equal(offRaw.subarray(0, 6).toString(), 'EdScB2');
  assert.equal(offRaw.readBigUInt64LE(38), 1048576n);
  assert.equal(offRaw.readBigUInt64LE(46), 33554432n);
  assert.equal(offRaw.length, raw.length);
});

test('ogni generazione usa sale, identificativo e chiavi nuovi', () => {
  const a = generateKeyPair('x');
  const b = generateKeyPair('x');
  assert.notEqual(a.secretKey, b.secretKey);
  assert.notEqual(a.keyId, b.keyId);
  assert.notEqual(a.publicKey, b.publicKey);
});

test('cifratura: la chiave privata non contiene in chiaro keynum, chiave segreta o checksum', () => {
  const k = generateKeyPair('segreto');
  const secret = decryptSecretKey(k.secretKey, 'segreto');
  const raw = Buffer.from(Buffer.from(k.secretKey, 'base64').toString('utf8').split('\n')[1], 'base64');
  assert.ok(!raw.includes(secret.seed), 'il seme non deve comparire in chiaro');
  assert.ok(!raw.includes(secret.keynum), 'il keynum non deve comparire in chiaro');
  assert.ok(!raw.includes(secret.publicKey));
});

test('andata e ritorno: decifratura con la password giusta, errore con quella sbagliata o file alterato', () => {
  for (const pw of ['una-password', 'àèìòù €uro', 'x'.repeat(1024), '']) {
    const k = generateKeyPair(pw);
    const s = decryptSecretKey(k.secretKey, pw);
    assert.equal(s.keyId, k.keyId);
    assert.ok(secretMatchesPublic(s, k.publicKey));
  }
  const k = generateKeyPair('giusta');
  assert.throws(() => decryptSecretKey(k.secretKey, 'sbagliata'), /password errata/);
  assert.throws(() => decryptSecretKey(k.secretKey, ''), /password errata/);
  assert.throws(() => generateKeyPair('x'.repeat(1025)), /1024/);
  // un byte alterato nella parte cifrata: il checksum non torna
  const text = Buffer.from(k.secretKey, 'base64').toString('utf8').split('\n');
  const raw = Buffer.from(text[1], 'base64');
  raw[100] ^= 1;
  const broken = Buffer.from(`${text[0]}\n${raw.toString('base64')}\n`).toString('base64');
  assert.throws(() => decryptSecretKey(broken, 'giusta'), /password errata/);
  assert.throws(() => decryptSecretKey('non base64 valido !!', 'x'), /formato/);
  assert.throws(() => decryptSecretKey(k.publicKey, 'x'), /formato|lunghezza/);
  assert.throws(() => parsePublicKey(k.secretKey), /pubblica/);
});

// ---- compatibilità con la CLI ufficiale (vettori salvati) ---------------------------------------------------

test('chiave generata dalla CLI ufficiale: il nostro codice la decifra e la abbina alla pubblica', () => {
  const s = decryptSecretKey(fxs('official.key'), OFFICIAL_PW);
  assert.equal(s.keyId, 'E45001DF87D95141');
  assert.ok(secretMatchesPublic(s, fxs('official.key.pub')));
  assert.equal(parsePublicKey(fxs('official.key.pub')).keyId, 'E45001DF87D95141');
  assert.throws(() => decryptSecretKey(fxs('official.key'), 'sbagliata'), /password errata/);
  // una chiave ufficiale non si abbina alla pubblica di un'altra coppia
  assert.ok(!secretMatchesPublic(s, fxs('script.key.pub')));
});

test('firma della CLI ufficiale con la chiave ufficiale: si verifica; dati o chiave diversi no', () => {
  const sig = fxs('sample.txt.official.sig');
  assert.equal(verifySignature(sig, fx('sample.txt'), fxs('official.key.pub')), true);
  assert.equal(verifySignature(sig, Buffer.from('altro contenuto'), fxs('official.key.pub')), false);
  assert.throws(() => verifySignature(sig, fx('sample.txt'), fxs('script.key.pub')), /altra chiave/);
});

test('chiave generata dal NOSTRO script, firmata dalla CLI ufficiale: la firma si verifica con la nostra pubblica', () => {
  assert.equal(verifySignature(fxs('sample.txt.script.sig'), fx('sample.txt'), fxs('script.key.pub')), true);
  assert.equal(verifySignature(fxs('sample.txt.script.sig'), Buffer.from('x'), fxs('script.key.pub')), false);
  const s = decryptSecretKey(fxs('script.key'), SCRIPT_PW);
  assert.ok(secretMatchesPublic(s, fxs('script.key.pub')));
  // alterare il commento fidato invalida la firma globale
  const text = Buffer.from(fxs('sample.txt.script.sig'), 'base64').toString('utf8').replace('file:sample.txt', 'file:altro.txt');
  assert.equal(verifySignature(Buffer.from(text).toString('base64'), fx('sample.txt'), fxs('script.key.pub')), false);
});

// ---- prove dal vivo con la CLI ufficiale ---------------------------------------------------------------------------

live('CLI ufficiale: `signer sign` con una chiave del nostro script firma, e la firma si verifica', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const k = generateKeyPair('pw-live');
  const data = Buffer.from(`contenuto ${Math.random()}\n`);
  const file = join(dir, 'dati.bin');
  writeFileSync(file, data);
  const r = tauri('signer', 'sign', '-k', k.secretKey, '-p', 'pw-live', file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const sig = readFileSync(`${file}.sig`, 'utf8');
  assert.equal(verifySignature(sig, data, k.publicKey), true);
  // con la password sbagliata la CLI ufficiale rifiuta la chiave
  const bad = tauri('signer', 'sign', '-k', k.secretKey, '-p', 'sbagliata', file);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /password/i);
});

live('CLI ufficiale: chiave generata dalla CLI con una password nota -> il nostro codice la decifra', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const key = join(dir, 'ufficiale.key');
  const r = tauri('signer', 'generate', '-w', key, '-p', 'pw-ufficiale');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = decryptSecretKey(readFileSync(key, 'utf8'), 'pw-ufficiale');
  assert.ok(secretMatchesPublic(s, readFileSync(`${key}.pub`, 'utf8')));
  assert.equal(readFileSync(key, 'utf8').length, generateKeyPair('x').secretKey.length);
});

live('CLI ufficiale: i file scritti dal nostro script (-w) si usano con `signer sign -f`', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const key = join(dir, 'sub', 'rocketsync.key');
  const g = spawnSync(process.execPath, [SCRIPT, '-w', key, '--password-env', 'RS_PW'], { encoding: 'utf8', env: { ...process.env, RS_PW: 'pw-script' } });
  assert.equal(g.status, 0, g.stderr);
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'ciao');
  const r = tauri('signer', 'sign', '-f', key, '-p', 'pw-script', file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(verifySignature(readFileSync(`${file}.sig`, 'utf8'), Buffer.from('ciao'), readFileSync(`${key}.pub`, 'utf8')), true);
});

// ---- lo script (CLI) ------------------------------------------------------------------------------------------------

const run = (args, { env = {}, input } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });

test('script: -w crea <percorso> e <percorso>.pub (cartelle comprese) con password da variabile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const key = join(dir, 'a', 'b', 'rocketsync.key');
  const r = run(['-w', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'pw1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(key) && existsSync(`${key}.pub`));
  assert.match(r.stdout, /UPDATER_PUBKEY/);
  assert.match(r.stdout, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.ok(!r.stdout.includes('pw1'), 'la password non viene mai stampata');
  if (process.platform !== 'win32') assert.equal(statSync(key).mode & 0o777, 0o600, 'chiave privata leggibile solo dall\'utente');
  const s = decryptSecretKey(readFileSync(key, 'utf8'), 'pw1');
  assert.ok(secretMatchesPublic(s, readFileSync(`${key}.pub`, 'utf8')));
  assert.ok(!readFileSync(`${key}.pub`, 'utf8').endsWith('\n'), 'come la CLI ufficiale: nessun a-capo finale');
});

test('script: rifiuta di sovrascrivere senza --force, e con --force sostituisce entrambi i file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const key = join(dir, 'k.key');
  assert.equal(run(['-w', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'a' } }).status, 0);
  const before = readFileSync(key, 'utf8');
  const again = run(['-w', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'a' } });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /esiste già/);
  assert.match(again.stderr, /--force/);
  assert.equal(readFileSync(key, 'utf8'), before, 'file intatto');
  // anche solo la .pub esistente blocca
  const dir2 = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  writeFileSync(join(dir2, 'x.key.pub'), 'qualcosa');
  assert.equal(run(['-w', join(dir2, 'x.key'), '--password-env', 'RS_PW'], { env: { RS_PW: 'a' } }).status, 1);
  const forced = run(['-w', key, '--password-env', 'RS_PW', '--force'], { env: { RS_PW: 'b' } });
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(readFileSync(key, 'utf8'), before);
  decryptSecretKey(readFileSync(key, 'utf8'), 'b');
});

test('script: password digitata due volte (stdin non interattivo): coincidenti sì, diverse o vuota no', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const ok = run(['-w', join(dir, 'ok.key')], { input: 'stessa\nstessa\n' });
  assert.equal(ok.status, 0, ok.stderr);
  decryptSecretKey(readFileSync(join(dir, 'ok.key'), 'utf8'), 'stessa');
  const diverse = run(['-w', join(dir, 'd.key')], { input: 'una\naltra\n' });
  assert.equal(diverse.status, 1);
  assert.match(diverse.stderr, /non coincidono/);
  assert.ok(!existsSync(join(dir, 'd.key')), 'nessun file scritto');
  const vuota = run(['-w', join(dir, 'v.key')], { input: '\n\n' });
  assert.equal(vuota.status, 1);
  assert.match(vuota.stderr, /vuota/);
  assert.ok(!existsSync(join(dir, 'v.key')));
  const noPw = run(['-w', join(dir, 'n.key'), '--no-password']);
  assert.equal(noPw.status, 0, noPw.stderr);
  decryptSecretKey(readFileSync(join(dir, 'n.key'), 'utf8'), '');
});

test('script: senza -w stampa le chiavi; --check verifica coppia e password; opzioni errate -> codice 2', () => {
  const out = run(['--password-env', 'RS_PW'], { env: { RS_PW: 'p' } });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.split('\n');
  const sk = lines[lines.indexOf('Privata (TIENILA SEGRETA):') + 1];
  const pk = lines[lines.indexOf('Pubblica:') + 1];
  assert.ok(secretMatchesPublic(decryptSecretKey(sk, 'p'), pk));

  const dir = mkdtempSync(join(tmpdir(), 'rs-keys-'));
  const key = join(dir, 'c.key');
  run(['-w', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'p' } });
  const good = run(['--check', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'p' } });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^OK: .*identificativo [0-9A-F]{16}/m);
  const bad = run(['--check', key, '--password-env', 'RS_PW'], { env: { RS_PW: 'x' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /password errata/);
  const other = join(dir, 'd.key');
  run(['-w', other, '--password-env', 'RS_PW'], { env: { RS_PW: 'p' } });
  writeFileSync(`${other}.pub`, readFileSync(`${key}.pub`)); // pubblica di un'altra coppia
  const mism = run(['--check', other, '--password-env', 'RS_PW'], { env: { RS_PW: 'p' } });
  assert.equal(mism.status, 1);
  assert.match(mism.stderr, /NON corrisponde/);
  assert.equal(run(['--check', join(dir, 'manca.key'), '--password-env', 'RS_PW'], { env: { RS_PW: 'p' } }).status, 1);

  const usage = run(['--boh']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Opzione sconosciuta/);
  assert.equal(run(['-w']).status, 2);
  assert.equal(run(['-w', join(dir, 'e.key'), '--password-env', 'NON_IMPOSTATA_XYZ']).status, 1);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Uso:/);
});

test('lo script non ha dipendenze: importa solo moduli integrati di Node', () => {
  for (const f of ['genera-chiavi.mjs', 'minisign.mjs']) {
    const src = readFileSync(join(here, f), 'utf8');
    const imports = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(i.startsWith('node:') || i.startsWith('./'), `${f} importa ${i}`);
  }
});
