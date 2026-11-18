import { useMemo } from 'react';
import type { OrkThreeWay } from '../../lib/types/ipc';
import { buildConflictRows, type ConflictRow, type SideCell } from '../../lib/utils/conflictRows';
import { Badge, CircleAlert, Minus, Plus, Check } from '../../ui';
import { it } from '../../i18n/it';
import styles from './ThreeWayTable.module.css';

function Cell({ cell, base }: { cell: SideCell; base: ConflictRow['base'] }) {
  if (cell.state === 'unchanged') {
    return <span className={styles.unchanged}>{it.conflicts.unchanged}</span>;
  }
  if (cell.state === 'added') {
    return (
      <span className={styles.added}>
        <Plus size={13} strokeWidth={3} /> {it.history.ork.added}
      </span>
    );
  }
  if (cell.state === 'removed') {
    return (
      <span className={styles.removed}>
        <Minus size={13} strokeWidth={3} /> {it.conflicts.removedValue}
      </span>
    );
  }
  return (
    <span className={styles.changed}>
      <strong>{cell.value?.display ?? it.history.ork.noValue}</strong>
      {base && cell.value && base.raw !== cell.value.raw && <span className={styles.was}>era {base.display}</span>}
    </span>
  );
}

/** Base / mine / theirs, one row per parameter or component touched by either side. */
export function ThreeWayTable({ threeWay, onlyOverlaps }: { threeWay: OrkThreeWay; onlyOverlaps: boolean }) {
  const rows = useMemo(() => buildConflictRows(threeWay), [threeWay]);
  const shown = onlyOverlaps ? rows.filter((r) => r.overlapping) : rows;
  const groups = useMemo(() => {
    const out: Array<{ key: string; group: string; path: string; rows: ConflictRow[] }> = [];
    for (const r of shown) {
      const key = `${r.groupPath}/${r.group}`;
      let g = out.find((x) => x.key === key);
      if (!g) {
        g = { key, group: r.group, path: r.groupPath, rows: [] };
        out.push(g);
      }
      g.rows.push(r);
    }
    return out;
  }, [shown]);

  return (
    <div className={styles.wrap} role="table" aria-label={it.conflicts.title} data-testid="three-way">
      <div className={[styles.row, styles.head].join(' ')} role="row">
        <div className={styles.gutter} role="columnheader" />
        <div className={[styles.col, styles.base].join(' ')} role="columnheader">
          <strong>{it.conflicts.columns.base}</strong>
          <span>{it.conflicts.columnHint.base}</span>
        </div>
        <div className={[styles.col, styles.mine].join(' ')} role="columnheader">
          <strong>{it.conflicts.columns.mine}</strong>
          <span>{it.conflicts.columnHint.mine}</span>
        </div>
        <div className={[styles.col, styles.theirs].join(' ')} role="columnheader">
          <strong>{it.conflicts.columns.theirs}</strong>
          <span>{it.conflicts.columnHint.theirs}</span>
        </div>
      </div>
      {groups.length === 0 && <p className={styles.empty}>{onlyOverlaps ? it.conflicts.independentTitle : it.history.changelog.noChanges}</p>}
      {groups.map((g) => (
        <div key={g.key} role="rowgroup" className={styles.group}>
          <div className={styles.groupHead}>
            <strong>{g.group}</strong>
            <span>{g.path}</span>
          </div>
          {g.rows.map((r) => (
            <div key={r.id} className={[styles.row, r.overlapping ? styles.overlap : ''].join(' ')} role="row" data-overlap={r.overlapping || undefined}>
              <div className={styles.gutter} role="rowheader">
                <span>{r.label}</span>
                {r.overlapping ? (
                  <Badge tone="red" icon={<CircleAlert />}>
                    {it.conflicts.overlapLabel}
                  </Badge>
                ) : (
                  <Badge tone="green" icon={<Check />}>
                    {it.conflicts.independentLabel}
                  </Badge>
                )}
              </div>
              <div className={[styles.col, styles.base].join(' ')} role="cell">
                {r.base ? <strong>{r.base.display}</strong> : <span className={styles.unchanged}>{it.history.ork.noValue}</span>}
              </div>
              <div className={[styles.col, styles.mine].join(' ')} role="cell">
                <Cell cell={r.mine} base={r.base} />
              </div>
              <div className={[styles.col, styles.theirs].join(' ')} role="cell">
                <Cell cell={r.theirs} base={r.base} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
