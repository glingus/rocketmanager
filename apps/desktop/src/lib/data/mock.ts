import type {
  ActivityEntry,
  Card,
  CardAttachment,
  CardCategory,
  CardComment,
  ConflictRecord,
  DiscordSettings,
  Invitation,
  Member,
  MemberRole,
  NotificationPreference,
  Profile,
  Project,
  ProjectWithRole,
} from '../types/data';
import type { DataService, RealtimeHandler } from './types';
import { getMockWorld, type MockWorld } from '../mock';
import { appError } from '../mock/errors';
import { defaultCategories } from '../mock/seed';
import { makeSha } from '../mock/repo';

const LATENCY = 40;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'progetto'
  );
}

const forbidden = () => appError('authFailed', 'Solo un amministratore del progetto può farlo.');

/** In-memory Supabase: same behaviour as the policies and RPC of docs/modello-dati.md. */
export class MockData implements DataService {
  readonly kind = 'mock' as const;

  constructor(readonly world: MockWorld) {}

  private async ready(ms = LATENCY): Promise<void> {
    await this.world.ready;
    await this.world.sleep(ms);
  }

  private requireAdmin(projectId: string): void {
    if (this.world.roleOf(projectId) !== 'admin') throw forbidden();
  }

  private requireMember(projectId: string): void {
    if (!this.world.roleOf(projectId)) throw appError('authFailed', 'Non fai parte di questo progetto.');
  }

  async setSession(): Promise<void> {
    /* the mock needs no token */
  }

  // ---- profiles ----------------------------------------------------------------

  async getMyProfile(): Promise<Profile> {
    await this.ready();
    return this.world.profileOf(this.world.me.id);
  }

  async updateMyProfile(patch: { displayName?: string; avatarColor?: string }): Promise<Profile> {
    await this.ready();
    const p = this.world.profiles.find((x) => x.id === this.world.me.id)!;
    if (patch.displayName !== undefined) {
      p.displayName = patch.displayName.trim() || p.displayName;
      this.world.me.name = p.displayName;
    }
    if (patch.avatarColor !== undefined) {
      p.avatarColor = patch.avatarColor;
      this.world.me.color = patch.avatarColor;
    }
    return { ...p };
  }

  async listProfiles(): Promise<Profile[]> {
    await this.ready();
    return this.world.profiles.map((p) => ({ ...p }));
  }

  async acceptInvitations(): Promise<number> {
    await this.ready();
    return 0;
  }

  // ---- projects ----------------------------------------------------------------

  async listProjects(): Promise<ProjectWithRole[]> {
    await this.ready();
    return this.world.projects
      .map((p) => ({ p, role: this.world.roleOf(p.id) }))
      .filter((x): x is { p: Project; role: MemberRole } => x.role != null)
      .map(({ p, role }) => ({ ...structuredClone(p), myRole: role }));
  }

