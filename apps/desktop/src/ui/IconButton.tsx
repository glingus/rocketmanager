import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  /** Accessible name, also used as tooltip. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'metal' | 'wood';
  size?: 'sm' | 'md';
  pressed?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', pressed, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={[styles.btn, styles[variant], styles[size], pressed ? styles.pressed : '', className ?? ''].join(' ')}
      {...rest}
    >
      {icon}
    </button>
  );
});
