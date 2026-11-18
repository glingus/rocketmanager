import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { backend } from '../lib/backend';
import { data } from '../lib/data';
import { qk } from './queryClient';
import type { Profile, ProjectWithRole } from '../lib/types/data';
import type { ProjectStatus } from '../lib/types/ipc';
import { useSession } from './session';

export function useProjects() {
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  return useQuery({ queryKey: qk.projects, queryFn: () => data.listProjects(), enabled: signedIn });
}

export function useProject(projectId: string | undefined): { project: ProjectWithRole | undefined; isLoading: boolean } {
  const q = useProjects();
  return { project: q.data?.find((p) => p.id === projectId), isLoading: q.isLoading };
}

export function useLocalProjects() {
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  return useQuery({ queryKey: qk.localProjects, queryFn: () => backend.listLocalProjects(), enabled: signedIn });
}

/** Sync status of one project. Kept fresh by the `project-status` event (see EventBridge). */
export function useProjectStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.status(projectId ?? ''),
    queryFn: () => backend.getProjectStatus(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useAllStatuses(projectIds: string[]): Record<string, ProjectStatus | undefined> {
  const results = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: qk.status(id),
      queryFn: () => backend.getProjectStatus(id),
      staleTime: 60_000,
    })),
  });
  return useMemo(() => {
    const map: Record<string, ProjectStatus | undefined> = {};
    projectIds.forEach((id, i) => {
      map[id] = results[i]?.data;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds.join('|'), results.map((r) => r.dataUpdatedAt).join('|')]);
}

export function useProfiles() {
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  const q = useQuery({ queryKey: qk.profiles, queryFn: () => data.listProfiles(), enabled: signedIn, staleTime: 60_000 });
  const byId = useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p])), [q.data]);
  const nameOf = (id: string | null | undefined, fallback = 'Sistema'): string => (id ? (byId.get(id)?.displayName ?? fallback) : fallback);
  return { profiles: q.data ?? [], byId, nameOf, isLoading: q.isLoading };
}

export function useMyProfile() {
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  return useQuery<Profile>({ queryKey: qk.me, queryFn: () => data.getMyProfile(), enabled: signedIn });
}

export function useAppInfo() {
  return useQuery({ queryKey: qk.appInfo, queryFn: () => backend.getAppInfo(), staleTime: Infinity });
}

export function useNotificationsUnread() {
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  return useQuery({ queryKey: qk.unread, queryFn: () => data.unreadNotificationCount(), enabled: signedIn, staleTime: 5_000 });
}
