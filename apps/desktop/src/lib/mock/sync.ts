/**
 * Simulation of one linked project: working folder, local Git history, pending versions,
 * conflicts, editor guard. It follows docs/protocollo-sync.md closely enough that the UI
 * can be exercised end to end without the Rust core.
 */
import type {
  AppError,
  ChangedFile,
  Comparison,
  Conflict,
  ConflictFile,
  FileResolution,
  PendingVersion,
  ProjectStatus,
  PublishPolicy,
  Snapshot,
  SyncState,
  VersionInfo,
} from '../types/ipc';
import type { MockWorld } from './world';
import { errors, appError } from './errors';
import { threeWay, type OrkDoc } from './ork';
import {
  changedPaths,
  cloneContent,
  cloneTree,
  compareTrees,
  contentEquals,
  contentSize,
  conflictId as newConflictId,
  copyName,
  describeChanges,
  generatedTitle,
  makeSha,
  toVersionInfo,
  type Commit,
  type FileContent,
  type Tree,
} from './repo';

type WorkingFile = { content: FileContent; modifiedAt: number; unstableUntil: number; invalid: string | null };
type Guard = { path: string; oldContent: FileContent | undefined; newContent: FileContent; fromVersion: number; toVersion: number };
type ConflictCtx = {
  conflict: Conflict;
  baseTree: Tree;
  oursTree: Tree;
  theirsTree: Tree;
  resolution: FileResolution[] | null;
};

type Busy = 'publishing' | 'updating' | null;

const STABLE_AFTER_MS = 2500;

export class ProjectSim {
  commits: Commit[];
  pending: Commit[] = [];
  working: Record<string, WorkingFile> = {};
  editor: { running: boolean; files: string[] | null } = { running: false, files: [] };
  guards: Guard[] = [];
  stale: string[] = [];
  conflicts: ConflictCtx[] = [];
  policy: PublishPolicy = { mode: 'assisted', idleMinutes: 10 };
  snapshots: Snapshot[] = [];
  error: AppError | null = null;
  lastFetchAt: string | null;
  lastPublishAt: string | null = null;
  lastSaveAt: number | null = null;
  knownRemoteLen: number;
  private busy: Busy = null;
  private pendingReason = new Map<string, PendingVersion['waitingReason']>();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private unlistenFns: Array<() => void> = [];

  constructor(
    readonly world: MockWorld,
    readonly projectId: string,
    history: Commit[],
    readonly folder: string,
  ) {
    this.commits = history.slice();
    this.knownRemoteLen = this.commits.length;
    this.lastFetchAt = world.iso();
    const project = world.projects.find((p) => p.id === projectId);
    if (project) this.policy = structuredClone(project.settings.publishPolicy) as PublishPolicy;
    const head = this.head();
    for (const [path, content] of Object.entries(head.tree)) {
      this.working[path] = { content: cloneContent(content), modifiedAt: Date.parse(head.date), unstableUntil: 0, invalid: null };
    }
    world.every(() => void this.fetchTick(), 20_000);
  }

  dispose(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.unlistenFns.forEach((f) => f());
  }

  // ---- derived state -------------------------------------------------------

  head(): Commit {
    return this.commits[this.commits.length - 1]!;
  }

  tipTree(): Tree {
    return this.pending[this.pending.length - 1]?.tree ?? this.head().tree;
  }

  workingTree(): Tree {
    const t: Tree = {};
    for (const [p, f] of Object.entries(this.working)) t[p] = f.content;
    return t;
  }

  private cloudTip(): Commit {
    const cloud = this.world.cloud.get(this.projectId)!;
    return cloud[cloud.length - 1]!;
  }

  private incoming(): Commit[] {
    return (this.world.cloud.get(this.projectId) ?? []).slice(this.commits.length);
  }

  changedFiles(): ChangedFile[] {
    const tip = this.tipTree();
    const work = this.workingTree();
    const now = this.world.now();
    return changedPaths(tip, work).map((path) => {
      const wf = this.working[path];
      const stable = !wf || now >= wf.unstableUntil;
      const valid: boolean | null = !wf ? true : wf.invalid ? false : stable ? true : null;
      return {
        path,
        change: !tip[path] ? 'added' : !work[path] ? 'deleted' : 'modified',
        stable,
        valid,
        ...(wf?.invalid ? { invalidReason: wf.invalid } : {}),
        sizeBytes: contentSize(work[path] ?? tip[path]),
        modifiedAt: wf ? new Date(wf.modifiedAt).toISOString() : null,
      } satisfies ChangedFile;
    });
  }

