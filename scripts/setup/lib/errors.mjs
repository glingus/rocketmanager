// Errori del configuratore: sempre con un messaggio in italiano pronto da mostrare.

export class SetupError extends Error {
  /**
   * @param {string} message messaggio per l'utente (italiano)
   * @param {{ code?: string, hint?: string, status?: number, detail?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SetupError';
    this.code = opts.code ?? 'setup';
    this.hint = opts.hint ?? null;
    this.status = opts.status ?? null;
    this.detail = opts.detail ?? null;
  }
}

/** Traduce uno status HTTP della Management API di Supabase in un messaggio chiaro. */
export function supabaseHttpError(status, body, what) {
  const detail = extractMessage(body);
  switch (status) {
    case 401:
      return new SetupError('L\'access token di Supabase non è valido o è scaduto.', {
        code: 'supabase-auth',
        status,
        hint: 'Creane uno nuovo da supabase.com → Account → Access Tokens e rilancia il configuratore.',
      });
    case 403:
      return new SetupError(`Supabase ha rifiutato l'operazione (${what}): il token non ha i permessi necessari.`, {
        code: 'supabase-forbidden',
        status,
        hint: 'Usa un token personale (non limitato) di un account che amministra il progetto.',
      });
    case 404:
      return new SetupError(`Supabase non ha trovato la risorsa richiesta (${what}). Controlla il ref del progetto.`, {
        code: 'supabase-notfound',
        status,
      });
    case 429:
      return new SetupError('Supabase ha limitato le richieste (troppe in poco tempo). Riprova tra un minuto.', {
        code: 'supabase-ratelimit',
        status,
      });
    default:
      if (status >= 500) {
        return new SetupError(`Supabase ha avuto un errore interno (${what}, HTTP ${status})${detail ? `: ${detail}` : ''}. Riprova tra poco.`, {
          code: 'supabase-server',
          status,
          detail,
        });
      }
      return new SetupError(`Supabase ha risposto con un errore (${what}, HTTP ${status})${detail ? `: ${detail}` : ''}.`, {
        code: 'supabase-http',
        status,
        detail,
      });
  }
}

/** Traduce uno status HTTP di GitHub (conversione del manifest). */
export function githubHttpError(status, body) {
  const detail = extractMessage(body);
  if (status === 404) {
    return new SetupError('GitHub non riconosce il codice di creazione dell\'app: è scaduto (vale un\'ora) o è già stato usato.', {
      code: 'github-code',
      status,
      hint: 'Rilancia il configuratore con --nuova-app per ripetere la registrazione.',
    });
  }
  if (status === 422) {
    return new SetupError(`GitHub ha rifiutato la creazione dell'app${detail ? `: ${detail}` : ''}.`, {
      code: 'github-invalid',
      status,
      hint: 'Spesso il nome è già in uso: GitHub richiede un nome unico per le app.',
    });
  }
  if (status === 403 || status === 429) {
    return new SetupError('GitHub ha limitato le richieste. Riprova tra qualche minuto.', { code: 'github-ratelimit', status });
  }
  return new SetupError(`GitHub ha risposto con un errore (HTTP ${status})${detail ? `: ${detail}` : ''}.`, {
    code: 'github-http',
    status,
  });
}

export function networkError(host, cause) {
  return new SetupError(`Non riesco a raggiungere ${host}. Controlla la connessione a Internet (e un eventuale proxy).`, {
    code: 'network',
    hint: cause && cause.message ? `Dettaglio tecnico: ${cause.message}` : undefined,
  });
}

function extractMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  const m = body.message ?? body.error ?? body.msg;
  if (typeof m === 'string') return m.slice(0, 300);
  if (m && typeof m.message === 'string') return m.message.slice(0, 300);
  return '';
}