  async createProject(input: { name: string; description?: string }): Promise<Project> {
    await this.ready(600);
    const w = this.world;
    const name = input.name.trim();
    if (!name || name.length > 80) throw appError('internal', 'Il nome del progetto deve avere da 1 a 80 caratteri.');
    const slug = slugify(name);
    if (w.projects.some((p) => p.slug === slug)) throw appError('internal', 'Esiste già un progetto con un nome simile.');
    const project: Project = {
      id: w.uid('p'),
      name,
      slug,
      description: input.description?.trim() ?? '',
      githubOwner: 'rocketsync-team',
      githubRepo: slug,
      defaultBranch: 'main',
      createdBy: w.me.id,
      createdAt: w.iso(),
      archivedAt: null,
      settings: { publishPolicy: { mode: 'assisted', idleMinutes: 10 }, activityRetention: 100 },
    };
    w.projects.push(project);
    w.members.push({ projectId: project.id, userId: w.me.id, role: 'admin', addedAt: w.iso(), lastActivityAt: w.iso() });
    w.categories.push(...defaultCategories(w, project.id));
    w.cloud.set(project.id, [
      {
        sha: makeSha(`${project.id}-init`),
        number: 0,
        kind: 'init',
        title: 'Progetto creato',
        description: null,
        authorId: w.me.id,
        date: w.iso(),
        tree: {},
        parentSha: null,
        restoredFrom: null,
        conflictId: null,
        published: true,
        changelog: [],
        files: [],
      },
    ]);
    w.discord.set(project.id, {
      projectId: project.id,
      enabledEventTypes: w.eventTypes.filter((e) => e.discordDefault).map((e) => e.type),
      webhookConfigured: false,
      updatedAt: null,
    });
    w.emitEvent(project.id, 'project.created', {});
    w.emitData('project_members', project.id);
    return structuredClone(project);
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; description?: string; settings?: Partial<Project['settings']> },
  ): Promise<Project> {
    await this.ready();
    this.requireAdmin(projectId);
    const p = this.world.project(projectId);
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.settings) p.settings = { ...p.settings, ...patch.settings };
    if (patch.settings?.activityRetention) this.world.trimActivity(projectId);
    this.world.emitData('activity_log', projectId);
    return structuredClone(p);
  }

  // ---- members -----------------------------------------------------------------

  async listMembers(projectId: string): Promise<Member[]> {
    await this.ready();
    return this.world.members
      .filter((m) => m.projectId === projectId)
      .map((m) => ({
        userId: m.userId,
        role: m.role,
        addedAt: m.addedAt,
        lastActivityAt: m.lastActivityAt,
        profile: this.world.profileOf(m.userId),
      }))
      .sort((a, b) => (a.role === b.role ? a.profile.displayName.localeCompare(b.profile.displayName) : a.role === 'admin' ? -1 : 1));
  }

  async listInvitations(projectId: string): Promise<Invitation[]> {
    await this.ready();
    this.requireAdmin(projectId);
    return this.world.invitations.filter((i) => i.projectId === projectId && i.status === 'pending').map((i) => ({ ...i }));
  }

  private lastAdminGuard(projectId: string, userId: string): void {
    const admins = this.world.members.filter((m) => m.projectId === projectId && m.role === 'admin');
    if (admins.length === 1 && admins[0]!.userId === userId) {
      throw appError('internal', 'Ogni progetto deve avere almeno un amministratore: nomina prima qualcun altro.');
    }
  }

  async addMember(projectId: string, githubLogin: string, role: MemberRole): Promise<void> {
    await this.ready(500);
    this.requireAdmin(projectId);
    const login = githubLogin.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
      throw appError('internal', 'Lo username GitHub non è valido: usa solo lettere, numeri e trattini.');
    }
    const w = this.world;
    const person = w.people.find((p) => p.login.toLowerCase() === login.toLowerCase());
    if (person && w.members.some((m) => m.projectId === projectId && m.userId === person.id)) {
      throw appError('internal', `${person.name} fa già parte del progetto.`);
    }
    if (w.invitations.some((i) => i.projectId === projectId && i.status === 'pending' && i.githubLogin.toLowerCase() === login.toLowerCase())) {
      throw appError('internal', `${login} è già stato invitato.`);
    }
    if (person) {
      w.members.push({ projectId, userId: person.id, role, addedAt: w.iso(), lastActivityAt: null });
      w.emitData('project_members', projectId);
    } else {
      w.invitations.push({ id: w.uid('inv'), projectId, githubLogin: login, role, status: 'pending', createdAt: w.iso() });
    }
    w.emitEvent(projectId, 'member.added', { login, role });
    w.emitData('project_members', projectId);
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.ready(400);
    this.requireAdmin(projectId);
    this.lastAdminGuard(projectId, userId);
    const w = this.world;
    const login = w.person(userId).login;
    w.members = w.members.filter((m) => !(m.projectId === projectId && m.userId === userId));
    w.emitEvent(projectId, 'member.removed', { login });
    w.emitData('project_members', projectId);
  }

  async revokeInvitation(projectId: string, invitation: Invitation): Promise<void> {
    await this.ready();
    this.requireAdmin(projectId);
    this.world.invitations = this.world.invitations.filter((i) => i.id !== invitation.id);
    this.world.emitData('project_members', projectId);
  }

  async setMemberRole(projectId: string, userId: string, role: MemberRole): Promise<void> {
    await this.ready();
    this.requireAdmin(projectId);
    if (role === 'member') this.lastAdminGuard(projectId, userId);
    const m = this.world.members.find((x) => x.projectId === projectId && x.userId === userId);
    if (!m) throw appError('notFound', 'Membro non trovato.');
    m.role = role;
    this.world.emitEvent(projectId, 'member.role_changed', { login: this.world.person(userId).login, role });
    this.world.emitData('project_members', projectId);
  }

  // ---- versions index and conflicts ------------------------------------------------

  async listIndexedVersions(projectId: string, limit?: number) {
    await this.ready();
    this.requireMember(projectId);
    const all = [...(this.world.indexedVersions.get(projectId) ?? [])].sort((a, b) => b.number - a.number);
    return (limit ? all.slice(0, limit) : all).map((v) => ({ ...v }));
  }

  async listConflictRecords(projectId: string): Promise<ConflictRecord[]> {
    await this.ready();
    this.requireMember(projectId);
    return this.world.conflictRecords.filter((c) => c.projectId === projectId).map((c) => ({ ...c }));
  }

  async reportConflict(args: {
    projectId: string;
    conflictId: string;
    files: { path: string; kind: string }[];
    theirsVersion: number | null;
    theirsUserLogin: string | null;
  }): Promise<void> {
    await this.ready();
    const w = this.world;
    if (w.conflictRecords.some((c) => c.id === args.conflictId)) return; // idempotent on the id
    const theirs = w.people.find((p) => p.login === args.theirsUserLogin);
    w.conflictRecords.push({
      id: args.conflictId,
      projectId: args.projectId,
      files: args.files,
      oursUserId: w.me.id,
      theirsUserId: theirs?.id ?? null,
      theirsVersion: args.theirsVersion,
      status: 'open',
      resolvedBy: null,
      resolvedVersion: null,
      createdAt: w.iso(),
      resolvedAt: null,
    });
    w.emitEvent(args.projectId, 'conflict.detected', { files: args.files.map((f) => f.path).join(', '), conflictId: args.conflictId });
    w.emitData('conflicts', args.projectId);
  }

  async resolveConflictRecord(args: { projectId: string; conflictId: string; resolution: unknown; resolvedVersion: number }): Promise<void> {
    await this.ready();
    const w = this.world;
    const rec = w.conflictRecords.find((c) => c.id === args.conflictId);
    if (!rec || rec.status === 'resolved') return;
    rec.status = 'resolved';
    rec.resolvedBy = w.me.id;
    rec.resolvedVersion = args.resolvedVersion;
    rec.resolvedAt = w.iso();
    w.emitEvent(args.projectId, 'conflict.resolved', { number: args.resolvedVersion, conflictId: args.conflictId });
    w.emitData('conflicts', args.projectId);
  }

  // ---- claims ----------------------------------------------------------------------

  async listFileClaims(projectId: string) {
    await this.ready();
    return this.world.claims.filter((c) => c.projectId === projectId).map((c) => ({ ...c }));
  }

  async claimFile(args: { projectId: string; path: string; kind: 'editing' | 'reserved'; note?: string | null; machineId: string; expiresAt?: string | null }) {
    await this.ready();
    const w = this.world;
    const existing = w.claims.find((c) => c.projectId === args.projectId && c.userId === w.me.id && c.path === args.path && c.kind === args.kind);
    if (existing) {
      existing.heartbeatAt = w.iso();
      existing.note = args.note ?? existing.note;
    } else {
      w.claims.push({
        projectId: args.projectId,
        userId: w.me.id,
        path: args.path,
        kind: args.kind,
        note: args.note ?? null,
        machineId: args.machineId,
        startedAt: w.iso(),
        heartbeatAt: w.iso(),
        expiresAt: args.expiresAt ?? null,
      });
    }
    w.emitData('file_claims', args.projectId);
  }

  async releaseFile(args: { projectId: string; path: string; kind: 'editing' | 'reserved'; machineId: string }) {
    await this.ready();
    const w = this.world;
    w.claims = w.claims.filter((c) => !(c.projectId === args.projectId && c.userId === w.me.id && c.path === args.path && c.kind === args.kind));
    w.emitData('file_claims', args.projectId);
  }

  async heartbeatClaims(projectId: string): Promise<void> {
    const w = this.world;
    w.claims.filter((c) => c.projectId === projectId && c.userId === w.me.id).forEach((c) => (c.heartbeatAt = w.iso()));
  }

  // ---- notes and tasks ------------------------------------------------------------------

  async listCategories(projectId: string): Promise<CardCategory[]> {
    await this.ready();
    return this.world.categories.filter((c) => c.projectId === projectId).sort((a, b) => a.sort - b.sort).map((c) => ({ ...c }));
  }

  async createCategory(projectId: string, input: { name: string; icon: string }): Promise<CardCategory> {
    await this.ready();
    this.requireMember(projectId);
    const name = input.name.trim();
    if (!name) throw appError('internal', 'Scrivi un nome per la categoria.');
    const list = this.world.categories.filter((c) => c.projectId === projectId);
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw appError('internal', 'Esiste già una categoria con questo nome.');
    const cat: CardCategory = { id: this.world.uid('cat'), projectId, name, icon: input.icon, sort: list.length, isDefault: false };
    this.world.categories.push(cat);
    this.world.emitData('card_categories', projectId);
    return { ...cat };
  }

  async updateCategory(categoryId: string, patch: { name?: string; icon?: string }): Promise<CardCategory> {
    await this.ready();
    const cat = this.world.categories.find((c) => c.id === categoryId);
    if (!cat) throw appError('notFound', 'Categoria non trovata.');
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw appError('internal', 'Scrivi un nome per la categoria.');
      if (this.world.categories.some((c) => c.projectId === cat.projectId && c.id !== cat.id && c.name.toLowerCase() === name.toLowerCase())) {
        throw appError('internal', 'Esiste già una categoria con questo nome.');
      }
      cat.name = name;
    }
    if (patch.icon !== undefined) cat.icon = patch.icon;
    this.world.emitData('card_categories', cat.projectId);
    return { ...cat };
  }

  async deleteCategory(categoryId: string): Promise<void> {
    await this.ready();
    const cat = this.world.categories.find((c) => c.id === categoryId);
    if (!cat) return;
    this.requireAdmin(cat.projectId);
    this.world.categories = this.world.categories.filter((c) => c.id !== categoryId);
    this.world.cards.filter((c) => c.categoryId === categoryId).forEach((c) => (c.categoryId = null));
    this.world.emitData('card_categories', cat.projectId);
    this.world.emitData('cards', cat.projectId);
  }

  async listCards(projectId: string): Promise<Card[]> {
    await this.ready();
    this.requireMember(projectId);
    return this.world.cards.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position).map((c) => ({ ...c }));
  }

  async createCard(projectId: string, input: Partial<Card> & { title: string }): Promise<Card> {
    await this.ready();
    this.requireMember(projectId);
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) throw appError('internal', 'Il titolo deve avere da 1 a 200 caratteri.');
    const w = this.world;
    const positions = w.cards.filter((c) => c.projectId === projectId).map((c) => c.position);
    const now = w.iso();
    const card: Card = {
      id: w.uid('card'),
      projectId,
      title,
      description: input.description ?? '',
      color: input.color ?? 'crema',
      priority: input.priority ?? null,
      categoryId: input.categoryId ?? null,
      status: input.status ?? 'open',
      createdBy: w.me.id,
      assigneeId: input.assigneeId ?? null,
      dueDate: input.dueDate ?? null,
      position: input.position ?? (positions.length ? Math.max(...positions) + 1000 : 1000),
      linkedVersion: input.linkedVersion ?? null,
      convertedAt: input.convertedAt ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    w.cards.push(card);
    w.emitData('cards', projectId);
    return { ...card };
  }

  async updateCard(cardId: string, patch: Partial<Card>): Promise<Card> {
    await this.ready(20);
    const w = this.world;
    const card = w.cards.find((c) => c.id === cardId);
    if (!card) throw appError('notFound', 'Card non trovata.');
    if (w.projects.find((p) => p.id === card.projectId)?.archivedAt) throw appError('internal', 'Il progetto è archiviato: le card sono in sola lettura.');
    if (patch.title !== undefined && !patch.title.trim()) throw appError('internal', 'Il titolo non può essere vuoto.');
    const wasCompleted = card.status === 'completed';
    Object.assign(card, patch, { updatedAt: w.iso() });
    if (card.status === 'completed' && !wasCompleted) card.completedAt = w.iso();
    if (card.status !== 'completed' && wasCompleted) card.completedAt = null;
    w.emitData('cards', card.projectId);
    return { ...card };
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.ready();
    const w = this.world;
    const card = w.cards.find((c) => c.id === cardId);
    if (!card) return;
    if (card.createdBy !== w.me.id && w.roleOf(card.projectId) !== 'admin') {
      throw appError('authFailed', 'Puoi eliminare solo le card create da te, oppure essere amministratore.');
    }
    w.cards = w.cards.filter((c) => c.id !== cardId);
    w.comments = w.comments.filter((c) => c.cardId !== cardId);
    w.attachments = w.attachments.filter((a) => a.cardId !== cardId);
    w.emitData('cards', card.projectId);
  }

  async listComments(cardId: string): Promise<CardComment[]> {
    await this.ready();
    return this.world.comments.filter((c) => c.cardId === cardId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => ({ ...c }));
  }

  async addComment(cardId: string, projectId: string, body: string): Promise<CardComment> {
    await this.ready();
    const text = body.trim();
    if (!text || text.length > 5000) throw appError('internal', 'Il commento deve avere da 1 a 5000 caratteri.');
    const c: CardComment = { id: this.world.uid('cm'), cardId, authorId: this.world.me.id, body: text, createdAt: this.world.iso(), editedAt: null };
    this.world.comments.push(c);
    this.world.emitData('card_comments', projectId);
    return { ...c };
  }

  async updateComment(commentId: string, body: string): Promise<CardComment> {
    await this.ready();
    const c = this.world.comments.find((x) => x.id === commentId);
    if (!c) throw appError('notFound', 'Commento non trovato.');
    if (c.authorId !== this.world.me.id) throw appError('authFailed', 'Puoi modificare solo i tuoi commenti.');
    c.body = body.trim();
    c.editedAt = this.world.iso();
    const card = this.world.cards.find((x) => x.id === c.cardId);
    this.world.emitData('card_comments', card?.projectId ?? null);
    return { ...c };
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.ready();
    const c = this.world.comments.find((x) => x.id === commentId);
    if (!c) return;
    const card = this.world.cards.find((x) => x.id === c.cardId);
    if (c.authorId !== this.world.me.id && (!card || this.world.roleOf(card.projectId) !== 'admin')) {
      throw appError('authFailed', 'Puoi eliminare solo i tuoi commenti, oppure essere amministratore.');
    }
    this.world.comments = this.world.comments.filter((x) => x.id !== commentId);
    this.world.emitData('card_comments', card?.projectId ?? null);
  }

  async listAttachments(cardId: string): Promise<CardAttachment[]> {
    await this.ready();
    return this.world.attachments.filter((a) => a.cardId === cardId).map(({ blobUrl: _b, ...a }) => a);
  }

  async uploadAttachment(cardId: string, projectId: string, file: File): Promise<CardAttachment> {
    await this.ready(300);
    if (file.size > 25 * 1024 * 1024) throw appError('fileTooLarge', 'Il file supera il limite di 25 MB.');
    const id = this.world.uid('att');
    const blobUrl = typeof URL !== 'undefined' && 'createObjectURL' in URL ? URL.createObjectURL(file) : null;
    const att = {
      id,
      cardId,
      storagePath: `${projectId}/${cardId}/${id}-${file.name}`,
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      uploadedBy: this.world.me.id,
      createdAt: this.world.iso(),
      blobUrl,
    };
    this.world.attachments.push(att);
    this.world.emitData('card_comments', projectId);
    const { blobUrl: _b, ...out } = att;
    return out;
  }

  async deleteAttachment(attachment: CardAttachment): Promise<void> {
    await this.ready();
    this.world.attachments = this.world.attachments.filter((a) => a.id !== attachment.id);
    const card = this.world.cards.find((c) => c.id === attachment.cardId);
    this.world.emitData('card_comments', card?.projectId ?? null);
  }

  async attachmentUrl(attachment: CardAttachment): Promise<string> {
    const found = this.world.attachments.find((a) => a.id === attachment.id);
    if (found?.blobUrl) return found.blobUrl;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#e9dfcb"/><text x="240" y="150" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#5d4a3a">${attachment.filename}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  // ---- events, activity, notifications ----------------------------------------------------

  async emitEvent(projectId: string, type: string, payload: Record<string, unknown>, recipients?: string[]): Promise<void> {
    await this.ready(10);
    const catalog = this.world.eventTypes.find((e) => e.type === type);
    if (!catalog?.clientAllowed) throw appError('internal', 'Questo tipo di evento non può essere registrato dal client.');
    this.requireMember(projectId);
    this.world.emitEvent(projectId, type, payload, { actorId: this.world.me.id, ...(recipients ? { recipients } : {}) });
  }

  async listActivity(projectId: string, filters: { actorId?: string; type?: string; importance?: string; from?: string; to?: string; limit?: number } = {}): Promise<ActivityEntry[]> {
    await this.ready();
    this.requireMember(projectId);
    return this.world.activity
      .filter((a) => a.projectId === projectId)
      .filter((a) => !filters.actorId || a.actorId === filters.actorId)
      .filter((a) => !filters.type || a.type === filters.type)
      .filter((a) => !filters.importance || a.importance === filters.importance)
      .filter((a) => !filters.from || a.createdAt >= filters.from)
      .filter((a) => !filters.to || a.createdAt <= filters.to)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .slice(0, filters.limit ?? 200)
      .map((a) => ({ ...a }));
  }

  async listEventTypes() {
    await this.ready(10);
    return this.world.eventTypes.map((e) => ({ ...e }));
  }

  async listNotifications(filters: { projectId?: string; unreadOnly?: boolean; limit?: number } = {}) {
    await this.ready();
    return this.world.notifications
      .filter((n) => !filters.projectId || n.projectId === filters.projectId)
      .filter((n) => !filters.unreadOnly || n.readAt == null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .slice(0, filters.limit ?? 100)
      .map((n) => ({ ...n }));
  }

  async unreadNotificationCount(): Promise<number> {
    await this.ready(10);
    return this.world.notifications.filter((n) => n.readAt == null).length;
  }

  async markNotificationsRead(ids?: number[]): Promise<void> {
    await this.ready(10);
    const now = this.world.iso();
    this.world.notifications.forEach((n) => {
      if (n.readAt == null && (!ids || ids.includes(n.id))) n.readAt = now;
    });
    this.world.emitData('notifications', null);
  }

  async listPreferences(): Promise<NotificationPreference[]> {
    await this.ready(10);
    return this.world.preferences.map((p) => ({ ...p }));
  }

  async setPreference(pref: NotificationPreference): Promise<void> {
    await this.ready(10);
    const existing = this.world.preferences.find((p) => p.eventType === pref.eventType);
    if (existing) Object.assign(existing, pref);
    else this.world.preferences.push({ ...pref });
  }

  // ---- Discord --------------------------------------------------------------------------------

  async getDiscordSettings(projectId: string): Promise<DiscordSettings> {
    await this.ready();
    this.requireMember(projectId);
    const s = this.world.discord.get(projectId);
    return s ? { ...s, enabledEventTypes: [...s.enabledEventTypes] } : { projectId, enabledEventTypes: [], webhookConfigured: false, updatedAt: null };
  }

  async setDiscordEventTypes(projectId: string, types: string[]): Promise<void> {
    await this.ready();
    this.requireAdmin(projectId);
    const s = this.world.discord.get(projectId)!;
    s.enabledEventTypes = [...types];
    s.updatedAt = this.world.iso();
  }

  async setDiscordWebhook(projectId: string, url: string | null): Promise<void> {
    await this.ready(400);
    this.requireAdmin(projectId);
    if (url != null && !/^https:\/\/(discord(app)?\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(url.trim())) {
      throw appError('internal', 'Questo non sembra un indirizzo webhook di Discord. Deve iniziare con https://discord.com/api/webhooks/');
    }
    const s = this.world.discord.get(projectId)!;
    s.webhookConfigured = url != null;
    s.updatedAt = this.world.iso();
  }

  async sendDiscordTest(projectId: string): Promise<void> {
    await this.ready(700);
    this.requireAdmin(projectId);
    const s = this.world.discord.get(projectId);
    if (!s?.webhookConfigured) throw appError('internal', 'Configura prima il webhook di Discord.');
    this.world.discordTests.push(projectId);
  }

  // ---- realtime -------------------------------------------------------------------------------

  subscribe(args: { projectId?: string }, handler: RealtimeHandler) {
    return this.world.onData((change) => {
      if (args.projectId ? change.projectId === args.projectId : change.table === 'notifications' || change.table === 'project_members') handler(change);
    });
  }
}

let instance: MockData | null = null;
export function getMockData(): MockData {
  if (!instance || instance.world !== getMockWorld()) instance = new MockData(getMockWorld());
  return instance;
}

export type { MemberRole };
