import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Backend } from '../backend/types';
import type { AppError } from '../types/ipc';
import type {
  ActivityEntry,
  ActivityFilters,
  AppNotification,
  Card,
  CardAttachment,
  CardCategory,
  CardComment,
  CardInput,
  ClaimKind,
  ConflictRecord,
  DiscordSettings,
  EventType,
  FileClaim,
  IndexedVersion,
  Invitation,
  Member,
  MemberRole,
  NotificationFilters,
  NotificationPreference,
  Profile,
  Project,
  ProjectSettings,
  ProjectWithRole,
  RealtimeTable,
} from '../types/data';
import type { DataService, RealtimeHandler, SessionTokens } from './types';
import {
  createProjectBody,
  discordBody,
  memberBody,
  type AcceptInvitationsResult,
  type EdgeFunctionName,
  type CreateProjectResult,
  type EdgeErrorBody,
} from './edgeContract';

export type SupabaseConfig = { url: string; anonKey: string };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function failure(message: string, detail?: string, code: AppError['code'] = 'internal', retryable = false): AppError {
  return { code, message, retryable, ...(detail ? { detail } : {}) };
}

/** Converts a PostgREST / Edge Function failure into a user friendly AppError. */
function toError(e: unknown, fallback: string): AppError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e && 'retryable' in e) return e as AppError;
  const err = e as { message?: string; code?: string; status?: number; context?: { status?: number } } | null;
  const status = err?.status ?? err?.context?.status;
  const message = err?.message ?? '';
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return failure('Non riesco a raggiungere il server. Controlla la connessione e riprova.', message, 'network', true);
  }
  if (status === 401 || err?.code === 'PGRST301') return failure('La sessione è scaduta: accedi di nuovo con GitHub.', message, 'authRequired');
  if (status === 403 || err?.code === '42501') return failure('Non hai i permessi per questa operazione.', message, 'authFailed');
  return failure(fallback, message);
}

function mapProfile(r: Row): Profile {
  return {
    id: str(r.id),
    githubId: numOrNull(r.github_id),
    githubLogin: str(r.github_login),
    displayName: str(r.display_name) || str(r.github_login),
    avatarUrl: strOrNull(r.avatar_url),
    avatarColor: strOrNull(r.avatar_color),
  };
}

function mapProject(r: Row): Project {
  const settings = (r.settings ?? {}) as Partial<ProjectSettings>;
  return {
    id: str(r.id),
    name: str(r.name),
    slug: str(r.slug),
    description: str(r.description),
    githubOwner: str(r.github_owner),
    githubRepo: str(r.github_repo),
    defaultBranch: str(r.default_branch) || 'main',
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    archivedAt: strOrNull(r.archived_at),
    settings: {
      publishPolicy: settings.publishPolicy ?? { mode: 'assisted', idleMinutes: 10 },
      activityRetention: settings.activityRetention ?? 100,
    },
  };
}

function mapCard(r: Row): Card {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    title: str(r.title),
    description: str(r.description),
    color: str(r.color) || 'crema',
    priority: (strOrNull(r.priority) as Card['priority']) ?? null,
    categoryId: strOrNull(r.category_id),
    status: (str(r.status) || 'open') as Card['status'],
    createdBy: str(r.created_by),
    assigneeId: strOrNull(r.assignee_id),
    dueDate: strOrNull(r.due_date),
    position: Number(r.position ?? 0),
    linkedVersion: numOrNull(r.linked_version),
    convertedAt: strOrNull(r.converted_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    completedAt: strOrNull(r.completed_at),
  };
}

const CARD_COLUMNS: Record<keyof CardInput, string> = {
  title: 'title',
  description: 'description',
  color: 'color',
  priority: 'priority',
  categoryId: 'category_id',
  status: 'status',
  assigneeId: 'assignee_id',
  dueDate: 'due_date',
  position: 'position',
  linkedVersion: 'linked_version',
  convertedAt: 'converted_at',
};

function cardRow(input: CardInput): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(input)) {
    const col = CARD_COLUMNS[k as keyof CardInput];
    if (col && v !== undefined) out[col] = v;
  }
  return out;
}

