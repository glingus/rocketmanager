import { data } from '../../lib/data';
import type { Card, CardCategory } from '../../lib/types/data';
import { isImportantCard } from '../../lib/utils/cards';

/** Shared events a card change raises (docs/modello-dati.md, `event_types`). Best effort. */
export async function emitCardCreated(projectId: string, card: Card, categories: CardCategory[], myId: string | null): Promise<void> {
  const payload = { title: card.title, cardId: card.id, priority: card.priority };
  const important = isImportantCard(card, categories);
  await data.emitEvent(projectId, important ? 'card.important' : 'card.created', payload).catch(() => undefined);
  if (card.assigneeId && card.assigneeId !== myId) {
    await data.emitEvent(projectId, 'card.assigned', payload, [card.assigneeId]).catch(() => undefined);
  }
}

export async function emitCardUpdated(projectId: string, before: Card, after: Card, categories: CardCategory[], myId: string | null): Promise<void> {
  const payload = { title: after.title, cardId: after.id, priority: after.priority };
  if (before.status !== 'completed' && after.status === 'completed') {
    await data.emitEvent(projectId, 'card.completed', payload).catch(() => undefined);
  }
  const becameImportant = !isImportantCard(before, categories) && isImportantCard(after, categories);
  if (becameImportant) await data.emitEvent(projectId, 'card.important', payload).catch(() => undefined);
  if (after.assigneeId && after.assigneeId !== before.assigneeId && after.assigneeId !== myId) {
    await data.emitEvent(projectId, 'card.assigned', payload, [after.assigneeId]).catch(() => undefined);
  }
  if (before.title !== after.title || before.description !== after.description) {
    await data.emitEvent(projectId, 'card.updated', payload).catch(() => undefined);
  }
}
