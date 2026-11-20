// Test dei moduli puri del configuratore: node --test scripts/setup/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP, normalizeRef, parseArgs, validateOrg, validateRef } from './lib/args.mjs';
import { Redactor, createLogger } from './lib/redact.mjs';
import { SetupError, githubHttpError, supabaseHttpError } from './lib/errors.mjs';
import { SupabaseApi } from './lib/supabase-api.mjs';
import { ENSURE_HISTORY_SQL, applyMigrations, buildMigrationSql, listMigrationFiles, parseMigrationName, sqlString } from './lib/migrations.mjs';
import { vaultUpsertSql } from './lib/vault.mjs';
import { LOOPBACK_PORTS, buildAuthPatch, loopbackUrls, mergeAllowList } from './lib/auth-config.mjs';
import { APP_PERMISSIONS, appInstallUrl, appName, appSettingsUrl, buildManifest, convertManifest, manifestFormAction, startManifestServer } from './lib/github-app.mjs';
import { EXPECTED_FUNCTIONS, SUPABASE_CLI_VERSION, buildDeployCommand, findNpxCli, listFunctions, runCommand } from './lib/deploy.mjs';
import { defaultStateDir, loadState, saveState, sanitizeState, STATE_FILE } from './lib/state.mjs';
import { VARIABLE_NAMES, offerGhVariables, publicValues } from './lib/summary.mjs';
import { openCommand } from './lib/browser.mjs';
import { FAKE, startFakeGithub, startFakeSupabase } from './fakes.mjs';
import { REPO_ROOT } from './setup-backend.mjs';

const MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');

test('argomenti: opzioni, variabili d\'ambiente e errori', () => {
  const o = parseArgs(['--org', 'mia-org', '--ref=' + FAKE.ref, '--nuova-app', '--senza-deploy', '--si'], { SUPABASE_ACCESS_TOKEN: 'tok' });
  assert.equal(o.org, 'mia-org');
  assert.equal(o.ref, FAKE.ref);
  assert.equal(o.accessToken, 'tok');
  assert.equal(o.nuovaApp, true);
  assert.equal(o.senzaDeploy, true);
  assert.equal(o.si, true);
  assert.equal(parseArgs([], { GITHUB_ORG: 'x', SUPABASE_PROJECT_REF: 'r' }).org, 'x');
  assert.throws(() => parseArgs(['--boh']), /Opzione sconosciuta/);
  assert.throws(() => parseArgs(['--org']), /Manca il valore/);
  assert.match(HELP, /non scrive mai i segreti/);
});

test('validazione di organizzazione e ref, ref estratto da un indirizzo', () => {
  assert.equal(validateOrg('rocket-team'), null);
  assert.match(validateOrg('-no'), /non è valido/);
  assert.match(validateOrg('due parole'), /non è valido/);
  assert.equal(validateRef(FAKE.ref), null);
  assert.match(validateRef('ABC'), /20 lettere/);
  assert.equal(normalizeRef(`https://supabase.com/dashboard/project/${FAKE.ref}/settings`), FAKE.ref);
  assert.equal(normalizeRef(`https://${FAKE.ref}.supabase.co`), FAKE.ref);
  assert.equal(normalizeRef('  ' + FAKE.ref + ' '), FAKE.ref);
});

test('il manifest contiene esattamente ciò che chiede il piano', () => {
  const m = buildManifest({ org: 'mia-org', ref: FAKE.ref, port: 51234 });
  assert.equal(m.name, 'Rocket Sync mia-org');
  assert.equal(m.hook_attributes.url, `https://${FAKE.ref}.supabase.co/functions/v1/github-webhook`);
  assert.equal(m.hook_attributes.active, true);
  assert.equal(m.redirect_url, 'http://127.0.0.1:51234/creata');
  assert.deepEqual(m.callback_urls, [`https://${FAKE.ref}.supabase.co/auth/v1/callback`]);
  assert.equal(m.request_oauth_on_install, false);
  assert.equal(m.public, false);
  assert.deepEqual(m.default_permissions, { administration: 'write', contents: 'write', metadata: 'read', members: 'write' });
  assert.deepEqual(m.default_events, ['push']);
  assert.equal(typeof m.url, 'string');
  assert.deepEqual(APP_PERMISSIONS, m.default_permissions);
  assert.ok(appName('un-nome-di-organizzazione-lunghissimo-davvero').length <= 34);
  assert.equal(manifestFormAction('mia org', 'abc'), 'https://github.com/organizations/mia%20org/settings/apps/new?state=abc');
  assert.equal(appSettingsUrl('o', 's'), 'https://github.com/organizations/o/settings/apps/s');
  assert.equal(appInstallUrl('https://github.com/apps/s/'), 'https://github.com/apps/s/installations/new');
});