  openConflicts(): ConflictCtx[] {
    return this.conflicts.filter((c) => c.conflict.status === 'open');
  }

  private editorBlocked(paths: string[]): string[] {
    if (!this.editor.running) return [];
    if (this.editor.files === null) return paths;
    return paths.filter((p) => this.editor.files!.includes(p));
  }

  private pathsToWrite(): string[] {
    const theirs = this.cloudTip().tree;
    const ours = this.workingTree();
    return changedPaths(this.head().tree, theirs).filter((p) => !contentEquals(ours[p], theirs[p]));
  }

  status(): ProjectStatus {
    const changes = this.changedFiles();
    const open = this.openConflicts();
    const incomingPending = this.knownRemoteLen > this.commits.length;
    let state: SyncState;
    if (this.error) state = 'error';
    else if (open.length) state = 'conflict';
    else if (this.busy) state = this.busy;
    else if (this.world.offline && this.pending.length) state = 'offline';
    else if (incomingPending) state = 'updateAvailable';
    else if (changes.length || this.pending.length) state = 'localChanges';
    else state = 'synced';

    const head = this.head();
    const cloudTipNumber = this.world.cloud.get(this.projectId)!.slice(0, this.knownRemoteLen).at(-1)?.number ?? null;
    const idle = this.policy.mode === 'assisted' ? this.policy.idleMinutes : null;
    const autoAt =
      idle != null && changes.length > 0 && this.lastSaveAt != null && !open.length
        ? new Date(this.lastSaveAt + idle * 60_000).toISOString()
        : null;
    const size = this.commits.reduce(
      (acc, c) => acc + c.files.reduce((a, f) => a + (f.sizeAfter ?? 0), 0),
      0,
    );
    return {
      projectId: this.projectId,
      state,
      folder: this.folder,
      headVersion: head.number,
      remoteVersion: cloudTipNumber,
      behindBy: Math.max(0, this.knownRemoteLen - this.commits.length),
      changedFiles: changes,
      pendingVersions: this.pending.map((c) => ({
        sha: c.sha,
        title: c.title,
        createdAt: c.date,
        waitingReason: open.length
          ? 'conflict'
          : this.world.offline
            ? 'offline'
            : (this.pendingReason.get(c.sha) ?? null),
      })),
      blockedByEditor: incomingPending && !open.length ? this.editorBlocked(this.pathsToWrite()) : [],
      openConflictIds: open.map((c) => c.conflict.id),
      staleSaveSuspected: [...this.stale],
      lastFetchAt: this.lastFetchAt,
      lastPublishAt: this.lastPublishAt,
      autoPublishAt: autoAt,
      repoSizeBytes: size,
      error: this.error,
    };
  }

  touch(): ProjectStatus {
    const s = this.status();
    this.world.emitBackend('project-status', s);
    return s;
  }

  private progress(op: string, step: string, percent: number | null, message: string): void {
    this.world.emitBackend('operation-progress', { projectId: this.projectId, op, step, percent, message });
  }

  private snapshot(operation: string): void {
    this.snapshots.unshift({
      id: `snap-${this.world.now().toString(36)}`,
      createdAt: this.world.iso(),
      operation,
      fileCount: Object.keys(this.working).length,
    });
    this.snapshots = this.snapshots.slice(0, 50);
  }

  // ---- local edits (what the watcher would see) ----------------------------

  /** Simulates OpenRocket saving a file in the working folder. */
  save(
    path: string,
    produce: (current: FileContent | undefined) => FileContent,
    opts: { at?: number; invalid?: string | null } = {},
  ): ProjectStatus {
    const current = this.working[path]?.content;
    const content = produce(current ? cloneContent(current) : undefined);
    const at = opts.at ?? this.world.now();
    this.working[path] = {
      content,
      modifiedAt: at,
      unstableUntil: opts.at ? 0 : at + STABLE_AFTER_MS * this.world.opts.speed,
      invalid: opts.invalid ?? null,
    };
    this.lastSaveAt = at;
    // Editor guard (§7.8): a save of a file written by Rocket Sync while the editor stayed open
    if (this.guards.some((g) => g.path === path) && !this.stale.includes(path)) {
      this.stale.push(path);
      this.world.emitBackend('stale-save-suspected', { projectId: this.projectId, path });
    }
    if (!opts.at) this.world.later(() => this.touch(), STABLE_AFTER_MS + 100);
    this.scheduleAuto();
    return this.touch();
  }

