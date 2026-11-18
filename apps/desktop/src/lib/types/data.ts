/** Entities of the shared Supabase model (see docs/modello-dati.md), camelCase on the UI side. */

export type MemberRole = 'admin' | 'member';
export type CardPriority = 'low' | 'medium' | 'high' | 'critical';
export type CardStatus = 'open' | 'in_progress' | 'completed' | 'archived';
export type Importance = 'info' | 'important' | 'critical';
export type ClaimKind = 'editing' | 'reserved';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export type Profile = {
  id: string;
  githubId: number | null;
  githubLogin: string;
  displayName: string;
  avatarUrl: string | null;
  avatarColor: string | null;
};

export type PublishPolicySetting =
  | { mode: 'assisted'; idleMinutes: number }
  | { mode: 'manual' }
  | { mode: 'onSave'; minIntervalMinutes: number };

export type ProjectSettings = {
  publishPolicy: PublishPolicySetting;
  activityRetention: number;
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  description: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  settings: ProjectSettings;
};

/** A project together with the current user's role in it. */
export type ProjectWithRole = Project & { myRole: MemberRole };

export type Member = {
  userId: string;
  role: MemberRole;
  addedAt: string;
  profile: Profile;
  lastActivityAt: string | null;
};

export type Invitation = {
  id: string;
  projectId: string;
  githubLogin: string;
  role: MemberRole;
  status: InvitationStatus;
  createdAt: string;
};

export type IndexedVersion = {
  number: number;
  sha: string;
  kind: 'publish' | 'restore' | 'conflict-resolution';
  title: string;
  description: string | null;
  authorLogin: string;
  authorName: string;
  publishedAt: string;
  restoredFrom: number | null;
  conflictId: string | null;
  files: { path: string; change: string }[];
};

export type ConflictRecord = {
  id: string;
  projectId: string;
  files: { path: string; kind: string }[];
  oursUserId: string | null;
  theirsUserId: string | null;
  theirsVersion: number | null;
  status: 'open' | 'resolved';
  resolvedBy: string | null;
  resolvedVersion: number | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type FileClaim = {
  projectId: string;
  userId: string;
  path: string;
  kind: ClaimKind;
  note: string | null;
  machineId: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string | null;
};

export type CardCategory = {
  id: string;
  projectId: string;
  name: string;
  icon: string;
  sort: number;
  isDefault: boolean;
};

export type Card = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  color: string;
  priority: CardPriority | null;
  categoryId: string | null;
  status: CardStatus;
  createdBy: string;
  assigneeId: string | null;
  dueDate: string | null;
  position: number;
  linkedVersion: number | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CardInput = Partial<
  Pick<
    Card,
    | 'title'
    | 'description'
    | 'color'
    | 'priority'
    | 'categoryId'
    | 'status'
    | 'assigneeId'
    | 'dueDate'
    | 'position'
    | 'linkedVersion'
    | 'convertedAt'
  >
>;

export type CardComment = {
  id: string;
  cardId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
};

export type CardAttachment = {
  id: string;
  cardId: string;
  storagePath: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  uploadedBy: string;
  createdAt: string;
};

export type EventType = {
  type: string;
  importance: Importance;
  audience: 'project' | 'private';
  notify: boolean;
  discordDefault: boolean;
  clientAllowed: boolean;
  labelIt: string;
};

export type ActivityEntry = {
  id: number;
  projectId: string;
  actorId: string | null;
  type: string;
  importance: Importance;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ActivityFilters = {
  actorId?: string;
  type?: string;
  importance?: Importance;
  from?: string;
  to?: string;
  limit?: number;
};

export type AppNotification = {
  id: number;
  eventId: number;
  projectId: string | null;
  type: string;
  importance: Importance;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
};

export type NotificationFilters = {
  projectId?: string;
  unreadOnly?: boolean;
  limit?: number;
};

export type NotificationPreference = { eventType: string; inApp: boolean; desktop: boolean };

export type DiscordSettings = {
  projectId: string;
  enabledEventTypes: string[];
  webhookConfigured: boolean;
  updatedAt: string | null;
};

export type StorageAttachmentInput = { file: File };

export type RealtimeChange =
  | { table: 'cards' | 'card_comments' | 'card_categories' }
  | { table: 'activity_log' }
  | { table: 'versions' }
  | { table: 'conflicts' }
  | { table: 'file_claims' }
  | { table: 'project_members' }
  | { table: 'notifications' };

export type RealtimeTable = RealtimeChange['table'];
