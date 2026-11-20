import type { Backend } from '../backend/types';

export type ResolvedConfig = { url: string; anonKey: string; githubOrg: string };

/** The app has no Supabase address or key: nothing can work, and people need to be told how to fix it. */
export class ConfigMissingError extends Error {
  readonly code = 'config-missing';
  constructor(readonly sources: string[]) {
    super('Configurazione mancante: non sono impostati l\'indirizzo e la chiave pubblica di Supabase.');
    this.name = 'ConfigMissingError';
  }
}

type Env = { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string };

const clean = (v: string | undefined | null) => (typeof v === 'string' ? v.trim() : '');

/**
 * Single source of truth for the Supabase configuration. Precedence:
 *  1. `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (development, or a build that passes them to Vite);
 *  2. the shell's `get_public_config` (build-time ROCKETSYNC_* values and `config.json`), in the desktop app.
 * Throws {@link ConfigMissingError} when neither source has both values.
 */
export async function resolveConfig(env: Env, backend: Pick<Backend, 'kind' | 'getPublicConfig'>): Promise<ResolvedConfig> {
  const url = clean(env.VITE_SUPABASE_URL);
  const anonKey = clean(env.VITE_SUPABASE_ANON_KEY);
  const tried = ['VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY'];
  if (url && anonKey) return { url, anonKey, githubOrg: '' };

  tried.push(backend.kind === 'tauri' ? 'get_public_config (ROCKETSYNC_* e config.json)' : 'get_public_config (non disponibile fuori da Tauri)');
  try {
    const shell = await backend.getPublicConfig();
    const sUrl = clean(shell.supabaseUrl) || url;
    const sKey = clean(shell.supabaseAnonKey) || anonKey;
    if (sUrl && sKey) return { url: sUrl, anonKey: sKey, githubOrg: clean(shell.githubOrg) };
  } catch {
    /* an older shell without the command: same as "not configured" */
  }
  throw new ConfigMissingError(tried);
}
