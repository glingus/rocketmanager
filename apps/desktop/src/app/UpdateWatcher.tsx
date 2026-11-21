import { useEffect } from 'react';
import { backend, type Backend } from '../lib/backend';
import { toast } from '../ui';
import { it } from '../i18n/it';
import { errorMessage } from './errors';

/** First check shortly after start, then every 6 hours. */
export const FIRST_CHECK_MS = 15_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Checks for a new version of Rocket Sync on its own and offers it with a toast
 * ("Installa e riavvia"). It never installs without a click: a restart in the middle of work
 * would be a surprise. Each version is offered once per session; failures stay silent
 * (offline, release server unreachable) - the manual check in Settings shows them.
 */
export function startUpdateWatcher(api: Pick<Backend, 'checkForUpdate' | 'installUpdate'>, timers = { setTimeout, setInterval, clearTimeout, clearInterval }) {
  let offered: string | null = null;
  const check = async () => {
    try {
      const info = await api.checkForUpdate();
      if (!info.available || !info.version || info.version === offered) return;
      offered = info.version;
      toast.info(it.appSettings.updates.available(info.version), {
        message: it.appSettings.updates.autoHint,
        duration: 0,
        action: {
          label: it.appSettings.updates.install,
          onClick: () => {
            toast.info(it.appSettings.updates.installing);
            api.installUpdate().catch((e) => toast.error(it.appSettings.updates.install, { message: errorMessage(e) }));
          },
        },
      });
    } catch {
      /* silent: see the doc comment */
    }
  };
  const first = timers.setTimeout(() => void check(), FIRST_CHECK_MS);
  const every = timers.setInterval(() => void check(), CHECK_EVERY_MS);
  return () => {
    timers.clearTimeout(first);
    timers.clearInterval(every);
  };
}

export function UpdateWatcher() {
  useEffect(() => (backend.kind === 'tauri' ? startUpdateWatcher(backend) : undefined), []);
  return null;
}
