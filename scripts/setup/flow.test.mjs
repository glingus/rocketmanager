// Test del flusso completo con server finti (GitHub e Management API) e un "browser" simulato.
// Niente chiamate reali: da qui api.supabase.com non è raggiungibile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { Redactor, createLogger } from './lib/redact.mjs';
import { SetupError } from './lib/errors.mjs';
import { APP_SECRET_NAMES, REPO_ROOT, runSetup } from './setup-backend.mjs';
import { FAKE, parseFormPage, startFakeGithub, startFakeSupabase } from './fakes.mjs';

/** Ambiente di prova: server finti, stdout/stderr catturati, "browser" che segue il redirect. */
async function harness({ supa = {}, gh = {}, browser = {}, answers = [], runImpl, args = [] } = {}) {
  const sb = await startFakeSupabase(supa);
  const github = await startFakeGithub(gh);
  const stateDir = await mkdtemp(join(tmpdir(), 'rs-flow-'));
  const out = [];
  const err = [];
  const redactor = new Redactor();
  const logger = createLogger({ redactor, out: (s) => out.push(s), err: (s) => err.push(s) });
  const asked = [];
  const queue = [...answers];
  const prompter = {
    ask: async (q) => (asked.push(q), queue.length ? queue.shift() : ''),
    askHidden: async (q) => (asked.push(q), FAKE.token),
    confirm: async (q) => (asked.push(q), true),
    close() {},
  };
  const opened = [];
  const seen = { form: null, badStateStatus: null, hostStatus: null };
  const openBrowser = async (url) => {
    opened.push(url);
    if (!url.startsWith('http://127.0.0.1:')) return true; // pagine di GitHub: non si seguono
    const page = await fetch(url);
    seen.form = parseFormPage(await page.text());
    const { manifest, action } = seen.form;
    const state = new URL(action).searchParams.get('state');
    if (browser.sendWrongState) seen.badStateStatus = (await fetch(`${manifest.redirect_url}?code=${FAKE.github.code}&state=falso`)).status;
    if (browser.sendCancel) {
      await fetch(`${manifest.redirect_url}?error=access_denied`);
      return true;
    }
    if (browser.noRedirect) return true;
    await fetch(`${manifest.redirect_url}?code=${browser.code ?? FAKE.github.code}&state=${state}`);
    return true;
  };
  const runCalls = [];
  const run = async (cmd, a, o) => {
    runCalls.push({ cmd, args: a, env: o?.env, shell: o?.shell });
    if (runImpl) return runImpl(cmd, a, o);
    if (cmd === 'gh') return { code: 127, stdout: '', stderr: 'gh: not found' };
    return { code: 0, stdout: 'Deployed', stderr: '' };
  };
  const opts = parseArgs(['--org', 'mia-org', '--ref', FAKE.ref, ...args], { SUPABASE_ACCESS_TOKEN: FAKE.token });
  const deps = {
    prompter, logger, redactor, openBrowser, run, stateDir, repoRoot: REPO_ROOT,
    supabaseBase: sb.baseUrl, githubApiBase: github.baseUrl, sleep: async () => {}, serverWaitMs: browser.waitMs ?? 5000,
  };
  return {
    sb, github, stateDir, out, err, asked, opened, seen, runCalls, opts, deps,
    all: () => out.join('') + err.join(''),
    run: (o = opts, d = deps) => runSetup(o, d),
    async close() { await sb.close(); await github.close(); },
  };
}

async function diskContents(dir) {
  const names = await readdir(dir);
  let text = names.join('\n');
  for (const n of names) text += '\n' + (await readFile(join(dir, n), 'utf8'));
  return text;
}

const SECRETS = [FAKE.token, FAKE.serviceRole, FAKE.github.clientSecret, FAKE.github.webhookSecret, FAKE.github.pem, 'MIIEowIBAAK', 'SECRETLINE'];

