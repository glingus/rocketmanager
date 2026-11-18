import styles from './TextDiffView.module.css';

/** Renders a unified diff with +/- colouring. */
export function TextDiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className={styles.diff} tabIndex={0} aria-label="Differenze riga per riga">
      {lines.map((line, i) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        return (
          <span key={i} className={styles.line} data-kind={kind}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}