test('accesso: dieci porte di ritorno, site URL e elenco esistente conservato', () => {
  assert.deepEqual(LOOPBACK_PORTS, [53682, 53683, 53684, 53685, 53686, 53687, 53688, 53689, 53690, 53691]);
  assert.equal(loopbackUrls().length, 10);
  const patch = buildAuthPatch({ existingAllowList: 'https://esempio.it/callback, http://127.0.0.1:53682/callback', clientId: 'id', clientSecret: 'sec' });
  assert.equal(patch.site_url, 'http://127.0.0.1:53682/callback');
  assert.equal(patch.external_github_enabled, true);
  assert.equal(patch.external_github_client_id, 'id');
  const list = patch.uri_allow_list.split(',');
  assert.equal(list.length, 11, 'esistente + dieci, senza duplicati');
  assert.ok(list.includes('https://esempio.it/callback'));
  assert.ok(list.includes('http://127.0.0.1:53691/callback'));
  assert.equal(mergeAllowList(undefined).split(',').length, 10);
});

test('migrazioni: file in ordine, nome e versione come la CLI', async () => {
  const files = await listMigrationFiles(MIGRATIONS);
  assert.equal(files.length, 6);
  assert.deepEqual(files.map((f) => f.version), [...files.map((f) => f.version)].sort());
  assert.equal(files[0].version, '20261101000001');
  assert.equal(files[0].name, 'types_and_catalog');
  assert.deepEqual(parseMigrationName('20261101000002_tables.sql'), { version: '20261101000002', name: 'tables' });
  assert.equal(parseMigrationName('tables.sql'), null);
  assert.match(ENSURE_HISTORY_SQL, /supabase_migrations\.schema_migrations \(version text not null primary key\)/);
  const sql = buildMigrationSql({ version: '1', name: "n'x", sql: "select 'a';" });
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;$/);
  assert.match(sql, /insert into supabase_migrations\.schema_migrations \(version, name, statements\)/);
  assert.match(sql, /values \('1', 'n''x', array\['select ''a'';'\]\)/);
  assert.equal(sqlString("it's"), "'it''s'");
  assert.throws(() => sqlString('a\0b'), SetupError);
});

test('migrazioni: applicate in ordine, una transazione per file, già presenti saltate', async () => {
  const sb = await startFakeSupabase({ appliedVersions: ['20261101000001', '20261101000002'] });
  try {
    const api = new SupabaseApi({ token: FAKE.token, baseUrl: sb.baseUrl });
    const events = [];
    const r = await applyMigrations({ api, ref: FAKE.ref, dir: MIGRATIONS, log: (m, k) => events.push([k, m]) });
    assert.equal(r.skipped.length, 2);
    assert.equal(r.applied.length, 4);
    assert.deepEqual(r.applied, ['20261101000003_triggers.sql', '20261101000004_functions.sql', '20261101000005_rls_and_grants.sql', '20261101000006_storage_realtime_cron.sql']);
    const txs = sb.st.queries.filter((q) => q.startsWith('begin;'));
    assert.equal(txs.length, 4);
    for (const q of txs) assert.ok(q.trimEnd().endsWith('commit;'));
    // seconda esecuzione: tutto saltato, nessuna transazione nuova
    const r2 = await applyMigrations({ api, ref: FAKE.ref, dir: MIGRATIONS });
    assert.equal(r2.applied.length, 0);
    assert.equal(r2.skipped.length, 6);
    assert.equal(sb.st.queries.filter((q) => q.startsWith('begin;')).length, 4);
  } finally {
    await sb.close();
  }
});

