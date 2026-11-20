#!/usr/bin/env node
// Controlla le variabili della release PRIMA di costruire l'installer, con messaggi in italiano.
// Legge dall'ambiente: RELEASES_REPO, UPDATER_PUBKEY, SUPABASE_URL, SUPABASE_ANON_KEY, PROJECTS_ORG.
// Non stampa mai i valori (solo cosa c'è che non va): niente chiavi nei log.
//
//   node scripts/validate-release-config.mjs        # esce con 1 se qualcosa non va
//
// Le funzioni `validate*` sono esportate e testate (validate-release-config.test.mjs).
import { pathToFileURL } from 'node:url';
import { parsePublicKey } from './updater-keys/minisign.mjs';

const PUB_HELP = 'UPDATER_PUBKEY deve essere il contenuto del file .key.pub generato da genera-chiavi.mjs (o da `tauri signer generate`): una sola riga che inizia con "dW50cnVzdGVk".';

/** Che tipo di valore sembra (per spiegare l'errore senza ripeterlo). */
function classify(v) {
  if (v.startsWith('sb_publishable_')) return 'una chiave "publishable" di Supabase';
  if (v.startsWith('sb_secret_')) return 'una chiave SEGRETA di Supabase';
  if (v.startsWith('eyJ')) return 'un JWT (probabilmente una chiave di Supabase)';
  if (/^https?:\/\//.test(v)) return 'un indirizzo web';
  if (/BEGIN [A-Z ]*KEY/.test(v)) return 'una chiave PEM';
  return null;
}

/** UPDATER_PUBKEY: base64 di una box minisign "minisign public key" con chiave Ed25519 di 42 byte. */
export function validatePubkey(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'La variabile UPDATER_PUBKEY manca. ' + PUB_HELP;
  if (/[\r\n]/.test(v)) return 'UPDATER_PUBKEY contiene a-capo: incolla il contenuto del file .key.pub su una sola riga. ' + PUB_HELP;
  const kind = classify(v);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) {
    return `UPDATER_PUBKEY non è base64${kind ? ` (sembra ${kind})` : ''}. ` + PUB_HELP;
  }
  const text = Buffer.from(v, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment: minisign public key')) {
    return `UPDATER_PUBKEY non è una chiave pubblica dell'updater: decodificata non inizia con "untrusted comment: minisign public key"${kind ? ` (sembra ${kind})` : ''}. ` + PUB_HELP;
  }
  try {
    parsePublicKey(v); // seconda riga = base64 di 42 byte che iniziano con "Ed", identificativo coerente
  } catch (e) {
    return `UPDATER_PUBKEY: ${e.message}. ` + PUB_HELP;
  }
  return null;
}

/** SUPABASE_ANON_KEY: JWT "anon" (eyJ…) o chiave "sb_publishable_…"; mai la chiave service_role / secret. */
export function validateAnonKey(raw) {
  const v = String(raw ?? '');
  if (!v.trim()) return 'La variabile SUPABASE_ANON_KEY manca (Supabase → Project Settings → API → chiave pubblica "anon" / "publishable").';
  if (/\s/.test(v)) return 'SUPABASE_ANON_KEY contiene spazi o a-capo (anche all\'inizio o in fondo): reincolla la chiave senza spazi.';
  if (/^[\\"'`]/.test(v) || /["'`\\]$/.test(v)) {
    return 'SUPABASE_ANON_KEY inizia o finisce con un carattere estraneo (backslash o virgolette): il valore della variabile deve essere solo la chiave, senza virgolette né "\\". Reincollala.';
  }
  if (v.startsWith('sb_secret_')) return 'SUPABASE_ANON_KEY è una chiave SEGRETA di Supabase (sb_secret_…): non va mai nell\'app. Serve la chiave "publishable" / "anon".';
  if (v.startsWith('sb_publishable_')) {
    return /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(v) ? null : 'SUPABASE_ANON_KEY (sb_publishable_…) contiene caratteri non validi.';
  }
  if (v.startsWith('eyJ')) {
    const parts = v.split('.');
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return 'SUPABASE_ANON_KEY inizia come un JWT ma non lo è (servono 3 parti separate da punti).';
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') return 'SUPABASE_ANON_KEY è la chiave service_role: NON va mai nell\'app. Serve la chiave "anon" (role: anon).';
      if (payload.role !== undefined && payload.role !== 'anon') return `SUPABASE_ANON_KEY ha role "${String(payload.role).slice(0, 20)}": serve la chiave "anon".`;
    } catch {
      return 'SUPABASE_ANON_KEY inizia come un JWT ma il contenuto non è leggibile.';
    }
    return null;
  }
  return 'SUPABASE_ANON_KEY deve iniziare con "eyJ" (JWT anon) oppure con "sb_publishable_".';
}

export function validateSupabaseUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'La variabile SUPABASE_URL manca.';
  if (!/^https:\/\/[A-Za-z0-9-]+\.supabase\.co$/.test(v)) return 'SUPABASE_URL deve essere nella forma https://<ref>.supabase.co, senza "/" finale né percorso.';
  return null;
}

export function validateOrg(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'La variabile PROJECTS_ORG (organizzazione GitHub dei progetti) manca.';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v)) return 'PROJECTS_ORG non è un nome di organizzazione GitHub valido.';
  return null;
}

export function validateReleasesRepo(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return 'La variabile RELEASES_REPO manca (nella forma proprietario/nome).';
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v)) return 'RELEASES_REPO non è nella forma proprietario/nome.';
  return null;
}

export function validateAll(env) {
  return [
    validateReleasesRepo(env.RELEASES_REPO),
    validatePubkey(env.UPDATER_PUBKEY),
    validateSupabaseUrl(env.SUPABASE_URL),
    validateAnonKey(env.SUPABASE_ANON_KEY),
    validateOrg(env.PROJECTS_ORG),
  ].filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = validateAll(process.env);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length) {
    console.error(`\nConfigurazione della release non valida (${errors.length} problemi). Correggi le variabili in Settings → Secrets and variables → Actions → Variables.`);
    process.exit(1);
  }
  console.log('Configurazione della release valida.');
}
