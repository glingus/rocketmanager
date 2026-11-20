import { describe, expect, it, vi } from 'vitest';
import { ConfigMissingError, resolveConfig } from './config';
import type { PublicConfig } from '../types/ipc';

const shell = (cfg: Partial<PublicConfig> | Error, kind: 'tauri' | 'mock' = 'tauri') => ({
  kind,
  getPublicConfig: vi.fn(async (): Promise<PublicConfig> => {
    if (cfg instanceof Error) throw cfg;
    return { supabaseUrl: '', supabaseAnonKey: '', githubOrg: '', ...cfg };
  }),
});

describe('resolveConfig: precedence of the configuration sources', () => {
  it('uses VITE_* when both are set, without asking the shell', async () => {
    const b = shell({ supabaseUrl: 'https://shell.supabase.co', supabaseAnonKey: 'shell-key' });
    const c = await resolveConfig({ VITE_SUPABASE_URL: 'https://env.supabase.co', VITE_SUPABASE_ANON_KEY: 'env-key' }, b);
    expect(c).toMatchObject({ url: 'https://env.supabase.co', anonKey: 'env-key' });
    expect(b.getPublicConfig).not.toHaveBeenCalled();
  });

  it('falls back to get_public_config when the VITE_* variables are absent or blank', async () => {
    const b = shell({ supabaseUrl: ' https://shell.supabase.co ', supabaseAnonKey: 'shell-key', githubOrg: 'rocket-team' });
    expect(await resolveConfig({}, b)).toEqual({ url: 'https://shell.supabase.co', anonKey: 'shell-key', githubOrg: 'rocket-team' });
    expect(await resolveConfig({ VITE_SUPABASE_URL: '  ', VITE_SUPABASE_ANON_KEY: '' }, b)).toMatchObject({ url: 'https://shell.supabase.co' });
  });

  it('completes a partial VITE_* configuration with the shell values', async () => {
    const b = shell({ supabaseAnonKey: 'shell-key' });
    expect(await resolveConfig({ VITE_SUPABASE_URL: 'https://env.supabase.co' }, b)).toMatchObject({ url: 'https://env.supabase.co', anonKey: 'shell-key' });
  });

  it('throws ConfigMissingError when no source has both values', async () => {
    await expect(resolveConfig({}, shell({}))).rejects.toBeInstanceOf(ConfigMissingError);
    await expect(resolveConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' }, shell({ supabaseUrl: 'https://y.supabase.co' }))).rejects.toBeInstanceOf(ConfigMissingError);
  });

  it('treats an older shell without the command (invoke rejects) as "not configured"', async () => {
    const err = await resolveConfig({}, shell(new Error('command get_public_config not found'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigMissingError);
    expect((err as ConfigMissingError).sources.join(' ')).toContain('get_public_config');
  });
});
