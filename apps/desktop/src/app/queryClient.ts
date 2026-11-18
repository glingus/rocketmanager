import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/** Query keys in one place so events and mutations can invalidate precisely. */
export const qk = {
  projects: ['projects'] as const,
  localProjects: ['local-projects'] as const,
  profiles: ['profiles'] as const,
  me: ['me'] as const,
  status: (projectId: string) => ['status', projectId] as const,
  versions: (projectId: string) => ['versions', projectId] as const,
  conflicts: (projectId: string) => ['conflicts', projectId] as const,
  conflict: (projectId: string, id: string) => ['conflict', projectId, id] as const,
  conflictRecords: (projectId: string) => ['conflict-records', projectId] as const,
  snapshots: (projectId: string) => ['snapshots', projectId] as const,
  members: (projectId: string) => ['members', projectId] as const,
  invitations: (projectId: string) => ['invitations', projectId] as const,
  cards: (projectId: string) => ['cards', projectId] as const,
  categories: (projectId: string) => ['categories', projectId] as const,
  comments: (cardId: string) => ['comments', cardId] as const,
  attachments: (cardId: string) => ['attachments', cardId] as const,
  activity: (projectId: string, filters?: unknown) => ['activity', projectId, filters ?? null] as const,
  claims: (projectId: string) => ['claims', projectId] as const,
  discord: (projectId: string) => ['discord', projectId] as const,
  notifications: (filters?: unknown) => ['notifications', filters ?? null] as const,
  unread: ['unread'] as const,
  eventTypes: ['event-types'] as const,
  preferences: ['preferences'] as const,
  appInfo: ['app-info'] as const,
  appSettings: ['app-settings'] as const,
  updateCheck: ['update-check'] as const,
};
