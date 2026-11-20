#!/usr/bin/env node
// Configuratore guidato del backend di Rocket Sync.
// Porta da "organizzazione GitHub e progetto Supabase appena creati" a "backend pronto":
// GitHub App, accesso con GitHub, segreti, migrazioni, Vault ed Edge Functions.
// Node 20+, nessuna dipendenza. Vedi docs/configurazione-iniziale.md.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { HELP, normalizeRef, parseArgs, validateOrg, validateRef } from './lib/args.mjs';
import { Redactor, createLogger } from './lib/redact.mjs';
import { SetupError } from './lib/errors.mjs';
import { createPrompter } from './lib/prompt.mjs';
import { SupabaseApi, SUPABASE_API } from './lib/supabase-api.mjs';
import { GITHUB_API, appInstallUrl, appSettingsUrl, convertManifest, startManifestServer } from './lib/github-app.mjs';
import { buildAuthPatch } from './lib/auth-config.mjs';
import { applyMigrations } from './lib/migrations.mjs';
import { upsertVaultSecrets } from './lib/vault.mjs';
import { deployFunctions, runCommand } from './lib/deploy.mjs';
import { openBrowser as realOpenBrowser } from './lib/browser.mjs';
import { defaultStateDir, loadState, saveState } from './lib/state.mjs';
import { offerGhVariables, publicValues } from './lib/summary.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Segreti che le Edge Functions si aspettano (supabase/.env.example). */
export const APP_SECRET_NAMES = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_ORG',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
];

const TOTAL = 8;

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {object} deps dipendenze iniettabili (nei test sono finte)
 */
