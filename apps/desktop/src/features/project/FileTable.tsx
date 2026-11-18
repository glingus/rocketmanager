import type { ChangedFile } from '../../lib/types/ipc';
import { Badge, Checkbox, CircleAlert, File, IconButton, Spinner, Check, ExternalLink } from '../../ui';
import { formatBytes, formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import styles from './FileTable.module.css';

export function FileTable({
  files,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  stale = [],
  selectable = true,
}: {
  files: ChangedFile[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (all: boolean) => void;
  onOpen: (path: string) => void;
  stale?: string[];
  selectable?: boolean;
}) {
  const allSelected = files.length > 0 && files.every((f) => selected.has(f.path));
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {selectable && (
              <th className={styles.check}>
                <Checkbox label={<span className="visually-hidden">{it.overview.unpublished.selectAll}</span>} checked={allSelected} onChange={(e) => onToggleAll(e.target.checked)} />
              </th>
            )}
            <th>{it.overview.files.columns.file}</th>
            <th>{it.overview.files.columns.change}</th>
            <th>{it.overview.files.columns.state}</th>
            <th className={styles.num}>{it.overview.files.columns.size}</th>
            <th>{it.overview.files.columns.modified}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path} className={selected.has(f.path) ? styles.selected : ''}>
              {selectable && (
                <td className={styles.check}>
                  <Checkbox label={<span className="visually-hidden">{f.path}</span>} checked={selected.has(f.path)} onChange={() => onToggle(f.path)} />
                </td>
              )}
              <td>
                <span className={styles.file}>
                  <File size={15} />
                  <span className={styles.path} title={f.path}>
                    {f.path}
                  </span>
                </span>
              </td>
              <td>
                <Badge tone={f.change === 'added' ? 'green' : f.change === 'deleted' ? 'red' : 'amber'}>{it.overview.files.change[f.change]}</Badge>
              </td>
              <td>
                <span className={styles.states}>
                  {f.stable ? (
                    <span className={styles.ok}>
                      <Check size={14} strokeWidth={3} /> {it.overview.files.stable}
                    </span>
                  ) : (
                    <span className={styles.busy} title={it.overview.files.savingHint}>
                      <Spinner size={13} /> {it.overview.files.saving}
                    </span>
                  )}
                  {f.valid === false ? (
                    <span className={styles.bad} title={it.overview.files.invalidHint(f.invalidReason ?? '')}>
                      <CircleAlert size={14} /> {it.overview.files.invalid}
                    </span>
                  ) : f.valid === true ? (
                    <span className={styles.ok}>
                      <Check size={14} strokeWidth={3} /> {it.overview.files.valid}
                    </span>
                  ) : (
                    <span className={styles.muted}>{it.overview.files.validating}</span>
                  )}
                  {stale.includes(f.path) && (
                    <Badge tone="amber" icon={<CircleAlert />}>
                      {it.overview.stale.no}
                    </Badge>
                  )}
                </span>
                {f.valid === false && f.invalidReason && <p className={styles.reason}>{it.overview.files.invalidHint(f.invalidReason)}</p>}
              </td>
              <td className={[styles.num, 'mono'].join(' ')}>{formatBytes(f.sizeBytes)}</td>
              <td className={styles.when}>{f.modifiedAt ? formatRelative(f.modifiedAt) : '—'}</td>
              <td className={styles.actions}>
                {f.path.endsWith('.ork') && f.change !== 'deleted' && (
                  <IconButton label={`${it.overview.files.openInOpenRocket}: ${f.path}`} size="sm" icon={<ExternalLink />} onClick={() => onOpen(f.path)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
