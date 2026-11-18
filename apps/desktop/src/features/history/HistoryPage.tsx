import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { qk } from '../../app/queryClient';
import { useProjectContext } from '../project/ProjectLayout';
import { Button, EmptyState, GitMerge, History, SkeletonLines, Timeline, TimelineItem } from '../../ui';
import { VersionCard, VersionNode, versionTone } from './VersionCard';
import { ChangelogPanel } from './ChangelogPanel';
import { ComparePanel } from './ComparePanel';
import { it } from '../../i18n/it';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import styles from './HistoryPage.module.css';

const PAGE = 40;

export function HistoryPage() {
  const { project, status, linked, folder } = useProjectContext();
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);

  const query = useInfiniteQuery({
    queryKey: qk.versions(project.id),
    enabled: linked,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => backend.listVersions({ projectId: project.id, limit: PAGE, ...(pageParam ? { beforeSha: pageParam } : {}) }),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.sha : undefined),
  });
  const versions = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);

  useEffect(() => {
    if (!selectedSha && versions.length > 0) setSelectedSha(versions[0]!.sha);
  }, [versions, selectedSha]);

  if (!linked) return <EmptyState icon={<History />} title={it.project.onlyOnPcTitle} description={it.project.onlyOnPcText} />;
  if (query.isLoading) return <SkeletonLines lines={8} />;
  if (query.isError) return <QueryErrorBox error={query.error} onRetry={() => void query.refetch()} />;

  const real = versions.filter((v) => v.kind !== 'init' || versions.length === 1);
  if (real.length === 0) return <EmptyState icon={<History />} title={it.history.empty} description={it.history.emptyText} />;

  const selectedIndex = Math.max(0, versions.findIndex((v) => v.sha === selectedSha));
  const selected = versions[selectedIndex]!;
  const previous = versions[selectedIndex + 1] ?? null;
  const maxNumber = Math.max(0, ...versions.map((v) => v.number ?? 0));
  const published = versions.filter((v) => v.published);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{it.history.title}</h2>
          <p className={styles.subtitle}>{it.history.subtitle}</p>
        </div>
        {published.length > 2 && (
          <Button icon={<GitMerge />} onClick={() => setCompare(true)} data-testid="open-compare">
            {it.history.compare.open}
          </Button>
        )}
      </div>
      <div className={styles.columns}>
        <div className={styles.timeline} data-testid="timeline">
          <Timeline label={it.history.title}>
            {versions.map((v, i) => (
              <TimelineItem key={v.sha} node={<VersionNode v={v} />} tone={versionTone(v)} selected={v.sha === selected.sha} last={i === versions.length - 1}>
                <VersionCard version={v} selected={v.sha === selected.sha} onSelect={() => { setSelectedSha(v.sha); setCompare(false); }} />
              </TimelineItem>
            ))}
          </Timeline>
          {query.hasNextPage && (
            <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
              {it.history.loadMore}
            </Button>
          )}
        </div>
        <div className={styles.detail}>
          {compare ? (
            <ComparePanel
              projectId={project.id}
              versions={published}
              initialFrom={(previous ?? published[published.length - 1]!).sha}
              initialTo={selected.sha}
              onClose={() => setCompare(false)}
            />
          ) : (
            <ChangelogPanel
              key={selected.sha}
              projectId={project.id}
              version={selected}
              previous={previous}
              nextNumber={maxNumber + 1}
              status={status}
              folder={folder}
              canCompare={published.length > 2}
              onCompare={() => setCompare(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
