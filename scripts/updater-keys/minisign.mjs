// Formato delle chiavi dell'updater di Tauri 2 (minisign/rsign2) in JavaScript puro:
// solo moduli integrati di Node (node:crypto), nessun binario nativo, nessuna dipendenza.
//
// Riferimenti (sorgente reale):
//  - tauri-cli v2.12.6, crates/tauri-cli/src/helpers/updater_signature.rs (generate_key / save_keypair):
//      chiave pubblica e privata = base64( testo della "box" minisign )
//  - crate minisign 0.10: keypair.rs, secret_key.rs, public_key.rs, helpers.rs (raw_scrypt_params), constants.rs
//
//  Chiave privata (158 byte, poi base64 in una box):
//    "Ed" | "Sc" | "B2" | salt(32) | opslimit u64 LE | memlimit u64 LE | keynum(8) | sk(64) | chk(32)
//    sk = seme Ed25519(32) || chiave pubblica(32);  chk = BLAKE2b-256("Ed" || keynum || sk)
//    keynum||sk||chk sono cifrati in XOR con scrypt(password, salt, 104 byte)
//  Chiave pubblica (42 byte): "Ed" | keynum(8) | pk(32)
//  Box privata:  "untrusted comment: rsign encrypted secret key\n<base64>\n"
//  Box pubblica: "untrusted comment: minisign public key: <KEYNUM u64 LE in esadecimale a 16 cifre>\n<base64>\n"

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, verify, timingSafeEqual } from 'node:crypto';

// ------------------------------------------------------------------------------------------------
// BLAKE2b (RFC 7693), lunghezza dell'impronta variabile. Node espone solo blake2b512.
// ------------------------------------------------------------------------------------------------
const M64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

function compress(h, block, t, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = block.readBigUInt64LE(i * 8);
  const v = [...h, ...IV];
  v[12] ^= t & M64;
  v[13] ^= (t >> 64n) & M64;
  if (last) v[14] ^= M64;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & M64;
    v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & M64;
    v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & M64;
    v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & M64;
    v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b senza chiave, impronta di `outLen` byte (1..64). */
export function blake2b(data, outLen) {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('outLen deve essere tra 1 e 64');
  const input = Buffer.from(data);
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen); // parametri: lunghezza impronta, nessuna chiave, fanout/depth 1
  let offset = 0;
  while (input.length - offset > 128) {
    compress(h, input.subarray(offset, offset + 128), BigInt(offset + 128), false);
    offset += 128;
  }
  const last = Buffer.alloc(128);
  input.copy(last, 0, offset);
  compress(h, last, BigInt(input.length), true);
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out.subarray(0, outLen);
}

// ------------------------------------------------------------------------------------------------
// Costanti del crate minisign 0.10
// ------------------------------------------------------------------------------------------------
export const OPSLIMIT = 1_048_576n;
export const MEMLIMIT = 33_554_432n;
const MEMLIMIT_MAX = 1_073_741_824n;
const N_LOG2_MAX = 20;
const KDF_SALTBYTES = 32;
const KEYNUM_BYTES = 8;
const SECRETKEY_BYTES = 64;
const CHK_BYTES = 32;
const PASSWORD_MAXBYTES = 1024;
const SECRET_COMMENT = 'rsign encrypted secret key';
const COMMENT_PREFIX = 'untrusted comment: ';

/**
 * Traduzione di (memlimit, opslimit) in parametri scrypt N/r/p: è `raw_scrypt_params` del crate
 * minisign, a sua volta il `pickparams` di libsodium.
 */
