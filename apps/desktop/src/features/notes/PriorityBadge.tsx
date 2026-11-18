import type { CardPriority } from '../../lib/types/data';
import { Badge, Flag, type BadgeTone } from '../../ui';
import { it } from '../../i18n/it';

const TONE: Record<CardPriority, BadgeTone> = { low: 'neutral', medium: 'blue', high: 'amber', critical: 'red' };

/** Priority is independent from the card colour: always icon + text. */
export function PriorityBadge({ priority }: { priority: CardPriority | null }) {
  if (!priority) return null;
  return (
    <Badge tone={TONE[priority]} icon={<Flag />} title={`${it.notes.priorityLabel}: ${it.notes.priority[priority]}`}>
      {it.notes.priority[priority]}
    </Badge>
  );
}