  /** Removes a file from the working folder. */
  remove(path: string): ProjectStatus {
    delete this.working[path];
    this.lastSaveAt = this.world.now();
    return this.touch();
  }

  setEditor(running: boolean, files: string[] | null = []): ProjectStatus {
    const wasRunning = this.editor.running;
    this.editor = { running, files: running ? files : [] };
    if (!running) {
      // Closing OpenRocket ends the guard (§7.8) and lets a blocked update go through.
      this.guards = [];
      if (wasRunning) void this.fetchTick();
    }
    return this.touch();
  }

  private scheduleAuto(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    if (!this.world.opts.timers) return;
    if (this.policy.mode === 'assisted') {
      const delay = this.policy.idleMinutes * 60_000;
      this.autoTimer = setTimeout(() => void this.autoPublish(), delay);
    } else if (this.policy.mode === 'onSave') {
      this.autoTimer = setTimeout(() => void this.autoPublish(), STABLE_AFTER_MS + 500);
    }
  }

  private async autoPublish(): Promise<void> {
    if (this.changedFiles().length === 0 || this.openConflicts().length || this.stale.length) return;
    try {
      await this.publish({});
    } catch {
      /* the UI shows the error through project-status */
    }
  }

  // ---- fetch / update ------------------------------------------------------

  async fetch(): Promise<void> {
    if (this.world.offline) throw errors.network();
    await this.world.sleep(250);
    this.knownRemoteLen = (this.world.cloud.get(this.projectId) ?? []).length;
    this.lastFetchAt = this.world.iso();
  }

  /** Periodic check: fetch, auto update when safe, send pending versions. */
  async fetchTick(): Promise<void> {
    if (this.busy) return;
    try {
      await this.fetch();
      if (this.error?.code === 'network') this.error = null;
    } catch (e) {
      this.world.emitBackend('sync-error', { projectId: this.projectId, error: e as AppError });
      this.touch();
      return;
    }
    if (this.openConflicts().length === 0) {
      await this.applyIncoming(false);
      if (this.pending.length) await this.send();
    }
    this.touch();
  }

  /**
   * Brings in versions published by colleagues. Returns what happened.
   */
  async applyIncoming(force: boolean): Promise<'none' | 'applied' | 'blocked' | 'conflict'> {
    const incoming = this.incoming();
    if (incoming.length === 0) return 'none';
    if (this.openConflicts().length) return 'conflict';
    const head = this.head();
    const theirsTree = this.cloudTip().tree;
    const ours = this.workingTree();
    const theirsTouched = changedPaths(head.tree, theirsTree);
    const overlap = theirsTouched.filter(
      (p) => !contentEquals(ours[p], head.tree[p]) && !contentEquals(ours[p], theirsTree[p]),
    );
    if (overlap.length) {
      this.createConflict(overlap, {
        baseTree: head.tree,
        oursTree: ours,
        theirsTree,
        theirsCommit: this.cloudTip(),
      });
      return 'conflict';
    }
    const writes = theirsTouched.filter((p) => !contentEquals(ours[p], theirsTree[p]));
    const blocked = this.editorBlocked(writes);
    if (blocked.length && !force) {
      this.pendingReason.forEach((_v, k) => this.pendingReason.set(k, 'blockedByEditor'));
      return 'blocked';
    }
    this.busy = 'updating';
    this.touch();
    if (Object.keys(ours).length) this.snapshot('update');
    this.progress('update', 'download', 40, 'Scarico le novità dei colleghi');
    await this.world.sleep(500);
    const fromVersion = head.number ?? 0;
    for (const p of writes) {
      const content = theirsTree[p];
      if (content) {
        this.working[p] = { content: cloneContent(content), modifiedAt: this.world.now(), unstableUntil: 0, invalid: null };
      } else delete this.working[p];
      if (blocked.includes(p)) {
        this.guards.push({
          path: p,
          oldContent: head.tree[p],
          newContent: content!,
          fromVersion,
          toVersion: this.cloudTip().number ?? 0,
        });
      }
    }
    this.commits.push(...incoming);
    this.knownRemoteLen = this.commits.length;
    this.busy = null;
    this.pendingReason.clear();
    this.progress('update', 'done', 100, 'Aggiornamento completato');
    this.world.emitBackend('update-applied', {
      projectId: this.projectId,
      fromVersion,
      toVersion: this.cloudTip().number ?? 0,
      files: writes,
    });
    this.touch();
    return 'applied';
  }

