import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { ProjectWithRole } from '../../lib/types/data';
import type { ProjectStatus } from '../../lib/types/ipc';
import { Badge, Button, Clock, FolderOpen, GitCommitHorizontal, SyncStateLamp, TriangleAlert, User } from '../../ui';
import { formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { useProjectSummary } from './useProjectSummary';
import { LinkProjectDialog } from '../shared/LinkProjectDialog';
import styles from './ProjectCard.module.css';

export function ProjectCard({ project, status, linked }: { project: ProjectWithRole; status: ProjectStatus | undefined; linked: boolean }) {
  const navigate = useNavigate();
  const summary = useProjectSummary(project.id);
  const [linking, setLinking] = useState(false);
  const state = linked ? (status?.state ?? 'synced') : 'notLinked';
  const conflicts = status?.openConflictIds.length ?? 0;
  const issues = conflicts + summary.problemCards;
  const pending = status?.pendingVersions.length ?? 0;
  const open = () => navigate(`/p/${project.id}/overview`);

  return (
    <article className={styles.card} data-state={state} data-testid={`project-card-${project.id}`}>
      <header className={[styles.band, 'on-wood'].join(' ')}>
        <h3 className={styles.name}>
          <button type="button" className={styles.nameButton} onClick={open}>
            {project.name}
          </button>
        </h3>
        <Badge tone="wood">{it.dashboard.card.myRole[project.myRole]}</Badge>
      </header>
      <div className={styles.body}>
        <div className={styles.lampRow}>
          <SyncStateLamp state={state} size="md" detail={state === 'offline' && pending > 0 ? `(${it.dashboard.card.pending(pending)})` : undefined} />
        </div>
        <p className={styles.hint}>
          {state === 'localChanges' && status
            ? it.dashboard.card.changed(status.changedFiles.length)
            : state === 'updateAvailable' && status
              ? it.dashboard.card.behind(status.behindBy)
              : it.syncStateHint[state]}
        </p>
        <dl className={styles.stats}>
          <div>
            <dt>
              <GitCommitHorizontal size={14} /> {it.dashboard.card.lastVersion}
            </dt>
            <dd className={styles.mono}>{summary.lastVersion ? `v${summary.lastVersion.number}` : it.dashboard.card.noVersions}</dd>
          </div>
          <div>
            <dt>
              <User size={14} /> {it.dashboard.card.lastAuthor}
            </dt>
            <dd>{summary.lastVersion?.authorName ?? '—'}</dd>
          </div>
          <div>
            <dt>
              <Clock size={14} /> {it.dashboard.card.lastActivity}
            </dt>
            <dd>{summary.lastActivity ? formatRelative(summary.lastActivity.createdAt) : it.dashboard.card.noActivity}</dd>
          </div>
          <div>
            <dt>
              <TriangleAlert size={14} /> {it.dashboard.card.openIssues}
            </dt>
            <dd title={it.dashboard.card.issuesTitle(conflicts, summary.problemCards)}>
              {issues > 0 ? <Badge tone={conflicts > 0 ? 'red' : 'amber'}>{issues}</Badge> : <span className={styles.zero}>0</span>}
            </dd>
          </div>
        </dl>
      </div>
      <footer className={styles.footer}>
        {linked ? (
          <Button variant="primary" onClick={open}>
            {it.dashboard.card.open}
          </Button>
        ) : (
          <Button variant="primary" icon={<FolderOpen />} onClick={() => setLinking(true)}>
            {it.dashboard.card.link}
          </Button>
        )}
        {!linked && (
          <Button variant="ghost" onClick={open}>
            {it.dashboard.card.open}
          </Button>
        )}
      </footer>
      {linking && <LinkProjectDialog project={project} open onClose={() => setLinking(false)} />}
    </article>
  );
}
