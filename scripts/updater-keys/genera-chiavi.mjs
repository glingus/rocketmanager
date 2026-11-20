#!/usr/bin/env node
// Genera la coppia di chiavi dell'updater di Rocket Sync, con lo stesso formato di
// `tauri signer generate` (minisign/rsign2), senza usare la CLI di Tauri.
//
// Perché esiste: su Windows 11 il "Controllo intelligente delle app" può bloccare il modulo nativo
// della CLI di Tauri (cli.win32-x64-msvc.node). Questo script è JavaScript puro: Node 20 o più
// recente, nessuna dipendenza, nessun binario nativo.
//
//   node scripts/updater-keys/genera-chiavi.mjs -w %USERPROFILE%\.tauri\rocketsync.key
//
// Crea <percorso> (chiave PRIVATA, cifrata con la password) e <percorso>.pub (chiave PUBBLICA).
// La password si digita due volte con input nascosto, oppure si legge da una variabile d'ambiente
// con --password-env NOME. Non sovrascrive file esistenti senza --force.
//
// Il formato è verificato contro la CLI ufficiale (tauri-cli 2.12.6) e contro `minisign-verify`,
// il crate usato dall'updater: vedi scripts/updater-keys/README.md e i test (genera-chiavi.test.mjs).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { decryptSecretKey, generateKeyPair, parsePublicKey, secretMatchesPublic } from './minisign.mjs';

const AIUTO = `Uso:
  node scripts/updater-keys/genera-chiavi.mjs -w <percorso> [opzioni]     genera la coppia di chiavi
  node scripts/updater-keys/genera-chiavi.mjs --check <percorso> [opzioni] controlla una chiave esistente

Opzioni:
  -w, --write-keys <percorso>  scrive la chiave privata in <percorso> e la pubblica in <percorso>.pub
                               (senza questa opzione le chiavi vengono stampate a video)
  --password-env <NOME>        legge la password dalla variabile d'ambiente NOME (invece di chiederla)
  -p, --password <testo>       password sulla riga di comando (sconsigliato: resta nella cronologia)
  --no-password                chiave senza password (sconsigliato)
  -f, --force                  sovrascrive i file se esistono già
  --check <percorso>           decifra <percorso> con la password e verifica che corrisponda a <percorso>.pub
  -h, --help                   questo aiuto
`;

export function parseArgs(argv) {
  const o = { force: false, noPassword: false };
  const need = (i, name) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new UsageError(`Manca il valore di ${name}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-w' || a === '--write-keys') o.write = need(i++, a);
    else if (a === '--check') o.check = need(i++, a);
    else if (a === '--password-env') o.passwordEnv = need(i++, a);
    else if (a === '-p' || a === '--password') o.password = argv[++i] ?? (() => { throw new UsageError(`Manca il valore di ${a}`); })();
    else if (a === '--no-password') o.noPassword = true;
    else if (a === '-f' || a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`Opzione sconosciuta: ${a}`);
  }
  return o;
}

export class UsageError extends Error {}

// ---- input della password -------------------------------------------------------------------------

let lineIterator = null;
function nextPipedLine() {
  lineIterator ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  return lineIterator.next().then((r) => (r.done ? '' : r.value));
}

/** Legge una riga senza mostrarla (terminale interattivo), oppure da stdin se non è un terminale. */
export async function askHidden(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    output.write(prompt + '\n');
    return await nextPipedLine();
  }
  output.write(prompt);
  return await new Promise((resolvePromise, reject) => {
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish();
          resolvePromise(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('Operazione annullata'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

async function getPassword(opts, { confirm }) {
  if (opts.noPassword) return '';
  if (opts.passwordEnv) {
    const v = process.env[opts.passwordEnv];
    if (v === undefined) throw new Error(`La variabile d'ambiente ${opts.passwordEnv} non è impostata.`);
    return v;
  }
  if (opts.password !== undefined) return opts.password;
  const first = await askHidden('Password della chiave privata: ');
  if (confirm) {
    const second = await askHidden('Ripeti la password: ');
    if (first !== second) throw new Error('Le due password non coincidono.');
  }
  if (first === '') throw new Error('La password è vuota. Scegline una (oppure usa --no-password, sconsigliato).');
  return first;
}

// ---- comandi -----------------------------------------------------------------------------------------

function scriviChiavePrivata(path, contenuto) {
  writeFileSync(path, contenuto, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // su un file preesistente il mode di writeFileSync non si applica
  } catch {
    // Windows: i permessi POSIX non esistono, si usano le ACL della cartella dell'utente
  }
}

export async function genera(opts, out = console) {
  const sk = opts.write ? resolve(opts.write) : null;
  if (sk && !opts.force) {
    for (const p of [sk, `${sk}.pub`]) {
      if (existsSync(p)) {
        throw new Error(`Generazione annullata: ${p} esiste già.\nPer sovrascrivere la coppia di chiavi esistente aggiungi --force (la vecchia chiave andrà persa per sempre).`);
      }
    }
  }
  const password = await getPassword(opts, { confirm: true });
  out.log('Derivazione della chiave dalla password (scrypt, qualche secondo)...');
  const keys = generateKeyPair(password);

  if (sk) {
    mkdirSync(dirname(sk), { recursive: true });
    scriviChiavePrivata(sk, keys.secretKey);
    writeFileSync(`${sk}.pub`, keys.publicKey);
    out.log(`
Coppia di chiavi generata (identificativo ${keys.keyId}).
  Privata: ${sk}   (TIENILA SEGRETA)
  Pubblica: ${sk}.pub
`);
  } else {
    out.log(`
Coppia di chiavi generata (identificativo ${keys.keyId}).

Privata (TIENILA SEGRETA):
${keys.secretKey}

Pubblica:
${keys.publicKey}
`);
  }
  out.log(`Dove vanno (docs/installazione.md, sezione 8.2):
  - variabile  UPDATER_PUBKEY                       = contenuto di ${sk ? `${sk}.pub` : 'la chiave pubblica'} (una sola riga)
  - segreto    TAURI_SIGNING_PRIVATE_KEY            = contenuto di ${sk ?? 'la chiave privata'}
  - segreto    TAURI_SIGNING_PRIVATE_KEY_PASSWORD   = la password appena scelta

ATTENZIONE: se perdi la chiave privata o la password non potrai più pubblicare aggiornamenti
accettati dalle app già installate. Conservale in un gestore di password.`);
  return keys;
}

export async function controlla(opts, out = console) {
  const sk = resolve(opts.check);
  const pk = `${sk}.pub`;
  for (const p of [sk, pk]) if (!existsSync(p)) throw new Error(`File non trovato: ${p}`);
  const password = await getPassword(opts, { confirm: false });
  const secret = decryptSecretKey(readFileSync(sk, 'utf8'), password);
  const pub = parsePublicKey(readFileSync(pk, 'utf8'));
  if (!secretMatchesPublic(secret, readFileSync(pk, 'utf8'))) {
    throw new Error(`La chiave privata (${secret.keyId}) NON corrisponde alla pubblica (${pub.keyId}).`);
  }
  out.log(`OK: la chiave privata si decifra con la password e corrisponde alla pubblica (identificativo ${pub.keyId}).`);
}

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.write && !opts.check && argv.length === 0)) {
    out.log(AIUTO);
    return 0;
  }
  if (opts.check) await controlla(opts, out);
  else await genera(opts, out);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Errore: ${e.message}`);
      if (e instanceof UsageError) console.error('\n' + AIUTO);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
