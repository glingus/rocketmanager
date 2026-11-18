import type { VersionInfo } from '../../lib/types/ipc';
import { Avatar, Badge, GitMerge, History, RotateCcw, Clock, File } from '../../ui';
import { formatDateTime, formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import styles from './VersionCard.module.css';

export function versionTone(v: VersionInfo): 'default' | 'amber' | 'red' | 'green' | 'blue' | 'brass' {
  if (!v.published) return 'blue';
  if (v.kind === 'restore') return 'brass';
  if (v.kind === 'conflictResolution') return 'red';
  return 'default';
}

export function VersionNode({ v }: { v: VersionInfo }) {
  if (!v.published) return <Clock />;
  if (v.kind === 'restore') return <RotateCcw />;
  if (v.kind === 'conflictResolution') return <GitMerge />;
  return <History />;
}

export function VersionCard({
  version,
  selected,
  onSelect,
  compareMark,
}: {
  version: VersionInfo;
  selected: boolean;
  onSelect: () => void;
  compareMark?: 'from' | 'to' | null;
}) {
  const v = version;
  const files = v.files.slice(0, 3);
  const hasBadges = v.kind === 'restore' || v.kind === 'conflictResolution' || !v.published || !!compareMark;
  return (
    <button type="button" className={[styles.card, selected ? styles.selected : '', !v.published ? styles.pending : ''].join(' ')} onClick={onSelect} aria-pressed={selected} data-testid={`version-${v.number ?? 'pending'}`}>
      <div className={styles.top}>
        <span className={styles.number}>{it.history.versionNumber(v.number)}</span>
        <h3 className={styles.title}>{v.kind === 'init' ? it.history.initTitle : v.title}</h3>
      </div>
      {hasBadges && (
      <span className={styles.badges}>
          {v.kind === 'restore' && <Badge tone="brass" icon={<RotateCcw />}>{it.history.badge.restore}{v.restoredFrom != null ? ` ${it.history.badge.restoredFrom(v.restoredFrom)}` : ''}</Badge>}
          {v.kind === 'conflictResolution' && <Badge tone="red" icon={<GitMerge />}>{it.history.badge.conflictResolution}</Badge>}
          {!v.published && <Badge tone="blue" icon={<Clock />}>{it.history.badge.pending}</Badge>}
          {compareMark && <Badge tone="wood">{compareMark === 'from' ? 'A' : 'B'}</Badge>}
      </span>
      )}
      <div className={styles.meta}>
        <Avatar name={v.author.name} size={20} />
        <span>{v.author.name}</span>
        <span className={styles.dot} aria-hidden="true">·</span>
        <time dateTime={v.date} title={formatDateTime(v.date)}>
          {formatRelative(v.date)}
        </time>
      </div>
      {v.files.length > 0 && (
        <div className={styles.files}>
          {files.map((f) => (
            <span key={f.path} className={styles.file} data-change={f.change}>
              <File size={12} />
              {f.path}
            </span>
          ))}
          {v.files.length > files.length && <span className={styles.more}>+{v.files.length - files.length}</span>}
        </div>
      )}
    </button>
  );
}
