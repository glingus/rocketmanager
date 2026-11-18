import { useEffect } from 'react';
import { CircleAlert, Check, Info, TriangleAlert, X } from './icons';
import { useToastStore, type ToastItem } from './toastStore';
import { it } from '../i18n/it';
import styles from './Toast.module.css';

const ICONS = { success: Check, info: Info, warning: TriangleAlert, error: CircleAlert } as const;

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    if (item.duration <= 0) return;
    const t = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(t);
  }, [item.id, item.duration, dismiss]);
  const Icon = ICONS[item.tone];
  return (
    <div className={[styles.toast, styles[item.tone]].join(' ')} role={item.tone === 'error' ? 'alert' : 'status'}>
      <span className={styles.icon}>
        <Icon strokeWidth={2.6} />
      </span>
      <div className={styles.text}>
        <strong>{item.title}</strong>
        {item.message && <span>{item.message}</span>}
      </div>
      {item.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            item.action!.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className={styles.close} aria-label={it.common.close} onClick={() => dismiss(item.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const items = useToastStore((s) => s.items);
  return (
    <div className={styles.viewport} aria-live="polite">
      {items.map((i) => (
        <ToastView key={i.id} item={i} />
      ))}
    </div>
  );
}