test('flusso completo: app, accesso, segreti, migrazioni, Vault, funzioni, riepilogo', async () => {
  const h = await harness({ browser: { sendWrongState: true } });
  try {
    const res = await h.run();
    // 1. il form punta a GitHub con il manifest richiesto
    const { action, manifest } = h.seen.form;
    assert.match(action, /^https:\/\/github\.com\/organizations\/mia-org\/settings\/apps\/new\?state=[A-Za-z0-9_-]{20,}$/);
    assert.equal(manifest.name, 'Rocket Sync mia-org');
    assert.equal(manifest.hook_attributes.url, `https://${FAKE.ref}.supabase.co/functions/v1/github-webhook`);
    assert.deepEqual(manifest.callback_urls, [`https://${FAKE.ref}.supabase.co/auth/v1/callback`]);
    assert.equal(manifest.request_oauth_on_install, false);
    assert.equal(manifest.public, false);
    assert.equal(h.seen.badStateStatus, 400, 'state errato rifiutato dal server locale');
    // 2. conversione eseguita una sola volta, con il codice giusto
    assert.equal(h.github.calls.length, 1);
    // 3. segreti sulle funzioni
    for (const n of APP_SECRET_NAMES) assert.ok(h.sb.st.secrets.has(n), `segreto ${n}`);
    assert.equal(h.sb.st.secrets.get('GITHUB_ORG'), 'mia-org');
    assert.equal(h.sb.st.secrets.get('GITHUB_APP_ID'), String(FAKE.github.id));
    assert.equal(h.sb.st.secrets.get('GITHUB_APP_PRIVATE_KEY'), FAKE.github.pem);
    // 4. accesso con GitHub
    const auth = h.sb.st.authConfig;
    assert.equal(auth.external_github_enabled, true);
    assert.equal(auth.external_github_client_id, FAKE.github.clientId);
    assert.equal(auth.external_github_secret, FAKE.github.clientSecret);
    assert.equal(auth.site_url, 'http://127.0.0.1:53682/callback');
    assert.ok(auth.uri_allow_list.includes('https://esempio.it/callback'), 'elenco esistente conservato');
    assert.ok(auth.uri_allow_list.includes('http://127.0.0.1:53691/callback'));
    // 5. migrazioni e Vault
    assert.equal(res.migrations.applied.length, 6);
    assert.equal(h.sb.st.appliedVersions.size, 6);
    const vault = Object.fromEntries(h.sb.st.vault.map((v) => [v.name, v.value]));
    assert.equal(vault.project_url, `https://${FAKE.ref}.supabase.co`);
    assert.equal(vault.service_role_key, FAKE.serviceRole);
    // 6. funzioni con la CLI fissata e il token solo nell'ambiente
    const deploy = h.runCalls.find((c) => c.args.includes('deploy'));
    assert.equal(deploy.shell === true, false, 'nessuna shell');
    assert.ok(deploy.args.includes('--use-api'));
    assert.equal(deploy.args.includes(FAKE.token), false, 'il token non è tra gli argomenti');
    assert.equal(deploy.env.SUPABASE_ACCESS_TOKEN, FAKE.token);
    assert.equal(deploy.args.filter((a) => /^[a-z-]+$/.test(a) && !['yes', 'functions', 'deploy'].includes(a)).length >= 7, true);
    // 7. pagine di GitHub aperte alla fine
    assert.ok(h.opened.includes(`https://github.com/organizations/mia-org/settings/apps/${FAKE.github.slug}`));
    assert.ok(h.opened.includes(`${FAKE.github.htmlUrl}/installations/new`));
    assert.match(h.all(), /Expire user authorization tokens/);
    // 8. riepilogo con i soli valori pubblici
    assert.equal(res.values.SUPABASE_URL, `https://${FAKE.ref}.supabase.co`);
    assert.equal(res.values.SUPABASE_ANON_KEY, FAKE.anon);
    assert.equal(res.values.PROJECTS_ORG, 'mia-org');
    assert.match(h.all(), /SUPABASE_ANON_KEY = eyJ/);
    assert.match(h.all(), /non è installato o non è autenticato/);
  } finally {
    await h.close();
  }
});

test('nessun segreto in stdout/stderr né su disco (token, service_role, client secret, webhook secret, chiave privata)', async () => {
  const h = await harness({ browser: { sendWrongState: true } });
  try {
    await h.run();
    const output = h.all();
    const disk = await diskContents(h.stateDir);
    assert.ok(output.length > 500, 'il configuratore ha scritto qualcosa');
    for (const s of SECRETS) {
      assert.equal(output.includes(s), false, `in uscita: ${s.slice(0, 12)}…`);
      assert.equal(disk.includes(s), false, `su disco: ${s.slice(0, 12)}…`);
    }
    assert.deepEqual(await readdir(h.stateDir), ['setup-backend.json'], 'un solo file di stato');
    const state = JSON.parse(await readFile(join(h.stateDir, 'setup-backend.json'), 'utf8'));
    assert.equal(state.app.slug, FAKE.github.slug);
    assert.equal(state.org, 'mia-org');
    assert.equal(state.steps.migrations, true);
    // il valore pubblico (anon) si può mostrare: non è un segreto
    assert.match(output, new RegExp(FAKE.anon.slice(0, 20)));
  } finally {
    await h.close();
  }
});

