import { backend } from '../backend';
import type { DataService } from './types';
import { getMockData } from './mock';
import { SupabaseData, readSupabaseConfig } from './supabase';

export type { DataService } from './types';

function chooseKind(): 'mock' | 'supabase' {
  const forced = import.meta.env.VITE_DATA;
  if (forced === 'mock' || forced === 'supabase') return forced;
  return backend.kind === 'mock' ? 'mock' : 'supabase';
}

function create(): DataService {
  if (chooseKind() === 'mock') return getMockData();
  const config = readSupabaseConfig();
  if (!config) {
    throw new Error('Configurazione mancante: imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (vedi .env.example).');
  }
  return new SupabaseData(config, backend);
}

/** The data layer used by the whole UI (Supabase, or the in-memory mock in development). */
export const data: DataService = create();
