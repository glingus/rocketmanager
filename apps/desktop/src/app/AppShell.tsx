import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationCenter } from './NotificationCenter';
import { EventBridge } from './EventBridge';
import { ErrorBoundary } from './ErrorBoundary';
import { Simulator } from './Simulator';
import { ToastViewport, WifiOff } from '../ui';
import { useUi } from './uiStore';
import { it } from '../i18n/it';
import styles from './AppShell.module.css';

export function AppShell() {
  const offline = useUi((s) => s.offlineSince != null);
  const location = useLocation();
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        {it.nav.skipToContent}
      </a>
      <Sidebar />
      <main id="main" className={styles.main} tabIndex={-1}>
        {offline && (
          <div className={styles.offline} role="status">
            <WifiOff size={16} />
            {it.nav.offlineBanner}
          </div>
        )}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <NotificationCenter />
      <EventBridge />
      <Simulator />
      <ToastViewport />
    </div>
  );
}
