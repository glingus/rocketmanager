import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from './icons';
import { IconButton } from './IconButton';
import { useFocusTrap } from './useFocusTrap';
import { it } from '../i18n/it';
import styles from './Drawer.module.css';

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
};

function DrawerInner({ onClose, title, subtitle, width = 440, children, actions, footer }: Omit<DrawerProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div className={styles.root}>
      <div className={styles.scrim} onClick={onClose} />
      <aside ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={styles.drawer} style={{ width }}>
        <header className={[styles.header, 'on-wood'].join(' ')}>
          <div className={styles.titles}>
            <h2 className={styles.title}>{title}</h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {actions}
          <IconButton label={it.common.close} variant="wood" icon={<X />} onClick={onClose} />
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </aside>
    </div>
  );
}

export function Drawer({ open, ...rest }: DrawerProps) {
  if (!open) return null;
  return createPortal(<DrawerInner {...rest} />, document.body);
}
