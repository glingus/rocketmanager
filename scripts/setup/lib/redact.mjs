// Garanzia "nessun segreto in uscita": ogni segreto noto viene registrato e cancellato da
// qualunque testo passi dal logger o dai messaggi di errore.

export class Redactor {
  constructor() {
    /** @type {Set<string>} */
    this.secrets = new Set();
  }

  /** Registra un valore segreto (e le sue varianti con a-capo codificati). */
  add(value) {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length < 6) return;
    this.secrets.add(v);
    if (v.includes('\n')) {
      this.secrets.add(v.replace(/\r?\n/g, '\\n'));
      for (const line of v.split(/\r?\n/)) if (line.trim().length >= 16) this.secrets.add(line.trim());
    }
  }

  /** Sostituisce ogni segreto noto e ogni pattern tipico con `***`. */
  clean(text) {
    let out = String(text);
    // i valori più lunghi per primi, così le sottostringhe non lasciano resti
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
    out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***');
    out = out.replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '***');
    out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '***');
    out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***');
    return out;
  }
}

/** Logger che pulisce tutto prima di scrivere. */
export function createLogger({ redactor, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) }) {
  const w = (fn, s) => fn(`${redactor.clean(s)}\n`);
  return {
    info: (s = '') => w(out, s),
    ok: (s) => w(out, `  ✔ ${s}`),
    skip: (s) => w(out, `  ↷ ${s}`),
    step: (n, total, s) => w(out, `\n[${n}/${total}] ${s}`),
    warn: (s) => w(err, `  ! ${s}`),
    error: (s) => w(err, s),
  };
}