  async updateNow(force: boolean): Promise<ProjectStatus> {
    if (this.openConflicts().length) throw errors.conflictOpen();
    await this.fetch();
    const result = await this.applyIncoming(force);
    if (result === 'blocked') {
      this.touch();
      throw errors.blockedByEditor(this.editorBlocked(this.pathsToWrite()));
    }
    if (this.pending.length && result !== 'conflict') await this.send();
    return this.touch();
  }

  async syncNow(): Promise<ProjectStatus> {
    this.progress('sync', 'fetch', null, 'Controllo le novità');
    await this.fetch();
    if (this.openConflicts().length === 0) {
      await this.applyIncoming(false);
      if (this.pending.length) await this.send();
    }
    return this.touch();
  }

  // ---- publish -------------------------------------------------------------

  async publish(input: { title?: string; description?: string; paths?: string[] }): Promise<ProjectStatus> {
    if (this.openConflicts().length) throw errors.conflictOpen();
    const all = this.changedFiles();
    const chosen = input.paths?.length ? all.filter((f) => input.paths!.includes(f.path)) : all;
    if (chosen.length === 0) throw errors.nothingToPublish();
    for (const f of chosen) {
      if (this.stale.includes(f.path)) throw errors.staleSave(f.path);
      if (!f.stable) throw errors.fileNotStable(f.path);
      if (f.valid === false) throw errors.fileInvalid(f.path, f.invalidReason ?? 'file incompleto');
    }
    this.busy = 'publishing';
    this.touch();
    try {
      this.progress('publish', 'safety', 15, 'Copia di sicurezza della cartella');
      this.snapshot('publish');
      await this.world.sleep(350);
      this.progress('publish', 'commit', 45, 'Creo la versione');
      const tree = cloneTree(this.tipTree());
      const work = this.workingTree();
      for (const f of chosen) {
        const content = work[f.path];
        if (content) tree[f.path] = cloneContent(content);
        else delete tree[f.path];
      }
      const { files, changelog } = describeChanges(this.tipTree(), tree);
      const title = input.title?.trim() || generatedTitle(chosen.map((c) => c.path));
      const commit: Commit = {
        sha: makeSha(`${this.projectId}-${this.world.now()}-${title}`),
        number: null,
        kind: 'publish',
        title,
        description: input.description?.trim() || null,
        authorId: this.world.me.id,
        date: this.world.iso(),
        tree,
        baseTree: cloneTree(this.tipTree()),
        parentSha: (this.pending.at(-1) ?? this.head()).sha,
        restoredFrom: null,
        conflictId: null,
        published: false,
        changelog,
        files,
      };
      this.pending.push(commit);
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.busy = null;
      await this.send();
    } finally {
      this.busy = null;
    }
    return this.touch();
  }

  /** Sends pending versions (renumbering them) as in protocol section 7.4.4. */
  async send(): Promise<void> {
    if (this.pending.length === 0 || this.openConflicts().length) return;
    if (this.world.offline) {
      this.pending.forEach((c) => this.pendingReason.set(c.sha, 'offline'));
      this.touch();
      return;
    }
    await this.fetch();
    const result = await this.applyIncoming(false);
    if (result === 'conflict') return;
    if (result === 'blocked') {
      this.pending.forEach((c) => this.pendingReason.set(c.sha, 'blockedByEditor'));
      this.touch();
      return;
    }
    this.busy = 'publishing';
    this.touch();
    this.progress('publish', 'push', 75, 'Invio a GitHub');
    await this.world.sleep(500);
    const cloud = this.world.cloud.get(this.projectId)!;
    while (this.pending.length) {
      const c = this.pending[0]!;
      const head = this.head();
      const tree = cloneTree(head.tree);
      const base = c.baseTree ?? head.tree;
      for (const p of changedPaths(base, c.tree)) {
        const content = c.tree[p];
        if (content) tree[p] = cloneContent(content);
        else delete tree[p];
      }
      const number = (head.number ?? 0) + 1;
      const { files, changelog } = describeChanges(head.tree, tree);
      const published: Commit = {
        ...c,
        number,
        tree,
        baseTree: undefined,
        parentSha: head.sha,
        sha: makeSha(`${c.sha}-${number}`),
        published: true,
        files: c.kind === 'restore' ? c.files : files,
        changelog: c.kind === 'restore' ? c.changelog : changelog,
        date: this.world.iso(),
      };
      cloud.push(published);
      this.commits.push(published);
      this.pending.shift();
      this.pendingReason.delete(c.sha);
      this.knownRemoteLen = cloud.length;
      this.lastPublishAt = published.date;
      this.world.recordVersion(this.projectId, published);
      this.world.touchMember(this.projectId, this.world.me.id);
      this.world.emitBackend('version-published', {
        projectId: this.projectId,
        number,
        sha: published.sha,
        title: published.title,
      });
    }
    this.busy = null;
    this.progress('publish', 'done', 100, 'Pubblicazione completata');
    this.touch();
  }

