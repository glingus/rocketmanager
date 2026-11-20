// Pubblicazione delle Edge Functions con la CLI di Supabase a versione fissata.
// Verificato: `npx supabase@2.122.1 functions deploy --help` mostra --project-ref e --use-api
// ("Bundle functions server-side without using Docker"). La versione 3.x usa --remote al posto
// di --project-ref, perciò si fissa la 2.122.1 (dist-tag npm `v2.stable`).

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { REF_RE } from './args.mjs';
import { SetupError } from './errors.mjs';

export const SUPABASE_CLI_VERSION = '2.122.1';

export const EXPECTED_FUNCTIONS = [
  'create-project',
  'manage-members',
  'accept-invitations',
  'github-webhook',
  'discord-settings',
  'discord-dispatch',
  'github-token-refresh',
];

/** Le funzioni presenti in supabase/functions (cartelle con index.ts, `_shared` escluso). */
export async function listFunctions(repoRoot) {
  const dir = join(repoRoot, 'supabase', 'functions');
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(dir, e.name, 'index.ts')))
    .map((e) => e.name)
    .sort();
}

export function buildDeployCommand({ ref, functions, platform = process.platform }) {
  if (!REF_RE.test(ref)) throw new SetupError('Project ref non valido.', { code: 'args' });
  for (const f of functions) if (!/^[a-z0-9-]+$/.test(f)) throw new SetupError(`Nome di funzione non valido: ${f}`, { code: 'args' });
  return {
    cmd: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'functions', 'deploy', ...functions, '--project-ref', ref, '--use-api'],
    shell: platform === 'win32', // i .cmd richiedono la shell su Windows; gli argomenti sono validati sopra
  };
}

/** Esecuzione reale: restituisce { code, stdout, stderr }. */
export function runCommand(cmd, args, { cwd, env, shell = false } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, stdout, stderr: String(e.message) });
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function deployFunctions({ run, repoRoot, ref, accessToken, platform = process.platform, log = () => {} }) {
  const functions = await listFunctions(repoRoot);
  const missing = EXPECTED_FUNCTIONS.filter((f) => !functions.includes(f));
  if (missing.length) {
    throw new SetupError(`Mancano delle Edge Functions in supabase/functions: ${missing.join(', ')}.`, { code: 'functions-missing' });
  }
  const { cmd, args, shell } = buildDeployCommand({ ref, functions, platform });
  log(`pubblico ${functions.length} funzioni con la CLI di Supabase ${SUPABASE_CLI_VERSION} (può richiedere un minuto)…`, 'info');
  const env = { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken, SUPABASE_YES: '1' };
  const r = await run(cmd, args, { cwd: repoRoot, env, shell });
  if (r.code !== 0) {
    const tail = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-8).join('\n');
    throw new SetupError('La pubblicazione delle Edge Functions non è riuscita.', {
      code: 'functions-deploy',
      hint: `Controlla la connessione e che Node 20+ possa scaricare la CLI (npx). Ultime righe:\n${tail}`,
    });
  }
  return functions;
}
