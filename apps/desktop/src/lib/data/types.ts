import type { AuthStatus, FileResolution } from '../types/ipc';
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

export type SessionTokens = NonNullable<AuthStatus['supabaseSession']>;
export type Unsubscribe = () => void;

export type RealtimeHandler = (change: { table: RealtimeTable; projectId: string | null }) => void;

/**
 * Everything the UI reads or writes on Supabase (docs/modello-dati.md).
 * Mutations reject with an `AppError`-shaped object whose `message` is in Italian.
 */
export interface DataService {
  readonly kind: 'mock' | 'supabase';

  setSession(session: SessionTokens | null): Promise<void>;

  // profiles and invitations
  getMyProfile(): Promise<Profile>;
  updateMyProfile(patch: { displayName?: string; avatarColor?: string }): Promise<Profile>;
  listProfiles(): Promise<Profile[]>;
  acceptInvitations(): Promise<number>;

  // projects
  listProjects(): Promise<ProjectWithRole[]>;
  createProject(input: { name: string; description?: string }): Promise<Project>;
  updateProject(
    projectId: string,
    patch: { name?: string; description?: string; settings?: Partial<ProjectSettings> },
  ): Promise<Project>;

  // members (writes go through the manage-members Edge Function)
  listMembers(projectId: string): Promise<Member[]>;
  listInvitations(projectId: string): Promise<Invitation[]>;
  addMember(projectId: string, githubLogin: string, role: MemberRole): Promise<void>;
  removeMember(projectId: string, userId: string): Promise<void>;
  revokeInvitation(projectId: string, invitation: Invitation): Promise<void>;
  setMemberRole(projectId: string, userId: string, role: MemberRole): Promise<void>;

  // version index and conflicts
  listIndexedVersions(projectId: string, limit?: number): Promise<IndexedVersion[]>;
  listConflictRecords(projectId: string): Promise<ConflictRecord[]>;
  reportConflict(args: {
    projectId: string;
    conflictId: string;
    files: { path: string; kind: string }[];
    theirsVersion: number | null;
    theirsUserId: string | null;
  }): Promise<void>;
  resolveConflictRecord(args: {
    projectId: string;
    conflictId: string;
    resolution: FileResolution[];
    resolvedVersion: number;
  }): Promise<void>;

  // who is working on what
  listFileClaims(projectId: string): Promise<FileClaim[]>;
  claimFile(args: {
    projectId: string;
    path: string;
    kind: ClaimKind;
    note?: string | null;
    machineId: string;
    expiresAt?: string | null;
  }): Promise<void>;
  releaseFile(args: { projectId: string; path: string; kind: ClaimKind }): Promise<void>;
  heartbeatClaims(projectId: string, machineId: string): Promise<void>;

  // notes and tasks
  listCategories(projectId: string): Promise<CardCategory[]>;
  createCategory(projectId: string, input: { name: string; icon: string }): Promise<CardCategory>;
  updateCategory(categoryId: string, patch: { name?: string; icon?: string }): Promise<CardCategory>;
  deleteCategory(categoryId: string): Promise<void>;
  listCards(projectId: string): Promise<Card[]>;
  createCard(projectId: string, input: CardInput & { title: string }): Promise<Card>;
  updateCard(cardId: string, patch: CardInput): Promise<Card>;
  deleteCard(cardId: string): Promise<void>;
  listComments(cardId: string): Promise<CardComment[]>;
  addComment(cardId: string, projectId: string, body: string): Promise<CardComment>;
  updateComment(commentId: string, body: string): Promise<CardComment>;
  deleteComment(commentId: string): Promise<void>;
  listAttachments(cardId: string): Promise<CardAttachment[]>;
  uploadAttachment(cardId: string, projectId: string, file: File): Promise<CardAttachment>;
  deleteAttachment(attachment: CardAttachment): Promise<void>;
  attachmentUrl(attachment: CardAttachment): Promise<string>;

  // events, activity and notifications
  emitEvent(projectId: string, type: string, payload: Record<string, unknown>, recipients?: string[]): Promise<void>;
  listActivity(projectId: string, filters?: ActivityFilters): Promise<ActivityEntry[]>;
  listEventTypes(): Promise<EventType[]>;
  listNotifications(filters?: NotificationFilters): Promise<AppNotification[]>;
  unreadNotificationCount(): Promise<number>;
  markNotificationsRead(ids?: number[]): Promise<void>;
  listPreferences(): Promise<NotificationPreference[]>;
  setPreference(pref: NotificationPreference): Promise<void>;

  // Discord (webhook URL never comes back to the client)
  getDiscordSettings(projectId: string): Promise<DiscordSettings>;
  setDiscordEventTypes(projectId: string, types: string[]): Promise<void>;
  setDiscordWebhook(projectId: string, url: string | null): Promise<void>;
  sendDiscordTest(projectId: string): Promise<void>;

  // realtime: with a projectId = that project's tables, without = my notifications and projects
  subscribe(args: { projectId?: string }, handler: RealtimeHandler): Unsubscribe;
}
