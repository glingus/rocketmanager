import { describe, expect, it as test, vi } from 'vitest';
import { SupabaseData, jwtSubject } from './supabase';
import type { Backend } from '../backend/types';

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (sub: string) => `${b64({ alg: 'HS256' })}.${b64({ sub, role: 'authenticated' })}.firma`;

function tauriBackend(next: { accessToken: string; refreshToken: string; expiresAt: number }) {
  return {
    kind: 'tauri',
    authStatus: vi.fn().mockResolvedValue({ signedIn: true, user: null, supabaseSession: next }),
    secureStoreDelete: vi.fn().mockResolvedValue(undefined),
  } as unknown as Backend & { authStatus: ReturnType<typeof vi.fn> };
}

describe('sessione Supabase nell\'app desktop', () => {
  test('jwtSubject legge l\'utente dal token', () => {
    expect(jwtSubject(jwt('11111111-2222-3333-4444-555555555555'))).toBe('11111111-2222-3333-4444-555555555555');
    expect(jwtSubject('non-un-token')).toBeNull();
  });

  test('supabase-js non rinnova da solo: chiede alla shell, una volta sola anche con più richieste', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = { accessToken: jwt('u-2'), refreshToken: 'r-2', expiresAt: now + 3600 };
    const backend = tauriBackend(fresh);
    const data = new SupabaseData({ url: 'https://esempio.supabase.co', anonKey: 'anon' }, backend);
    const token = () => (data as unknown as { accessToken(): Promise<string | null> }).accessToken();

    expect(await token()).toBeNull(); // not signed in
    await data.setSession({ accessToken: jwt('u-1'), refreshToken: 'r-1', expiresAt: now + 3600 });
    expect(await token()).toBe(jwt('u-1'));
    expect(backend.authStatus).not.toHaveBeenCalled();

    // about to expire: the shell renews it, concurrent callers share one call
    await data.setSession({ accessToken: jwt('u-1'), refreshToken: 'r-1', expiresAt: now + 30 });
    const [a, b] = await Promise.all([token(), token()]);
    expect(a).toBe(fresh.accessToken);
    expect(b).toBe(fresh.accessToken);
    expect(backend.authStatus).toHaveBeenCalledTimes(1);
    expect(backend.secureStoreDelete).toHaveBeenCalledWith('rocketsync-auth');
  });
});
