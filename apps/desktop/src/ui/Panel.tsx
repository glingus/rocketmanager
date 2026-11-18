import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Panel.module.css';

export type PanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Selected panels get a cherry-wood frame. */
  selected?: boolean;
  flush?: boolean;
  tone?: 'paper' | 'sunken';
  as?: 'section' | 'div' | 'article' | 'aside';
};

/** A sheet of technical paper. Selected state is framed in cherry wood. */
export function Panel({ title, subtitle, actions, footer, selected, flush, tone = 'paper', as: Tag = 'section', className, children, ...rest }: PanelProps) {
  return (
    <Tag className={[styles.panel, selected ? styles.selected : '', tone === 'sunken' ? styles.sunken : '', className ?? ''].join(' ')} {...rest}>
      {(title || actions) && (
        <header className={styles.header}>
          <div className={styles.titles}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={flush ? styles.bodyFlush : styles.body}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </Tag>
  );
}
