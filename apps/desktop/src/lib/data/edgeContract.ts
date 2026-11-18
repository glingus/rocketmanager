/**
 * Request bodies and response types of the Edge Functions, typed against the real implementation
 * in `supabase/functions/_shared` (so a change there breaks the typecheck here).
 */
import type { acceptInvitations, MemberAction } from '../../../../../supabase/functions/_shared/members.ts';
import type { DiscordSettingsRequest } from '../../../../../supabase/functions/_shared/discord.ts';
import type { CreateProjectResult } from '../../../../../supabase/functions/_shared/create-project.ts';
import type { RefreshedTokens } from '../../../../../supabase/functions/_shared/github-app.ts';
import type { MemberRole } from '../types/data';

export type { CreateProjectResult, RefreshedTokens, MemberAction, DiscordSettingsRequest };
export type AcceptInvitationsResult = Awaited<ReturnType<typeof acceptInvitations>>;

/** Edge Function names used by the UI. `github-token-refresh` is called by the Rust core only. */
export const EDGE_FUNCTIONS = ['create-project', 'manage-members', 'accept-invitations', 'discord-settings'] as const;
export type EdgeFunctionName = (typeof EDGE_FUNCTIONS)[number];

export const createProjectBody = (name: string, description: string) => ({ name, description });

export const memberBody = {
  add: (projectId: string, login: string, role: MemberRole) => ({ action: 'add', projectId, login, role }) satisfies MemberAction,
  remove: (projectId: string, userId: string) => ({ action: 'remove', projectId, userId }) satisfies MemberAction,
  revokeInvitation: (projectId: string, login: string) => ({ action: 'remove', projectId, login }) satisfies MemberAction,
  setRole: (projectId: string, userId: string, role: MemberRole) => ({ action: 'set_role', projectId, userId, role }) satisfies MemberAction,
};

export const discordBody = {
  set: (projectId: string, webhookUrl: string) => ({ action: 'set', projectId, webhookUrl }) satisfies DiscordSettingsRequest,
  remove: (projectId: string) => ({ action: 'remove', projectId }) satisfies DiscordSettingsRequest,
  test: (projectId: string) => ({ action: 'test', projectId }) satisfies DiscordSettingsRequest,
};

/** Failure body of every Edge Function: `{ error: { code, message } }` (see `_shared/http.ts`). */
export type EdgeErrorBody = { error: { code: string; message: string } };
