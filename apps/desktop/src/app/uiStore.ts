import { create } from 'zustand';

export type Progress = { projectId: string; op: string; step: string; percent: number | null; message: string };

type UiState = {
  notificationsOpen: boolean;
  setNotificationsOpen: (v: boolean) => void;
  /** Set while a sync error with code `network` is outstanding. */
  offlineSince: number | null;
  setOfflineSince: (v: number | null) => void;
  /** Latest progress per project, for link/publish/update operations. */
  progress: Record<string, Progress | undefined>;
  setProgress: (p: Progress) => void;
  clearProgress: (projectId: string) => void;
};

export const useUi = create<UiState>((set) => ({
  notificationsOpen: false,
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  offlineSince: null,
  setOfflineSince: (offlineSince) => set({ offlineSince }),
  progress: {},
  setProgress: (p) => set((s) => ({ progress: { ...s.progress, [p.projectId]: p } })),
  clearProgress: (projectId) =>
    set((s) => {
      const next = { ...s.progress };
      delete next[projectId];
      return { progress: next };
    }),
}));

/** Per-viewer conveniences kept in localStorage (never required to render). */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`rocketsync.${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`rocketsync.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