  // ---- discard / restore ---------------------------------------------------

  discard(paths: string[]): ProjectStatus {
    this.snapshot('discard');
    const tip = this.tipTree();
    for (const p of paths) {
      const original = tip[p];
      if (original) {
        this.working[p] = { content: cloneContent(original), modifiedAt: this.world.now(), unstableUntil: 0, invalid: null };
      } else delete this.working[p];
      this.stale = this.stale.filter((s) => s !== p);
      this.guards = this.guards.filter((g) => g.path !== p);
    }
    return this.touch();
  }

  async restore(sha: string, paths?: string[]): Promise<ProjectStatus> {
    if (this.openConflicts().length) throw errors.conflictOpen();
    const target = this.commits.find((c) => c.sha === sha);
    if (!target) throw errors.notFound('Versione');
    if (this.world.offline === false && this.incoming().length) {
      await this.fetch();
      const r = await this.applyIncoming(false);
      if (r === 'blocked' || r === 'conflict') throw errors.blockedByEditor(this.editorBlocked(this.pathsToWrite()));
    }
    const tip = this.tipTree();
    const newTree: Tree = paths?.length ? cloneTree(tip) : cloneTree(target.tree);
    if (paths?.length) {
      for (const p of paths) {
        if (target.tree[p]) newTree[p] = cloneContent(target.tree[p]!);
        else delete newTree[p];
      }
    }
    const affected = changedPaths(this.workingTree(), newTree);
    const dirty = this.changedFiles().filter((f) => affected.includes(f.path));
    if (dirty.length) throw errors.localChanges();
    const blocked = this.editorBlocked(affected);
    if (blocked.length) throw errors.blockedByEditor(blocked);

    this.snapshot('restore');
    this.busy = 'updating';
    this.touch();
    this.progress('restore', 'write', 50, `Ripristino la versione ${target.number}`);
    await this.world.sleep(500);
    for (const p of affected) {
      const content = newTree[p];
      if (content) this.working[p] = { content: cloneContent(content), modifiedAt: this.world.now(), unstableUntil: 0, invalid: null };
      else delete this.working[p];
    }
    const { files, changelog } = describeChanges(tip, newTree);
    const commit: Commit = {
      sha: makeSha(`restore-${this.projectId}-${sha}-${this.world.now()}`),
      number: null,
      kind: 'restore',
      title: `Ripristinata la versione ${target.number}`,
      description: paths?.length ? `Ripristinati: ${paths.join(', ')}` : null,
      authorId: this.world.me.id,
      date: this.world.iso(),
      tree: newTree,
      baseTree: cloneTree(tip),
      parentSha: (this.pending.at(-1) ?? this.head()).sha,
      restoredFrom: target.number,
      conflictId: null,
      published: false,
      changelog,
      files,
    };
    this.pending.push(commit);
    this.busy = null;
    await this.send();
    return this.touch();
  }

  // ---- conflicts -----------------------------------------------------------

