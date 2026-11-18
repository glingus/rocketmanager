import { useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { data } from '../../lib/data';
import { qk } from '../../app/queryClient';
import { useProfiles, useProjects } from '../../app/hooks';
import { Panel, EmptyState, ScrollText, SkeletonLines, Avatar } from '../../ui';
import { formatRelative } from '../../lib/utils/format';
import { NotificationIcon, notificationTarget } from '../notifications/notificationMeta';
import { it } from '../../i18n/it';
import styles from './RecentActivity.module.css';

export function RecentActivity() {
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { byId } = useProfiles();
  const results = useQueries({
    queries: projects.map((p) => ({ queryKey: qk.activity(p.id, { limit: 8 }), queryFn: () => data.listActivity(p.id, { limit: 8 }) })),
  });
  const loading = results.some((r) => r.isLoading);
  const entries = results
    .flatMap((r) => r.data ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 9);

  return (
    <Panel title={it.dashboard.recent} subtitle={it.dashboard.recentHint}>
      {loading ? (
        <SkeletonLines lines={6} />
      ) : entries.length === 0 ? (
        <EmptyState compact icon={<ScrollText />} title={it.dashboard.recentEmpty} />
      ) : (
        <ul className={styles.list}>
          {entries.map((e) => {
            const project = projects.find((p) => p.id === e.projectId);
            const actor = e.actorId ? byId.get(e.actorId) : undefined;
            const target = notificationTarget({ type: e.type, projectId: e.projectId, payload: e.payload });
            return (
              <li key={`${e.projectId}-${e.id}`}>
                <button type="button" className={styles.row} data-importance={e.importance} onClick={() => target && navigate(target)}>
                  <Avatar name={actor?.displayName ?? '?'} color={actor?.avatarColor} size={26} />
                  <span className={styles.text}>
                    <span className={styles.summary}>{e.summary}</span>
                    <span className={styles.meta}>
                      <NotificationIcon type={e.type} /> {project?.name} · {formatRelative(e.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
