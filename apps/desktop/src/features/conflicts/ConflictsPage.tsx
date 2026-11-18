import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { data } from '../../lib/data';
import { qk } from '../../app/queryClient';
import { useProfiles } from '../../app/hooks';
import { useProjectContext } from '../project/ProjectLayout';
import { Badge, Button, CircleCheck, EmptyState, GitMerge, Panel, ShieldAlert, SkeletonLines } from '../../ui';
import { formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import styles from './ConflictsPage.module.css';

export function ConflictsPage() {
  const { project, linked } = useProjectContext();
  const { nameOf } = useProfiles();
  const local = useQuery({ queryKey: qk.conflicts(project.id), queryFn: () => backend.listConflicts({ projectId: project.id, includeResolved: true }), enabled: linked });
  const records = useQuery({ queryKey: qk.conflictRecords(project.id), queryFn: () => data.listConflictRecords(project.id) });

  if (linked && local.isLoading) return <SkeletonLines lines={5} />;
  if (local.isError) return <QueryErrorBox error={local.error} onRetry={() => void local.refetch()} />;

  const open = (local.data ?? []).filter((c) => c.status === 'open');
  const resolvedLocal = (local.data ?? []).filter((c) => c.status === 'resolved');
  const resolvedRemote = (records.data ?? []).filter((r) => r.status === 'resolved' && !resolvedLocal.some((c) => c.id === r.id));

  return (
    <div className={styles.page}>
      <div>
        <h2 className={styles.title}>{it.conflicts.title}</h2>
        <p className={styles.subtitle}>{it.conflicts.subtitle}</p>
      </div>

      {open.length === 0 && resolvedLocal.length === 0 && resolvedRemote.length === 0 ? (
        <EmptyState icon={<CircleCheck />} title={it.conflicts.empty} description={it.conflicts.emptyText} />
      ) : (
        <>
          <section aria-label={it.conflicts.open} className={styles.section}>
            <h3 className={styles.h}>{it.conflicts.open}</h3>
            {open.length === 0 ? (
              <EmptyState compact icon={<CircleCheck />} title={it.conflicts.empty} description={it.conflicts.emptyText} />
            ) : (
              open.map((c) => (
                <Panel key={c.id} selected className={styles.open} data-testid={`conflict-${c.id}`}>
                  <div className={styles.row}>
                    <span className={styles.icon}>
                      <ShieldAlert size={22} />
                    </span>
                    <div className={styles.text}>
                      <strong className={styles.fileList}>{c.files.map((f) => f.path).join(', ')}</strong>
                      <span>
                        {it.conflicts.theirsBy(c.theirsAuthor ?? it.common.unknown, c.theirsVersion)} · {it.conflicts.detectedAt(formatRelative(c.createdAt))}
                      </span>
                      <span className={styles.badges}>
                        {c.files.map((f) => (
                          <Badge key={f.path} tone="red">
                            {it.conflicts.kind[f.kind]}
                          </Badge>
                        ))}
                      </span>
                    </div>
                    <Link to={c.id} className={styles.link}>
                      <Button variant="primary" icon={<GitMerge />}>
                        {it.conflicts.resolve}
                      </Button>
                    </Link>
                  </div>
                </Panel>
              ))
            )}
          </section>

          {(resolvedLocal.length > 0 || resolvedRemote.length > 0) && (
            <section aria-label={it.conflicts.resolved} className={styles.section}>
              <h3 className={styles.h}>{it.conflicts.resolved}</h3>
              <ul className={styles.resolved}>
                {resolvedLocal.map((c) => (
                  <li key={c.id}>
                    <Badge tone="green" icon={<CircleCheck />}>
                      {it.conflicts.resolved}
                    </Badge>
                    <span className={styles.rfiles}>{c.files.map((f) => f.path).join(', ')}</span>
                    <span className={styles.when}>{it.conflicts.detectedAt(formatRelative(c.createdAt))}</span>
                  </li>
                ))}
                {resolvedRemote.map((r) => (
                  <li key={r.id}>
                    <Badge tone="green" icon={<CircleCheck />}>
                      {it.conflicts.resolved}
                    </Badge>
                    <span className={styles.rfiles}>{r.files.map((f) => f.path).join(', ')}</span>
                    <span className={styles.when}>
                      {r.resolvedAt ? it.conflicts.resolvedAt(formatRelative(r.resolvedAt)) : ''}
                      {r.resolvedBy ? ` · ${nameOf(r.resolvedBy)}` : ''}
                      {r.resolvedVersion != null ? ` · v${r.resolvedVersion}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
