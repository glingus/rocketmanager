import type {
  AppError,
  AppInfo,
  AppSettings,
  AuthStatus,
  BackendEventName,
  BackendEvents,
  Comparison,
  Conflict,
  FileResolution,
  FolderCheck,
  LocalProject,
  ProjectStatus,
  PublishPolicy,
  Snapshot,
  UpdateCheck,
  VersionInfo,
} from '../types/ipc';

export type Unsubscribe = () => void;

/**
 * Everything the UI can ask of the Rust core. One method per IPC command (docs/contratto-ipc.md),
 * plus `on` for the events. Failures reject with an `AppError`.
 */
export interface Backend {
  readonly kind: 'tauri' | 'mock';

  // session and credentials
  authStatus(): Promise<AuthStatus>;
  authSignIn(): Promise<AuthStatus>;
  authSignOut(): Promise<void>;
  secureStoreGet(key: string): Promise<string | null>;
  secureStoreSet(key: string, value: string): Promise<void>;
  secureStoreDelete(key: string): Promise<void>;

  // local projects
  listLocalProjects(): Promise<LocalProject[]>;
  suggestProjectFolder(projectName: string): Promise<string>;
  checkFolder(path: string): Promise<FolderCheck>;
  pickFolder(defaultPath?: string): Promise<string | null>;
  linkProject(args: { projectId: string; repoFullName: string; folder: string }): Promise<ProjectStatus>;
  unlinkProject(projectId: string): Promise<void>;
  getProjectStatus(projectId: string): Promise<ProjectStatus>;

  // synchronisation
  publish(args: { projectId: string; title?: string; description?: string; paths?: string[] }): Promise<ProjectStatus>;
  syncNow(projectId: string): Promise<ProjectStatus>;
  updateNow(args: { projectId: string; force?: boolean }): Promise<ProjectStatus>;
  discardChanges(args: { projectId: string; paths: string[] }): Promise<ProjectStatus>;
  answerStaleSave(args: { projectId: string; path: string; reopened: boolean }): Promise<ProjectStatus>;
  getPublishPolicy(projectId: string): Promise<PublishPolicy>;
  setPublishPolicy(args: { projectId: string; policy: PublishPolicy }): Promise<void>;

  // history
  listVersions(args: { projectId: string; limit?: number; beforeSha?: string }): Promise<VersionInfo[]>;
  getVersion(args: { projectId: string; sha: string }): Promise<VersionInfo>;
  compareVersions(args: { projectId: string; fromSha: string; toSha: string }): Promise<Comparison>;
  exportVersion(args: { projectId: string; sha: string; paths?: string[]; destDir: string }): Promise<string[]>;
  openVersionCopy(args: { projectId: string; sha: string; path: string }): Promise<void>;
  restoreVersion(args: { projectId: string; sha: string; paths?: string[] }): Promise<ProjectStatus>;

  // conflicts and safety copies
  listConflicts(args: { projectId: string; includeResolved?: boolean }): Promise<Conflict[]>;
  getConflict(args: { projectId: string; conflictId: string }): Promise<Conflict>;
  openConflictCopy(args: { projectId: string; conflictId: string; path: string; side: 'base' | 'theirs' }): Promise<void>;
  resolveConflict(args: { projectId: string; conflictId: string; resolutions: FileResolution[] }): Promise<ProjectStatus>;
  listSnapshots(projectId: string): Promise<Snapshot[]>;
  exportSnapshot(args: { projectId: string; snapshotId: string; destDir: string }): Promise<string[]>;

  // system
  getAppInfo(): Promise<AppInfo>;
  openInOpenRocket(args: { projectId: string; path: string }): Promise<void>;
  openFolder(path: string): Promise<void>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<void>;
  exportDiagnostics(): Promise<string>;
  checkForUpdate(): Promise<UpdateCheck>;
  installUpdate(): Promise<void>;
  notifyDesktop(args: { title: string; body: string }): Promise<void>;

  // events
  on<E extends BackendEventName>(event: E, handler: (payload: BackendEvents[E]) => void): Unsubscribe;
}

export function toAppError(e: unknown): AppError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) return e as AppError;
  if (typeof e === 'string') {
    try {
      const parsed = JSON.parse(e) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && 'message' in parsed) return parsed as AppError;
    } catch {
      /* not JSON */
    }
    return { code: 'internal', message: 'Si è verificato un errore imprevisto.', detail: e, retryable: false };
  }
  const detail = e instanceof Error ? e.message : String(e);
  return { code: 'internal', message: 'Si è verificato un errore imprevisto.', detail, retryable: false };
}
