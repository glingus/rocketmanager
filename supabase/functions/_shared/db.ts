// Adattatori sottili tra le interfacce delle funzioni e supabase-js (client con chiave service_role).
// Le operazioni su `private.*` passano da RPC `security definer` (lo schema non è esposto da PostgREST).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectRole } from "./auth.ts";
import type { CreatorProfile } from "./create-project.ts";
import type { MemberProject, ProfileLite } from "./members.ts";
import type { OutboxRow } from "./discord.ts";
import type { VersionRow } from "./versions.ts";

function fail(what: string, error: { message: string; code?: string } | null): void {
  if (error) {
    const e = new Error(`${what}: ${error.message}`) as Error & { code?: string };
    e.code = error.code;
    throw e;
  }
}

export function makeDb(sb: SupabaseClient) {
  return {
    // ---- autenticazione ---------------------------------------------------------------------
    async getUserId(token: string): Promise<string | null> {
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data.user) return null;
      return data.user.id;
    },

    async getRole(projectId: string, userId: string): Promise<ProjectRole | null> {
      const { data, error } = await sb
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .maybeSingle();
      fail("lettura ruolo", error);
      return (data?.role as ProjectRole | undefined) ?? null;
    },

    // ---- profili e progetti ------------------------------------------------------------------
    async getProfile(userId: string): Promise<(CreatorProfile & ProfileLite) | null> {
      const { data, error } = await sb
        .from("profiles")
        .select("id, github_login, github_id, display_name")
        .eq("id", userId)
        .maybeSingle();
      fail("lettura profilo", error);
      return (data as (CreatorProfile & ProfileLite) | null) ?? null;
    },

    async findProfileByLogin(login: string): Promise<ProfileLite | null> {
      const { data, error } = await sb
        .from("profiles")
        .select("id, github_login, display_name")
        .ilike("github_login", login)
        .maybeSingle();
      fail("ricerca profilo", error);
      return (data as ProfileLite | null) ?? null;
    },

    async findProfilesByLogins(logins: string[]): Promise<Map<string, { id: string; display_name: string }>> {
      const out = new Map<string, { id: string; display_name: string }>();
      if (logins.length === 0) return out;
      const { data, error } = await sb
        .from("profiles")
        .select("id, github_login, display_name")
        .in("github_login", logins);
      fail("ricerca profili", error);
      for (const p of data ?? []) out.set(p.github_login as string, { id: p.id as string, display_name: p.display_name as string });
      return out;
    },

    async getProject(projectId: string): Promise<MemberProject | null> {
      const { data, error } = await sb
        .from("projects")
        .select("id, name, github_owner, github_repo, archived_at")
        .eq("id", projectId)
        .maybeSingle();
      fail("lettura progetto", error);
      return (data as MemberProject | null) ?? null;
    },

    async findProject(
      repoId: number | undefined,
      fullName: string | undefined,
    ): Promise<{ id: string; default_branch: string } | null> {
      if (repoId !== undefined) {
        const { data, error } = await sb
          .from("projects")
          .select("id, default_branch")
          .eq("github_repo_id", repoId)
          .maybeSingle();
        fail("ricerca progetto per repository", error);
        if (data) return data as { id: string; default_branch: string };
      }
      const [owner, repo] = (fullName ?? "").split("/");
      if (!owner || !repo) return null;
      const { data, error } = await sb
        .from("projects")
        .select("id, default_branch")
        .eq("github_owner", owner)
        .eq("github_repo", repo)
        .maybeSingle();
      fail("ricerca progetto per nome", error);
      return (data as { id: string; default_branch: string } | null) ?? null;
    },

    async slugExists(slug: string): Promise<boolean> {
      const { data, error } = await sb.from("projects").select("id").eq("slug", slug).maybeSingle();
      fail("controllo slug", error);
      return data !== null;
    },

    async createProjectRecord(a: {
      id: string;
      name: string;
      slug: string;
      description: string;
      githubOwner: string;
      githubRepo: string;
      githubRepoId: number;
      defaultBranch: string;
      createdBy: string;
    }): Promise<string> {
      const { data, error } = await sb.rpc("create_project_record", {
        p_name: a.name,
        p_slug: a.slug,
        p_description: a.description,
        p_github_owner: a.githubOwner,
        p_github_repo: a.githubRepo,
        p_github_repo_id: a.githubRepoId,
        p_default_branch: a.defaultBranch,
        p_created_by: a.createdBy,
        p_id: a.id,
      });
      fail("creazione del record del progetto", error);
      return data as string;
    },

    async deleteProject(projectId: string): Promise<void> {
      const { error } = await sb.from("projects").delete().eq("id", projectId);
      fail("eliminazione del progetto", error);
    },

    // ---- membri e inviti ---------------------------------------------------------------------
    async getMemberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
      return await this.getRole(projectId, userId);
    },

    async addMember(projectId: string, userId: string, role: ProjectRole, addedBy: string | null): Promise<void> {
      const { error } = await sb
        .from("project_members")
        .insert({ project_id: projectId, user_id: userId, role, added_by: addedBy });
      fail("aggiunta del membro", error);
    },

    async removeMember(projectId: string, userId: string): Promise<void> {
      const { error } = await sb.from("project_members").delete().eq("project_id", projectId).eq("user_id", userId);
      fail("rimozione del membro", error);
    },

    async setMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<void> {
      const { error } = await sb
        .from("project_members")
        .update({ role })
        .eq("project_id", projectId)
        .eq("user_id", userId);
      fail("cambio di ruolo", error);
    },

    async createInvitation(projectId: string, login: string, role: ProjectRole, invitedBy: string): Promise<boolean> {
      const { error } = await sb
        .from("project_invitations")
        .insert({ project_id: projectId, github_login: login, role, invited_by: invitedBy });
      if (error?.code === "23505") return false;
      fail("creazione dell'invito", error);
      return true;
    },

    async revokeInvitation(projectId: string, login: string): Promise<boolean> {
      const { data, error } = await sb
        .from("project_invitations")
        .update({ status: "revoked" })
        .eq("project_id", projectId)
        .eq("status", "pending")
        .ilike("github_login", login)
        .select("id");
      fail("revoca dell'invito", error);
      return (data?.length ?? 0) > 0;
    },

    async pendingInvitationsFor(
      login: string,
    ): Promise<{ id: string; project_id: string; role: ProjectRole; invited_by: string | null }[]> {
      const { data, error } = await sb
        .from("project_invitations")
        .select("id, project_id, role, invited_by")
        .eq("status", "pending")
        .ilike("github_login", login);
      fail("lettura degli inviti", error);
      return (data ?? []) as { id: string; project_id: string; role: ProjectRole; invited_by: string | null }[];
    },

    async markInvitationAccepted(invitationId: string): Promise<void> {
      const { error } = await sb
        .from("project_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invitationId);
      fail("accettazione dell'invito", error);
    },

    // ---- eventi e versioni ---------------------------------------------------------------------
    async emitEvent(a: {
      projectId: string;
      type: string;
      payload: Record<string, unknown>;
      actorId: string | null;
    }): Promise<void> {
      const { error } = await sb.rpc("emit_event_server", {
        p_project_id: a.projectId,
        p_type: a.type,
        p_payload: a.payload,
        p_actor_id: a.actorId,
      });
      fail("registrazione dell'evento", error);
    },

    /** Una riga alla volta: sha o numero già presenti (23505) sono duplicati, non errori. */
    async insertVersions(rows: VersionRow[]): Promise<VersionRow[]> {
      const inserted: VersionRow[] = [];
      for (const row of rows) {
        const { error } = await sb.from("versions").insert(row);
        if (error?.code === "23505") continue;
        fail("inserimento della versione", error);
        inserted.push(row);
      }
      return inserted;
    },

    // ---- Discord ---------------------------------------------------------------------------------
    async setWebhook(projectId: string, url: string, userId: string): Promise<void> {
      const { error } = await sb.rpc("set_discord_webhook", { p_project_id: projectId, p_url: url, p_user_id: userId });
      fail("salvataggio del webhook", error);
    },

    async removeWebhook(projectId: string, userId: string): Promise<void> {
      const { error } = await sb.rpc("remove_discord_webhook", { p_project_id: projectId, p_user_id: userId });
      fail("rimozione del webhook", error);
    },

    async getWebhookUrl(projectId: string): Promise<string | null> {
      const { data, error } = await sb.rpc("get_discord_webhook", { p_project_id: projectId });
      fail("lettura del webhook", error);
      return (data as string | null) ?? null;
    },

    async pending(now: Date, limit: number): Promise<OutboxRow[]> {
      const { data, error } = await sb.rpc("claim_discord_outbox", { p_now: now.toISOString(), p_limit: limit });
      fail("lettura della coda Discord", error);
      return (data ?? []) as OutboxRow[];
    },

    async markSent(ids: number[], now: Date): Promise<void> {
      const { error } = await sb.rpc("mark_discord_sent", { p_ids: ids, p_now: now.toISOString() });
      fail("segno di invio", error);
    },

    async markFailedAttempt(
      ids: number[],
      a: { attempts: number; status: "pending" | "failed"; nextAttemptAt: Date; error: string },
    ): Promise<void> {
      const { error } = await sb.rpc("mark_discord_failed", {
        p_ids: ids,
        p_attempts: a.attempts,
        p_status: a.status,
        p_next_attempt_at: a.nextAttemptAt.toISOString(),
        p_error: a.error,
      });
      fail("registrazione del tentativo", error);
    },
  };
}

export type Db = ReturnType<typeof makeDb>;
