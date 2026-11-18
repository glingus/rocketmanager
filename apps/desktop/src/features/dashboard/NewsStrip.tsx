import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { data } from '../../lib/data';
import { qk } from '../../app/queryClient';
import { useProjects } from '../../app/hooks';
import { Badge, ChevronLeft, ChevronRight, IconButton, Skeleton } from '../../ui';
import { NotificationIcon, notificationTarget } from '../notifications/notificationMeta';
import { formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import styles from './NewsStrip.module.css';

export function NewsStrip() {
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const ref = useRef<HTMLUListElement>(null);
  const q = useQuery({ queryKey: qk.notifications({ strip: true }), queryFn: () => data.listNotifications({ limit: 14 }) });

  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 340, behavior: 'smooth' });

  return (
    <section aria-labelledby="news-title" className={styles.section}>
      <div className={styles.head}>
        <h2 id="news-title" className={styles.title}>
          {it.dashboard.news}
        </h2>
        <div className={styles.arrows}>
          <IconButton label="Scorri a sinistra" variant="metal" size="sm" icon={<ChevronLeft />} onClick={() => scroll(-1)} />
          <IconButton label="Scorri a destra" variant="metal" size="sm" icon={<ChevronRight />} onClick={() => scroll(1)} />
        </div>
      </div>
      {q.isLoading ? (
        <div className={styles.loading}>
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </div>
      ) : (q.data ?? []).length === 0 ? (
        <p className={styles.empty}>{it.dashboard.newsEmpty}</p>
      ) : (
        <ul ref={ref} className={styles.strip} tabIndex={0} aria-label={it.dashboard.news}>
          {(q.data ?? []).map((n) => {
            const target = notificationTarget(n);
            const project = projects.find((p) => p.id === n.projectId);
            return (
              <li key={n.id} className={styles.slide}>
                <button type="button" className={[styles.news, n.readAt ? '' : styles.unread].join(' ')} data-importance={n.importance} onClick={() => target && navigate(target)}>
                  <span className={styles.newsTop}>
                    <span className={styles.icon}>
                      <NotificationIcon type={n.type} />
                    </span>
                    <span className={styles.project}>{project?.name}</span>
                    {n.importance !== 'info' && <Badge tone={n.importance === 'critical' ? 'red' : 'amber'}>{it.notifications.importance[n.importance]}</Badge>}
                  </span>
                  <span className={styles.summary}>{n.summary}</span>
                  <span className={styles.time}>{formatRelative(n.createdAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
