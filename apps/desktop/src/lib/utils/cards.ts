import type { Card, CardCategory, CardPriority, CardStatus } from '../types/data';
import { dayKey } from './format';

/** Workshop palette: ~10 colours, independent from the priority. Names are stored in `cards.color`. */
export const CARD_COLORS = [
  'crema',
  'ottone',
  'rame',
  'ruggine',
  'prugna',
  'cobalto',
  'petrolio',
  'oliva',
  'acciaio',
  'grafite',
] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export const DEFAULT_CARD_COLOR: CardColor = 'crema';

export function isCardColor(value: string): value is CardColor {
  return (CARD_COLORS as readonly string[]).includes(value);
}

export function normalizeColor(value: string | null | undefined): CardColor {
  return value && isCardColor(value) ? value : DEFAULT_CARD_COLOR;
}

export const PRIORITIES: CardPriority[] = ['low', 'medium', 'high', 'critical'];
export const STATUSES: CardStatus[] = ['open', 'in_progress', 'completed', 'archived'];

const PRIORITY_RANK: Record<CardPriority, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function priorityRank(p: CardPriority | null): number {
  return p ? PRIORITY_RANK[p] : 0;
}

/** A card is a "task" once it has been converted (structured fields revealed). */
export function isTask(card: Pick<Card, 'convertedAt' | 'assigneeId' | 'dueDate' | 'status'>): boolean {
  return card.convertedAt != null || card.assigneeId != null || card.dueDate != null || card.status !== 'open';
}

export type DueFilter = 'overdue' | 'today' | 'week' | 'none' | 'any';

export type CardFilters = {
  search?: string;
  priorities?: CardPriority[];
  colors?: string[];
  categoryIds?: string[];
  assigneeIds?: Array<string | 'none'>;
  statuses?: CardStatus[];
  due?: DueFilter;
  /** Show archived cards (hidden by default). */
  showArchived?: boolean;
};

export function dueState(dueDate: string | null, now: Date = new Date()): 'overdue' | 'today' | 'soon' | 'later' | 'none' {
  if (!dueDate) return 'none';
  const today = dayKey(now);
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  const limit = dayKey(new Date(now.getTime() + 7 * 86_400_000));
  return dueDate <= limit ? 'soon' : 'later';
}

export function matchesDue(card: Pick<Card, 'dueDate' | 'status'>, due: DueFilter, now: Date = new Date()): boolean {
  if (due === 'any') return true;
  const state = dueState(card.dueDate, now);
  const closed = card.status === 'completed' || card.status === 'archived';
  switch (due) {
    case 'none':
      return state === 'none';
    case 'overdue':
      return state === 'overdue' && !closed;
    case 'today':
      return state === 'today';
    case 'week':
      return state === 'today' || state === 'soon';
  }
}

/** Applies every active filter (AND between groups, OR inside a group). */
export function filterCards(cards: Card[], filters: CardFilters, now: Date = new Date()): Card[] {
  const search = filters.search?.trim().toLowerCase();
  return cards.filter((card) => {
    if (!filters.showArchived && card.status === 'archived' && !filters.statuses?.includes('archived')) return false;
    if (search && !`${card.title} ${card.description}`.toLowerCase().includes(search)) return false;
    if (filters.priorities?.length && !(card.priority && filters.priorities.includes(card.priority))) return false;
    if (filters.colors?.length && !filters.colors.includes(normalizeColor(card.color))) return false;
    if (filters.categoryIds?.length && !(card.categoryId && filters.categoryIds.includes(card.categoryId))) return false;
    if (filters.assigneeIds?.length) {
      const key = card.assigneeId ?? 'none';
      if (!filters.assigneeIds.includes(key)) return false;
    }
    if (filters.statuses?.length && !filters.statuses.includes(card.status)) return false;
    if (filters.due && !matchesDue(card, filters.due, now)) return false;
    return true;
  });
}

export function countActiveFilters(filters: CardFilters): number {
  let n = 0;
  if (filters.search?.trim()) n++;
  if (filters.priorities?.length) n++;
  if (filters.colors?.length) n++;
  if (filters.categoryIds?.length) n++;
  if (filters.assigneeIds?.length) n++;
  if (filters.statuses?.length) n++;
  if (filters.due && filters.due !== 'any') n++;
  return n;
}

/** Sort by manual position (fractional ordering). */
export function sortByPosition(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.position - b.position);
}

/** Fractional position between two neighbours (either may be missing). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1000;
  if (before == null) return (after as number) - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

/**
 * Note -> task conversion: reveals the structured fields. The colour is kept,
 * the priority defaults to "medium" only when none was set, and the status becomes open.
 */
export function noteToTaskPatch(
  card: Pick<Card, 'priority' | 'status'>,
  extra: { assigneeId?: string | null; dueDate?: string | null; priority?: CardPriority | null } = {},
  now: Date = new Date(),
) {
  return {
    convertedAt: now.toISOString(),
    assigneeId: extra.assigneeId ?? null,
    dueDate: extra.dueDate ?? null,
    priority: extra.priority ?? card.priority ?? ('medium' as CardPriority),
    status: card.status === 'archived' ? ('open' as CardStatus) : card.status,
  };
}

/** Cards that count as an "open problem": category Problema, or priority high/critical, while open. */
export function isOpenProblem(card: Card, categories: CardCategory[]): boolean {
  if (card.status === 'completed' || card.status === 'archived') return false;
  const category = categories.find((c) => c.id === card.categoryId);
  const isProblemCategory = category?.name.toLowerCase() === 'problema';
  return isProblemCategory || card.priority === 'high' || card.priority === 'critical';
}

export function countOpenProblems(cards: Card[], categories: CardCategory[]): number {
  return cards.filter((c) => isOpenProblem(c, categories)).length;
}

/** Event raised when a card is created or edited, if it should reach the whole project. */
export function isImportantCard(card: Pick<Card, 'priority' | 'categoryId'>, categories: CardCategory[]): boolean {
  if (card.priority === 'high' || card.priority === 'critical') return true;
  const category = categories.find((c) => c.id === card.categoryId);
  return category?.name.toLowerCase() === 'problema';
}

/**
 * New fractional position to drop `dragId` right before `targetId` (or at the end when null).
 * `sorted` is the visible list ordered by position.
 */
export function positionBefore(sorted: Card[], dragId: string, targetId: string | null): number {
  const list = sorted.filter((c) => c.id !== dragId);
  if (targetId == null) return positionBetween(list.length ? list[list.length - 1]!.position : null, null);
  const idx = list.findIndex((c) => c.id === targetId);
  if (idx < 0) return positionBetween(list.length ? list[list.length - 1]!.position : null, null);
  return positionBetween(idx > 0 ? list[idx - 1]!.position : null, list[idx]!.position);
}

/** Position after moving a card one step up (-1) or down (+1) in `sorted`; null when it cannot move. */
export function positionAfterStep(sorted: Card[], id: string, dir: -1 | 1): number | null {
  const idx = sorted.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  if (dir === -1) {
    if (idx === 0) return null;
    return positionBetween(idx > 1 ? sorted[idx - 2]!.position : null, sorted[idx - 1]!.position);
  }
  if (idx === sorted.length - 1) return null;
  return positionBetween(sorted[idx + 1]!.position, idx + 2 < sorted.length ? sorted[idx + 2]!.position : null);
}
