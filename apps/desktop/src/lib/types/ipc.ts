/**
 * Types of the IPC contract between the UI and the Rust core
 * (see docs/contratto-ipc.md). JSON is camelCase, dates are ISO 8601 UTC strings.
 */

// ---- 1. Common types -------------------------------------------------------

export type ErrorCode =
  | 'network'
  | 'authRequired'
  | 'authFailed'
  | 'notLinked'
  | 'folderNotEmpty'
  | 'folderInSyncedDrive'
  | 'fileNotStable'
  | 'fileInvalid'
  | 'fileTooLarge'
  | 'blockedByEditor'
  | 'conflictOpen'
  | 'localChangesPresent'
  | 'nonFastForward'
  | 'lockHeld'
  | 'notFound'
  | 'invalidPath'
  | 'gitMissing'
  | 'internal';

export type AppError = {
  code: ErrorCode;
  message: string;
  detail?: string;
  retryable: boolean;
};

export type SyncState =
  | 'synced'
  | 'localChanges'
  | 'publishing'
  | 'updateAvailable'
  | 'updating'
  | 'conflict'
  | 'offline'
  | 'error'
  | 'notLinked';

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

// ---- 2. Project status -----------------------------------------------------

export type ChangedFile = {
  path: string;
  change: FileChangeKind;
  oldPath?: string;
  stable: boolean;
  valid: boolean | null;
  invalidReason?: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
};

export type PendingVersion = {
  sha: string;
  title: string;
  createdAt: string;
  waitingReason: 'offline' | 'blockedByEditor' | 'conflict' | 'retrying' | null;
};

export type ProjectStatus = {
  projectId: string;
  state: SyncState;
  folder: string | null;
  headVersion: number | null;
  remoteVersion: number | null;
  behindBy: number;
  changedFiles: ChangedFile[];
  pendingVersions: PendingVersion[];
  blockedByEditor: string[];
  openConflictIds: string[];
  staleSaveSuspected: string[];
  lastFetchAt: string | null;
  lastPublishAt: string | null;
  autoPublishAt: string | null;
  repoSizeBytes: number | null;
  error: AppError | null;
};

export type PublishPolicy =
  | { mode: 'assisted'; idleMinutes: number }
  | { mode: 'manual' }
  | { mode: 'onSave'; minIntervalMinutes: number };

// ---- 3. Versions, comparison, semantic diff --------------------------------

export type VersionKind = 'init' | 'publish' | 'restore' | 'conflictResolution';

export type ChangelogGroup = { path: string; lines: string[]; interpreted: boolean };

export type FileChange = {
  path: string;
  change: FileChangeKind;
  oldPath?: string;
  binary: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
};

export type VersionInfo = {
  number: number | null;
  sha: string;
  kind: VersionKind;
  title: string;
  description: string | null;
  changelog: ChangelogGroup[];
  author: { name: string; email: string; githubLogin: string | null };
  date: string;
  files: FileChange[];
  restoredFrom: number | null;
  conflictId: string | null;
  published: boolean;
};

export type VersionRef = { number: number | null; sha: string };

export type DisplayValue = { raw: string; display: string; unit: string | null };

export type ParamChange = {
  key: string;
  label: string;
  before: DisplayValue | null;
  after: DisplayValue | null;
};

export type OrkSummary = {
  container: 'zip' | 'gzip' | 'xml';
  creator: string | null;
  formatVersion: string | null;
  rocketName: string | null;
  stageCount: number;
  componentCount: number;
  simulationCount: number;
};

export type ComponentChange = {
  kind: 'added' | 'removed' | 'modified' | 'moved';
  componentType: string;
  typeLabel: string;
  name: string;
  path: string[];
  params: ParamChange[];
};

export type ConfigChange = {
  kind: 'added' | 'removed' | 'modified';
  name: string;
  params: ParamChange[];
};

export type SimulationChange = {
  kind: 'added' | 'removed' | 'modified';
  name: string;
  conditions: ParamChange[];
  results: ParamChange[];
  dataUpdated: boolean;
};

export type UninterpretedChange = { section: string; count: number; sample: string | null };

export type OrkDiff = {
  path: string;
  before: OrkSummary | null;
  after: OrkSummary | null;
  components: ComponentChange[];
  motorConfigurations: ConfigChange[];
  simulations: SimulationChange[];
  uninterpreted: UninterpretedChange[];
  parseError: string | null;
};

export type OverlapItem = {
  componentPath: string[];
  componentName: string;
  key: string | null;
  label: string;
  mine: DisplayValue | null;
  theirs: DisplayValue | null;
};

export type OrkThreeWay = {
  path: string;
  mine: OrkDiff;
  theirs: OrkDiff;
  overlapping: OverlapItem[];
  independent: boolean;
};

export type FileComparison = FileChange & {
  ork: OrkDiff | null;
  textDiff: string | null;
  note: string | null;
};

export type Comparison = { from: VersionRef; to: VersionRef; files: FileComparison[] };

// ---- 4. Conflicts and safety copies ----------------------------------------

export type ConflictFile = {
  path: string;
  kind: 'bothModified' | 'bothAdded' | 'modifiedDeleted' | 'deletedModified';
  threeWay: OrkThreeWay | null;
};

export type Conflict = {
  id: string;
  projectId: string;
  status: 'open' | 'resolved';
  createdAt: string;
  baseSha: string;
  oursSha: string;
  theirsSha: string;
  theirsVersion: number | null;
  theirsAuthor: string | null;
  remoteBranchPushed: boolean;
  files: ConflictFile[];
};

export type ResolutionChoice = 'mine' | 'theirs' | 'both' | 'manual';
export type FileResolution = { path: string; choice: ResolutionChoice };

export type Snapshot = { id: string; createdAt: string; operation: string; fileCount: number };

// ---- 5. Commands: auxiliary types ------------------------------------------

export type AuthStatus = {
  signedIn: boolean;
  user: { githubLogin: string; name: string; avatarUrl: string | null } | null;
  supabaseSession: { accessToken: string; refreshToken: string; expiresAt: number } | null;
};

export type LocalProject = {
  projectId: string;
  folder: string;
  repoFullName: string;
  linkedAt: string;
};

export type SyncedDrive = 'onedrive' | 'dropbox' | 'googleDrive';

export type FolderCheck = {
  exists: boolean;
  empty: boolean;
  writable: boolean;
  inSyncedDrive: SyncedDrive | null;
  fileCount: number;
};

export type AppInfo = {
  version: string;
  gitVersion: string;
  openRocket: { found: boolean; path: string | null; version: string | null };
};

export type AppSettings = {
  autostart: boolean;
  desktopNotifications: boolean;
  minimizeToTray: boolean;
  fetchIntervalSeconds: number;
};

export type UpdateCheck = { available: boolean; version?: string; notes?: string };

// ---- 6. Events (core -> UI) ------------------------------------------------

export type BackendEvents = {
  'project-status': ProjectStatus;
  'operation-progress': {
    projectId: string;
    op: string;
    step: string;
    percent: number | null;
    message: string;
  };
  'version-published': { projectId: string; number: number; sha: string; title: string };
  'update-applied': { projectId: string; fromVersion: number; toVersion: number; files: string[] };
  'conflict-detected': { projectId: string; conflictId: string; files: string[] };
  'conflict-resolved': { projectId: string; conflictId: string; number: number };
  'stale-save-suspected': { projectId: string; path: string };
  'recovery-performed': { projectId: string; summary: string };
  'sync-error': { projectId: string; error: AppError };
};

export type BackendEventName = keyof BackendEvents;
