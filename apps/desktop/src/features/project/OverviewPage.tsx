import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { backend } from '../../lib/backend';
import { useProjectContext } from './ProjectLayout';
import { StatusHero } from './StatusHero';
import { UnpublishedPanel } from './UnpublishedPanel';
import { UpdatePanel } from './UpdatePanel';
import { StalePanel } from './StalePanel';
import { PendingPanel } from './PendingPanel';
import { ClaimsPanel } from './ClaimsPanel';
import { SafetyPanel } from './SafetyPanel';
import { Button, EmptyState, FolderOpen, GitMerge, Panel, ShieldAlert, SkeletonLines } from '../../ui';
import { LinkProjectDialog } from '../shared/LinkProjectDialog';
import { it } from '../../i18n/it';
import { useState } from 'react';
import styles from './OverviewPage.module.css';

export function OverviewPage() {
  const { project, status, linked } = useProjectContext();
  const [linking, setLinking] = useState(false);
  const policy = useQuery({ queryKey: ['policy', project.id], queryFn: () => backend.getPublishPolicy(project.id), enabled: linked });

  if (!linked) {
    return (
      <>
        <EmptyState
          icon={<FolderOpen />}
          title={it.project.notLinkedTitle}
          description={it.project.notLinkedText}
          action={
            <Button variant="primary" icon={<FolderOpen />} onClick={() => setLinking(true)}>
              {it.project.notLinkedAction}
            </Button>
          }
        />
        {linking && <LinkProjectDialog project={project} open onClose={() => setLinking(false)} />}
      </>
    );
  }
  if (!status) return <SkeletonLines lines={6} />;

  const conflicts = status.openConflictIds;
  const hasChanges = status.changedFiles.length > 0;
  const incoming = status.behindBy > 0 && conflicts.length === 0;

  return (
    <div className={styles.stack}>
      <StatusHero status={status} projectId={project.id} />

      {conflicts.length > 0 && (
        <Panel selected className={styles.conflict} data-testid="conflict-banner">
          <div className={styles.conflictRow}>
            <span className={styles.conflictIcon} aria-hidden="true">
              <ShieldAlert size={24} />
            </span>
            <div className={styles.conflictText}>
              <h2>{it.overview.conflictBanner.title(conflicts.length)}</h2>
              <p>{it.overview.conflictBanner.text}</p>
            </div>
            <Link to={`/p/${project.id}/conflicts/${conflicts[0]}`} className={styles.link}>
              <Button variant="danger" icon={<GitMerge />}>
                {it.overview.conflictBanner.action}
              </Button>
            </Link>
          </div>
        </Panel>
      )}

      {status.staleSaveSuspected.map((path) => (
        <StalePanel key={path} projectId={project.id} path={path} />
      ))}

      {incoming && <UpdatePanel status={status} />}

      {hasChanges ? (
        <UnpublishedPanel status={status} policy={policy.data} />
      ) : (
        <Panel title={it.overview.files.title}>
          <EmptyState compact icon={<FolderOpen />} title={it.overview.files.empty} description={it.overview.files.emptyText} />
        </Panel>
      )}

      {status.pendingVersions.length > 0 && <PendingPanel status={status} />}

      <div className={styles.columns}>
        <ClaimsPanel projectId={project.id} />
        <SafetyPanel projectId={project.id} folder={status.folder} />
      </div>
    </div>
  );
}

