import { Outlet, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { createContext, useContext } from 'react';
import { PageHeader } from '../../app/PageHeader';
import { useLocalProjects, useProject, useProjectStatus } from '../../app/hooks';
import { Badge, Button, EmptyState, FolderOpen, GitMerge, History, RefreshCw, ScrollText, Settings, StickyNote, SyncStateLamp, TabNav, TriangleAlert, Users, LayoutDashboard } from '../../ui';
import type { ProjectWithRole } from '../../lib/types/data';
import type { ProjectStatus } from '../../lib/types/ipc';
import { it } from '../../i18n/it';
import { backend } from '../../lib/backend';
import { useApiMutation } from '../../app/useApiMutation';
import { toast } from '../../ui';
import { qk } from '../../app/queryClient';
import { useUi } from '../../app/uiStore';
import styles from './ProjectLayout.module.css';

export type ProjectContextValue = {
  project: ProjectWithRole;
  status: ProjectStatus | undefined;
  linked: boolean;
  folder: string | null;
  isAdmin: boolean;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext outside ProjectLayout');
  return ctx;
}

export function ProjectLayout() {
  const { projectId } = useParams();
  const { project, isLoading } = useProject(projectId);
  const { data: status } = useProjectStatus(projectId);
  const { data: local = [] } = useLocalProjects();
  const offline = useUi((s) => s.offlineSince != null);

  const linked = local.some((l) => l.projectId === projectId);

  const sync = useApiMutation(() => backend.syncNow(projectId!), {
    successToast: it.toasts.synced,
    invalidate: [qk.versions(projectId ?? '')],
    errorTitle: it.toasts.syncError,
  });

  useEffect(() => {
    document.title = project ? `${project.name} · ${it.appName}` : it.appName;
    return () => {
      document.title = it.appName;
    };
  }, [project]);

  if (isLoading) return null;
  if (!project) {
    return <EmptyState icon={<TriangleAlert />} title={it.errors.projectNotFound} description={it.errors.projectNotFoundText} />;
  }

  const state = linked ? (status?.state ?? 'synced') : 'notLinked';
  const conflictCount = status?.openConflictIds.length ?? 0;
  const base = `/p/${project.id}`;
  const tabs = [
    { id: 'overview', label: it.nav.project.overview, to: `${base}/overview`, icon: <LayoutDashboard /> },
    { id: 'history', label: it.nav.project.history, to: `${base}/history`, icon: <History /> },
    { id: 'conflicts', label: it.nav.project.conflicts, to: `${base}/conflicts`, icon: <GitMerge />, badge: conflictCount > 0 ? conflictCount : undefined },
    { id: 'notes', label: it.nav.project.notes, to: `${base}/notes`, icon: <StickyNote /> },
    { id: 'members', label: it.nav.project.members, to: `${base}/members`, icon: <Users /> },
    { id: 'activity', label: it.nav.project.activity, to: `${base}/activity`, icon: <ScrollText /> },
    { id: 'settings', label: it.nav.project.settings, to: `${base}/settings`, icon: <Settings /> },
  ];

  const pending = status?.pendingVersions.length ?? 0;
  const lampDetail = state === 'offline' && pending > 0 ? `(${it.offlinePending(pending)})` : undefined;

  return (
    <ProjectContext.Provider value={{ project, status, linked, folder: status?.folder ?? null, isAdmin: project.myRole === 'admin' }}>
      <div className={styles.page}>
        <PageHeader
          eyebrow={
            <span className={styles.eyebrow}>
              {project.githubOwner}/{project.githubRepo}
              <Badge tone="wood">{project.myRole === 'admin' ? it.project.roleAdmin : it.project.roleMember}</Badge>
            </span>
          }
          title={project.name}
          subtitle={
            <span className={styles.statusLine}>
              <SyncStateLamp state={state} onWood detail={lampDetail} />
              {status?.folder && <span className={styles.folder} title={status.folder}>{status.folder}</span>}
            </span>
          }
          actions={
            linked ? (
              <>
                <Button
                  variant="wood"
                  size="sm"
                  icon={<FolderOpen />}
                  onClick={() => status?.folder && void backend.openFolder(status.folder).catch(() => toast.error(it.errors.title))}
                >
                  {it.project.openFolder}
                </Button>
                <Button variant="wood" size="sm" icon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate(undefined)} disabled={offline}>
                  {sync.isPending ? it.project.checking : it.project.syncNow}
                </Button>
              </>
            ) : undefined
          }
          strip={<TabNav label={it.nav.tabsLabel} items={tabs} />}
        />
        <div className={styles.content} id="project-content">
          <Outlet />
        </div>
      </div>
    </ProjectContext.Provider>
  );
}

