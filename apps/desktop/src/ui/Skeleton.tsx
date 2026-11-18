import styles from './Skeleton.module.css';

export function Skeleton({ width = '100%', height = 14, radius = 4 }: { width?: number | string; height?: number | string; radius?: number }) {
  return <span className={styles.skeleton} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

/** A few lines of placeholder text while content loads. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.lines} role="status" aria-label="Caricamento">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
