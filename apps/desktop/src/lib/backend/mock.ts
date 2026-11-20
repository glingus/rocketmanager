import type {
  PublicConfig,
  AppInfo,
  AppSettings,
  AuthStatus,
  BackendEventName,
  BackendEvents,
  FileResolution,
  ProjectStatus,
  PublishPolicy,
} from '../types/ipc';
import type { Backend } from './types';
import { getMockWorld, type MockWorld } from '../mock';
import { errors } from '../mock/errors';

const LATENCY = 90;

/** In-memory implementation of the IPC contract. It runs the same flows the Rust core does. */
export class MockBackend implements Backend {
  readonly kind = 'mock' as const;

  constructor(readonly world: MockWorld) {}

  private async ready(ms = LATENCY): Promise<void> {
    await this.world.ready;
    await this.world.sleep(ms);
  }

  // ---- session ---------------------------------------------------------------

  async authStatus(): Promise<AuthStatus> {
    await this.ready(40);
    const me = this.world.me;
    if (!this.world.signedIn) return { signedIn: false, user: null, supabaseSession: null };
    return {
      signedIn: true,
      user: { githubLogin: me.login, name: me.name, avatarUrl: null },
      supabaseSession: {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    };
  }

  async authSignIn(): Promise<AuthStatus> {
    await this.world.ready;
    await this.world.sleep(1100);
    this.world.signedIn = true;
    this.world.persistSession();
    return this.authStatus();
  }

  async authSignOut(): Promise<void> {
    await this.ready();
    this.world.signedIn = false;
    this.world.persistSession();
  }

  async secureStoreGet(key: string): Promise<string | null> {
    return this.world.secureStore.get(key) ?? null;
  }
  async secureStoreSet(key: string, value: string): Promise<void> {
    this.world.secureStore.set(key, value);
  }
  async secureStoreDelete(key: string): Promise<void> {
    this.world.secureStore.delete(key);
  }

  // ---- local projects ----------------------------------------------------------

  async listLocalProjects() {
    await this.ready();
    return [...this.world.linkedFolders.entries()].map(([projectId, v]) => ({ projectId, ...v }));
  }

  async suggestProjectFolder(projectName: string): Promise<string> {
    return `C:\\Users\\simone\\RocketSync\\${projectName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Progetto'}`;
  }

  async checkFolder(path: string) {
    await this.ready(150);
    const lower = path.toLowerCase();
    const inSyncedDrive = lower.includes('onedrive')
      ? ('onedrive' as const)
      : lower.includes('dropbox')
        ? ('dropbox' as const)
        : lower.includes('google drive') || lower.includes('googledrive')
          ? ('googleDrive' as const)
          : null;
    const nonEmpty = /esistent|desktop|documenti|razzi/.test(lower);
    const readOnly = lower.includes('sola lettura');
    return {
      exists: nonEmpty || readOnly || inSyncedDrive != null,
      empty: !nonEmpty,
      writable: !readOnly,
      inSyncedDrive,
      fileCount: nonEmpty ? 4 : 0,
    };
  }

  async pickFolder(): Promise<string | null> {
    await this.ready(250);
    return 'C:\\Users\\simone\\Desktop\\Razzi OpenRocket';
  }

  async linkProject(args: { projectId: string; repoFullName: string; folder: string }): Promise<ProjectStatus> {
    await this.world.ready;
    const w = this.world;
    const { projectId } = args;
    const steps: Array<[string, number, string]> = [
      ['connect', 8, 'Mi collego al repository del progetto'],
      ['download', 45, 'Scarico lo storico delle versioni'],
      ['files', 78, 'Preparo i file nella cartella'],
      ['verify', 94, 'Controllo che tutto sia in ordine'],
    ];
    for (const [step, percent, message] of steps) {
      w.emitBackend('operation-progress', { projectId, op: 'link', step, percent, message });
      await w.sleep(650);
    }
    if (!w.cloud.has(projectId)) throw errors.notFound('Progetto');
    w.linkedFolders.set(projectId, { folder: args.folder, repoFullName: args.repoFullName, linkedAt: w.iso() });
    const sim = w.ensureSim(projectId, args.folder);
    w.persistSession();
    w.emitBackend('operation-progress', { projectId, op: 'link', step: 'done', percent: 100, message: 'Progetto collegato' });
    return sim.touch();
  }

  async unlinkProject(projectId: string): Promise<void> {
    await this.ready();
    this.world.sims.get(projectId)?.dispose();
    this.world.sims.delete(projectId);
    this.world.linkedFolders.delete(projectId);
    this.world.persistSession();
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    await this.ready(40);
    const sim = this.world.sims.get(projectId);
    if (!sim) {
      return {
        projectId,
        state: 'notLinked',
        folder: null,
        headVersion: null,
        remoteVersion: null,
        behindBy: 0,
        changedFiles: [],
        pendingVersions: [],
        blockedByEditor: [],
        openConflictIds: [],
        staleSaveSuspected: [],
        lastFetchAt: null,
        lastPublishAt: null,
        autoPublishAt: null,
        repoSizeBytes: null,
        error: null,
      };
    }
    return sim.status();
  }

  // ---- sync ----------------------------------------------------------------------

  async publish(args: { projectId: string; title?: string; description?: string; paths?: string[] }) {
    await this.ready();
    return this.world.sim(args.projectId).publish(args);
  }
  async syncNow(projectId: string) {
    await this.ready();
    return this.world.sim(projectId).syncNow();
  }
  async updateNow(args: { projectId: string; force?: boolean }) {
    await this.ready();
    return this.world.sim(args.projectId).updateNow(args.force ?? false);
  }
  async discardChanges(args: { projectId: string; paths: string[] }) {
    await this.ready();
    return this.world.sim(args.projectId).discard(args.paths);
  }
  async answerStaleSave(args: { projectId: string; path: string; reopened: boolean }) {
    await this.ready();
    return this.world.sim(args.projectId).answerStale(args.path, args.reopened);
  }
  async getPublishPolicy(projectId: string): Promise<PublishPolicy> {
    await this.ready(40);
    return this.world.sim(projectId).policy;
  }
  async setPublishPolicy(args: { projectId: string; policy: PublishPolicy }): Promise<void> {
    await this.ready();
    const sim = this.world.sim(args.projectId);
    sim.policy = args.policy;
    sim.touch();
  }

  // ---- history ---------------------------------------------------------------------

  async listVersions(args: { projectId: string; limit?: number; beforeSha?: string }) {
    await this.ready();
    return this.world.sim(args.projectId).versions(args.limit, args.beforeSha);
  }
  async getVersion(args: { projectId: string; sha: string }) {
    await this.ready(40);
    return this.world.sim(args.projectId).version(args.sha);
  }
  async compareVersions(args: { projectId: string; fromSha: string; toSha: string }) {
    await this.ready(180);
    return this.world.sim(args.projectId).compare(args.fromSha, args.toSha);
  }
  async exportVersion(args: { projectId: string; sha: string; paths?: string[]; destDir: string }) {
    await this.ready(300);
    const sim = this.world.sim(args.projectId);
    const files = args.paths?.length ? args.paths : sim.versionPaths(args.sha);
    return files.map((f) => `${args.destDir}\\${f}`);
  }
  async openVersionCopy(args: { projectId: string; sha: string; path: string }) {
    await this.ready();
    this.world.sim(args.projectId).version(args.sha);
    this.world.openedCopies.push(`${args.projectId}:${args.sha}:${args.path}`);
  }
  async restoreVersion(args: { projectId: string; sha: string; paths?: string[] }) {
    await this.ready();
    return this.world.sim(args.projectId).restore(args.sha, args.paths);
  }

  // ---- conflicts ---------------------------------------------------------------------

  async listConflicts(args: { projectId: string; includeResolved?: boolean }) {
    await this.ready();
    return this.world
      .sim(args.projectId)
      .conflicts.map((c) => c.conflict)
      .filter((c) => args.includeResolved || c.status === 'open');
  }
  async getConflict(args: { projectId: string; conflictId: string }) {
    await this.ready(40);
    return this.world.sim(args.projectId).getConflict(args.conflictId);
  }
  async openConflictCopy(args: { projectId: string; conflictId: string; path: string; side: 'base' | 'theirs' }) {
    await this.ready();
    this.world.sim(args.projectId).getConflict(args.conflictId);
    this.world.openedCopies.push(`${args.conflictId}:${args.side}:${args.path}`);
  }
  async resolveConflict(args: { projectId: string; conflictId: string; resolutions: FileResolution[] }) {
    await this.ready();
    return this.world.sim(args.projectId).resolve(args.conflictId, args.resolutions);
  }
  async listSnapshots(projectId: string) {
    await this.ready();
    return this.world.sim(projectId).snapshots;
  }
  async exportSnapshot(args: { projectId: string; snapshotId: string; destDir: string }) {
    await this.ready(300);
    return [`${args.destDir}\\copia-di-sicurezza`];
  }

  // ---- system -------------------------------------------------------------------------

  async getAppInfo(): Promise<AppInfo> {
    await this.ready(40);
    return {
      version: '0.1.0',
      gitVersion: '2.47.1',
      openRocket: { found: true, path: 'C:\\Program Files\\OpenRocket\\OpenRocket.exe', version: '23.09' },
    };
  }
  /** What the shell would report. Tests set it; by default it mirrors the VITE_* variables (empty = not configured). */
  publicConfig: PublicConfig = {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
    githubOrg: '',
  };
  async getPublicConfig(): Promise<PublicConfig> {
    await this.ready(10);
    return { ...this.publicConfig };
  }
  async openInOpenRocket(args: { projectId: string; path: string }) {
    await this.ready();
    this.world.openedCopies.push(`openrocket:${args.projectId}:${args.path}`);
  }
  async openFolder(path: string) {
    await this.ready();
    this.world.openedCopies.push(`folder:${path}`);
  }
  async getAppSettings(): Promise<AppSettings> {
    await this.ready(40);
    return { ...this.world.appSettings };
  }
  async setAppSettings(settings: AppSettings) {
    await this.ready();
    this.world.appSettings = { ...settings };
  }
  async exportDiagnostics() {
    await this.ready(500);
    return 'C:\\Users\\simone\\Desktop\\rocketsync-diagnostica.zip';
  }
  async checkForUpdate() {
    await this.ready(400);
    return this.world.updateInfo;
  }
  async installUpdate() {
    await this.ready(600);
    this.world.updateInfo = { available: false };
  }
  async notifyDesktop(args: { title: string; body: string }) {
    this.world.desktopNotifications.push(args);
  }

  async notifyRemoteChanged(projectId: string) {
    await this.world.ready;
    const sim = this.world.sims.get(projectId);
    if (sim) await sim.fetchTick();
  }

  on<E extends BackendEventName>(event: E, handler: (payload: BackendEvents[E]) => void) {
    return this.world.onBackend(event, handler);
  }
}

let instance: MockBackend | null = null;
export function getMockBackend(): MockBackend {
  if (!instance || instance.world !== getMockWorld()) instance = new MockBackend(getMockWorld());
  return instance;
}