const REALTIME_TABLES: Record<string, RealtimeTable> = {
  cards: 'cards',
  card_comments: 'card_comments',
  card_categories: 'card_categories',
  activity_log: 'activity_log',
  versions: 'versions',
  conflicts: 'conflicts',
  file_claims: 'file_claims',
  project_members: 'project_members',
  notifications: 'notifications',
};

/** Ask the shell for a renewed session when the access token has less than this left. */
const TOKEN_RENEW_MARGIN_MS = 2 * 60 * 1000;

/** The user id (`sub` claim) of a Supabase access token, without verifying it (the server does). */
export function jwtSubject(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

/** Supabase implementation, built on the schema in docs/modello-dati.md. */
export class SupabaseData implements DataService {
  readonly kind = 'supabase' as const;
  private readonly sb: SupabaseClient;
  private userId: string | null = null;

  /**
   * Desktop app: the shell owns the Supabase session (it renews it and keeps it in Credential
   * Manager). supabase-js only borrows the access token through `accessToken`, so it never
   * refreshes - and never rotates - the refresh token the shell is using.
   */
  private readonly shellOwnsSession: boolean;
  private session: { accessToken: string; expiresAt: number } | null = null;
  private renewing: Promise<void> | null = null;

  constructor(
    config: SupabaseConfig,
    private readonly backend: Backend,
  ) {
    this.shellOwnsSession = backend.kind === 'tauri';
    if (this.shellOwnsSession) {
      // Versions up to 0.1.4 kept a second copy of the session here: drop it.
      void Promise.resolve()
        .then(() => backend.secureStoreDelete('rocketsync-auth'))
        .catch(() => undefined);
      this.sb = createClient(config.url, config.anonKey, { accessToken: () => this.accessToken() });
    } else {
      this.sb = createClient(config.url, config.anonKey, {
        auth: { storageKey: 'rocketsync-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
  }

  /** Access token for supabase-js, asking the shell for a renewed session when it is about to expire. */
  private async accessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.expiresAt * 1000 - Date.now() < TOKEN_RENEW_MARGIN_MS) {
      // The shell renews a session that expires within 5 minutes; concurrent callers share one call.
      this.renewing ??= this.backend
        .authStatus()
        .then((st) => this.useSession(st.supabaseSession))
        .catch(() => undefined)
        .finally(() => {
          this.renewing = null;
        });
      await this.renewing;
    }
    return this.session?.accessToken ?? null;
  }

  private useSession(s: SessionTokens | null): void {
    this.session = s ? { accessToken: s.accessToken, expiresAt: s.expiresAt } : null;
    this.userId = s ? jwtSubject(s.accessToken) : null;
  }

  private async uid(): Promise<string> {
    if (this.userId) return this.userId;
    const id = this.shellOwnsSession ? null : (await this.sb.auth.getSession()).data.session?.user.id;
    if (!id) throw failure('Devi accedere con GitHub per continuare.', undefined, 'authRequired');
    this.userId = id;
    return id;
  }

  // PostgREST responses are untyped here (no generated database types), hence the loose return.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private check(res: { data: unknown; error: unknown }, fallback: string): any {
    if (res.error) throw toError(res.error, fallback);
    return res.data;
  }

  private async fn<T>(name: EdgeFunctionName, body: Record<string, unknown>, fallback: string): Promise<T> {
    const { data, error } = await this.sb.functions.invoke(name, { body });
    if (error) {
      // Edge Functions fail with `{ error: { code, message } }` and a message already in Italian.
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.clone === 'function') {
        const payload = (await ctx.clone().json().catch(() => null)) as Partial<EdgeErrorBody> | null;
        const text = payload?.error?.message;
        if (text) {
          const code = ctx.status === 401 ? 'authRequired' : ctx.status === 403 ? 'authFailed' : 'internal';
          throw failure(text, payload?.error?.code, code);
        }
      }
      throw toError(error, fallback);
    }
    return data as T;
  }

  async setSession(session: SessionTokens | null): Promise<void> {
    if (this.shellOwnsSession) {
      this.useSession(session);
      // Realtime reads the token on connect and on every heartbeat; give it the new one now.
      await this.sb.realtime.setAuth(session?.accessToken ?? null).catch(() => undefined);
      return;
    }
    if (!session) {
      await this.sb.auth.signOut();
      this.userId = null;
      return;
    }
    const { data, error } = await this.sb.auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken });
    if (error) throw toError(error, 'Non riesco ad aprire la sessione. Accedi di nuovo con GitHub.');
    this.userId = data.session?.user.id ?? null;
  }

  // ---- profiles ----------------------------------------------------------------

  async getMyProfile(): Promise<Profile> {
    const id = await this.uid();
    const row = this.check(await this.sb.from('profiles').select('*').eq('id', id).single(), 'Non riesco a leggere il tuo profilo.');
    return mapProfile(row as Row);
  }

  async updateMyProfile(patch: { displayName?: string; avatarColor?: string }): Promise<Profile> {
    const id = await this.uid();
    const update: Row = {};
    if (patch.displayName !== undefined) update.display_name = patch.displayName;
    if (patch.avatarColor !== undefined) update.avatar_color = patch.avatarColor;
    const row = this.check(await this.sb.from('profiles').update(update).eq('id', id).select('*').single(), 'Non riesco a salvare il profilo.');
    return mapProfile(row as Row);
  }

  async listProfiles(): Promise<Profile[]> {
    const rows = this.check(await this.sb.from('profiles').select('*'), 'Non riesco a leggere i profili.');
    return (rows as Row[]).map(mapProfile);
  }

  async acceptInvitations(): Promise<number> {
    const res = await this.fn<AcceptInvitationsResult>('accept-invitations', {}, 'Non riesco a controllare gli inviti.');
    return res.accepted.length;
  }

  // ---- projects ----------------------------------------------------------------

  async listProjects(): Promise<ProjectWithRole[]> {
    const id = await this.uid();
    const members = this.check(await this.sb.from('project_members').select('project_id, role').eq('user_id', id), 'Non riesco a leggere i tuoi progetti.') as Row[];
    if (members.length === 0) return [];
    const rows = this.check(
      await this.sb.from('projects').select('*').in('id', members.map((m) => str(m.project_id))).is('archived_at', null).order('name'),
      'Non riesco a leggere i tuoi progetti.',
    ) as Row[];
    const roleOf = new Map(members.map((m) => [str(m.project_id), str(m.role) as MemberRole]));
    return rows.map((r) => ({ ...mapProject(r), myRole: roleOf.get(str(r.id)) ?? 'member' }));
  }

  async createProject(input: { name: string; description?: string }): Promise<Project> {
    const res = await this.fn<CreateProjectResult>('create-project', createProjectBody(input.name, input.description ?? ''), 'Non sono riuscito a creare il progetto.');
    const row = this.check(await this.sb.from('projects').select('*').eq('id', res.projectId).single(), 'Il progetto è stato creato ma non riesco a leggerlo.');
    return mapProject(row as Row);
  }

  async updateProject(projectId: string, patch: { name?: string; description?: string; settings?: Partial<ProjectSettings> }): Promise<Project> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.settings) {
      const current = this.check(await this.sb.from('projects').select('settings').eq('id', projectId).single(), 'Non riesco a leggere le impostazioni.') as Row;
      update.settings = { ...((current.settings as object) ?? {}), ...patch.settings };
    }
    const row = this.check(await this.sb.from('projects').update(update).eq('id', projectId).select('*').single(), 'Non riesco a salvare le impostazioni del progetto.');
    return mapProject(row as Row);
  }

  // ---- members -----------------------------------------------------------------

  async listMembers(projectId: string): Promise<Member[]> {
    const members = this.check(await this.sb.from('project_members').select('user_id, role, added_at').eq('project_id', projectId), 'Non riesco a leggere i membri.') as Row[];
    const ids = members.map((m) => str(m.user_id));
    const profiles = ids.length ? (this.check(await this.sb.from('profiles').select('*').in('id', ids), 'Non riesco a leggere i membri.') as Row[]) : [];
    const recent = this.check(
      await this.sb.from('activity_log').select('actor_id, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(300),
      'Non riesco a leggere l’attività.',
    ) as Row[];
    const lastBy = new Map<string, string>();
    for (const r of recent) if (r.actor_id && !lastBy.has(str(r.actor_id))) lastBy.set(str(r.actor_id), str(r.created_at));
    const byId = new Map(profiles.map((p) => [str(p.id), mapProfile(p)]));
    return members
      .map((m) => ({
        userId: str(m.user_id),
        role: str(m.role) as MemberRole,
        addedAt: str(m.added_at),
        lastActivityAt: lastBy.get(str(m.user_id)) ?? null,
        profile: byId.get(str(m.user_id)) ?? { id: str(m.user_id), githubId: null, githubLogin: '?', displayName: 'Utente', avatarUrl: null, avatarColor: null },
      }))
      .sort((a, b) => (a.role === b.role ? a.profile.displayName.localeCompare(b.profile.displayName) : a.role === 'admin' ? -1 : 1));
  }

  async listInvitations(projectId: string): Promise<Invitation[]> {
    const rows = this.check(
      await this.sb.from('project_invitations').select('*').eq('project_id', projectId).eq('status', 'pending').order('created_at', { ascending: false }),
      'Non riesco a leggere gli inviti.',
    ) as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      projectId: str(r.project_id),
      githubLogin: str(r.github_login),
      role: str(r.role) as MemberRole,
      status: str(r.status) as Invitation['status'],
      createdAt: str(r.created_at),
    }));
  }

  async addMember(projectId: string, githubLogin: string, role: MemberRole): Promise<void> {
    await this.fn('manage-members', memberBody.add(projectId, githubLogin.trim().replace(/^@/, ''), role), 'Non sono riuscito ad aggiungere il membro.');
  }
  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.fn('manage-members', memberBody.remove(projectId, userId), 'Non sono riuscito a rimuovere il membro.');
  }
  async revokeInvitation(projectId: string, invitation: Invitation): Promise<void> {
    await this.fn('manage-members', memberBody.revokeInvitation(projectId, invitation.githubLogin), 'Non sono riuscito a revocare l’invito.');
  }
  async setMemberRole(projectId: string, userId: string, role: MemberRole): Promise<void> {
    await this.fn('manage-members', memberBody.setRole(projectId, userId, role), 'Non sono riuscito a cambiare il ruolo.');
  }

  // ---- versions index and conflicts ----------------------------------------------

  async listIndexedVersions(projectId: string, limit = 200): Promise<IndexedVersion[]> {
    const rows = this.check(
      await this.sb.from('versions').select('*').eq('project_id', projectId).order('number', { ascending: false }).limit(limit),
      'Non riesco a leggere le versioni.',
    ) as Row[];
    return rows.map((r) => ({
      number: Number(r.number),
      sha: str(r.sha),
      kind: str(r.kind) as IndexedVersion['kind'],
      title: str(r.title),
      description: strOrNull(r.description),
      authorLogin: str(r.author_github_login),
      authorName: str(r.author_github_login),
      publishedAt: str(r.published_at),
      restoredFrom: numOrNull(r.restored_from),
      conflictId: strOrNull(r.conflict_id),
      files: ((r.files as Array<{ path: string; change: string }>) ?? []).map((f) => ({ path: f.path, change: f.change })),
    }));
  }

  async listConflictRecords(projectId: string): Promise<ConflictRecord[]> {
    const rows = this.check(await this.sb.from('conflicts').select('*').eq('project_id', projectId).order('created_at', { ascending: false }), 'Non riesco a leggere i conflitti.') as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      projectId: str(r.project_id),
      files: (r.files as Array<{ path: string; kind: string }>) ?? [],
      oursUserId: strOrNull(r.ours_user_id),
      theirsUserId: strOrNull(r.theirs_user_id),
      theirsVersion: numOrNull(r.theirs_version),
      status: str(r.status) as ConflictRecord['status'],
      resolvedBy: strOrNull(r.resolved_by),
      resolvedVersion: numOrNull(r.resolved_version),
      createdAt: str(r.created_at),
      resolvedAt: strOrNull(r.resolved_at),
    }));
  }

  async reportConflict(args: {
    projectId: string;
    conflictId: string;
    files: { path: string; kind: string }[];
    theirsVersion: number | null;
    theirsUserId: string | null;
  }): Promise<void> {
    const { error } = await this.sb.rpc('report_conflict', {
      p_project_id: args.projectId,
      p_conflict_id: args.conflictId,
      p_files: args.files,
      p_theirs_version: args.theirsVersion,
      p_theirs_user_id: args.theirsUserId,
    });
    if (error) throw toError(error, 'Non riesco a registrare il conflitto per il team.');
  }

  async resolveConflictRecord(args: { projectId: string; conflictId: string; resolution: unknown; resolvedVersion: number }): Promise<void> {
    const { error } = await this.sb.rpc('resolve_conflict_record', {
      p_project_id: args.projectId,
      p_conflict_id: args.conflictId,
      p_resolution: args.resolution,
      p_resolved_version: args.resolvedVersion,
    });
    if (error) throw toError(error, 'Non riesco a registrare la risoluzione del conflitto.');
  }

  // ---- claims ------------------------------------------------------------------

  async listFileClaims(projectId: string): Promise<FileClaim[]> {
    const rows = this.check(await this.sb.from('file_claims').select('*').eq('project_id', projectId), 'Non riesco a leggere chi sta lavorando sui file.') as Row[];
    return rows.map((r) => ({
      projectId: str(r.project_id),
      userId: str(r.user_id),
      path: str(r.path),
      kind: str(r.kind) as ClaimKind,
      note: strOrNull(r.note),
      machineId: str(r.machine_id),
      startedAt: str(r.started_at),
      heartbeatAt: str(r.heartbeat_at),
      expiresAt: strOrNull(r.expires_at),
    }));
  }

  async claimFile(args: { projectId: string; path: string; kind: ClaimKind; note?: string | null; machineId: string; expiresAt?: string | null }): Promise<void> {
    const { error } = await this.sb.rpc('claim_file', {
      p_project_id: args.projectId,
      p_path: args.path,
      p_kind: args.kind,
      p_note: args.note ?? null,
      p_machine_id: args.machineId,
      p_expires_at: args.expiresAt ?? null,
    });
    if (error) throw toError(error, 'Non riesco a segnalare il file in modifica.');
  }

  async releaseFile(args: { projectId: string; path: string; kind: ClaimKind }): Promise<void> {
    const { error } = await this.sb.rpc('release_file', { p_project_id: args.projectId, p_path: args.path, p_kind: args.kind });
    if (error) throw toError(error, 'Non riesco a rilasciare il file.');
  }

  async heartbeatClaims(projectId: string, machineId: string): Promise<void> {
    await this.sb.rpc('heartbeat_claims', { p_project_id: projectId, p_machine_id: machineId });
  }

  // ---- notes and tasks -----------------------------------------------------------

  private mapCategory(r: Row): CardCategory {
    return { id: str(r.id), projectId: str(r.project_id), name: str(r.name), icon: str(r.icon), sort: Number(r.sort ?? 0), isDefault: Boolean(r.is_default) };
  }

  async listCategories(projectId: string): Promise<CardCategory[]> {
    const rows = this.check(await this.sb.from('card_categories').select('*').eq('project_id', projectId).order('sort'), 'Non riesco a leggere le categorie.') as Row[];
    return rows.map((r) => this.mapCategory(r));
  }

  async createCategory(projectId: string, input: { name: string; icon: string }): Promise<CardCategory> {
    const existing = await this.listCategories(projectId);
    const row = this.check(
      await this.sb.from('card_categories').insert({ project_id: projectId, name: input.name.trim(), icon: input.icon, sort: existing.length, is_default: false }).select('*').single(),
      'Non riesco a creare la categoria (forse esiste già).',
    );
    return this.mapCategory(row as Row);
  }

  async updateCategory(categoryId: string, patch: { name?: string; icon?: string }): Promise<CardCategory> {
    const row = this.check(await this.sb.from('card_categories').update(patch).eq('id', categoryId).select('*').single(), 'Non riesco a modificare la categoria.');
    return this.mapCategory(row as Row);
  }

  async deleteCategory(categoryId: string): Promise<void> {
    const { error } = await this.sb.from('card_categories').delete().eq('id', categoryId);
    if (error) throw toError(error, 'Solo un amministratore può eliminare una categoria.');
  }

  async listCards(projectId: string): Promise<Card[]> {
    const rows = this.check(await this.sb.from('cards').select('*').eq('project_id', projectId).order('position'), 'Non riesco a leggere le card.') as Row[];
    return rows.map(mapCard);
  }

  async createCard(projectId: string, input: CardInput & { title: string }): Promise<Card> {
    const id = await this.uid();
    const row = this.check(
      await this.sb.from('cards').insert({ ...cardRow(input), project_id: projectId, created_by: id }).select('*').single(),
      'Non riesco a creare la card.',
    );
    return mapCard(row as Row);
  }

  async updateCard(cardId: string, patch: CardInput): Promise<Card> {
    // updated_at and completed_at are maintained by the `cards_guard` trigger.
    const update = cardRow(patch);
    const row = this.check(await this.sb.from('cards').update(update).eq('id', cardId).select('*').single(), 'Non riesco a salvare la card.');
    return mapCard(row as Row);
  }

  async deleteCard(cardId: string): Promise<void> {
    const { error } = await this.sb.from('cards').delete().eq('id', cardId);
    if (error) throw toError(error, 'Puoi eliminare solo le card create da te, oppure essere amministratore.');
  }

  private mapComment(r: Row): CardComment {
    return { id: str(r.id), cardId: str(r.card_id), authorId: str(r.author_id), body: str(r.body), createdAt: str(r.created_at), editedAt: strOrNull(r.edited_at) };
  }

  async listComments(cardId: string): Promise<CardComment[]> {
    const rows = this.check(await this.sb.from('card_comments').select('*').eq('card_id', cardId).order('created_at'), 'Non riesco a leggere i commenti.') as Row[];
    return rows.map((r) => this.mapComment(r));
  }

  async addComment(cardId: string, projectId: string, body: string): Promise<CardComment> {
    const id = await this.uid();
    const row = this.check(
      await this.sb.from('card_comments').insert({ card_id: cardId, project_id: projectId, author_id: id, body: body.trim() }).select('*').single(),
      'Non riesco a salvare il commento.',
    );
    return this.mapComment(row as Row);
  }

  async updateComment(commentId: string, body: string): Promise<CardComment> {
    const row = this.check(
      await this.sb.from('card_comments').update({ body: body.trim() }).eq('id', commentId).select('*').single(),
      'Puoi modificare solo i tuoi commenti.',
    );
    return this.mapComment(row as Row);
  }

  async deleteComment(commentId: string): Promise<void> {
    const { error } = await this.sb.from('card_comments').delete().eq('id', commentId);
    if (error) throw toError(error, 'Puoi eliminare solo i tuoi commenti, oppure essere amministratore.');
  }

  private mapAttachment(r: Row): CardAttachment {
    return {
      id: str(r.id),
      cardId: str(r.card_id),
      storagePath: str(r.storage_path),
      filename: str(r.filename),
      sizeBytes: Number(r.size_bytes ?? 0),
      mimeType: str(r.mime_type),
      uploadedBy: str(r.uploaded_by),
      createdAt: str(r.created_at),
    };
  }

  async listAttachments(cardId: string): Promise<CardAttachment[]> {
    const rows = this.check(await this.sb.from('card_attachments').select('*').eq('card_id', cardId).order('created_at'), 'Non riesco a leggere gli allegati.') as Row[];
    return rows.map((r) => this.mapAttachment(r));
  }

  async uploadAttachment(cardId: string, projectId: string, file: File): Promise<CardAttachment> {
    if (file.size > 25 * 1024 * 1024) throw failure('Il file supera il limite di 25 MB.', undefined, 'fileTooLarge');
    const uploader = await this.uid();
    const safeName = file.name.replace(/[^\w.\- ()]+/g, '_');
    const path = `${projectId}/${cardId}/${crypto.randomUUID()}-${safeName}`;
    const up = await this.sb.storage.from('attachments').upload(path, file, { contentType: file.type || undefined });
    if (up.error) throw toError(up.error, 'Non riesco a caricare l’allegato.');
    const row = await this.sb
      .from('card_attachments')
      .insert({ card_id: cardId, project_id: projectId, storage_path: path, filename: file.name, size_bytes: file.size, mime_type: file.type || 'application/octet-stream', uploaded_by: uploader })
      .select('*')
      .single();
    if (row.error) {
      await this.sb.storage.from('attachments').remove([path]);
      throw toError(row.error, 'Non riesco a registrare l’allegato.');
    }
    return this.mapAttachment(row.data as Row);
  }

  async deleteAttachment(attachment: CardAttachment): Promise<void> {
    const { error } = await this.sb.from('card_attachments').delete().eq('id', attachment.id);
    if (error) throw toError(error, 'Puoi eliminare solo i tuoi allegati, oppure essere amministratore.');
    await this.sb.storage.from('attachments').remove([attachment.storagePath]);
  }

  async attachmentUrl(attachment: CardAttachment): Promise<string> {
    const { data, error } = await this.sb.storage.from('attachments').createSignedUrl(attachment.storagePath, 3600);
    if (error || !data) throw toError(error, 'Non riesco ad aprire l’allegato.');
    return data.signedUrl;
  }

  // ---- events, activity, notifications -----------------------------------------------

  async emitEvent(projectId: string, type: string, payload: Record<string, unknown>, recipients?: string[]): Promise<void> {
    const { error } = await this.sb.rpc('emit_event', { p_project_id: projectId, p_type: type, p_payload: payload, p_recipients: recipients ?? null });
    if (error) throw toError(error, 'Non riesco a registrare l’evento.');
  }

  async listActivity(projectId: string, filters: ActivityFilters = {}): Promise<ActivityEntry[]> {
    let q = this.sb.from('activity_log').select('*').eq('project_id', projectId);
    if (filters.actorId) q = q.eq('actor_id', filters.actorId);
    if (filters.type) q = q.eq('type', filters.type);
    if (filters.importance) q = q.eq('importance', filters.importance);
    if (filters.from) q = q.gte('created_at', filters.from);
    if (filters.to) q = q.lte('created_at', filters.to);
    const rows = this.check(await q.order('created_at', { ascending: false }).limit(filters.limit ?? 200), 'Non riesco a leggere l’Activity Log.') as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      projectId: str(r.project_id),
      actorId: strOrNull(r.actor_id),
      type: str(r.type),
      importance: str(r.importance) as ActivityEntry['importance'],
      summary: str(r.summary),
      payload: (r.payload as Record<string, unknown>) ?? {},
      createdAt: str(r.created_at),
    }));
  }

  async listEventTypes(): Promise<EventType[]> {
    const rows = this.check(await this.sb.from('event_types').select('*'), 'Non riesco a leggere i tipi di evento.') as Row[];
    return rows.map((r) => ({
      type: str(r.type),
      importance: str(r.importance) as EventType['importance'],
      audience: str(r.audience) as EventType['audience'],
      notify: Boolean(r.notify),
      discordDefault: Boolean(r.discord_default),
      clientAllowed: Boolean(r.client_allowed),
      labelIt: str(r.label_it),
    }));
  }

  private mapNotification(r: Row): AppNotification {
    return {
      id: Number(r.id),
      eventId: Number(r.event_id),
      projectId: strOrNull(r.project_id),
      type: str(r.type),
      importance: str(r.importance) as AppNotification['importance'],
      summary: str(r.summary),
      payload: (r.payload as Record<string, unknown>) ?? {},
      createdAt: str(r.created_at),
      readAt: strOrNull(r.read_at),
    };
  }

  async listNotifications(filters: NotificationFilters = {}): Promise<AppNotification[]> {
    let q = this.sb.from('notifications').select('*');
    if (filters.projectId) q = q.eq('project_id', filters.projectId);
    if (filters.unreadOnly) q = q.is('read_at', null);
    const rows = this.check(await q.order('created_at', { ascending: false }).limit(filters.limit ?? 100), 'Non riesco a leggere le notifiche.') as Row[];
    return rows.map((r) => this.mapNotification(r));
  }

  async unreadNotificationCount(): Promise<number> {
    const { count, error } = await this.sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
    if (error) throw toError(error, 'Non riesco a leggere le notifiche.');
    return count ?? 0;
  }

  async markNotificationsRead(ids?: number[]): Promise<void> {
    const { error } = await this.sb.rpc('mark_notifications_read', { p_ids: ids ?? null });
    if (error) throw toError(error, 'Non riesco a segnare le notifiche come lette.');
  }

  async listPreferences(): Promise<NotificationPreference[]> {
    const rows = this.check(await this.sb.from('notification_preferences').select('*'), 'Non riesco a leggere le preferenze.') as Row[];
    return rows.map((r) => ({ eventType: str(r.event_type), inApp: Boolean(r.in_app), desktop: Boolean(r.desktop) }));
  }

  async setPreference(pref: NotificationPreference): Promise<void> {
    const id = await this.uid();
    const { error } = await this.sb
      .from('notification_preferences')
      .upsert({ user_id: id, event_type: pref.eventType, in_app: pref.inApp, desktop: pref.desktop }, { onConflict: 'user_id,event_type' });
    if (error) throw toError(error, 'Non riesco a salvare la preferenza.');
  }

  // ---- Discord -----------------------------------------------------------------------

  async getDiscordSettings(projectId: string): Promise<DiscordSettings> {
    const { data, error } = await this.sb.from('project_discord_settings').select('*').eq('project_id', projectId).maybeSingle();
    if (error) throw toError(error, 'Non riesco a leggere le impostazioni di Discord.');
    const r = (data ?? {}) as Row;
    return {
      projectId,
      enabledEventTypes: (r.enabled_event_types as string[]) ?? [],
      webhookConfigured: Boolean(r.webhook_configured),
      updatedAt: strOrNull(r.updated_at),
    };
  }

  async setDiscordEventTypes(projectId: string, types: string[]): Promise<void> {
    // updated_by / updated_at are set by the `discord_settings_guard` trigger.
    const { error } = await this.sb.from('project_discord_settings').update({ enabled_event_types: types }).eq('project_id', projectId);
    if (error) throw toError(error, 'Solo un amministratore può cambiare le impostazioni di Discord.');
  }

  async setDiscordWebhook(projectId: string, url: string | null): Promise<void> {
    await this.fn('discord-settings', url ? discordBody.set(projectId, url) : discordBody.remove(projectId), 'Non sono riuscito a salvare il webhook di Discord.');
  }

  async sendDiscordTest(projectId: string): Promise<void> {
    await this.fn('discord-settings', discordBody.test(projectId), 'Non sono riuscito a inviare il messaggio di prova.');
  }

  // ---- realtime -----------------------------------------------------------------------

  subscribe(args: { projectId?: string }, handler: RealtimeHandler) {
    const { projectId } = args;
    const channel = this.sb.channel(`rs-${projectId ?? 'user'}-${Math.random().toString(36).slice(2, 8)}`);
    const tables = projectId
      ? ['cards', 'card_comments', 'activity_log', 'versions', 'conflicts', 'file_claims', 'project_members']
      : ['notifications', 'project_members'];
    for (const table of tables) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(projectId ? { filter: `project_id=eq.${projectId}` } : {}) },
        (payload) => {
          const row = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as Row;
          handler({ table: REALTIME_TABLES[table]!, projectId: strOrNull(row?.project_id) ?? projectId ?? null });
        },
      );
    }
    channel.subscribe();
    return () => {
      void this.sb.removeChannel(channel);
    };
  }
}
