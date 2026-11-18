import type { ComponentChange, DisplayValue, OrkDiff, OrkThreeWay, ParamChange, SimulationChange } from '../types/ipc';

export type SideCell =
  | { state: 'unchanged'; value: DisplayValue | null }
  | { state: 'changed'; value: DisplayValue | null }
  | { state: 'added'; value: DisplayValue | null }
  | { state: 'removed'; value: DisplayValue | null };

export type ConflictRow = {
  id: string;
  /** Group heading, e.g. "Pinne trapezoidali" or "Simulazione “Volo nominale”". */
  group: string;
  groupPath: string;
  label: string;
  base: DisplayValue | null;
  mine: SideCell;
  theirs: SideCell;
  /** Both sides changed the same thing to different values. */
  overlapping: boolean;
  /** Only one side changed it. */
  side: 'mine' | 'theirs' | 'both';
};

type Entry = { group: string; groupPath: string; label: string; before: DisplayValue | null; after: DisplayValue | null; cell: 'changed' | 'added' | 'removed' };

function fromComponent(c: ComponentChange): Entry[] {
  const group = c.name;
  const groupPath = [...c.path, c.typeLabel].join(' › ');
  if (c.kind === 'added' || c.kind === 'removed') {
    return [{ group, groupPath, label: c.typeLabel, before: null, after: null, cell: c.kind }];
  }
  return c.params.map((p: ParamChange) => ({ group, groupPath, label: p.label, before: p.before, after: p.after, cell: 'changed' as const }));
}

function fromSim(s: SimulationChange): Entry[] {
  const group = `Simulazione “${s.name}”`;
  if (s.kind !== 'modified') return [{ group, groupPath: 'Simulazioni', label: s.name, before: null, after: null, cell: s.kind }];
  return [...s.conditions, ...s.results].map((p) => ({ group, groupPath: 'Simulazioni', label: p.label, before: p.before, after: p.after, cell: 'changed' as const }));
}

function entries(diff: OrkDiff): Entry[] {
  return [...diff.components.flatMap(fromComponent), ...diff.simulations.flatMap(fromSim)];
}

const rowKey = (e: Entry) => `${e.groupPath}/${e.group}/${e.label}`;

function cellOf(entry: Entry | undefined, base: DisplayValue | null): SideCell {
  if (!entry) return { state: 'unchanged', value: base };
  if (entry.cell === 'added') return { state: 'added', value: null };
  if (entry.cell === 'removed') return { state: 'removed', value: null };
  return { state: 'changed', value: entry.after };
}

/**
 * Turns a semantic three-way into table rows: one per changed parameter / component, with the
 * base value and what each side did. Rows changed by both sides to different values are overlapping.
 */
export function buildConflictRows(tw: OrkThreeWay): ConflictRow[] {
  const mine = new Map(entries(tw.mine).map((e) => [rowKey(e), e]));
  const theirs = new Map(entries(tw.theirs).map((e) => [rowKey(e), e]));
  const order: string[] = [];
  for (const k of [...mine.keys(), ...theirs.keys()]) if (!order.includes(k)) order.push(k);

  return order.map((k) => {
    const m = mine.get(k);
    const t = theirs.get(k);
    const ref = (m ?? t)!;
    const base = m?.before ?? t?.before ?? null;
    const both = !!m && !!t;
    const overlapping = both && isOverlap(tw, ref);
    return {
      id: k,
      group: ref.group,
      groupPath: ref.groupPath,
      label: ref.label,
      base,
      mine: cellOf(m, base),
      theirs: cellOf(t, base),
      overlapping,
      side: both ? 'both' : m ? 'mine' : 'theirs',
    } satisfies ConflictRow;
  });
}

function isOverlap(tw: OrkThreeWay, e: Entry): boolean {
  return tw.overlapping.some((o) => {
    const names = o.componentName === e.group || `Simulazione “${o.componentName}”` === e.group;
    return names && (o.key == null ? e.cell !== 'changed' || o.label === e.label : o.label === e.label);
  });
}

export function summarizeRows(rows: ConflictRow[]) {
  return {
    mine: rows.filter((r) => r.side !== 'theirs').length,
    theirs: rows.filter((r) => r.side !== 'mine').length,
    overlap: rows.filter((r) => r.overlapping).length,
  };
}
