// Client minimale della Management API di Supabase (https://api.supabase.com/v1).
// Endpoint e campi verificati sulla specifica OpenAPI pubblicata (supabase/supabase,
// apps/docs/spec/api_v1_openapi.json):
//   GET   /v1/projects/{ref}                       -> { ref, name, region, status, ... }
//   GET   /v1/projects/{ref}/api-keys?reveal=true  -> [{ name, type: 'legacy'|..., api_key }]
//   GET   /v1/projects/{ref}/secrets               -> [{ name, value, updated_at }]
//   POST  /v1/projects/{ref}/secrets               -> body [{ name, value }]   (201)
//   GET/PATCH /v1/projects/{ref}/config/auth           -> { site_url, uri_allow_list, external_github_* }
//   POST  /v1/projects/{ref}/database/query        -> body { query }           (201, righe JSON)

import { SetupError, networkError, supabaseHttpError } from './errors.mjs';

export const SUPABASE_API = 'https://api.supabase.com';

export class SupabaseApi {
  /**
   * @param {{ token: string, baseUrl?: string, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, maxRetries?: number }} o
   */
  constructor({ token, baseUrl = SUPABASE_API, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 3 }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
  }

  async request(method, path, { body, query, what = path } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            'User-Agent': 'rocketsync-setup',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw networkError(url.host, e);
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (res.ok) return parsed;
      const retryable = res.status === 429 || res.status === 502 || res.status === 503;
      if (retryable && attempt < this.maxRetries) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
        await this.sleep(Math.min(wait, 20000));
        continue;
      }
      throw supabaseHttpError(res.status, parsed, what);
    }
  }

  getProject(ref) {
    return this.request('GET', `/v1/projects/${ref}`, { what: 'lettura del progetto' });
  }

  /** Chiavi JWT "legacy": anon (pubblica) e service_role (segreta). */
  async getApiKeys(ref) {
    const keys = await this.request('GET', `/v1/projects/${ref}/api-keys`, { query: { reveal: 'true' }, what: 'lettura delle chiavi API' });
    const list = Array.isArray(keys) ? keys : [];
    const pick = (name) => list.find((k) => k.name === name && (k.type === 'legacy' || k.type == null))?.api_key;
    const anon = pick('anon');
    const serviceRole = pick('service_role');
    if (!anon || !serviceRole) {
      throw new SetupError('Non trovo le chiavi API "anon" e "service_role" del progetto.', {
        code: 'supabase-keys',
        hint: 'In Supabase → Project Settings → API Keys → "Legacy API keys" devono essere attive. Abilitale e rilancia.',
      });
    }
    return { anon, serviceRole };
  }

  async listSecretNames(ref) {
    const list = await this.request('GET', `/v1/projects/${ref}/secrets`, { what: 'elenco dei segreti' });
    return new Set((Array.isArray(list) ? list : []).map((s) => s.name));
  }

  setSecrets(ref, secrets) {
    return this.request('POST', `/v1/projects/${ref}/secrets`, { body: secrets, what: 'salvataggio dei segreti' });
  }

  getAuthConfig(ref) {
    return this.request('GET', `/v1/projects/${ref}/config/auth`, { what: 'lettura della configurazione dell\'accesso' });
  }

  updateAuthConfig(ref, config) {
    return this.request('PATCH', `/v1/projects/${ref}/config/auth`, { body: config, what: 'configurazione dell\'accesso' });
  }

  /** Esegue SQL. Un errore SQL (HTTP 400/500 con messaggio) diventa un SetupError leggibile. */
  async query(ref, sql, { what = 'esecuzione SQL' } = {}) {
    try {
      return await this.request('POST', `/v1/projects/${ref}/database/query`, { body: { query: sql }, what });
    } catch (e) {
      if (e instanceof SetupError && (e.status === 400 || e.status === 500) && e.detail) {
        throw new SetupError(`Il database ha rifiutato l'operazione (${what}): ${e.detail}`, { code: 'sql', status: e.status, detail: e.detail });
      }
      throw e;
    }
  }
}
