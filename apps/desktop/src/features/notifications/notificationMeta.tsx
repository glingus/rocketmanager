import type { AppNotification } from '../../lib/types/data';
import {
  Bell,
  CircleAlert,
  FileText,
  GitMerge,
  History,
  ListChecks,
  MessageSquare,
  Pencil,
  RotateCcw,
  ShieldAlert,
  StickyNote,
  UserPlus,
  Users,
  Zap,
} from '../../ui';

export function NotificationIcon({ type }: { type: string }) {
  if (type === 'version.published') return <History />;
  if (type === 'version.restored') return <RotateCcw />;
  if (type === 'conflict.detected') return <ShieldAlert />;
  if (type === 'conflict.resolved') return <GitMerge />;
  if (type.startsWith('member.')) return <Users />;
  if (type === 'project.created' || type === 'project.archived') return <FileText />;
  if (type === 'card.important') return <CircleAlert />;
  if (type === 'card.assigned') return <UserPlus />;
  if (type === 'card.completed') return <ListChecks />;
  if (type === 'card.commented') return <MessageSquare />;
  if (type === 'card.created' || type === 'card.updated') return <StickyNote />;
  if (type === 'file.editing_started') return <Pencil />;
  if (type === 'sync.error') return <Zap />;
  return <Bell />;
}

/** Where a notification leads when clicked. */
export function notificationTarget(n: Pick<AppNotification, 'type' | 'projectId' | 'payload'>): string | null {
  if (!n.projectId) return null;
  const base = `/p/${n.projectId}`;
  if (n.type.startsWith('version.')) return `${base}/history`;
  if (n.type === 'conflict.detected') {
    const id = n.payload.conflictId;
    return typeof id === 'string' ? `${base}/conflicts/${id}` : `${base}/conflicts`;
  }
  if (n.type === 'conflict.resolved') return `${base}/history`;
  if (n.type.startsWith('member.')) return `${base}/members`;
  if (n.type.startsWith('card.')) return `${base}/notes`;
  if (n.type === 'file.editing_started' || n.type === 'sync.error') return `${base}/overview`;
  return base;
}
