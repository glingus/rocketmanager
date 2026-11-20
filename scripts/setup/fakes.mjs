// Server finti per i test: Management API di Supabase e API di GitHub (conversione del manifest).
// Nessuna chiamata reale: da qui api.supabase.com non è raggiungibile.

import { createServer } from 'node:http';

export const FAKE = {
  token: 'sbp_' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  ref: 'abcdefghijklmnopqrst',
  anon: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.ANON_PUBLIC_SIGNATURE',
  serviceRole: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SERVICE_ROLE_SECRET_SIG',
  github: {
    code: 'good-code-123',
    id: 424242,
    slug: 'rocket-sync-team',
    clientId: 'Iv1.0123456789abcdef',
    clientSecret: 'cs_super_secret_value_0123456789',
    webhookSecret: 'whsec_super_secret_webhook_0123456789',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefakefakefakefakefakefake\nSECRETLINEsecretlineSECRETLINEsecretline1234\n-----END RSA PRIVATE KEY-----\n',
    htmlUrl: 'https://github.com/apps/rocket-sync-team',
  },
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/** Management API finta con stato in memoria. */
export async function startFakeSupabase(over = {}) {
  const st = {
    token: over.token ?? FAKE.token,
    projectStatus: over.projectStatus ?? 'ACTIVE_HEALTHY',
    secrets: new Map(over.secrets ?? []),
    authConfig: { uri_allow_list: over.allowList ?? 'https://esempio.it/callback', ...(over.authConfig ?? {}) },
    appliedVersions: new Set(over.appliedVersions ?? []),
    queries: [],
    requests: [],
    vault: [],
    failMigration: over.failMigration ?? null, // nome (parte del file) che deve fallire
    rateLimitFirst: over.rateLimitFirst ?? 0, // quante risposte 429 prima di rispondere
    legacyKeys: over.legacyKeys ?? true,
  };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    st.requests.push({ method: req.method, path: url.pathname + url.search, body, auth: req.headers.authorization });
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${st.token}`) return send(401, { message: 'Unauthorized' });
    if (st.rateLimitFirst > 0) {
      st.rateLimitFirst--;
      res.writeHead(429, { 'Retry-After': '0' });
      return res.end('{}');
    }
    const m = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return send(404, { message: 'not found' });
    const [, ref, sub = ''] = m;
    if (ref !== FAKE.ref) return send(404, { message: 'Project not found' });
    const json = body ? JSON.parse(body) : undefined;
    if (req.method === 'GET' && sub === '') return send(200, { ref, name: 'Rocket Sync', region: 'eu-central-1', status: st.projectStatus, organization_slug: 'org' });
    if (req.method === 'GET' && sub === '/api-keys') {
      if (url.searchParams.get('reveal') !== 'true') return send(400, { message: 'reveal richiesto' });
      return send(200, st.legacyKeys ? [
        { name: 'anon', type: 'legacy', api_key: FAKE.anon },
        { name: 'service_role', type: 'legacy', api_key: FAKE.serviceRole },
        { name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' },
      ] : [{ name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' }]);
    }
    if (req.method === 'GET' && sub === '/secrets') return send(200, [...st.secrets.keys()].map((name) => ({ name, value: 'digest', updated_at: 'x' })));
    if (req.method === 'POST' && sub === '/secrets') {
      for (const s of json) {
        if (/^SUPABASE_/.test(s.name)) return send(400, { message: 'Secret name must not start with SUPABASE_' });
        st.secrets.set(s.name, s.value);
      }
      return send(201);
    }
    if (req.method === 'GET' && sub === '/config/auth') return send(200, st.authConfig);
    if (req.method === 'PATCH' && sub === '/config/auth') {
      Object.assign(st.authConfig, json);
      return send(200, { ...st.authConfig, external_github_secret: undefined });
    }
    if (req.method === 'POST' && sub === '/database/query') {
      const sql = json.query;
      st.queries.push(sql);
      if (/select version from supabase_migrations\.schema_migrations/i.test(sql)) {
        return send(201, [...st.appliedVersions].sort().map((version) => ({ version })));
      }
      if (/^begin;/.test(sql)) {
        const name = /values \('(\d+)', '([^']+)'/.exec(sql);
        if (st.failMigration && name && name[2].includes(st.failMigration)) {
          return send(400, { message: 'ERROR: 42601: syntax error at or near "FALLITO"' });
        }
        if (name) st.appliedVersions.add(name[1]);
        return send(201, []);
      }
      if (/vault\.(create|update)_secret/.test(sql)) {
        const n = /vault\.create_secret\('((?:[^']|'')*)', '([^']+)'\)/.exec(sql);
        if (n) st.vault.push({ name: n[2], value: n[1].replace(/''/g, "'") });
        return send(201, []);
      }
      return send(201, []);
    }
    return send(404, { message: 'not found' });
  });
  const port = await listen(server);
  return { st, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

/** API di GitHub finta: solo POST /app-manifests/{code}/conversions. */
export async function startFakeGithub(over = {}) {
  const g = { ...FAKE.github, ...over };
  const calls = [];
  const server = createServer(async (req, res) => {
    await readBody(req);
    calls.push({ method: req.method, url: req.url });
    const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url);
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method !== 'POST' || !m) return send(404, { message: 'Not Found' });
    if (m[1] !== g.code || g.used) return send(404, { message: 'Not Found' });
    if (over.incomplete) return send(201, { id: g.id, slug: g.slug });
    g.used = !over.reusable;
    return send(201, {
      id: g.id, slug: g.slug, html_url: g.htmlUrl, client_id: g.clientId, client_secret: g.clientSecret,
      webhook_secret: g.webhookSecret, pem: g.pem, name: 'Rocket Sync org', owner: { login: 'org' },
    });
  });
  const port = await listen(server);
  return { calls, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

/** Il manifest e l'azione del form contenuti nella pagina servita dal configuratore. */
export function parseFormPage(html) {
  const action = /<form[^>]* action="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, '&');
  const raw = /name="manifest" value="([^"]*)"/.exec(html)?.[1];
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { action, manifest: raw ? JSON.parse(unescape(raw)) : null };
}
