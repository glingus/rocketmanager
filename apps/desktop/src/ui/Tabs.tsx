import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export type TabItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  to?: string;
};

/** Controlled tabs (buttons). */
export function Tabs({ items, value, onChange, label, onWood = true }: { items: TabItem[]; value: string; onChange: (id: string) => void; label: string; onWood?: boolean }) {
  return (
    <div role="tablist" aria-label={label} className={[styles.tabs, onWood ? styles.onWood : styles.onPaper].join(' ')}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          className={[styles.tab, value === t.id ? styles.active : ''].join(' ')}
          onClick={() => onChange(t.id)}
        >
          {t.icon && <span className={styles.icon}>{t.icon}</span>}
          <span>{t.label}</span>
          {t.badge != null && <span className={styles.badge}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/** Router-driven tabs (links): used by the project workspace. */
export function TabNav({ items, label }: { items: Array<TabItem & { to: string }>; label: string }) {
  return (
    <nav aria-label={label} className={[styles.tabs, styles.onWood].join(' ')}>
      {items.map((t) => (
        <NavLink key={t.id} to={t.to} className={({ isActive }) => [styles.tab, isActive ? styles.active : ''].join(' ')}>
          {t.icon && <span className={styles.icon}>{t.icon}</span>}
          <span>{t.label}</span>
          {t.badge != null && <span className={styles.badge}>{t.badge}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
