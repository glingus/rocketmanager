import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'brass' | 'wood';

export function Badge({ tone = 'neutral', icon, children, title }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className={[styles.badge, styles[tone]].join(' ')} title={title}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </span>
  );
}
