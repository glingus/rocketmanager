/**
 * The mock "world": shared in-memory state used by both the mock backend (files / Git)
 * and the mock data service (Supabase). Keeping a single source guarantees that, for example,
 * a version published through the backend shows up in the indexed versions, the Activity Log
 * and the colleagues' notifications, exactly like the real webhook would make it happen.
 */
import type { AppSettings, BackendEventName, BackendEvents, UpdateCheck } from '../types/ipc';
import type {
  ActivityEntry,
  AppNotification,
  Card,
  CardAttachment,
  CardCategory,
  CardComment,
  ConflictRecord,
  DiscordSettings,
  EventType,
  FileClaim,
  IndexedVersion,
  Invitation,
  MemberRole,
  NotificationPreference,
  Profile,
  Project,
  RealtimeTable,
} from '../types/data';
import { EVENT_CATALOG, formatSummary } from './summary';
import type { Commit, Person } from './repo';
import { ProjectSim } from './sync';
import { errors } from './errors';

export type WorldOptions = {
  /** `ready` links every project and applies the demo scenario (local changes, a conflict...). */
  seed: 'fresh' | 'ready';
  /** Multiplier for simulated latency. 0 = instant (tests). */
  speed: number;
  /** Background timers: periodic fetch, automatic publication. */
  timers: boolean;
  /** Persist the tiny bits of "session" state in localStorage. */
  persist: boolean;
};

export const DEFAULT_OPTIONS: WorldOptions = { seed: 'fresh', speed: 1, timers: true, persist: true };

export type Member = { projectId: string; userId: string; role: MemberRole; addedAt: string; lastActivityAt: string | null };

type Listener<T> = (payload: T) => void;

export const PEOPLE: Person[] = [
  { id: 'u-simone', login: 'sferri', name: 'Simone Ferri', email: '1001+sferri@users.noreply.github.com', color: '#a8503a' },
  { id: 'u-marco', login: 'mbellini', name: 'Marco Bellini', email: '1002+mbellini@users.noreply.github.com', color: '#4d6f8a' },
  { id: 'u-luca', login: 'lconti', name: 'Luca Conti', email: '1003+lconti@users.noreply.github.com', color: '#6b7f3a' },
  { id: 'u-giulia', login: 'grinaldi', name: 'Giulia Rinaldi', email: '1004+grinaldi@users.noreply.github.com', color: '#7a4a78' },
];

export class MockWorld {
  readonly opts: WorldOptions;
  /** Resolves once the demo scenario has been applied (tests and the backend await it). */
  ready: Promise<void> = Promise.resolve();
  readonly people: Person[] = PEOPLE;
  readonly me: Person = PEOPLE[0]!;

  // session / system
  signedIn = false;
  offline = false;
  appSettings: AppSettings = {
    autostart: true,
    desktopNotifications: true,
    minimizeToTray: true,
    fetchIntervalSeconds: 60,
  };
  updateInfo: UpdateCheck = { available: false };
  desktopNotifications: Array<{ title: string; body: string }> = [];
  /** Files / folders the app asked the OS to open (OpenRocket copies, folders). */
  openedCopies: string[] = [];
  secureStore = new Map<string, string>();
  linkedFolders = new Map<string, { folder: string; repoFullName: string; linkedAt: string }>();

  // Supabase-side tables
  profiles: Profile[] = [];
  projects: Project[] = [];
  members: Member[] = [];
  invitations: Invitation[] = [];
  indexedVersions = new Map<string, IndexedVersion[]>();
  conflictRecords: ConflictRecord[] = [];
  claims: FileClaim[] = [];
  categories: CardCategory[] = [];
  cards: Card[] = [];
  comments: CardComment[] = [];
  attachments: Array<CardAttachment & { blobUrl: string | null }> = [];
  activity: ActivityEntry[] = [];
  notifications: AppNotification[] = [];
  preferences: NotificationPreference[] = [];
  discord = new Map<string, DiscordSettings>();
  discordTests: string[] = [];
  eventTypes: EventType[] = EVENT_CATALOG;

  // Git-side
  cloud = new Map<string, Commit[]>();
  sims = new Map<string, ProjectSim>();