test('anche i messaggi d\'errore non contengono segreti (migrazione che fallisce a metà)', async () => {
  const h = await harness({ supa: { failMigration: 'tables' }, browser: {} });
  try {
    await assert.rejects(() => h.run(), SetupError);
    for (const s of SECRETS) assert.equal(h.all().includes(s), false);
    for (const s of SECRETS) assert.equal((await diskContents(h.stateDir)).includes(s), false);
  } finally {
    await h.close();
  }
});

test('seconda esecuzione: app non ricreata, migrazioni già applicate saltate, tutto idempotente', async () => {
  const h = await harness();
  try {
    await h.run();
    assert.equal(h.github.calls.length, 1);
    const txBefore = h.sb.st.queries.filter((q) => q.startsWith('begin;')).length;
    assert.equal(txBefore, 6);
    h.out.length = 0;
    h.err.length = 0;
    const second = await h.run();
    assert.equal(h.github.calls.length, 1, 'nessuna nuova conversione');
    assert.equal(second.app, null, 'app non ricreata');
    assert.equal(second.migrations.applied.length, 0);
    assert.equal(second.migrations.skipped.length, 6);
    assert.equal(h.sb.st.queries.filter((q) => q.startsWith('begin;')).length, 6, 'nessuna transazione in più');
    assert.match(h.all(), /GITHUB_APP_\* esistono già/);
    assert.match(h.all(), /6 già presenti/);
    // i segreti dell'app e la configurazione di accesso sono rimasti
    assert.equal(h.sb.st.secrets.get('GITHUB_APP_PRIVATE_KEY'), FAKE.github.pem);
    assert.equal(h.sb.st.authConfig.external_github_client_id, FAKE.github.clientId);
  } finally {
    await h.close();
  }
});

test('--nuova-app: l\'app viene registrata di nuovo anche se i segreti esistono', async () => {
  const h = await harness({ gh: { reusable: true }, args: ['--nuova-app'] });
  try {
    await h.run();
    await h.run();
    assert.equal(h.github.calls.length, 2);
    assert.equal(h.sb.st.appliedVersions.size, 6);
  } finally {
    await h.close();
  }
});

test('ripresa dopo un errore: le migrazioni riuscite non si ripetono, l\'app non si ricrea', async () => {
  const h = await harness({ supa: { failMigration: 'functions' } });
  try {
    await assert.rejects(() => h.run(), /La migrazione 20261101000004_functions\.sql non è riuscita/);
    assert.equal(h.sb.st.appliedVersions.size, 3);
    h.sb.st.failMigration = null;
    const res = await h.run();
    assert.equal(h.github.calls.length, 1, 'l\'app non viene ricreata');
    assert.equal(res.migrations.skipped.length, 3);
    assert.equal(res.migrations.applied.length, 3);
    assert.equal(h.sb.st.appliedVersions.size, 6);
  } finally {
    await h.close();
  }
});

test('--senza-deploy salta le Edge Functions', async () => {
  const h = await harness({ args: ['--senza-deploy'] });
  try {
    await h.run();
    assert.equal(h.runCalls.some((c) => c.args.includes('deploy')), false);
  } finally {
    await h.close();
  }
});

test('token errato: messaggio italiano chiaro, nessuna app creata', async () => {
  const h = await harness({ supa: { token: 'sbp_un_altro_token_un_altro_token_1234' } });
  try {
    await assert.rejects(() => h.run(), (e) => e instanceof SetupError && /access token di Supabase non è valido/.test(e.message));
    assert.equal(h.github.calls.length, 0);
    assert.equal(h.opened.length, 0);
  } finally {
    await h.close();
  }
});

