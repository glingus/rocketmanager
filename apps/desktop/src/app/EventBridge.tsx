import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../lib/backend';
import { data } from '../lib/data';
import type { ProjectStatus } from '../lib/types/ipc';
import { toast } from '../ui';
import { it } from '../i18n/it';
import { qk } from './queryClient';
import { useUi } from './uiStore';
import { useProjects } from './hooks';
import { errorMessage } from './errors';
import { useSession } from './session';

function machineId(): string {
  try {
    let id = localStorage.getItem('rocketsync.machineId');
    if (!id) {
      id = `pc-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('rocketsync.machineId', id);
    }
    return id;
  } catch {
    return 'pc-unknown';
  }
}

/**
 * Connects the two worlds: core events update the query cache, raise toasts and are mirrored to
 * Supabase (conflicts, "editing" claims, sync errors); Supabase realtime refreshes the data views.
 */
export function EventBridge() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signedIn = useSession((s) => s.auth?.signedIn ?? false);
  const { data: projects } = useProjects();
  const lastPublished = useRef<{ key: string; at: number } | null>(null);
  const claimed = useRef(new Map<string, Set<string>>());
  const announcedEditing = useRef(new Set<string>());
  const lastNotifId = useRef<number | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const projectName = (id: string) => projectsRef.current?.find((p) => p.id === id)?.name ?? 'il progetto';

  // ---- core events ------------------------------------------------------------------
  useEffect(() => {
    if (!signedIn) return;
    const mid = machineId();

    const syncClaims = (s: ProjectStatus) => {
      const now = new Set(s.changedFiles.map((f) => f.path));
      const before = claimed.current.get(s.projectId) ?? new Set<string>();
      for (const path of now) {
        if (!before.has(path)) {
          void data.claimFile({ projectId: s.projectId, path, kind: 'editing', machineId: mid }).catch(() => undefined);
          const key = `${s.projectId}:${path}`;
          if (!announcedEditing.current.has(key)) {
            announcedEditing.current.add(key);
            void data.emitEvent(s.projectId, 'file.editing_started', { path }).catch(() => undefined);
          }
        }
      }
      for (const path of before) {
        if (!now.has(path)) void data.releaseFile({ projectId: s.projectId, path, kind: 'editing', machineId: mid }).catch(() => undefined);
      }
      claimed.current.set(s.projectId, now);
    };

    const offs = [
      backend.on('project-status', (s) => {
        qc.setQueryData(qk.status(s.projectId), s);
        const since = useUi.getState().offlineSince;
        if (since && s.lastFetchAt && Date.parse(s.lastFetchAt) > since && s.state !== 'offline') {
          useUi.getState().setOfflineSince(null);
          toast.success(it.toasts.online);
        }
        if (s.state === 'offline' && !useUi.getState().offlineSince) useUi.getState().setOfflineSince(Date.now());
        syncClaims(s);
      }),
      backend.on('operation-progress', (p) => {
        useUi.getState().setProgress(p);
        if (p.percent === 100) setTimeout(() => useUi.getState().clearProgress(p.projectId), 1200);
      }),
      backend.on('version-published', (e) => {
        lastPublished.current = { key: `${e.projectId}:${e.number}`, at: Date.now() };
        toast.success(it.toasts.published(e.number, e.title), { message: projectName(e.projectId) });
        void qc.invalidateQueries({ queryKey: qk.versions(e.projectId) });
      }),
      backend.on('update-applied', (e) => {
        toast.info(it.toasts.updateApplied(e.toVersion, e.files.length), { message: projectName(e.projectId) });
        void qc.invalidateQueries({ queryKey: qk.versions(e.projectId) });
      }),
      backend.on('conflict-detected', (e) => {
        toast.error(it.toasts.conflictDetected(projectName(e.projectId)), {
          message: it.toasts.conflictDetectedText,
          duration: 0,
          action: { label: it.toasts.viewConflict, onClick: () => navigate(`/p/${e.projectId}/conflicts/${e.conflictId}`) },
        });
        void qc.invalidateQueries({ queryKey: qk.conflicts(e.projectId) });
        // Share the conflict with the team (idempotent on the conflict id).
        void (async () => {
          try {
            const conflict = await backend.getConflict({ projectId: e.projectId, conflictId: e.conflictId });
            const profiles = await data.listProfiles();
            const theirs = profiles.find((p) => p.displayName === conflict.theirsAuthor || p.githubLogin === conflict.theirsAuthor);
            await data.reportConflict({
              projectId: e.projectId,
              conflictId: e.conflictId,
              files: conflict.files.map((f) => ({ path: f.path, kind: f.kind })),
              theirsVersion: conflict.theirsVersion,
              theirsUserLogin: theirs?.githubLogin ?? null,
            });
          } catch {
            /* the conflict stays local; the core retries through the status events */
          }
        })();
      }),
      backend.on('conflict-resolved', (e) => {
        const recent = lastPublished.current;
        if (!recent || recent.key !== `${e.projectId}:${e.number}` || Date.now() - recent.at > 3000) {
          toast.success(it.toasts.conflictResolved(e.number), { message: projectName(e.projectId) });
        }
        void qc.invalidateQueries({ queryKey: qk.conflicts(e.projectId) });
        void data
          .resolveConflictRecord({ projectId: e.projectId, conflictId: e.conflictId, resolution: [], resolvedVersion: e.number })
          .catch(() => undefined);
      }),
      backend.on('stale-save-suspected', (e) => {
        toast.warning(it.toasts.staleSave, {
          message: it.toasts.staleSaveText,
          duration: 9000,
          action: { label: it.toasts.viewFile, onClick: () => navigate(`/p/${e.projectId}/overview`) },
        });
      }),
      backend.on('recovery-performed', (e) => {
        toast.info(it.toasts.recovery, { message: e.summary });
      }),
      backend.on('sync-error', (e) => {
        if (e.error.code === 'network') {
          if (!useUi.getState().offlineSince) {
            useUi.getState().setOfflineSince(Date.now());
            toast.warning(it.toasts.offline, { message: it.toasts.offlineText });
          }
          return;
        }
        toast.error(it.toasts.syncError, { message: errorMessage(e.error), duration: 9000 });
        void data.emitEvent(e.projectId, 'sync.error', { message: e.error.message }, []).catch(() => undefined);
      }),
    ];

    // Heartbeat for the "editing" claims of this machine.
    const hb = setInterval(() => {
      for (const [projectId, paths] of claimed.current) {
        if (paths.size > 0) void data.heartbeatClaims(projectId, mid).catch(() => undefined);
      }
    }, 60_000);

    return () => {
      offs.forEach((off) => off());
      clearInterval(hb);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // ---- realtime data ----------------------------------------------------------------
  useEffect(() => {
    if (!signedIn) return;
    const off = data.subscribe({}, (change) => {
      if (change.table === 'notifications') {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: qk.unread });
        void (async () => {
          try {
            const [latest, settings] = await Promise.all([data.listNotifications({ unreadOnly: true, limit: 5 }), backend.getAppSettings()]);
            const max = Math.max(0, ...latest.map((n) => n.id));
            if (lastNotifId.current != null && settings.desktopNotifications) {
              const prefs = await data.listPreferences();
              for (const n of latest.filter((x) => x.id > lastNotifId.current!)) {
                if (prefs.find((p) => p.eventType === n.type)?.desktop === false) continue;
                void backend.notifyDesktop({ title: n.projectId ? projectName(n.projectId) : it.appName, body: n.summary });
              }
            }
            lastNotifId.current = Math.max(lastNotifId.current ?? 0, max);
          } catch {
            /* notifications are best effort */
          }
        })();
      }
      if (change.table === 'project_members') {
        void qc.invalidateQueries({ queryKey: qk.projects });
        void qc.invalidateQueries({ queryKey: ['members'] });
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const projectIds = (projects ?? []).map((p) => p.id).join('|');
  useEffect(() => {
    if (!signedIn || !projectIds) return;
    const offs = projectIds.split('|').map((projectId) =>
      data.subscribe({ projectId }, (change) => {
        const map: Record<string, unknown[][]> = {
          cards: [qk.cards(projectId) as unknown as unknown[]],
          card_comments: [['comments'], ['attachments'], qk.cards(projectId) as unknown as unknown[]],
          card_categories: [qk.categories(projectId) as unknown as unknown[]],
          activity_log: [['activity', projectId]],
          versions: [qk.versions(projectId) as unknown as unknown[]],
          conflicts: [qk.conflictRecords(projectId) as unknown as unknown[]],
          file_claims: [qk.claims(projectId) as unknown as unknown[]],
          project_members: [qk.members(projectId) as unknown as unknown[], qk.invitations(projectId) as unknown as unknown[]],
        };
        for (const key of map[change.table] ?? []) void qc.invalidateQueries({ queryKey: key });
        if (change.table === 'versions') {
          // A colleague published: look for news right away (fetch + automatic update).
          void backend.syncNow(projectId).catch(() => undefined);
        }
      }),
    );
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, projectIds]);

  return null;
}
