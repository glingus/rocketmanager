import styles from './ProgressBar.module.css';

export function ProgressBar({ percent, label }: { percent: number | null; label?: string }) {
  return (
    <div className={styles.wrap}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={label}
      >
        <div className={[styles.fill, percent == null ? styles.indeterminate : ''].join(' ')} style={percent != null ? { width: `${percent}%` } : undefined} />
      </div>
      {label && <p className={styles.label}>{label}</p>}
    </div>
  );
}
