// Argomenti da riga di comando e variabili d'ambiente.

export const REF_RE = /^[a-z]{20}$/;
export const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const HELP = `Configuratore guidato del backend di Rocket Sync

Uso:
  node scripts/setup/setup-backend.mjs [opzioni]

Opzioni (in alternativa vengono chieste a video):
  --org <nome>          organizzazione GitHub che ospiterà i repository dei progetti  (env: GITHUB_ORG)
  --ref <ref>           project ref di Supabase, 20 lettere minuscole                  (env: SUPABASE_PROJECT_REF)
  (access token)        solo da variabile d'ambiente SUPABASE_ACCESS_TOKEN oppure chiesto senza eco
  --nuova-app           registra una nuova GitHub App anche se i segreti esistono già
  --senza-deploy        non pubblica le Edge Functions
  --senza-browser       non apre il browser: stampa gli indirizzi da aprire a mano
  --si                  risponde "sì" alle conferme (per l'uso non interattivo)
  --aiuto               mostra questo testo

Il configuratore non scrive mai i segreti su disco e non li stampa.`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function parseArgs(argv, env = {}) {
  const opts = {
    org: env.GITHUB_ORG || undefined,
    ref: env.SUPABASE_PROJECT_REF || undefined,
    accessToken: env.SUPABASE_ACCESS_TOKEN || undefined,
    nuovaApp: false,
    senzaDeploy: false,
    senzaBrowser: false,
    si: false,
    aiuto: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`Manca il valore dopo ${a}`);
      return v;
    };
    if (a === '--org') opts.org = next();
    else if (a.startsWith('--org=')) opts.org = a.slice(6);
    else if (a === '--ref') opts.ref = next();
    else if (a.startsWith('--ref=')) opts.ref = a.slice(6);
    else if (a === '--nuova-app') opts.nuovaApp = true;
    else if (a === '--senza-deploy') opts.senzaDeploy = true;
    else if (a === '--senza-browser') opts.senzaBrowser = true;
    else if (a === '--si' || a === '--yes' || a === '-y') opts.si = true;
    else if (a === '--aiuto' || a === '--help' || a === '-h') opts.aiuto = true;
    else throw new Error(`Opzione sconosciuta: ${a}`);
  }
  return opts;
}

/** Restituisce un messaggio d'errore in italiano, o null se i valori sono validi. */
export function validateOrg(org) {
  if (!org || !ORG_RE.test(org)) return 'Il nome dell\'organizzazione GitHub non è valido (lettere, numeri e trattini).';
  return null;
}

export function validateRef(ref) {
  if (!ref || !REF_RE.test(ref)) return 'Il project ref di Supabase deve essere di 20 lettere minuscole (lo trovi nell\'indirizzo del progetto).';
  return null;
}

/** Il ref si può incollare anche come URL del pannello o del progetto. */
export function normalizeRef(input) {
  const s = String(input ?? '').trim();
  const m = /(?:project\/|\/\/)([a-z]{20})(?:\.supabase\.co|\/|$)/.exec(s);
  return m ? m[1] : s;
}
