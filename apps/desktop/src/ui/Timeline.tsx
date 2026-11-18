import type { ReactNode } from 'react';
import styles from './Timeline.module.css';

export function Timeline({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ol className={styles.timeline} aria-label={label}>
      {children}
    </ol>
  );
}

export type TimelineItemProps = {
  children: ReactNode;
  node?: ReactNode;
  tone?: 'default' | 'amber' | 'red' | 'green' | 'blue' | 'brass';
  selected?: boolean;
  last?: boolean;
};

export function TimelineItem({ children, node, tone = 'default', selected, last }: TimelineItemProps) {
  return (
    <li className={[styles.item, last ? styles.last : ''].join(' ')} data-tone={tone}>
      <span className={[styles.node, selected ? styles.nodeSelected : ''].join(' ')} aria-hidden="true">
        {node}
      </span>
      <div className={styles.content}>{children}</div>
    </li>
  );
}
