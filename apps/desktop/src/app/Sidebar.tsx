import { NavLink } from 'react-router-dom';
import { Avatar, LayoutDashboard, Settings, StatusLamp } from '../ui';
import { stateMeta } from '../lib/utils/status';
import { useAllStatuses, useMyProfile, useProjects } from './hooks';
import { useSession } from './session';
import { LogoMark } from './Logo';
import { it } from '../i18n/it';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const { data: projects = [] } = useProjects();
  const statuses = useAllStatuses(projects.map((p) => p.id));
  const auth = useSession((s) => s.auth);
  const { data: me } = useMyProfile();
  const name = me?.displayName ?? auth?.user?.name ?? '';

  return (
    <aside className={[styles.sidebar, 'on-wood'].join(' ')}>
      <div className={styles.brand}>
        <LogoMark />
        <span className={styles.brandText}>
          Rocket <b>Sync</b>
        </span>
      </div>
      <nav className={styles.nav} aria-label={it.nav.main}>
        <NavLink to="/" end className={({ isActive }) => [styles.link, isActive ? styles.active : ''].join(' ')} title={it.nav.dashboard}>
          <LayoutDashboard size={18} />
          <span className={styles.linkText}>{it.nav.dashboard}</span>
        </NavLink>

        <div className={styles.sectionLabel}>{it.nav.projects}</div>
        <ul className={styles.projects}>
          {projects.map((p) => {
            const status = statuses[p.id];
            const state = status?.state ?? 'notLinked';
            const meta = stateMeta(state);
            return (
              <li key={p.id}>
                <NavLink
                  to={`/p/${p.id}/overview`}
                  className={({ isActive }) => [styles.link, styles.projectLink, isActive ? styles.active : ''].join(' ')}
                  title={`${p.name}: ${it.syncState[state]}`}
                >
                  <StatusLamp tone={meta.tone} icon={meta.icon} busy={meta.busy} label={it.syncState[state]} size="sm" showLabel={false} onWood />
                  <span className={styles.linkText}>{p.name}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className={styles.footer}>
        <NavLink to="/settings" className={({ isActive }) => [styles.link, isActive ? styles.active : ''].join(' ')} title={it.nav.settings}>
          <Settings size={18} />
          <span className={styles.linkText}>{it.nav.settings}</span>
        </NavLink>
        <div className={styles.user}>
          <Avatar name={name || '?'} color={me?.avatarColor} size={32} />
          <div className={styles.userText}>
            <span className={styles.userName}>{name}</span>
            <span className={styles.userLogin}>@{auth?.user?.githubLogin}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
