import type { ProjectStatus, SyncState } from '../types/ipc';

export type LampTone = 'green' | 'amber' | 'red' | 'blue' | 'neutral';
export type LampIcon = 'check' | 'pencil' | 'arrow-down' | 'alert' | 'wifi-off' | 'refresh' | 'unlink' | 'upload';

export type StateMeta = {
  tone: LampTone;
  icon: LampIcon;
  /** True when the lamp should pulse (an operation is in progress). */
  busy: boolean;
};

/** Maps a sync state to the workshop lamp: colour + icon (the text comes from i18n). */
export function stateMeta(state: SyncState): StateMeta {
  switch (state) {
    case 'synced':
      return { tone: 'green', icon: 'check', busy: false };
    case 'localChanges':
      return { tone: 'amber', icon: 'pencil', busy: false };
    case 'publishing':
      return { tone: 'amber', icon: 'upload', busy: true };
    case 'updateAvailable':
      return { tone: 'amber', icon: 'arrow-down', busy: false };
    case 'updating':
      return { tone: 'amber', icon: 'refresh', busy: true };
    case 'conflict':
      return { tone: 'red', icon: 'alert', busy: false };
    case 'offline':
      return { tone: 'blue', icon: 'wifi-off', busy: false };
    case 'error':
      return { tone: 'red', icon: 'alert', busy: false };
    case 'notLinked':
      return { tone: 'neutral', icon: 'unlink', busy: false };
  }
}

/** Short detail suffix for a status, e.g. offline with pending versions. */
export function pendingCount(status: Pick<ProjectStatus, 'pendingVersions'>): number {
  return status.pendingVersions.length;
}

/** Number of files that can be published right now (stable and valid). */
export function publishableFiles(status: Pick<ProjectStatus, 'changedFiles'>) {
  return status.changedFiles.filter((f) => f.stable && f.valid !== false);
}

export function hasBlockingFileIssues(status: Pick<ProjectStatus, 'changedFiles'>): boolean {
  return status.changedFiles.some((f) => !f.stable || f.valid === false);
}

/** Milliseconds until the automatic publication, or null when nothing is scheduled. */
export function autoPublishRemaining(autoPublishAt: string | null, now: number = Date.now()): number | null {
  if (!autoPublishAt) return null;
  return Math.max(0, Date.parse(autoPublishAt) - now);
}