  private seq = { activity: 1, notification: 1, event: 1, id: 1 };
  private backendListeners = new Map<string, Set<Listener<never>>>();
  private dataListeners = new Set<Listener<{ table: RealtimeTable; projectId: string | null }>>();
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();

  constructor(opts: Partial<WorldOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  // ---- utilities -----------------------------------------------------------

  now(): number {
    return Date.now();
  }

  iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  uid(prefix = 'id'): string {
    return `${prefix}-${(this.seq.id++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  sleep(ms: number): Promise<void> {
    const real = ms * this.opts.speed;
    if (real <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timeouts.delete(t);
        resolve();
      }, real);
      this.timeouts.add(t);
    });
  }

  later(fn: () => void, ms: number): ReturnType<typeof setTimeout> | null {
    if (!this.opts.timers) return null;
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      fn();
    }, ms);
    this.timeouts.add(t);
    return t;
  }

  every(fn: () => void, ms: number): void {
    if (!this.opts.timers) return;
    this.intervals.add(setInterval(fn, ms));
  }

  dispose(): void {
    this.timeouts.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.timeouts.clear();
    this.intervals.clear();
    this.sims.forEach((s) => s.dispose());
  }

  person(id: string | null | undefined): Person {
    return this.people.find((p) => p.id === id) ?? this.me;
  }

  project(id: string): Project {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Error(`project ${id} not found`);
    return p;
  }

  roleOf(projectId: string, userId = this.me.id): MemberRole | null {
    return this.members.find((m) => m.projectId === projectId && m.userId === userId)?.role ?? null;
  }

  // ---- event buses ---------------------------------------------------------

  onBackend<E extends BackendEventName>(name: E, fn: (payload: BackendEvents[E]) => void): () => void {
    let set = this.backendListeners.get(name);
    if (!set) {
      set = new Set();
      this.backendListeners.set(name, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emitBackend<E extends BackendEventName>(name: E, payload: BackendEvents[E]): void {
    this.backendListeners.get(name)?.forEach((fn) => (fn as Listener<BackendEvents[E]>)(payload));
  }

  onData(fn: Listener<{ table: RealtimeTable; projectId: string | null }>): () => void {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  emitData(table: RealtimeTable, projectId: string | null): void {
    this.dataListeners.forEach((fn) => fn({ table, projectId }));
  }

  // ---- domain events -------------------------------------------------------

  /**
   * Mirrors `emit_event` / `emit_event_server`: writes the Activity Log, applies the retention
   * trigger, and creates the current user's notification when it is addressed to them.
   */
  emitEvent(
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    opts: { actorId?: string | null; at?: string; recipients?: string[] } = {},
  ): ActivityEntry {
    const catalog = this.eventTypes.find((e) => e.type === type);
    if (!catalog) throw new Error(`unknown event type ${type}`);
    const project = this.project(projectId);
    const actor = this.person(opts.actorId ?? null);
    const createdAt = opts.at ?? this.iso();
    const summary = formatSummary(type, payload, actor.name, project.name);
    const entry: ActivityEntry = {
      id: this.seq.activity++,
      projectId,
      actorId: opts.actorId === undefined ? this.me.id : opts.actorId,
      type,
      importance: catalog.importance,
      summary,
      payload,
      createdAt,
    };
    this.activity.push(entry);
    this.trimActivity(projectId);
    this.emitData('activity_log', projectId);

    if (catalog.notify) {
      const eventId = this.seq.event++;
      const isProjectAudience = catalog.audience === 'project';
      const addressedToMe = isProjectAudience
        ? entry.actorId !== this.me.id
        : (opts.recipients ?? []).includes(this.me.id);
      const pref = this.preferences.find((p) => p.eventType === type);
      if (addressedToMe && (pref?.inApp ?? true)) {
        this.notifications.push({
          id: this.seq.notification++,
          eventId,
          projectId,
          type,
          importance: catalog.importance,
          summary,
          payload,
          createdAt,
          readAt: null,
        });
        this.emitData('notifications', projectId);
        if (this.appSettings.desktopNotifications && (pref?.desktop ?? true) && !opts.at) {
          this.desktopNotifications.push({ title: project.name, body: summary });
        }
      }
    }
    return entry;
  }

  /** Retention trigger: keeps only the last N entries of a project. Never touches Git or versions. */
  trimActivity(projectId: string): void {
    const keep = this.project(projectId).settings.activityRetention;
    const mine = this.activity.filter((a) => a.projectId === projectId).sort((a, b) => b.id - a.id);
    const drop = new Set(mine.slice(keep).map((a) => a.id));
    if (drop.size > 0) this.activity = this.activity.filter((a) => !drop.has(a.id));
  }

  /** What the GitHub webhook does when a commit reaches `main`. */
  recordVersion(projectId: string, commit: Commit): void {
    if (commit.number == null || commit.kind === 'init') return;
    const author = this.person(commit.authorId);
    const list = this.indexedVersions.get(projectId) ?? [];
    if (list.some((v) => v.sha === commit.sha)) return;
    list.push({
      number: commit.number,
      sha: commit.sha,
      kind: commit.kind === 'conflictResolution' ? 'conflict-resolution' : commit.kind,
      title: commit.title,
      description: commit.description,
      authorLogin: author.login,
      authorName: author.name,
      publishedAt: commit.date,
      restoredFrom: commit.restoredFrom,
      conflictId: commit.conflictId,
      files: commit.files.map((f) => ({ path: f.path, change: f.change })),
    });
    this.indexedVersions.set(projectId, list);
    this.emitData('versions', projectId);
    this.emitEvent(
      projectId,
      commit.kind === 'restore' ? 'version.restored' : 'version.published',
      { number: commit.number, sha: commit.sha, title: commit.title, restoredFrom: commit.restoredFrom },
      { actorId: commit.authorId, at: commit.date },
    );
  }

  touchMember(projectId: string, userId: string, at = this.iso()): void {
    const m = this.members.find((x) => x.projectId === projectId && x.userId === userId);
    if (m) m.lastActivityAt = at;
  }

  // ---- projects & sims -----------------------------------------------------

  ensureSim(projectId: string, folder: string): ProjectSim {
    let sim = this.sims.get(projectId);
    if (!sim) {
      const history = this.cloud.get(projectId) ?? [];
      sim = new ProjectSim(this, projectId, history, folder);
      this.sims.set(projectId, sim);
    }
    return sim;
  }

  sim(projectId: string): ProjectSim {
    const sim = this.sims.get(projectId);
    if (!sim) throw Object.assign(new Error('not linked'), { code: 'notLinked', message: 'Questo progetto non è collegato a una cartella su questo PC.', retryable: false });
    return sim;
  }

  setOffline(value: boolean): void {
    this.offline = value;
    if (!value) this.sims.forEach((s) => void s.fetchTick());
    else {
      this.sims.forEach((s) => {
        this.emitBackend('sync-error', { projectId: s.projectId, error: errors.network() });
        s.touch();
      });
    }
  }

  persistSession(): void {
    if (!this.opts.persist || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem('rs.mock.signedIn', this.signedIn ? '1' : '0');
      localStorage.setItem('rs.mock.linked', JSON.stringify([...this.linkedFolders.entries()]));
    } catch {
      /* storage not available */
    }
  }

  restoreSession(): { signedIn: boolean; linked: Array<[string, { folder: string; repoFullName: string; linkedAt: string }]> } {
    if (!this.opts.persist || typeof localStorage === 'undefined') return { signedIn: false, linked: [] };
    try {
      return {
        signedIn: localStorage.getItem('rs.mock.signedIn') === '1',
        linked: JSON.parse(localStorage.getItem('rs.mock.linked') ?? '[]') as never,
      };
    } catch {
      return { signedIn: false, linked: [] };
    }
  }

  profileOf(personId: string): Profile {
    const p = this.profiles.find((x) => x.id === personId);
    if (p) return p;
    const person = this.person(personId);
    return {
      id: person.id,
      githubId: null,
      githubLogin: person.login,
      displayName: person.name,
      avatarUrl: null,
      avatarColor: person.color,
    };
  }
}
