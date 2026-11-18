import { create } from 'zustand';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export type ToastItem = {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  /** ms; 0 = stays until dismissed */
  duration: number;
};

type ToastState = {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'duration'> & { duration?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
};

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (t) => {
    const id = nextId++;
    const duration = t.duration ?? (t.tone === 'error' ? 8000 : 5000);
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id, duration }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

type Opts = { message?: string; action?: ToastItem['action']; duration?: number };

/** Imperative toast API: `toast.success('Fatto')`. */
export const toast = {
  success: (title: string, o: Opts = {}) => useToastStore.getState().push({ tone: 'success', title, ...o }),
  info: (title: string, o: Opts = {}) => useToastStore.getState().push({ tone: 'info', title, ...o }),
  warning: (title: string, o: Opts = {}) => useToastStore.getState().push({ tone: 'warning', title, ...o }),
  error: (title: string, o: Opts = {}) => useToastStore.getState().push({ tone: 'error', title, ...o }),
};