  createConflict(
    paths: string[],
    ctx: { baseTree: Tree; oursTree: Tree; theirsTree: Tree; theirsCommit: Commit },
  ): ConflictCtx {
    // Local, unpublished work goes into a pending version first (protocol 7.5.1).
    const unpublished = changedPaths(this.tipTree(), this.workingTree());
    if (unpublished.length) {
      const tree = cloneTree(this.workingTree());
      const { files, changelog } = describeChanges(this.tipTree(), tree);
      this.pending.push({
        sha: makeSha(`conflict-local-${this.projectId}-${this.world.now()}`),
        number: null,
        kind: 'publish',
        title: 'Modifiche locali in conflitto',
        description: null,
        authorId: this.world.me.id,
        date: this.world.iso(),
        tree,
        baseTree: cloneTree(this.tipTree()),
        parentSha: (this.pending.at(-1) ?? this.head()).sha,
        restoredFrom: null,
        conflictId: null,
        published: false,
        changelog,
        files,
      });
    }
    const files: ConflictFile[] = paths.map((path) => {
      const b = ctx.baseTree[path];
      const o = ctx.oursTree[path];
      const t = ctx.theirsTree[path];
      const kind: ConflictFile['kind'] = !b && o && t ? 'bothAdded' : o && !t ? 'modifiedDeleted' : !o && t ? 'deletedModified' : 'bothModified';
      const allOrk = (!b || b.kind === 'ork') && o?.kind === 'ork' && t?.kind === 'ork';
      return {
        path,
        kind,
        threeWay: allOrk
          ? threeWay(path, b?.kind === 'ork' ? (b.doc as OrkDoc) : null, (o as { doc: OrkDoc }).doc, (t as { doc: OrkDoc }).doc)
          : null,
      };
    });
    const id = newConflictId(new Date(this.world.now()));
    const author = this.world.person(ctx.theirsCommit.authorId);
    const conflict: Conflict = {
      id,
      projectId: this.projectId,
      status: 'open',
      createdAt: this.world.iso(),
      baseSha: this.head().sha,
      oursSha: (this.pending.at(-1) ?? this.head()).sha,
      theirsSha: ctx.theirsCommit.sha,
      theirsVersion: ctx.theirsCommit.number,
      theirsAuthor: author.name,
      remoteBranchPushed: !this.world.offline,
      files,
    };
    const entry: ConflictCtx = { conflict, baseTree: ctx.baseTree, oursTree: cloneTree(ctx.oursTree), theirsTree: ctx.theirsTree, resolution: null };
    this.conflicts.push(entry);
    this.knownRemoteLen = this.world.cloud.get(this.projectId)!.length;
    this.world.emitBackend('conflict-detected', { projectId: this.projectId, conflictId: id, files: paths });
    this.touch();
    return entry;
  }

  answerStale(path: string, reopened: boolean): ProjectStatus {
    const guard = this.guards.find((g) => g.path === path);
    this.stale = this.stale.filter((p) => p !== path);
    this.guards = this.guards.filter((g) => g.path !== path);
    if (!reopened && guard) {
      const baseTree = cloneTree(this.head().tree);
      if (guard.oldContent) baseTree[path] = cloneContent(guard.oldContent);
      else delete baseTree[path];
      this.createConflict([path], {
        baseTree,
        oursTree: this.workingTree(),
        theirsTree: this.head().tree,
        theirsCommit: this.head(),
      });
    }
    return this.touch();
  }

  getConflict(id: string): Conflict {
    const c = this.conflicts.find((x) => x.conflict.id === id);
    if (!c) throw errors.notFound('Conflitto');
    return c.conflict;
  }

