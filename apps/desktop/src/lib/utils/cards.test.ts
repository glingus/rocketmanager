import { describe, expect, it } from 'vitest';
import type { Card, CardCategory } from '../types/data';
import {
  CARD_COLORS,
  countActiveFilters,
  countOpenProblems,
  dueState,
  filterCards,
  isTask,
  noteToTaskPatch,
  positionAfterStep,
  positionBefore,
  sortByPosition,
} from './cards';

const NOW = new Date('2026-11-18T12:00:00Z');
const cats: CardCategory[] = [
  { id: 'c-nota', projectId: 'p', name: 'Nota', icon: 'sticky-note', sort: 0, isDefault: true },
  { id: 'c-prob', projectId: 'p', name: 'Problema', icon: 'triangle-alert', sort: 1, isDefault: true },
];

let n = 0;
const card = (over: Partial<Card> = {}): Card => ({
  id: `k${++n}`, projectId: 'p', title: 'Titolo', description: '', color: 'crema', priority: null, categoryId: null, status: 'open',
  createdBy: 'u1', assigneeId: null, dueDate: null, position: n * 1000, linkedVersion: null, convertedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', completedAt: null, ...over,
});

describe('card palette', () => {
  it('has about ten workshop colours', () => {
    expect(CARD_COLORS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CARD_COLORS).size).toBe(CARD_COLORS.length);
  });
});

describe('filterCards', () => {
  const cards = [
    card({ id: 'a', title: 'Paracadute', priority: 'high', color: 'ottone', categoryId: 'c-prob', assigneeId: 'u1', dueDate: '2026-11-17', status: 'in_progress' }),
    card({ id: 'b', title: 'Pinne', priority: 'low', color: 'cobalto', categoryId: 'c-nota', dueDate: '2026-11-18' }),
    card({ id: 'c', title: 'Ogiva', description: 'in fibra di vetro', priority: 'critical', color: 'ottone', assigneeId: 'u2', dueDate: '2026-11-30' }),
    card({ id: 'd', title: 'Vecchia', status: 'archived' }),
    card({ id: 'e', title: 'Fatta', status: 'completed', dueDate: '2026-11-01' }),
  ];
  const ids = (f: Parameters<typeof filterCards>[1]) => filterCards(cards, f, NOW).map((c) => c.id);

  it('hides archived cards unless asked', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'e']);
    expect(ids({ showArchived: true })).toContain('d');
    expect(ids({ statuses: ['archived'] })).toEqual(['d']);
  });

  it('filters by priority, colour, category and assignee (OR inside a group)', () => {
    expect(ids({ priorities: ['high', 'critical'] })).toEqual(['a', 'c']);
    expect(ids({ colors: ['ottone'] })).toEqual(['a', 'c']);
    expect(ids({ colors: ['cobalto', 'ottone'] })).toEqual(['a', 'b', 'c']);
    expect(ids({ categoryIds: ['c-prob'] })).toEqual(['a']);
    expect(ids({ assigneeIds: ['u2'] })).toEqual(['c']);
    expect(ids({ assigneeIds: ['none'] })).toEqual(['b', 'e']);
  });

  it('combines groups with AND', () => {
    expect(ids({ colors: ['ottone'], priorities: ['critical'] })).toEqual(['c']);
    expect(ids({ colors: ['cobalto'], priorities: ['critical'] })).toEqual([]);
  });

  it('colour and priority are independent', () => {
    expect(ids({ colors: ['cobalto'] })).toEqual(['b']);
    expect(ids({ priorities: ['low'] })).toEqual(['b']);
  });

  it('searches title and description', () => {
    expect(ids({ search: 'vetro' })).toEqual(['c']);
    expect(ids({ search: 'PINNE' })).toEqual(['b']);
  });

  it('filters by due date', () => {
    expect(ids({ due: 'overdue' })).toEqual(['a']); // completed cards are never overdue
    expect(ids({ due: 'today' })).toEqual(['b']);
    expect(ids({ due: 'week' })).toEqual(['b']);
    expect(ids({ due: 'none' })).toEqual([]);
  });

  it('counts active filter groups', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({ search: ' ', priorities: [] })).toBe(0);
    expect(countActiveFilters({ search: 'x', colors: ['ottone'], due: 'today' })).toBe(3);
  });
});

describe('note to task conversion', () => {
  it('reveals task fields and keeps colour and priority independent', () => {
    const note = card({ color: 'prugna', priority: null });
    expect(isTask(note)).toBe(false);
    const patch = noteToTaskPatch(note, {}, NOW);
    expect(patch.convertedAt).toBe(NOW.toISOString());
    expect(patch).not.toHaveProperty('color');
    expect(patch.priority).toBe('medium');
    expect(isTask({ ...note, ...patch })).toBe(true);
  });

  it('keeps an existing priority and applies the given fields', () => {
    const patch = noteToTaskPatch(card({ priority: 'critical' }), { assigneeId: 'u2', dueDate: '2026-12-01' }, NOW);
    expect(patch).toMatchObject({ priority: 'critical', assigneeId: 'u2', dueDate: '2026-12-01', status: 'open' });
    expect(noteToTaskPatch(card({ status: 'archived' }), {}, NOW).status).toBe('open');
  });
});

describe('open problems and due states', () => {
  it('counts Problema cards and high/critical priorities while open', () => {
    const list = [
      card({ categoryId: 'c-prob' }),
      card({ priority: 'critical' }),
      card({ priority: 'high', status: 'completed' }),
      card({ priority: 'medium' }),
    ];
    expect(countOpenProblems(list, cats)).toBe(2);
  });

  it('classifies due dates', () => {
    expect(dueState(null, NOW)).toBe('none');
    expect(dueState('2026-11-17', NOW)).toBe('overdue');
    expect(dueState('2026-11-18', NOW)).toBe('today');
    expect(dueState('2026-11-22', NOW)).toBe('soon');
    expect(dueState('2026-12-30', NOW)).toBe('later');
  });
});

describe('manual ordering', () => {
  const list = sortByPosition([card({ id: 'x', position: 1000 }), card({ id: 'y', position: 2000 }), card({ id: 'z', position: 3000 })]);
  it('drops a card before another using fractional positions', () => {
    expect(positionBefore(list, 'z', 'y')).toBe(1500);
    expect(positionBefore(list, 'z', 'x')).toBe(0);
    expect(positionBefore(list, 'x', null)).toBe(4000);
  });
  it('moves one step up or down', () => {
    expect(positionAfterStep(list, 'x', -1)).toBeNull();
    expect(positionAfterStep(list, 'y', -1)).toBe(0);
    expect(positionAfterStep(list, 'x', 1)).toBe(2500);
    expect(positionAfterStep(list, 'z', 1)).toBeNull();
  });
});