test('migrazioni: un errore SQL ferma tutto con un messaggio in italiano e si riparte da lì', async () => {
  const sb = await startFakeSupabase({ failMigration: 'triggers' });
  try {
    const api = new SupabaseApi({ token: FAKE.token, baseUrl: sb.baseUrl });
    await assert.rejects(
      () => applyMigrations({ api, ref: FAKE.ref, dir: MIGRATIONS }),
      (e) => {
        assert.ok(e instanceof SetupError);
        assert.match(e.message, /La migrazione 20261101000003_triggers\.sql non è riuscita/);
        assert.match(e.message, /Il database ha rifiutato l'operazione/);
        assert.match(e.message, /syntax error/);
        assert.match(e.hint, /annullata \(transazione\)/);
        return true;
      },
    );
    assert.deepEqual([...sb.st.appliedVersions].sort(), ['20261101000001', '20261101000002']);
    sb.st.failMigration = null;
    const r = await applyMigrations({ api, ref: FAKE.ref, dir: MIGRATIONS });
    assert.equal(r.skipped.length, 2);
    assert.equal(r.applied.length, 4);
  } finally {
    await sb.close();
  }
});

test('Vault: crea o aggiorna project_url e service_role_key con gli apici protetti', () => {
  const sql = vaultUpsertSql('project_url', "https://x'y");
  assert.match(sql, /vault\.create_secret\('https:\/\/x''y', 'project_url'\)/);
  assert.match(sql, /vault\.update_secret\(v_id, 'https:\/\/x''y', 'project_url'\)/);
  assert.match(sql, /where name = 'project_url'/);
});

test('errori HTTP tradotti in messaggi italiani chiari', () => {
  assert.match(supabaseHttpError(401, {}, 'x').message, /access token di Supabase non è valido/);
  assert.match(supabaseHttpError(403, {}, 'segreti').message, /non ha i permessi/);
  assert.match(supabaseHttpError(404, {}, 'lettura del progetto').message, /ref del progetto/);
  assert.match(supabaseHttpError(429, {}, 'x').message, /troppe in poco tempo/);
  assert.match(supabaseHttpError(503, { message: 'down' }, 'x').message, /errore interno.*down/);
  assert.match(githubHttpError(404, {}).message, /è scaduto .* già stato usato/);
  assert.match(githubHttpError(422, { message: 'Name already exists' }).message, /Name already exists/);
  assert.match(githubHttpError(422, {}).hint, /nome è già in uso/);
});

test('API Supabase: 401, 404, 429 con nuovi tentativi, rete assente, chiavi mancanti', async () => {
  const sb = await startFakeSupabase({ rateLimitFirst: 2 });
  try {
    const api = new SupabaseApi({ token: FAKE.token, baseUrl: sb.baseUrl, sleep: async () => {} });
    const p = await api.getProject(FAKE.ref);
    assert.equal(p.name, 'Rocket Sync', 'dopo due 429 la richiesta riesce');
    const bad = new SupabaseApi({ token: 'sbp_sbagliato_sbagliato_sbagliato', baseUrl: sb.baseUrl });
    await assert.rejects(() => bad.getProject(FAKE.ref), /access token di Supabase non è valido/);
    await assert.rejects(() => api.getProject('zzzzzzzzzzzzzzzzzzzz'), /ref del progetto/);
    const keys = await api.getApiKeys(FAKE.ref);
    assert.equal(keys.anon, FAKE.anon);
    assert.equal(keys.serviceRole, FAKE.serviceRole);
    sb.st.legacyKeys = false;
    await assert.rejects(() => api.getApiKeys(FAKE.ref), /chiavi API "anon" e "service_role"/);
    const limited = new SupabaseApi({ token: FAKE.token, baseUrl: sb.baseUrl, sleep: async () => {}, maxRetries: 1 });
    sb.st.rateLimitFirst = 5;
    await assert.rejects(() => limited.getProject(FAKE.ref), /troppe in poco tempo/);
  } finally {
    await sb.close();
  }
  const offline = new SupabaseApi({ token: 'x', baseUrl: 'http://127.0.0.1:1', sleep: async () => {} });
  await assert.rejects(() => offline.getProject(FAKE.ref), /Non riesco a raggiungere 127\.0\.0\.1:1/);
});

test('server del manifest: state errato rifiutato, Host estraneo rifiutato, state giusto accettato', async () => {
  const server = await startManifestServer({ org: 'mia-org', ref: FAKE.ref, waitMs: 5000 });
  try {
    const get = (path, host) =>
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server.port, path, headers: host ? { Host: host } : {} }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      });
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /settings\/apps\/new\?state=/);
    assert.match(page.headers['content-security-policy'], /form-action https:\/\/github\.com/);
    assert.equal((await get('/creata?code=c&state=SBAGLIATO')).status, 400);
    assert.equal((await get('/creata?code=c')).status, 400);
    assert.equal((await get('/', 'evil.example.com')).status, 400, 'protezione da DNS rebinding');
    assert.equal(server.stats.badState, 2);
    const racing = server.waitForCode();
    const ok = await get(`/creata?code=il-codice&state=${server.state}`);
    assert.equal(ok.status, 200);
    assert.equal(await racing, 'il-codice');
  } finally {
    await server.close();
  }
});

