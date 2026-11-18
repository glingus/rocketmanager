import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { data } from '../lib/data';
import type { AppNotification } from '../lib/types/data';
import { Badge, Button, Checkbox, Drawer, EmptyState, Select, SkeletonLines, Bell, CheckCheck } from '../ui';
import { it } from '../i18n/it';
import { formatRelative } from '../lib/utils/format';
import { qk } from './queryClient';
import { useProjects } from './hooks';
import { useUi } from './uiStore';
import { useApiMutation } from './useApiMutation';
import { NotificationIcon, notificationTarget } from '../features/notifications/notificationMeta';
import styles from './NotificationCenter.module.css';

export function NotificationCenter() {
  const open = useUi((s) => s.notificationsOpen);
  const setOpen = useUi((s) => s.setNotificationsOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects();
  const [projectId, setProjectId] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const filters = useMemo(() => ({ projectId: projectId || undefined, unreadOnly, limit: 100 }), [projectId, unreadOnly]);
  const query = useQuery({ queryKey: qk.notifications(filters), queryFn: () => data.listNotifications(filters), enabled: open });
  const unread = query.data?.filter((n) => !n.readAt).length ?? 0;

  const markRead = useApiMutation((ids?: number[]) => data.markNotificationsRead(ids), {
    invalidate: [['notifications'], qk.unread],
  });

  const go = (n: AppNotification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    const target = notificationTarget(n);
    if (target) {
      setOpen(false);
      navigate(target);
    }
  };
  void qc;

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      title={it.notifications.title}
      subtitle={it.notifications.subtitle(unread)}
      width={460}
    >
      <div className={styles.toolbar}>
        <Select aria-label={it.notifications.filterProject} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{it.notifications.allProjects}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Checkbox label={it.notifications.onlyUnread} checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
        <Button size="sm" icon={<CheckCheck />} onClick={() => markRead.mutate(undefined)} disabled={unread === 0} loading={markRead.isPending}>
          {it.notifications.markAllRead}
        </Button>
      </div>
      {query.isLoading ? (
        <div className={styles.pad}>
          <SkeletonLines lines={6} />
        </div>
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState icon={<Bell />} title={it.notifications.empty} description={unreadOnly ? it.notifications.emptyUnread : it.notifications.emptyText} />
      ) : (
        <ul className={styles.list}>
          {(query.data ?? []).map((n) => {
            const project = projects.find((p) => p.id === n.projectId);
            return (
              <li key={n.id}>
                <button type="button" className={[styles.item, n.readAt ? styles.read : styles.unread].join(' ')} data-importance={n.importance} onClick={() => go(n)}>
                  <span className={styles.icon}>
                    <NotificationIcon type={n.type} />
                  </span>
                  <span className={styles.text}>
                    <span className={styles.summary}>{n.summary}</span>
                    <span className={styles.meta}>
                      {project && <span>{project.name}</span>}
                      <span>{formatRelative(n.createdAt)}</span>
                      <Badge tone={n.importance === 'critical' ? 'red' : n.importance === 'important' ? 'amber' : 'neutral'}>{it.notifications.importance[n.importance]}</Badge>
                    </span>
                  </span>
                  {!n.readAt && <span className={styles.dot} aria-label={it.common.unread} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
