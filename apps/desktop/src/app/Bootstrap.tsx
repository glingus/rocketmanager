import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { backend } from '../lib/backend';
import { data } from '../lib/data';
import { useSession } from './session';
import { Spinner } from '../ui';
import { it } from '../i18n/it';
import styles from './Bootstrap.module.css';

/** Reads the auth status once, opens the Supabase session, then renders the routed app. */
export function Bootstrap() {
  const { booting, auth, setAuth, setBooted } = useSession();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await backend.authStatus();
        if (status.supabaseSession) await data.setSession(status.supabaseSession).catch(() => undefined);
        // Demo mode (?ready=1) starts from the finished onboarding.
        if (status.signedIn && backend.kind === 'mock' && new URLSearchParams(window.location.search).get('ready') === '1') {
          useSession.getState().setOnboarded(true);
        }
        if (!cancelled) setAuth(status);
      } catch {
        if (!cancelled) setAuth({ signedIn: false, user: null, supabaseSession: null });
      } finally {
        if (!cancelled) setBooted();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setAuth, setBooted]);

  if (booting || !auth) {
    return (
      <div className={styles.boot}>
        <Spinner size={28} label={it.common.loading} />
      </div>
    );
  }
  return <Outlet />;
}

/** Sends people who are not signed in (or not onboarded) to the onboarding. */
export function RequireOnboarded() {
  const { auth, onboarded } = useSession();
  if (!auth?.signedIn || !onboarded) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}
