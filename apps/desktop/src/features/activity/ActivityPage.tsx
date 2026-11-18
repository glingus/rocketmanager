import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { data } from '../../lib/data';
import type { ActivityFilters, Importance } from '../../lib/types/data';
import { qk } from '../../app/queryClient';
import { useProfiles } from '../../app/hooks';
import { useProjectContext } from '../project/ProjectLayout';
import { Avatar, Badge, Button, EmptyState, Field, Input, ScrollText, Select, SkeletonLines, X, Info } from '../../ui';
import { NotificationIcon } from '../notifications/notificationMeta';
import { dayKey, formatDateTime, formatTime, formatWeekday } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import styles from './ActivityPage.module.css';

const IMPORTANCE_TONE = { info: 'neutral', important: 'amber', critical: 'red' } as const;

export function ActivityPage() {
  const { project } = useProjectContext();
  const { profiles, byId } = useProfiles();
  const [actorId, setActorId] = useState('');
  const [type, setType] = useState('');
  const [importance, setImportance] = useState<'' | Importance>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters = useMemo<ActivityFilters>(
    () => ({
      limit: 300,
      ...(actorId ? { actorId } : {}),
      ...(type ? { type } : {}),
      ...(importance ? { importance } : {}),
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
    }),
    [actorId, type, importance, from, to],
  );
  const eventTypes = useQuery({ queryKey: qk.eventTypes, queryFn: () => data.listEventTypes(), staleTime: Infinity });
  const log = useQuery({ queryKey: qk.activity(project.id, filters), queryFn: () => data.listActivity(project.id, filters) });
  const active = !!(actorId || type || importance || from || to);
  const reset = () => {
    setActorId('');
    setType('');
    setImportance('');
    setFrom('');
    setTo('');
  };

  const groups = useMemo(() => {
    const out: Array<{ day: string; label: string; entries: NonNullable<typeof log.data> }> = [];
    for (const e of log.data ?? []) {
      const day = dayKey(e.createdAt);
      let g = out.find((x) => x.day === day);
      if (!g) {
        g = { day, label: formatWeekday(e.createdAt), entries: [] };
        out.push(g);
      }
      g.entries.push(e);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.data]);

  return (
    <div className={styles.page}>
      <div>
        <h2 className={styles.title}>{it.activity.title}</h2>
        <p className={styles.subtitle}>{it.activity.subtitle}</p>
      </div>

      <div className={styles.note} role="note" data-testid="activity-note">
        <Info size={16} />
        <span>{it.activity.note(project.settings.activityRetention)}</span>
      </div>

      <div className={styles.filters} role="search" aria-label="Filtri Activity Log">
        <Field label={it.activity.filters.user}>
          {(p) => (
            <Select {...p} value={actorId} onChange={(e) => setActorId(e.target.value)}>
              <option value="">{it.activity.filters.all}</option>
              {profiles.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={it.activity.filters.type}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">{it.activity.filters.all}</option>
              {(eventTypes.data ?? []).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.labelIt}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={it.activity.filters.importance}>
          {(p) => (
            <Select {...p} value={importance} onChange={(e) => setImportance(e.target.value as '' | Importance)}>
              <option value="">{it.activity.filters.all}</option>
              <option value="info">{it.activity.importance.info}</option>
              <option value="important">{it.activity.importance.important}</option>
              <option value="critical">{it.activity.importance.critical}</option>
            </Select>
          )}
        </Field>
        <Field label={it.activity.filters.from}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={it.activity.filters.to}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        {active && (
          <Button variant="ghost" icon={<X />} onClick={reset}>
            {it.activity.filters.reset}
          </Button>
        )}
      </div>

      {log.isLoading ? (
        <SkeletonLines lines={8} />
      ) : log.isError ? (
        <QueryErrorBox error={log.error} onRetry={() => void log.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState icon={<ScrollText />} title={active ? it.activity.emptyFiltered : it.activity.empty} description={active ? undefined : it.activity.emptyText} />
      ) : (
        <div className={styles.log} data-testid="activity-list">
          <p className={styles.count}>{it.activity.count(log.data?.length ?? 0)}</p>
          {groups.map((g) => (
            <section key={g.day} aria-label={g.label}>
              <h3 className={styles.day}>{g.label}</h3>
              <ul className={styles.list}>
                {g.entries.map((e) => {
                  const actor = e.actorId ? byId.get(e.actorId) : undefined;
                  return (
                    <li key={e.id} className={styles.entry} data-importance={e.importance}>
                      <span className={styles.bar} aria-hidden="true" />
                      <time className={styles.time} dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                        {formatTime(e.createdAt)}
                      </time>
                      <Avatar name={actor?.displayName ?? it.activity.system} color={actor?.avatarColor} size={26} />
                      <span className={styles.icon}>
                        <NotificationIcon type={e.type} />
                      </span>
                      <span className={styles.summary}>{e.summary}</span>
                      <Badge tone={IMPORTANCE_TONE[e.importance]}>{it.activity.importance[e.importance]}</Badge>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
