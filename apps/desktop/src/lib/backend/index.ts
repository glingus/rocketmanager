import type { Backend } from './types';
import { getMockBackend } from './mock';
import { tauriBackend } from './tauri';

export type { Backend, Unsubscribe } from './types';
export { toAppError } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function choose(): Backend {
  const forced = import.meta.env.VITE_BACKEND;
  if (forced === 'tauri') return tauriBackend;
  if (forced === 'mock') return getMockBackend();
  return isTauri() ? tauriBackend : getMockBackend();
}

/** The IPC layer used by the whole UI: Tauri commands in the desktop app, in-memory mock otherwise. */
export const backend: Backend = choose();