export function scryptParams(memlimit, opslimit, nLog2Max = N_LOG2_MAX) {
  const ops = opslimit > 32768n ? opslimit : 32768n;
  const r = 8n;
  let nLog2 = 1n;
  let p;
  if (ops < memlimit / 32n) {
    p = 1n;
    const maxn = ops / (r * 4n);
    while (nLog2 < 63n) {
      if (1n << nLog2 > maxn / 2n) break;
      nLog2++;
    }
  } else {
    const maxn = memlimit / (r * 128n);
    while (nLog2 < 63n) {
      if (1n << nLog2 > maxn / 2n) break;
      nLog2++;
    }
    let maxrp = (ops / 4n) / (1n << nLog2);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  if (nLog2 > BigInt(nLog2Max)) throw new Error('parametri scrypt troppo alti');
  return { N: 2 ** Number(nLog2), r: Number(r), p: Number(p) };
}

function deriveStream(password, salt, memlimit, opslimit) {
  if (memlimit > MEMLIMIT_MAX) throw new Error('parametri scrypt troppo alti');
  const { N, r, p } = scryptParams(memlimit, opslimit);
  const pw = Buffer.from(password, 'utf8');
  if (pw.length > PASSWORD_MAXBYTES) throw new Error('la password non può superare 1024 byte');
  const maxmem = Math.max(64 * 1024 * 1024, 256 * N * r * p);
  return scryptSync(pw, salt, CHK_BYTES + SECRETKEY_BYTES + KEYNUM_BYTES, { N, r, p, maxmem });
}

function xorInto(buf, offset, stream, streamOffset, len) {
  for (let i = 0; i < len; i++) buf[offset + i] ^= stream[streamOffset + i];
}

const keyIdHex = (keynum) => keynum.readBigUInt64LE(0).toString(16).toUpperCase().padStart(16, '0');
const b64 = (buf) => Buffer.from(buf).toString('base64');
const fromB64 = (s) => Buffer.from(s.trim(), 'base64');

// ------------------------------------------------------------------------------------------------
// Generazione
// ------------------------------------------------------------------------------------------------

/**
 * Genera una coppia di chiavi identica nel formato a `tauri signer generate`.
 * Ritorna i CONTENUTI dei due file (base64 della box minisign) e l'identificativo della chiave.
 */
export function generateKeyPair(password, { rng = randomBytes } = {}) {
  if (typeof password !== 'string') throw new TypeError('password mancante');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const sk = Buffer.concat([seed, pk]); // formato libsodium: seme || chiave pubblica
  const keynum = rng(KEYNUM_BYTES);
  const salt = rng(KDF_SALTBYTES);
  const sigAlg = Buffer.from('Ed');

  const chk = blake2b(Buffer.concat([sigAlg, keynum, sk]), CHK_BYTES);
  const opslimit = Buffer.alloc(8);
  opslimit.writeBigUInt64LE(OPSLIMIT);
  const memlimit = Buffer.alloc(8);
  memlimit.writeBigUInt64LE(MEMLIMIT);

  const stream = deriveStream(password, salt, MEMLIMIT, OPSLIMIT);
  const enc = Buffer.concat([keynum, sk, chk]);
  xorInto(enc, 0, stream, 0, enc.length);

  const skBytes = Buffer.concat([sigAlg, Buffer.from('Sc'), Buffer.from('B2'), salt, opslimit, memlimit, enc]);
  const pkBytes = Buffer.concat([sigAlg, keynum, pk]);

  const skBox = `${COMMENT_PREFIX}${SECRET_COMMENT}\n${b64(skBytes)}\n`;
  const pkBox = `${COMMENT_PREFIX}minisign public key: ${keyIdHex(keynum)}\n${b64(pkBytes)}\n`;
  return {
    secretKey: b64(skBox), // contenuto del file della chiave privata
    publicKey: b64(pkBox), // contenuto del file .pub (e valore di UPDATER_PUBKEY)
    keyId: keyIdHex(keynum),
  };
}

// ------------------------------------------------------------------------------------------------
// Lettura / validazione
// ------------------------------------------------------------------------------------------------

function decodeBox(fileText, what) {
  let text;
  try {
    text = Buffer.from(String(fileText).trim(), 'base64').toString('utf8');
  } catch {
    throw new Error(`${what}: il file non è base64 valido`);
  }
  const lines = text.split('\n');
  if (!lines[0]?.startsWith(COMMENT_PREFIX) || !lines[1]) throw new Error(`${what}: formato minisign non riconosciuto`);
  return { comment: lines[0].slice(COMMENT_PREFIX.length), payload: fromB64(lines[1]) };
}

/** Legge una chiave pubblica (contenuto del file .pub). */
export function parsePublicKey(fileText) {
  const { comment, payload } = decodeBox(fileText, 'chiave pubblica');
  if (payload.length !== 42 || payload.subarray(0, 2).toString() !== 'Ed') throw new Error('chiave pubblica: lunghezza o algoritmo non validi');
  const keynum = payload.subarray(2, 10);
  const m = /^minisign public key: ([0-9A-F]{16})$/.exec(comment);
  if (!m || m[1] !== keyIdHex(keynum)) throw new Error('chiave pubblica: identificativo nel commento diverso da quello della chiave');
  return { keyId: keyIdHex(keynum), keynum, publicKey: payload.subarray(10, 42) };
}

/** Decifra una chiave privata (contenuto del file) con la password. Controlla il checksum BLAKE2b. */
export function decryptSecretKey(fileText, password) {
  const { payload } = decodeBox(fileText, 'chiave privata');
  if (payload.length !== 158) throw new Error('chiave privata: lunghezza non valida');
  if (payload.subarray(0, 2).toString() !== 'Ed') throw new Error('chiave privata: algoritmo di firma non supportato');
  if (payload.subarray(4, 6).toString() !== 'B2') throw new Error('chiave privata: algoritmo di checksum non supportato');
  const kdf = payload.subarray(2, 4).toString();
  if (kdf !== 'Sc') throw new Error(kdf === '\0\0' ? 'chiave privata: la chiave non è cifrata' : 'chiave privata: algoritmo di cifratura non supportato');
  const salt = payload.subarray(6, 38);
  const opslimit = payload.readBigUInt64LE(38);
  const memlimit = payload.readBigUInt64LE(46);
  const enc = Buffer.from(payload.subarray(54, 158));
  const stream = deriveStream(password, salt, memlimit, opslimit);
  xorInto(enc, 0, stream, 0, enc.length);
  const keynum = enc.subarray(0, 8);
  const sk = enc.subarray(8, 72);
  const chk = enc.subarray(72, 104);
  const expected = blake2b(Buffer.concat([payload.subarray(0, 2), keynum, sk]), CHK_BYTES);
  if (!timingSafeEqual(expected, chk)) throw new Error('password errata per questa chiave (o chiave danneggiata)');
  return { keyId: keyIdHex(keynum), keynum, seed: sk.subarray(0, 32), publicKey: sk.subarray(32, 64) };
}

// ------------------------------------------------------------------------------------------------
// Verifica di una firma (come `minisign-verify`, usato dall'updater di Tauri)
// ------------------------------------------------------------------------------------------------

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ed25519Verify = (pk, message, signature) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' }), signature);

/**
 * Verifica un file `.sig` prodotto da `tauri signer sign` (base64 di un .minisig) con la chiave
 * pubblica (contenuto del file .pub). Controlla identificativo, firma sui dati (BLAKE2b-512 prehash)
 * e firma globale sul commento fidato.
 */
export function verifySignature(sigFileText, data, publicKeyFileText) {
  const pub = parsePublicKey(publicKeyFileText);
  const text = Buffer.from(String(sigFileText).trim(), 'base64').toString('utf8');
  const lines = text.split('\n');
  if (!lines[0]?.startsWith(COMMENT_PREFIX) || !lines[2]?.startsWith('trusted comment: ')) throw new Error('firma: formato minisig non riconosciuto');
  const sigBytes = fromB64(lines[1]);
  if (sigBytes.length !== 74) throw new Error('firma: lunghezza non valida');
  const alg = sigBytes.subarray(0, 2).toString();
  if (alg !== 'ED') throw new Error('firma: solo le firme prehashed (ED) sono supportate');
  if (!sigBytes.subarray(2, 10).equals(pub.keynum)) throw new Error('firma: creata con un\'altra chiave (identificativo diverso)');
  const sig = sigBytes.subarray(10, 74);
  const trusted = Buffer.from(lines[2].slice('trusted comment: '.length), 'utf8');
  const globalSig = fromB64(lines[3] ?? '');
  const okData = ed25519Verify(pub.publicKey, blake2b(data, 64), sig);
  const okGlobal = globalSig.length === 64 && ed25519Verify(pub.publicKey, Buffer.concat([sig, trusted]), globalSig);
  return okData && okGlobal;
}

/** Controlla che seme e chiave pubblica della chiave privata decifrata siano coerenti. */
export function secretMatchesPublic(secret, publicKeyFileText) {
  const pub = parsePublicKey(publicKeyFileText);
  const derived = createPublicKey(createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: secret.seed.toString('base64url'), x: secret.publicKey.toString('base64url') }, format: 'jwk' }))
    .export({ format: 'jwk' }).x;
  return Buffer.from(derived, 'base64url').equals(secret.publicKey) && secret.publicKey.equals(pub.publicKey) && secret.keynum.equals(pub.keynum);
}