export async function runSetup(opts, deps = {}) {
  const redactor = deps.redactor ?? new Redactor();
  const log = deps.logger ?? createLogger({ redactor });
  const prompter = deps.prompter ?? createPrompter();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const openBrowser = deps.openBrowser ?? realOpenBrowser;
  const run = deps.run ?? runCommand;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const say = (msg, kind = 'info') => (log[kind] ?? log.info)(msg);

  // ---- 1. Dati e validazione del progetto ---------------------------------------------------
  log.step(1, TOTAL, 'Dati di partenza');
  let org = opts.org;
  while (validateOrg(org)) {
    if (org) log.warn(validateOrg(org));
    if (opts.si) throw new SetupError(validateOrg(org));
    org = await prompter.ask('Nome dell\'organizzazione GitHub (quella che ospiterà i repository dei progetti):');
  }
  let ref = opts.ref ? normalizeRef(opts.ref) : undefined;
  while (validateRef(ref)) {
    if (ref) log.warn(validateRef(ref));
    if (opts.si) throw new SetupError(validateRef(ref));
    ref = normalizeRef(await prompter.ask('Project ref di Supabase (20 lettere, o incolla l\'indirizzo del progetto):'));
  }
  let token = opts.accessToken;
  if (!token) {
    if (opts.si) throw new SetupError('Manca l\'access token di Supabase (variabile SUPABASE_ACCESS_TOKEN).');
    log.info('L\'access token si crea da supabase.com → Account → Access Tokens. Non viene mostrato né salvato.');
    token = await prompter.askHidden('Access token di Supabase (input nascosto):');
  }
  if (!token) throw new SetupError('Serve l\'access token di Supabase.');
  redactor.add(token);

  const api = deps.api ?? new SupabaseApi({ token, baseUrl: deps.supabaseBase ?? SUPABASE_API, fetchImpl, sleep: deps.sleep });
  const project = await api.getProject(ref);
  if (project?.status && project.status !== 'ACTIVE_HEALTHY') {
    log.warn(`Il progetto è nello stato ${project.status}: se è appena stato creato, aspetta che diventi attivo e rilancia.`);
    if (['INACTIVE', 'PAUSING', 'REMOVED', 'INIT_FAILED', 'RESTORE_FAILED'].includes(project.status)) {
      throw new SetupError(`Il progetto Supabase non è utilizzabile (stato ${project.status}).`, { hint: 'Ripristinalo dal pannello di Supabase e rilancia.' });
    }
  }
  log.ok(`progetto trovato: ${project?.name ?? ref}${project?.region ? ` (${project.region})` : ''}`);

  const state = await loadState(stateDir);
  state.org = org;
  state.ref = ref;
  state.steps ??= {};
  const persist = () => saveState(stateDir, state);

  // ---- 2. GitHub App ------------------------------------------------------------------------
  log.step(2, TOTAL, 'App GitHub');
  const existing = await api.listSecretNames(ref);
  const haveApp = APP_SECRET_NAMES.filter((n) => n !== 'GITHUB_ORG').every((n) => existing.has(n));
  /** @type {null | { id: number|string, slug: string, clientId: string, clientSecret: string, webhookSecret: string, pem: string, htmlUrl: string }} */
  let app = null;
  if (haveApp && !opts.nuovaApp) {
    log.skip('I segreti GITHUB_APP_* esistono già su Supabase: salto la creazione dell\'app (usa --nuova-app per rifarla).');
  } else {
    app = await registerGithubApp({ org, ref, opts, log, prompter, openBrowser, fetchImpl, githubApi: deps.githubApiBase ?? GITHUB_API, redactor, serverWaitMs: deps.serverWaitMs });
    state.app = { id: app.id, slug: app.slug, htmlUrl: app.htmlUrl };
    state.steps.app = true;
    state.steps.appInstalled = false;
    await persist();
    log.ok(`app creata: ${app.slug}`);
    await guideAppSetup({ app, org, opts, log, prompter, openBrowser });
    state.steps.appInstalled = true;
    await persist();
  }

  // ---- 3. Chiavi API ------------------------------------------------------------------------
  log.step(3, TOTAL, 'Chiavi API del progetto');
  const keys = await api.getApiKeys(ref);
  redactor.add(keys.serviceRole);
  redactor.allow(keys.anon); // pubblica: serve nel riepilogo
  log.ok('chiavi lette (la chiave service_role non viene mostrata né salvata)');

  // ---- 4. Accesso con GitHub ----------------------------------------------------------------
  log.step(4, TOTAL, 'Accesso con GitHub (Supabase Auth)');
  if (app) {
    let allowList = '';
    try {
      allowList = (await api.getAuthConfig(ref))?.uri_allow_list ?? '';
    } catch {
      /* se non si legge, si imposta l'elenco standard */
    }
    await api.updateAuthConfig(ref, buildAuthPatch({ existingAllowList: allowList, clientId: app.clientId, clientSecret: app.clientSecret }));
    state.steps.auth = true;
    await persist();
    log.ok('provider GitHub attivo, site URL e le dieci porte di ritorno configurati');
  } else if (state.steps.auth) {
    log.skip('già configurato in una esecuzione precedente');
  } else {
    log.warn('Non ho le credenziali dell\'app (il client secret si vede una volta sola): l\'accesso con GitHub potrebbe non essere configurato.');
    log.warn('Rilancia con --nuova-app per registrare di nuovo l\'app e configurare tutto.');
  }

  // ---- 5. Segreti delle Edge Functions ------------------------------------------------------
  log.step(5, TOTAL, 'Segreti delle Edge Functions');
  const secrets = [{ name: 'GITHUB_ORG', value: org }];
  if (app) {
    secrets.push(
      { name: 'GITHUB_APP_ID', value: String(app.id) },
      { name: 'GITHUB_APP_PRIVATE_KEY', value: app.pem },
      { name: 'GITHUB_WEBHOOK_SECRET', value: app.webhookSecret },
      { name: 'GITHUB_APP_CLIENT_ID', value: app.clientId },
      { name: 'GITHUB_APP_CLIENT_SECRET', value: app.clientSecret },
    );
  }
  await api.setSecrets(ref, secrets);
  state.steps.secrets = true;
  await persist();
  log.ok(`salvati su Supabase: ${secrets.map((s) => s.name).join(', ')}`);

  // ---- 6. Migrazioni e Vault ----------------------------------------------------------------
  log.step(6, TOTAL, 'Database: migrazioni e Vault');
  const result = await applyMigrations({
    api,
    ref,
    dir: join(repoRoot, 'supabase', 'migrations'),
    log: (m, kind) => say(m, kind === 'skip' ? 'skip' : 'ok'),
  });
  state.steps.migrations = true;
  await persist();
  log.info(`  migrazioni: ${result.applied.length} applicate, ${result.skipped.length} già presenti`);
  await upsertVaultSecrets({ api, ref, projectUrl: `https://${ref}.supabase.co`, serviceRoleKey: keys.serviceRole });
  state.steps.vault = true;
  await persist();
  log.ok('Vault: project_url e service_role_key aggiornati (per la coda Discord)');

  // ---- 7. Edge Functions --------------------------------------------------------------------
  log.step(7, TOTAL, 'Edge Functions');
  if (opts.senzaDeploy) {
    log.skip('saltato su richiesta (--senza-deploy)');
  } else {
    const fns = await deployFunctions({ run, repoRoot, ref, accessToken: token, log: (m, kind) => say(m, kind) });
    state.steps.functions = true;
    await persist();
    log.ok(`pubblicate: ${fns.join(', ')}`);
  }

  // ---- 8. Riepilogo -------------------------------------------------------------------------
  log.step(8, TOTAL, 'Riepilogo');
  const values = publicValues({ ref, org, anonKey: keys.anon });
  log.info('\nValori PUBBLICI per le variabili Actions del repository (Settings → Secrets and variables → Actions → Variables):');
  for (const [k, v] of Object.entries(values)) log.info(`  ${k} = ${v}`);
  log.info('\nAltre variabili del rilascio (non dipendono da questo configuratore): RELEASES_REPO, UPDATER_PUBKEY (vedi docs/installazione.md §8).');
  const gh = await offerGhVariables({ run, prompter, values, log: (m, kind) => say(m, kind === 'ok' ? 'ok' : 'warn'), assumeYes: opts.si, cwd: repoRoot });
  if (gh === 'non-disponibile') log.info('\n(gh non è installato o non è autenticato: imposta le tre variabili a mano dal sito di GitHub.)');
  if (gh === 'rifiutato') log.info('\nVariabili non impostate: fallo a mano dal sito di GitHub.');
  log.info('\nFatto. Prossimi passi: docs/configurazione-iniziale.md, dal §7 (installare l\'app e creare il primo progetto).');
  return { org, ref, app: app ? { id: app.id, slug: app.slug } : null, values, migrations: result };
}