  async resolve(id: string, resolutions: FileResolution[]): Promise<ProjectStatus> {
    const ctx = this.conflicts.find((c) => c.conflict.id === id);
    if (!ctx || ctx.conflict.status !== 'open') throw errors.notFound('Conflitto aperto');
    const byPath = new Map(resolutions.map((r) => [r.path, r.choice]));
    for (const f of ctx.conflict.files) {
      if (!byPath.has(f.path)) throw appError('internal', `Manca la scelta per ${f.path}.`);
    }
    const conflictPaths = new Set(ctx.conflict.files.map((f) => f.path));
    const final: Tree = cloneTree(ctx.theirsTree);
    // Non conflicting local changes are carried over.
    for (const p of changedPaths(ctx.baseTree, ctx.oursTree)) {
      if (conflictPaths.has(p)) continue;
      const mine = ctx.oursTree[p];
      if (mine) final[p] = cloneContent(mine);
      else delete final[p];
    }
    const today = new Date(this.world.now()).toISOString().slice(0, 10);
    const firstName = this.world.me.name.split(' ')[0]!;
    const manualPaths: string[] = [];
    for (const p of conflictPaths) {
      const choice = byPath.get(p)!;
      const mine = ctx.oursTree[p];
      const theirs = ctx.theirsTree[p];
      if (choice === 'mine') {
        if (mine) final[p] = cloneContent(mine);
        else delete final[p];
      } else if (choice === 'theirs') {
        if (theirs) final[p] = cloneContent(theirs);
        else delete final[p];
      } else if (choice === 'both') {
        if (theirs) final[p] = cloneContent(theirs);
        if (mine) final[copyName(p, firstName, today)] = cloneContent(mine);
      } else {
        manualPaths.push(p);
        const current = this.working[p];
        if (!current) throw errors.fileNotStable(p);
        if (current.invalid) throw errors.fileInvalid(p, current.invalid);
        final[p] = cloneContent(current.content);
      }
    }
    const writes = changedPaths(this.workingTree(), final).filter((p) => !manualPaths.includes(p));
    const blocked = this.editorBlocked(writes);
    if (blocked.length) throw errors.blockedByEditor(blocked);

    this.snapshot('resolve');
    this.busy = 'publishing';
    this.touch();
    this.progress('resolve', 'merge', 40, 'Creo la versione di risoluzione');
    await this.world.sleep(600);
    const cloud = this.world.cloud.get(this.projectId)!;
    // Catch up with everything published meanwhile.
    this.commits = cloud.slice();
    const head = this.head();
    const number = (head.number ?? 0) + 1;
    const { files, changelog } = describeChanges(head.tree, final);
    const commit: Commit = {
      sha: makeSha(`resolve-${id}-${number}`),
      number,
      kind: 'conflictResolution',
      title: `Risoluzione conflitto su ${[...conflictPaths].join(', ')}`,
      description: null,
      authorId: this.world.me.id,
      date: this.world.iso(),
      tree: final,
      parentSha: head.sha,
      restoredFrom: null,
      conflictId: id,
      published: true,
      changelog,
      files,
    };
    cloud.push(commit);
    this.commits.push(commit);
    this.pending = [];
    this.pendingReason.clear();
    this.working = {};
    for (const [p, content] of Object.entries(final)) {
      const manual = manualPaths.includes(p);
      this.working[p] = {
        content: cloneContent(content),
        modifiedAt: manual ? (this.working[p]?.modifiedAt ?? this.world.now()) : this.world.now(),
        unstableUntil: 0,
        invalid: null,
      };
    }
    ctx.conflict.status = 'resolved';
    ctx.resolution = resolutions;
    this.knownRemoteLen = cloud.length;
    this.lastPublishAt = commit.date;
    this.busy = null;
    this.world.recordVersion(this.projectId, commit);
    this.progress('resolve', 'done', 100, 'Conflitto risolto');
    this.world.emitBackend('version-published', { projectId: this.projectId, number, sha: commit.sha, title: commit.title });
    this.world.emitBackend('conflict-resolved', { projectId: this.projectId, conflictId: id, number });
    return this.touch();
  }

  // ---- history -------------------------------------------------------------

  private personFor(commit: Commit) {
    return this.world.person(commit.authorId);
  }

  versions(limit?: number, beforeSha?: string): VersionInfo[] {
    const published = this.commits.slice().reverse();
    const pending = this.pending.slice().reverse();
    let all = [...pending, ...published];
    if (beforeSha) {
      const idx = all.findIndex((c) => c.sha === beforeSha);
      if (idx >= 0) all = all.slice(idx + 1);
    }
    if (limit) all = all.slice(0, limit);
    return all.map((c) => toVersionInfo(c, this.personFor(c)));
  }

  version(sha: string): VersionInfo {
    const c = [...this.commits, ...this.pending].find((x) => x.sha === sha);
    if (!c) throw errors.notFound('Versione');
    return toVersionInfo(c, this.personFor(c));
  }

  private treeFor(sha: string): Tree {
    const c = [...this.commits, ...this.pending].find((x) => x.sha === sha);
    if (!c) throw errors.notFound('Versione');
    return c.tree;
  }

  compare(fromSha: string, toSha: string): Comparison {
    const all = [...this.commits, ...this.pending];
    const from = all.find((c) => c.sha === fromSha);
    const to = all.find((c) => c.sha === toSha);
    if (!from || !to) throw errors.notFound('Versione');
    return {
      from: { number: from.number, sha: from.sha },
      to: { number: to.number, sha: to.sha },
      files: compareTrees(this.treeFor(fromSha), this.treeFor(toSha)),
    };
  }

  versionPaths(sha: string): string[] {
    return Object.keys(this.treeFor(sha)).sort();
  }
}
