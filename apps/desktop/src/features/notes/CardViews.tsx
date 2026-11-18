import { useMemo, useState } from 'react';
import type { Card, CardCategory, CardStatus, Member } from '../../lib/types/data';
import { positionAfterStep, positionBefore, sortByPosition, STATUSES } from '../../lib/utils/cards';
import { CardTile } from './CardTile';
import { EmptyState, StickyNote } from '../../ui';
import { it } from '../../i18n/it';
import styles from './CardViews.module.css';

type Common = {
  cards: Card[];
  categories: CardCategory[];
  members: Member[];
  onOpen: (card: Card) => void;
  onPatch: (card: Card, patch: { position?: number; status?: CardStatus }) => void;
  readOnly: boolean;
  filtered: boolean;
};

function useDnd() {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  return { dragId, setDragId, overId, setOverId };
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <EmptyState
      icon={<StickyNote />}
      title={filtered ? it.notes.board.emptyFiltered : it.notes.board.empty}
      description={filtered ? it.notes.board.emptyFilteredText : it.notes.board.emptyText}
    />
  );
}

/** Free-form board: one list ordered by hand. */
export function BoardView({ cards, categories, members, onOpen, onPatch, readOnly, filtered }: Common) {
  const sorted = useMemo(() => sortByPosition(cards), [cards]);
  const dnd = useDnd();
  if (sorted.length === 0) return <Empty filtered={filtered} />;
  return (
    <>
      {!readOnly && <p className={styles.hint}>{it.notes.board.dragHint}</p>}
      <div className={styles.board} data-testid="board">
        {sorted.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            category={categories.find((c) => c.id === card.categoryId)}
            assignee={members.find((m) => m.userId === card.assigneeId)}
            onOpen={() => onOpen(card)}
            onMove={(dir) => {
              const pos = positionAfterStep(sorted, card.id, dir);
              if (pos != null) onPatch(card, { position: pos });
            }}
            draggable
            readOnly={readOnly}
            dragging={dnd.dragId === card.id}
            dropTarget={dnd.overId === card.id && dnd.dragId !== card.id}
            onDragStart={(e) => {
              dnd.setDragId(card.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', card.id);
            }}
            onDragEnd={() => {
              dnd.setDragId(null);
              dnd.setOverId(null);
            }}
            onDragOver={(e) => {
              if (!dnd.dragId) return;
              e.preventDefault();
              dnd.setOverId(card.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = dnd.dragId;
              dnd.setDragId(null);
              dnd.setOverId(null);
              if (!id || id === card.id) return;
              const dragged = sorted.find((c) => c.id === id);
              if (dragged) onPatch(dragged, { position: positionBefore(sorted, id, card.id) });
            }}
          />
        ))}
      </div>
    </>
  );
}

/** Columns by status; dragging a card to another column changes its status. */
export function ColumnsView({ cards, categories, members, onOpen, onPatch, readOnly, filtered, showArchived }: Common & { showArchived: boolean }) {
  const dnd = useDnd();
  const [overColumn, setOverColumn] = useState<CardStatus | null>(null);
  const statuses = STATUSES.filter((s) => s !== 'archived' || showArchived);
  if (cards.length === 0) return <Empty filtered={filtered} />;

  return (
    <div className={styles.columns} data-testid="columns" style={{ gridTemplateColumns: `repeat(${statuses.length}, minmax(240px, 1fr))` }}>
      {statuses.map((status) => {
        const list = sortByPosition(cards.filter((c) => c.status === status));
        return (
          <section
            key={status}
            className={[styles.column, overColumn === status ? styles.columnOver : ''].join(' ')}
            aria-label={it.notes.statusColumn[status]}
            data-status={status}
            onDragOver={(e) => {
              if (!dnd.dragId) return;
              e.preventDefault();
              setOverColumn(status);
            }}
            onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              const id = dnd.dragId;
              dnd.setDragId(null);
              dnd.setOverId(null);
              setOverColumn(null);
              const dragged = cards.find((c) => c.id === id);
              if (dragged && dragged.status !== status) onPatch(dragged, { status, position: positionBefore(list, dragged.id, null) });
            }}
          >
            <header className={styles.columnHead}>
              <h3>{it.notes.statusColumn[status]}</h3>
              <span className={styles.badge}>{list.length}</span>
            </header>
            <div className={styles.columnBody}>
              {list.map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  category={categories.find((c) => c.id === card.categoryId)}
                  assignee={members.find((m) => m.userId === card.assigneeId)}
                  onOpen={() => onOpen(card)}
                  onMove={(dir) => {
                    const pos = positionAfterStep(list, card.id, dir);
                    if (pos != null) onPatch(card, { position: pos });
                  }}
                  draggable
                  readOnly={readOnly}
                  dragging={dnd.dragId === card.id}
                  dropTarget={dnd.overId === card.id && dnd.dragId !== card.id}
                  onDragStart={(e) => {
                    dnd.setDragId(card.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', card.id);
                  }}
                  onDragEnd={() => {
                    dnd.setDragId(null);
                    dnd.setOverId(null);
                    setOverColumn(null);
                  }}
                  onDragOver={(e) => {
                    if (!dnd.dragId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    dnd.setOverId(card.id);
                    setOverColumn(status);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const id = dnd.dragId;
                    dnd.setDragId(null);
                    dnd.setOverId(null);
                    setOverColumn(null);
                    if (!id || id === card.id) return;
                    const dragged = cards.find((c) => c.id === id);
                    if (!dragged) return;
                    onPatch(dragged, { ...(dragged.status !== status ? { status } : {}), position: positionBefore(list, id, card.id) });
                  }}
                />
              ))}
              {list.length === 0 && <p className={styles.emptyCol}>—</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