test('ref inesistente: messaggio chiaro sul project ref', async () => {
  const h = await harness();
  try {
    await assert.rejects(() => h.run(parseArgs(['--org', 'mia-org', '--ref', 'zzzzzzzzzzzzzzzzzzzz'], { SUPABASE_ACCESS_TOKEN: FAKE.token }), h.deps), /ref del progetto/);
  } finally {
    await h.close();
  }
});

test('progetto in pausa: si ferma con un messaggio chiaro', async () => {
  const h = await harness({ supa: { projectStatus: 'INACTIVE' } });
  try {
    await assert.rejects(() => h.run(), /non è utilizzabile \(stato INACTIVE\)/);
  } finally {
    await h.close();
  }
});

test('dati mancanti: le domande vengono poste, il token con input nascosto', async () => {
  const h = await harness({ answers: ['mia-org', `https://supabase.com/dashboard/project/${FAKE.ref}`] });
  try {
    const opts = parseArgs([], {});
    await h.run(opts, h.deps);
    assert.ok(h.asked.some((q) => /organizzazione GitHub/.test(q)));
    assert.ok(h.asked.some((q) => /Access token.*nascosto/.test(q)));
    assert.ok(h.sb.st.secrets.has('GITHUB_ORG'));
    assert.equal(h.all().includes(FAKE.token), false);
  } finally {
    await h.close();
  }
});

test('con --si i dati mancanti sono un errore, non una domanda', async () => {
  const h = await harness({ args: ['--si'] });
  try {
    await assert.rejects(() => h.run(parseArgs(['--si', '--ref', FAKE.ref], { SUPABASE_ACCESS_TOKEN: FAKE.token }), h.deps), /nome dell'organizzazione|Il nome/i);
  } finally {
    await h.close();
  }
});

test('GitHub annulla la creazione: errore chiaro', async () => {
  const h = await harness({ browser: { sendCancel: true } });
  try {
    await assert.rejects(() => h.run(), /GitHub ha annullato/);
    assert.equal(h.github.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('nessun ritorno dal browser: tempo scaduto con messaggio chiaro', async () => {
  const h = await harness({ browser: { noRedirect: true, waitMs: 80 } });
  try {
    await assert.rejects(() => h.run(), /Tempo scaduto/);
  } finally {
    await h.close();
  }
});

test('codice di GitHub scaduto: messaggio chiaro sulla conversione', async () => {
  const h = await harness({ browser: { code: FAKE.github.code }, gh: { code: 'un-altro-codice' } });
  try {
    await assert.rejects(() => h.run(), /scaduto .* già stato usato/);
    assert.equal(h.sb.st.secrets.size, 0, 'niente segreti scritti a metà');
  } finally {
    await h.close();
  }
});

test('chiavi legacy assenti: errore chiaro prima di toccare il database', async () => {
  const h = await harness({ supa: { legacyKeys: false } });
  try {
    await assert.rejects(() => h.run(), /chiavi API "anon" e "service_role"/);
    assert.equal(h.sb.st.queries.length, 0);
  } finally {
    await h.close();
  }
});

test('limite di richieste (429): il configuratore riprova e arriva in fondo', async () => {
  const h = await harness({ supa: { rateLimitFirst: 3 } });
  try {
    const res = await h.run();
    assert.equal(res.migrations.applied.length, 6);
  } finally {
    await h.close();
  }
});

test('deploy fallito: errore italiano con le ultime righe, senza token', async () => {
  const h = await harness({ runImpl: async () => ({ code: 1, stdout: '', stderr: `boom ${FAKE.token}` }) });
  try {
    await assert.rejects(() => h.run(), /pubblicazione delle Edge Functions non è riuscita/);
    assert.equal(h.all().includes(FAKE.token), false);
  } finally {
    await h.close();
  }
});

test('gh disponibile: variabili impostate solo dopo conferma', async () => {
  const calls = [];
  const runImpl = async (cmd, a) => {
    calls.push([cmd, ...a]);
    if (cmd === 'gh' && a[0] === 'repo') return { code: 0, stdout: 'mia-org/rocket\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const h = await harness({ runImpl });
  try {
    await h.run();
    const sets = calls.filter((c) => c[0] === 'gh' && c[1] === 'variable');
    assert.deepEqual(sets.map((c) => c[3]), ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PROJECTS_ORG']);
    assert.ok(h.asked.some((q) => /gh variable set/.test(q)), 'chiesta conferma');
  } finally {
    await h.close();
  }
});
