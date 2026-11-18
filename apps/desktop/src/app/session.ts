import { create } from 'zustand';
import type { AuthStatus } from '../lib/types/ipc';

const ONBOARDED_KEY = 'rocketsync.onboarded';

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

type SessionState = {
  /** null until the first auth_status answer. */
  auth: AuthStatus | null;
  booting: boolean;
  onboarded: boolean;
  setAuth: (a: AuthStatus) => void;
  setBooted: () => void;
  setOnboarded: (v: boolean) => void;
};

export const useSession = create<SessionState>((set) => ({
  auth: null,
  booting: true,
  onboarded: readOnboarded(),
  setAuth: (auth) => set({ auth }),
  setBooted: () => set({ booting: false }),
  setOnboarded: (onboarded) => {
    try {
      localStorage.setItem(ONBOARDED_KEY, onboarded ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    set({ onboarded });
  },
}));
