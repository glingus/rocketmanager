import type { FileComparison } from '../../lib/types/ipc';
import { Badge, File } from '../../ui';
import { formatBytes } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { OrkDiffView } from './OrkDiffView';
import { TextDiffView } from './TextDiffView';
import styles from './FileComparisonView.module.css';

const TONE = { added: 'green', deleted: 'red', modified: 'amber', renamed: 'blue' } as const;
const LABEL = { added: 'Nuovo', deleted: 'Rimosso', modified: 'Modificato', renamed: 'Rinominato' } as const;

/** One file of a comparison: header with size change, then semantic / text / size-only detail. */
export function FileComparisonView({ file }: { file: FileComparison }) {
  return (
    <section className={styles.file} aria-label={file.path}>
      <header className={styles.head}>
        <File size={16} />
        <span className={styles.path}>{file.path}</span>
        <Badge tone={TONE[file.change]}>{LABEL[file.change]}</Badge>
        <span className={styles.size}>{it.history.changelog.sizeChange(formatBytes(file.sizeBefore), formatBytes(file.sizeAfter))}</span>
      </header>
      <div className={styles.body}>
        {file.ork ? (
          <OrkDiffView diff={file.ork} />
        ) : file.textDiff ? (
          <>
            <h4 className={styles.sub}>{it.history.changelog.textDiff}</h4>
            <TextDiffView diff={file.textDiff} />
          </>
        ) : (
          <p className={styles.note}>{file.note ?? it.history.changelog.binary}</p>
        )}
      </div>
    </section>
  );
}