test('server del manifest: scadenza e annullamento da parte di GitHub', async () => {
  const s1 = await startManifestServer({ org: 'o', ref: FAKE.ref, waitMs: 50 });
  await assert.rejects(() => s1.waitForCode(), /Tempo scaduto/);
  await s1.close();
  const s2 = await startManifestServer({ org: 'o', ref: FAKE.ref, waitMs: 5000 });
  const check = assert.rejects(() => s2.waitForCode(), /GitHub ha annullato/);
  await fetch(`${s2.url}creata?error=access_denied`);
  await check;
  await s2.close();
});

test('conversione del manifest: credenziali, codice scaduto, risposta incompleta', async () => {
  const gh = await startFakeGithub();
  try {
    const app = await convertManifest({ code: FAKE.github.code, apiBase: gh.baseUrl });
    assert.equal(app.id, FAKE.github.id);
    assert.equal(app.slug, FAKE.github.slug);
    assert.equal(app.clientId, FAKE.github.clientId);
    assert.equal(app.pem, FAKE.github.pem);
    await assert.rejects(() => convertManifest({ code: FAKE.github.code, apiBase: gh.baseUrl }), /scaduto .* già stato usato/);
    await assert.rejects(() => convertManifest({ code: 'altro', apiBase: gh.baseUrl }), /scaduto/);
  } finally {
    await gh.close();
  }
  const gh2 = await startFakeGithub({ incomplete: true });
  try {
    await assert.rejects(() => convertManifest({ code: FAKE.github.code, apiBase: gh2.baseUrl }), /incompleta \(manca "client_id"\)/);
  } finally {
    await gh2.close();
  }
});

