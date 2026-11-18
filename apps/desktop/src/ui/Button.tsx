import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'wood';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
};

/** Brushed-metal button; `primary` is brass (the call to action), `wood` sits on cherry surfaces. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = [styles.button, styles[variant], styles[size], block ? styles.block : '', className ?? ''].join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <span className={styles.icon}>{icon}</span> : null}
      {children != null && <span className={styles.label}>{children}</span>}
    </button>
  );
});
