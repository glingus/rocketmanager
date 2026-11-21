// Registrazione della GitHub App con il "manifest flow" di GitHub
// (docs: "Registering a GitHub App from a manifest").
//  1. Un server locale su 127.0.0.1 serve una pagina che fa il POST automatico del manifest a
//     https://github.com/organizations/<org>/settings/apps/new?state=<casuale>
//  2. GitHub rimanda il browser a redirect_url?code=...&state=...
//  3. Il codice (valido un'ora) si scambia con POST https://api.github.com/app-manifests/{code}/conversions
//     che restituisce id, slug, client_id, client_secret, webhook_secret, pem, html_url.
// I segreti restano in memoria: questo modulo non scrive nulla su disco.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SetupError, githubHttpError, networkError } from './errors.mjs';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';

export const APP_PERMISSIONS = {
  administration: 'write',
  contents: 'write',
  metadata: 'read',
  members: 'write',
  // Account permission "Email addresses": Supabase legge GET /user/emails all'accesso; senza,
  // il login fallisce con "Error getting user profile from external provider".
  emails: 'read',
};

export function appName(org) {
  return `Rocket Sync ${org}`.slice(0, 34);
}

/** Manifest della GitHub App (vedi supabase/README.md §3). */
export function buildManifest({ org, ref, port }) {
  const supabaseUrl = `https://${ref}.supabase.co`;
  return {
    name: appName(org),
    url: `${GITHUB_WEB}/${org}`,
    description: 'Sincronizzazione dei file OpenRocket del team (Rocket Sync).',
    hook_attributes: { url: `${supabaseUrl}/functions/v1/github-webhook`, active: true },
    redirect_url: `http://127.0.0.1:${port}/creata`,
    callback_urls: [`${supabaseUrl}/auth/v1/callback`],
    request_oauth_on_install: false, // il login avviene dall'app, non all'installazione (e niente setup_url)
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: ['push'],
  };
}

export function newState() {
  return randomBytes(24).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function manifestFormAction(org, state) {
  return `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

export function formPage({ org, state, manifest }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Rocket Sync: creazione dell'app GitHub</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#2b211b}button{font:inherit;padding:.5rem 1rem}</style></head>
<body><h1>Creazione dell'app GitHub</h1>
<p>Sto aprendo GitHub per registrare l'app nell'organizzazione <strong>${escapeAttr(org)}</strong>…</p>
<form id="f" method="post" action="${escapeAttr(manifestFormAction(org, state))}">
<input type="hidden" name="manifest" value="${escapeAttr(JSON.stringify(manifest))}">
<noscript><button type="submit">Continua su GitHub</button></noscript></form>
<script>document.getElementById('f').submit();</script></body></html>`;
}

const DONE_PAGE = `<!doctype html><html lang="it"><meta charset="utf-8"><title>Fatto</title>
<body style="font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">
<h1>App creata</h1><p>Puoi tornare al terminale: il configuratore continua da solo.</p></body></html>`;

const BAD_PAGE = `<!doctype html><html lang="it"><meta charset="utf-8"><title>Richiesta non valida</title>
<body style="font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">
<h1>Richiesta non valida</h1><p>Il codice di verifica non corrisponde: la richiesta è stata ignorata.</p></body></html>`;

/**
 * Avvia il server locale. `start()` restituisce l'indirizzo da aprire e `waitForCode()` il codice
 * (solo se `state` coincide).
 */
export async function startManifestServer({ org, ref, state = newState(), waitMs = 15 * 60 * 1000, host = '127.0.0.1' }) {
  let manifest;
  let port;
  let settle;
  let fail;
  const codePromise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  codePromise.catch(() => {});
  const stats = { badState: 0 };

  const server = createServer((req, res) => {
    const send = (status, html) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action https://github.com",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
    };
    // Protezione da DNS rebinding: solo richieste indirizzate a 127.0.0.1:<porta>.
    if (req.headers.host !== `${host}:${port}`) return send(400, BAD_PAGE);
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/') return send(200, formPage({ org, state, manifest }));
    if (req.method === 'GET' && url.pathname === '/creata') {
      const err = url.searchParams.get('error');
      if (err) {
        send(400, BAD_PAGE);
        return fail(new SetupError('GitHub ha annullato la creazione dell\'app.', { code: 'github-cancelled' }));
      }
      const code = url.searchParams.get('code');
      if (!code || !safeEqual(url.searchParams.get('state'), state)) {
        stats.badState++;
        return send(400, BAD_PAGE);
      }
      send(200, DONE_PAGE);
      return settle(code);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  port = server.address().port;
  manifest = buildManifest({ org, ref, port });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SetupError('Tempo scaduto: la registrazione dell\'app su GitHub non è stata completata.', { code: 'github-timeout' })), waitMs);
    timer.unref?.();
  });
  timeout.catch(() => {});

  return {
    port,
    state,
    manifest,
    stats,
    url: `http://${host}:${port}/`,
    waitForCode: () => Promise.race([codePromise, timeout]),
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Scambia il codice con le credenziali dell'app. */
export async function convertManifest({ code, apiBase = GITHUB_API, fetchImpl = globalThis.fetch }) {
  const url = `${apiBase.replace(/\/$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rocketsync-setup' },
    });
  } catch (e) {
    throw networkError(new URL(url).host, e);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw githubHttpError(res.status, body);
  for (const k of ['id', 'slug', 'client_id', 'client_secret', 'webhook_secret', 'pem', 'html_url']) {
    if (body?.[k] === undefined || body[k] === null || body[k] === '') {
      throw new SetupError(`La risposta di GitHub è incompleta (manca "${k}").`, { code: 'github-response' });
    }
  }
  return {
    id: body.id,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    webhookSecret: body.webhook_secret,
    pem: body.pem,
    htmlUrl: body.html_url,
  };
}

export function appSettingsUrl(org, slug) {
  return `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/${encodeURIComponent(slug)}`;
}

export function appInstallUrl(htmlUrl) {
  return `${htmlUrl.replace(/\/$/, '')}/installations/new`;
}
