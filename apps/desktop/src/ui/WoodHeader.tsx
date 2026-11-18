import type { ReactNode } from 'react';
import styles from './WoodHeader.module.css';

export type WoodHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  /** Lower strip (usually tabs) rendered on dark walnut. */
  strip?: ReactNode;
};

/** Cherry-wood page header with an optional walnut strip for tabs. */
export function WoodHeader({ title, eyebrow, subtitle, leading, actions, strip }: WoodHeaderProps) {
  return (
    <header className={[styles.header, 'on-wood'].join(' ')}>
      <div className={styles.top}>
        {leading && <div className={styles.leading}>{leading}</div>}
        <div className={styles.titles}>
          {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {strip && <div className={styles.strip}>{strip}</div>}
    </header>
  );
}
