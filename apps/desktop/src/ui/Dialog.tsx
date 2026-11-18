import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { useFocusTrap } from './useFocusTrap';
import { it } from '../i18n/it';
import styles from './Dialog.module.css';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  width?: number;
  tone?: 'default' | 'danger';
  icon?: ReactNode;
};

function DialogInner({ onClose, title, description, children, actions, width = 520, tone = 'default', icon }: Omit<DialogProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(ref, onClose);
  return (
    <div className={styles.root}>
      <div className={styles.scrim} onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={[styles.dialog, tone === 'danger' ? styles.danger : ''].join(' ')}
        style={{ width }}
      >
        <header className={styles.header}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        </header>
        <div className={styles.body}>
          {description && (
            <p id={descId} className={styles.description}>
              {description}
            </p>
          )}
          {children}
        </div>
        {actions && <footer className={styles.footer}>{actions}</footer>}
      </div>
    </div>
  );
}

export function Dialog({ open, ...rest }: DialogProps) {
  if (!open) return null;
  return createPortal(<DialogInner {...rest} />, document.body);
}

export type ConfirmDialogProps = Omit<DialogProps, 'actions'> & {
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
  confirmDisabled?: boolean;
};

export function ConfirmDialog({ confirmLabel, cancelLabel = it.common.cancel, onConfirm, loading, confirmDisabled, tone, ...rest }: ConfirmDialogProps) {
  return (
    <Dialog
      {...rest}
      tone={tone}
      actions={
        <>
          <Button variant="ghost" onClick={rest.onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} disabled={confirmDisabled} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
