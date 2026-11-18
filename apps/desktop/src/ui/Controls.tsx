import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check } from './icons';
import styles from './Controls.module.css';

/** Metal toggle switch. */
export function Switch({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div className={[styles.switchRow, disabled ? styles.disabled : ''].join(' ')}>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${sid}-d` : undefined}
        aria-label={label}
        disabled={disabled}
        className={[styles.switch, checked ? styles.on : ''].join(' ')}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} />
        <span className={styles.switchText} aria-hidden="true">
          {checked ? 'ON' : 'OFF'}
        </span>
      </button>
      <label htmlFor={sid} className={styles.switchLabel}>
        <span>{label}</span>
        {description && (
          <span id={`${sid}-d`} className={styles.switchDesc}>
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

export function Checkbox({ label, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label className={[styles.checkbox, className ?? ''].join(' ')}>
      <input type="checkbox" {...rest} />
      <span className={styles.box} aria-hidden="true">
        <Check size={12} strokeWidth={3.4} />
      </span>
      <span>{label}</span>
    </label>
  );
}

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode };

export function SegmentedControl<T extends string>({ options, value, onChange, label }: { options: SegmentedOption<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={styles.segmented}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={[styles.segment, value === o.value ? styles.segmentActive : ''].join(' ')}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Toggleable filter chip. */
export function Chip({ active, onClick, children, count, tone }: { active?: boolean; onClick?: () => void; children: ReactNode; count?: number; tone?: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={[styles.chip, active ? styles.chipActive : ''].join(' ')} data-tone={tone}>
      {children}
      {count != null && <span className={styles.chipCount}>{count}</span>}
    </button>
  );
}