async function registerGithubApp({ org, ref, opts, log, prompter, openBrowser, fetchImpl, githubApi, redactor, serverWaitMs }) {
  const server = await startManifestServer({ org, ref, waitMs: serverWaitMs });
  try {
    log.info('Sto per aprire GitHub nel browser per registrare l\'app nell\'organizzazione.');
    log.info('Accedi se richiesto e premi "Create GitHub App" nella pagina che si apre.');
    if (opts.senzaBrowser) {
      log.info(`Apri questo indirizzo nel browser: ${server.url}`);
    } else if (!(await openBrowser(server.url))) {
      log.warn(`Non riesco ad aprire il browser da solo. Apri questo indirizzo: ${server.url}`);
    }
    log.info('In attesa del ritorno da GitHub…');
    const code = await server.waitForCode();
    redactor.add(code);
    const app = await convertManifest({ code, apiBase: githubApi, fetchImpl });
    for (const v of [app.clientSecret, app.webhookSecret, app.pem]) redactor.add(v);
    return app;
  } finally {
    await server.close();
  }
}

/** Istruzioni manuali che GitHub non permette di fare dal manifest. */
async function guideAppSetup({ app, org, opts, log, prompter, openBrowser }) {
  const settings = appSettingsUrl(org, app.slug);
  const install = appInstallUrl(app.htmlUrl);
  log.info('\nDue passaggi da fare a mano su GitHub (il manifest non può farli al posto tuo):');
  log.info('  1) Impostazioni dell\'app: togli la spunta "Expire user authorization tokens" (sezione "Optional features"');
  log.info('     o "Identifying and authorizing users") e salva. Così Git funziona anche se Supabase è irraggiungibile.');
  log.info(`     ${settings}`);
  log.info('  2) Installa l\'app sull\'organizzazione scegliendo "All repositories".');
  log.info(`     ${install}`);
  if (!opts.senzaBrowser) {
    await openBrowser(settings);
    await openBrowser(install);
  }
  if (!opts.si) {
    await prompter.ask('Quando hai fatto entrambe le cose premi Invio per continuare…');
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}\n`);
    return 2;
  }
  if (opts.aiuto) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    process.stderr.write(`Serve Node 20 o più recente (hai ${process.versions.node}).\n`);
    return 2;
  }
  const redactor = new Redactor();
  const log = createLogger({ redactor });
  const prompter = createPrompter();
  try {
    log.info('Rocket Sync — configuratore del backend');
    await runSetup(opts, { redactor, logger: log, prompter });
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      log.error(`\nErrore: ${e.message}`);
      if (e.hint) log.error(e.hint);
    } else {
      log.error(`\nErrore imprevisto: ${e && e.message ? e.message : e}`);
    }
    log.error('\nPuoi rilanciare il configuratore: riparte dai passi non ancora completati.');
    return 1;
  } finally {
    prompter.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
