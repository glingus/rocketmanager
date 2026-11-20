import { backend } from '../backend';
import type { DataService } from './types';
import { resolveConfig } from './config';

export type { DataService } from './types';
export { ConfigMissingError } from './config';

function chooseKind(): 'mock' | 'supabase' {
  const forced = import.meta.env.VITE_DATA;
  if (forced === 'mock' || forced === 'supabase') return forced;
  return backend.kind === 'mock' ? 'mock' : 'supabase';
}

async function create(): Promise<DataService> {
  if (chooseKind() === 'mock') return (await import('./mock')).getMockData();
  const config = await resolveConfig(import.meta.env, backend);
  const { SupabaseData } = await import('./supabase');
  return new SupabaseData({ url: config.url, anonKey: config.anonKey }, backend);
}

/**
 * The data layer used by the whole UI (Supabase, or the in-memory mock in development).
 * Creating it can fail (missing configuration): `main.tsx` imports the app dynamically and shows
 * a readable error screen instead of an empty window.
 */
export const data: DataService = await create();