test('Edge Functions: CLI fissata, --project-ref e --use-api, le 7 funzioni presenti', async () => {
  assert.match(SUPABASE_CLI_VERSION, /^\d+\.\d+\.\d+$/, 'versione esatta, non un intervallo');
  const fns = await listFunctions(REPO_ROOT);
  assert.deepEqual(fns, [...EXPECTED_FUNCTIONS].sort());
  assert.equal(fns.length, 7);
  const c = buildDeployCommand({ ref: FAKE.ref, functions: fns, platform: 'linux', execPath: '/opt/node/bin/node', exists: (f) => f === '/opt/node/lib/node_modules/npm/bin/npx-cli.js' });
  assert.equal(c.cmd, '/opt/node/bin/node', 'Node stesso esegue npx-cli.js');
  assert.equal(c.shell, false);
  assert.equal(c.args[0], '/opt/node/lib/node_modules/npm/bin/npx-cli.js');
  assert.ok(c.args.includes(`supabase@${SUPABASE_CLI_VERSION}`));
  assert.ok(c.args.includes('--use-api'));
  assert.equal(c.args[c.args.indexOf('--project-ref') + 1], FAKE.ref);
  // Windows: npx-cli.js accanto a node.exe, nessuna shell (niente DEP0190)
  const w = buildDeployCommand({ ref: FAKE.ref, functions: fns, platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: (f) => f === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js' });
  assert.equal(w.cmd, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(w.shell, false);
  assert.equal(w.args[0], 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
  // ripiego se npx-cli.js non si trova
  const f = buildDeployCommand({ ref: FAKE.ref, functions: fns, platform: 'win32', execPath: 'D:\\n\\node.exe', exists: () => false });
  assert.equal(f.cmd, 'npx.cmd');
  assert.equal(f.shell, true);
  assert.equal(buildDeployCommand({ ref: FAKE.ref, functions: fns, platform: 'linux', execPath: '/x/node', exists: () => false }).cmd, 'npx');
  assert.throws(() => buildDeployCommand({ ref: 'x; rm -rf', functions: [] }), SetupError);
  assert.throws(() => buildDeployCommand({ ref: FAKE.ref, functions: ['a b'] }), SetupError);
});

test('stato non segreto: percorso per sistema operativo, campi ripuliti', async () => {
  assert.match(defaultStateDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }), /RocketSync$/);
  assert.match(defaultStateDir('linux', { XDG_CONFIG_HOME: '/x' }), /\/x\/RocketSync$/);
  assert.match(defaultStateDir('darwin', {}), /Application Support\/RocketSync$/);
  const dirty = { org: 'o', ref: 'r', app: { id: 1, slug: 's', htmlUrl: 'u', clientSecret: 'SEGRETO', pem: 'SEGRETO' }, steps: {}, clientSecret: 'SEGRETO' };
  const clean = sanitizeState(dirty);
  assert.equal(JSON.stringify(clean).includes('SEGRETO'), false);
  const dir = await mkdtemp(join(tmpdir(), 'rs-state-'));
  await saveState(dir, dirty);
  assert.deepEqual(await readdir(dir), [STATE_FILE]);
  const loaded = await loadState(dir);
  assert.equal(loaded.app.slug, 's');
  assert.equal((await readFile(join(dir, STATE_FILE), 'utf8')).includes('SEGRETO'), false);
  assert.deepEqual((await loadState(join(dir, 'nuova'))).steps, {});
});

test('Redactor e logger: nessun segreto in uscita, nemmeno a pezzi o nei messaggi d\'errore', () => {
  const red = new Redactor();
  red.add(FAKE.github.clientSecret);
  red.add(FAKE.github.pem);
  const out = [];
  const err = [];
  const log = createLogger({ redactor: red, out: (s) => out.push(s), err: (s) => err.push(s) });
  log.info(`il segreto è ${FAKE.github.clientSecret}`);
  log.warn(`chiave: ${FAKE.github.pem}`);
  log.error(`riga: SECRETLINEsecretlineSECRETLINEsecretline1234`);
  log.info(`token sbp_abcdefghijklmnopqrstuvwxyz0123 e JWT ${FAKE.serviceRole} e ghp_abcdefghijklmnopqrstuvwxyz0123456789`);
  const all = out.join('') + err.join('');
  for (const s of [FAKE.github.clientSecret, 'MIIEowIBAAK', 'SECRETLINE', 'sbp_abcdefghij', 'SERVICE_ROLE_SECRET_SIG', 'ghp_abcdefghij']) {
    assert.equal(all.includes(s), false, `non deve comparire: ${s}`);
  }
  assert.match(all, /\*\*\*/);
});

test('Redactor: un valore dichiarato pubblico resta leggibile, un segreto mai', () => {
  const red = new Redactor();
  red.allow(FAKE.anon);
  red.add(FAKE.serviceRole);
  red.allow(FAKE.serviceRole); // ignorato: è un segreto
  const t = red.clean(`anon ${FAKE.anon} service ${FAKE.serviceRole}`);
  assert.ok(t.includes(FAKE.anon));
  assert.equal(t.includes('SERVICE_ROLE_SECRET_SIG'), false);
});

test('riepilogo: valori pubblici e gh variable set solo con conferma', async () => {
  const values = publicValues({ ref: FAKE.ref, org: 'mia-org', anonKey: FAKE.anon });
  assert.deepEqual(Object.keys(values), VARIABLE_NAMES);
  assert.equal(values.SUPABASE_URL, `https://${FAKE.ref}.supabase.co`);
  assert.equal(values.PROJECTS_ORG, 'mia-org');
  assert.equal(JSON.stringify(values).includes('SERVICE_ROLE'), false);

  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'repo') return { code: 0, stdout: 'team/rocket\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const logs = [];
  const no = { confirm: async () => false };
  assert.equal(await offerGhVariables({ run, prompter: no, values, log: (m) => logs.push(m) }), 'rifiutato');
  assert.equal(calls.filter((c) => c[1] === 'variable').length, 0, 'nessuna scrittura senza conferma');
  const yes = { confirm: async () => true };
  assert.equal(await offerGhVariables({ run, prompter: yes, values, log: (m) => logs.push(m) }), 'impostate');
  const sets = calls.filter((c) => c[1] === 'variable');
  assert.equal(sets.length, 3);
  assert.deepEqual(sets[0], ['gh', 'variable', 'set', 'SUPABASE_URL', '--body', values.SUPABASE_URL, '--repo', 'team/rocket']);
  const missing = async () => ({ code: 127, stdout: '', stderr: '' });
  assert.equal(await offerGhVariables({ run: missing, prompter: yes, values, log: () => {} }), 'non-disponibile');
});

test('apertura del browser: comando per sistema operativo', () => {
  assert.equal(openCommand('http://x', 'win32').cmd, 'rundll32');
  assert.equal(openCommand('http://x', 'darwin').cmd, 'open');
  assert.equal(openCommand('http://x', 'linux').cmd, 'xdg-open');
});

test('Edge Functions: su questa macchina npx-cli.js si trova e parte davvero, senza shell e senza avvisi', async () => {
  const cli = findNpxCli();
  assert.ok(cli, 'npx-cli.js accanto a Node');
  const r = await runCommand(process.execPath, [cli, '--version'], { env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }, shell: false });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(/DEP0190|DeprecationWarning/.test(r.stderr), false);
});
