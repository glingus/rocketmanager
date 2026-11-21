import { afterEach, beforeEach, describe, expect, it as test, vi } from 'vitest';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, startUpdateWatcher } from './UpdateWatcher';
import { useToastStore } from '../ui/toastStore';

describe('controllo automatico degli aggiornamenti', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clear();
  });
  afterEach(() => vi.useRealTimers());

  const api = (available: boolean, version = '0.1.3') => ({
    checkForUpdate: vi.fn().mockResolvedValue({ available, version: available ? version : null, notes: null, date: null }),
    installUpdate: vi.fn().mockResolvedValue(undefined),
  });

  test('propone la versione nuova una sola volta e installa solo al clic', async () => {
    const a = api(true);
    const stop = startUpdateWatcher(a);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(a.checkForUpdate).toHaveBeenCalledTimes(2);
    const items = useToastStore.getState().items.filter((t) => t.title.includes('0.1.3'));
    expect(items).toHaveLength(1);
    expect(items[0]!.duration).toBe(0);
    expect(a.installUpdate).not.toHaveBeenCalled();
    items[0]!.action!.onClick();
    expect(a.installUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  test('nessun avviso se non ci sono novità o se il controllo fallisce', async () => {
    const a = api(false);
    const b = { checkForUpdate: vi.fn().mockRejectedValue(new Error('offline')), installUpdate: vi.fn() };
    const s1 = startUpdateWatcher(a);
    const s2 = startUpdateWatcher(b);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(useToastStore.getState().items).toHaveLength(0);
    s1();
    s2();
  });

  test('chiama i timer del browser senza staccarli da window (niente "Illegal invocation")', () => {
    const real = { st: globalThis.setTimeout, si: globalThis.setInterval };
    const strict = <T extends (...a: never[]) => unknown>(f: T) =>
      function (this: unknown, ...a: Parameters<T>) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        return f.apply(globalThis, a);
      };
    globalThis.setTimeout = strict(real.st) as typeof setTimeout;
    globalThis.setInterval = strict(real.si) as typeof setInterval;
    try {
      const stop = startUpdateWatcher(api(false));
      stop();
    } finally {
      globalThis.setTimeout = real.st;
      globalThis.setInterval = real.si;
    }
  });
});
