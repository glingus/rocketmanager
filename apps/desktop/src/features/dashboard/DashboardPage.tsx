import { useState } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { useAllStatuses, useLocalProjects, useMyProfile, useProjects } from '../../app/hooks';
import { Button, EmptyState, Plus, Rocket, SkeletonLines } from '../../ui';
import { ProjectCard } from './ProjectCard';
import { NewsStrip } from './NewsStrip';
import { RecentActivity } from './RecentActivity';
import { CreateProjectDialog } from './CreateProjectDialog';
import { it } from '../../i18n/it';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const projects = useProjects();
  const { data: local = [] } = useLocalProjects();
  const { data: me } = useMyProfile();
  const list = projects.data ?? [];
  const statuses = useAllStatuses(list.map((p) => p.id));
  const [creating, setCreating] = useState(false);

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={it.appName}
        title={it.dashboard.title}
        subtitle={me ? `${it.dashboard.greeting(me.displayName.split(' ')[0] ?? me.displayName)}. ${it.dashboard.subtitle}` : it.dashboard.subtitle}
        actions={
          <Button variant="wood" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
            {it.dashboard.createProject}
          </Button>
        }
      />
      <div className={styles.content}>
        <NewsStrip />
        <section aria-labelledby="projects-title" className={styles.projects}>
          <h2 id="projects-title" className={styles.sectionTitle}>
            {it.dashboard.projects}
          </h2>
          {projects.isLoading ? (
            <SkeletonLines lines={5} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<Rocket />}
              title={it.dashboard.emptyTitle}
              description={it.dashboard.emptyText}
              action={
                <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                  {it.dashboard.createProject}
                </Button>
              }
            />
          ) : (
            <div className={styles.grid}>
              {list.map((p) => (
                <ProjectCard key={p.id} project={p} status={statuses[p.id]} linked={local.some((l) => l.projectId === p.id)} />
              ))}
            </div>
          )}
        </section>
        <RecentActivity />
      </div>
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
