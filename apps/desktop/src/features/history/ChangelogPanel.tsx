import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ProjectStatus, VersionInfo } from '../../lib/types/ipc';
import { Avatar, Badge, Button, Download, ExternalLink, Panel, RotateCcw, SkeletonLines, EmptyState, GitMerge, Info } from '../../ui';
import { formatDateTime } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { FileComparisonView } from './FileComparisonView';
import { DownloadDialog, OpenCopyDialog, RestoreDialog } from './ActionDialogs';
import { QueryState } from '../../app/QueryState';
import { useApiMutation } from '../../app/useApiMutation';
import styles from './ChangelogPanel.module.css';

export function ChangelogPanel({
  projectId,
  version,
  previous,
  nextNumber,
  status,
  folder,
  canCompare,
  onCompare,
}: {
  projectId: string;
  version: VersionInfo;
  previous: VersionInfo | null;
  nextNumber: number;
  status: ProjectStatus | undefined;
  folder: string | null;
  canCompare: boolean;
  onCompare: () => void;
}) {
  const [dialog, setDialog] = useState<'download' | 'restore' | 'open' | null>(null);
  const comparison = useQuery({
    queryKey: ['compare', projectId, previous?.sha, version.sha],
    queryFn: () => backend.compareVersions({ projectId, fromSha: previous!.sha, toSha: version.sha }),
    enabled: previous != null,
  });
  // One .ork file: open it straight away, but with the same feedback as the dialog (errors included).
  const openCopy = useApiMutation((path: string) => backend.openVersionCopy({ projectId, sha: version.sha, path }), {
    errorTitle: it.history.actions.openCopy,
    successToast: it.toasts.openedCopy,
  });
  const orkPaths = version.files.filter((f) => f.path.endsWith('.ork') && f.change !== 'deleted').map((f) => f.path);
  const isInit = version.kind === 'init';
  const published = version.published;

  return (
    <Panel
      className={styles.panel}
      data-testid="changelog-panel"
      title={
        <span className={styles.title}>
          <span className={styles.num}>{it.history.versionNumber(version.number)}</span>
          {isInit ? it.history.initTitle : version.title}
        </span>
      }
      subtitle={
        <span className={styles.byline}>
          <Avatar name={version.author.name} size={20} />
          {version.author.name} · {formatDateTime(version.date)}
        </span>
      }
      actions={
        published && !isInit ? (
          <div className={styles.actions}>
            <Button size="sm" icon={<Download />} onClick={() => setDialog('download')}>
              {it.history.actions.download}
            </Button>
            <Button size="sm" icon={<ExternalLink />} onClick={() => (orkPaths.length === 1 ? openCopy.mutate(orkPaths[0]!) : setDialog('open'))} loading={openCopy.isPending} disabled={orkPaths.length === 0} title={it.history.actions.openCopyHint}>
              {it.history.actions.openCopy}
            </Button>
            <Button size="sm" icon={<RotateCcw />} onClick={() => setDialog('restore')} data-testid="restore-button">
              {it.history.actions.restore}
            </Button>
            {canCompare && (
              <Button size="sm" icon={<GitMerge />} onClick={onCompare}>
                {it.history.actions.compare}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className={styles.body}>
        <div className={styles.badges}>
          {version.kind === 'restore' && (
            <Badge tone="brass" icon={<RotateCcw />}>
              {it.history.badge.restore} {version.restoredFrom != null && it.history.badge.restoredFrom(version.restoredFrom)}
            </Badge>
          )}
          {version.kind === 'conflictResolution' && (
            <Badge tone="red" icon={<GitMerge />}>
              {it.history.badge.conflictResolution}
            </Badge>
          )}
          {!published && <Badge tone="blue">{it.history.badge.pending}</Badge>}
          <span className={styles.sha} title={version.sha}>
            {version.sha.slice(0, 8)}
          </span>
        </div>

        {version.description && (
          <section>
            <h3 className={styles.h}>{it.history.changelog.description}</h3>
            <p className={styles.description}>{version.description}</p>
          </section>
        )}

        {isInit ? (
          <EmptyState compact icon={<Info />} title={it.history.initTitle} description={it.history.changelog.firstVersion} />
        ) : (
          <section>
            <h3 className={styles.h}>
              {it.history.changelog.title}{' '}
              <span className={styles.against}>{it.history.changelog.against(previous?.number ?? null)}</span>
            </h3>
            {previous == null ? (
              <p className={styles.none}>{it.history.changelog.firstVersion}</p>
            ) : (
              <QueryState query={comparison} lines={5}>
                {(c) =>
                  c.files.length === 0 ? (
                    <p className={styles.none}>{it.history.changelog.noChanges}</p>
                  ) : (
                    <div className={styles.files}>
                      {c.files.map((f) => (
                        <FileComparisonView key={f.path} file={f} />
                      ))}
                    </div>
                  )
                }
              </QueryState>
            )}
          </section>
        )}
        {comparison.isLoading && <SkeletonLines lines={2} />}
      </div>

      {dialog === 'download' && <DownloadDialog open projectId={projectId} version={version} defaultDir={folder ? `${folder}\\..\\Scaricati` : null} onClose={() => setDialog(null)} />}
      {dialog === 'restore' && <RestoreDialog open projectId={projectId} version={version} nextNumber={nextNumber} status={status} onClose={() => setDialog(null)} />}
      {dialog === 'open' && <OpenCopyDialog open projectId={projectId} version={version} paths={orkPaths} onClose={() => setDialog(null)} />}
    </Panel>
  );
}
