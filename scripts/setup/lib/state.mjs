// Stato NON segreto del configuratore (passi completati, id e slug dell'app) nella cartella
// dati dell'utente. I segreti non vengono mai scritti qui.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStateDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'RocketSync');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'RocketSync');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'RocketSync');
}

export const STATE_FILE = 'setup-backend.json';

const SAFE_KEYS = new Set(['version', 'org', 'ref', 'app', 'steps', 'updatedAt']);

/** Toglie qualunque campo che non sia nell'elenco dei campi pubblici noti. */
export function sanitizeState(state) {
  const out = {};
  for (const k of Object.keys(state)) if (SAFE_KEYS.has(k)) out[k] = state[k];
  if (out.app) out.app = { id: out.app.id, slug: out.app.slug, htmlUrl: out.app.htmlUrl };
  return out;
}

export async function loadState(dir) {
  try {
    return JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
  } catch {
    return { version: 1, steps: {} };
  }
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  const clean = sanitizeState({ ...state, version: 1, updatedAt: new Date().toISOString() });
  await writeFile(join(dir, STATE_FILE), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
}
