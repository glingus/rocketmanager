import type { DragEvent } from 'react';
import type { Card, CardCategory, Member } from '../../lib/types/data';
import { Avatar, Badge, CategoryIcon, Calendar, GitCommitHorizontal, GripVertical, ChevronRight, IconButton, ArrowUp, ArrowDown, Check } from '../../ui';
import { PriorityBadge } from './PriorityBadge';
import { dueState, isTask, normalizeColor } from '../../lib/utils/cards';
import { formatDateShort } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import styles from './CardTile.module.css';

export type CardTileProps = {
  card: Card;
  category: CardCategory | undefined;
  assignee: Member | undefined;
  onOpen: () => void;
  onMove?: (dir: -1 | 1) => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
  dragging?: boolean;
  dropTarget?: boolean;
  readOnly?: boolean;
};

export function CardTile({ card, category, assignee, onOpen, onMove, draggable, onDragStart, onDragEnd, onDragOver, onDrop, dragging, dropTarget, readOnly }: CardTileProps) {
  const due = dueState(card.dueDate);
  const task = isTask(card);
  const closed = card.status === 'completed' || card.status === 'archived';
  return (
    <article
      className={[styles.tile, dragging ? styles.dragging : '', dropTarget ? styles.dropTarget : '', closed ? styles.closed : ''].join(' ')}
      data-card-color={normalizeColor(card.color)}
      data-testid={`card-${card.id}`}
      draggable={draggable && !readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className={styles.top}>
        {draggable && !readOnly && (
          <span className={styles.grip} aria-hidden="true">
            <GripVertical size={16} />
          </span>
        )}
        {category && (
          <span className={styles.category}>
            <CategoryIcon name={category.icon} size={13} />
            {category.name}
          </span>
        )}
        <span className={styles.kind}>{task ? it.notes.task : it.notes.note}</span>
      </div>
      <h3 className={styles.title}>
        <button type="button" className={styles.titleButton} onClick={onOpen}>
          {card.status === 'completed' && <Check size={15} strokeWidth={3} aria-label={it.notes.status.completed} />}
          {card.title}
        </button>
      </h3>
      {card.description && <p className={styles.desc}>{card.description}</p>}
      <div className={styles.meta}>
        <PriorityBadge priority={card.priority} />
        {task && card.dueDate && (
          <Badge tone={due === 'overdue' && !closed ? 'red' : due === 'today' && !closed ? 'amber' : 'neutral'} icon={<Calendar />}>
            {due === 'overdue' && !closed ? it.notes.due.overdue : due === 'today' && !closed ? it.notes.due.today : formatDateShort(card.dueDate)}
          </Badge>
        )}
        {task && card.status !== 'open' && <Badge tone={card.status === 'completed' ? 'green' : 'brass'}>{it.notes.status[card.status]}</Badge>}
        {card.linkedVersion != null && (
          <Badge tone="neutral" icon={<GitCommitHorizontal />}>
            v{card.linkedVersion}
          </Badge>
        )}
        <span className={styles.spacer} />
        {assignee && <Avatar name={assignee.profile.displayName} color={assignee.profile.avatarColor} size={24} />}
      </div>
      <div className={styles.actions}>
        {onMove && !readOnly && (
          <>
            <IconButton label={it.notes.board.moveUp} size="sm" icon={<ArrowUp />} onClick={() => onMove(-1)} />
            <IconButton label={it.notes.board.moveDown} size="sm" icon={<ArrowDown />} onClick={() => onMove(1)} />
          </>
        )}
        <IconButton label={it.notes.open} size="sm" icon={<ChevronRight />} onClick={onOpen} />
      </div>
    </article>
  );
}
