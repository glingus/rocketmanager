import { describe, expect, it } from 'vitest';
import { createMockWorld, PROJECT_IDS } from '../mock';
import { buildConflictRows, summarizeRows } from './conflictRows';

describe('buildConflictRows', () => {
  it('lists every changed parameter with base, mine and theirs, flagging overlaps', async () => {
    const world = createMockWorld({ seed: 'ready', speed: 0, timers: false, persist: false });
    await world.ready;
    const conflict = world.sim(PROJECT_IDS.vega).openConflicts()[0]!.conflict;
    const rows = buildConflictRows(conflict.files[0]!.threeWay!);
    const root = rows.find((r) => r.label === 'Corda alla radice')!;
    expect(root.overlapping).toBe(true);
    expect(root.base?.display).toBe('80 mm');
    expect(root.mine).toMatchObject({ state: 'changed', value: { display: '100 mm' } });
    expect(root.theirs).toMatchObject({ state: 'changed', value: { display: '105 mm' } });

    const tip = rows.find((r) => r.label === 'Corda all’estremità')!;
    expect(tip.overlapping).toBe(false);
    expect(tip.side).toBe('mine');
    expect(tip.theirs).toMatchObject({ state: 'unchanged' });

    const sweep = rows.find((r) => r.label === 'Freccia')!;
    expect(sweep.side).toBe('theirs');
    expect(sweep.mine.state).toBe('unchanged');

    const counts = summarizeRows(rows);
    expect(counts.overlap).toBeGreaterThanOrEqual(2);
    expect(counts.mine).toBeGreaterThan(counts.overlap);
  });
});
