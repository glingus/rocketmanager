import type { Backend } from './types';

export type { Backend, Unsubscribe } from './types';
export { toAppError } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function choose(): Promise<Backend> {
  const forced = import.meta.env.VITE_BACKEND;
  const useTauri = forced === 'tauri' || (forced !== 'mock' && isTauri());
  // Dynamic imports keep the simulator out of the initial bundle (and out of a Tauri build).
  if (useTauri) return (await import('./tauri')).tauriBackend;
  return (await import('./mock')).getMockBackend();
}

/** The IPC layer used by the whole UI: Tauri commands in the desktop app, in-memory mock otherwise. */
export const backend: Backend = await choose();
