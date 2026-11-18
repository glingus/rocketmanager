// Edge Functions `manage-members` e `accept-invitations`.

import { HttpError } from "./http.ts";
import type { AccessResult } from "./github-app.ts";
import { GithubError } from "./github-app.ts";
import { requireProjectRole, type AuthDeps, type ProjectRole } from "./auth.ts";

export interface MemberProject {
  id: string;
  name: string;
  github_owner: string;
  github_repo: string;
  archived_at: string | null;
}

export interface ProfileLite {
  id: string;
  github_login: string;
  display_name: string;
}

export interface MembersDb {
  getProject(projectId: string): Promise<MemberProject | null>;
  findProfileByLogin(login: string): Promise<ProfileLite | null>;
  getProfile(userId: string): Promise<ProfileLite | null>;
  getMemberRole(projectId: string, userId: string): Promise<ProjectRole | null>;
  addMember(projectId: string, userId: string, role: ProjectRole, addedBy: string | null): Promise<void>;
  removeMember(projectId: string, userId: string): Promise<void>;
  setMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<void>;
  /** Crea l'invito in sospeso; false se ne esiste già uno per quel login. */
  createInvitation(projectId: string, login: string, role: ProjectRole, invitedBy: string): Promise<boolean>;
  revokeInvitation(projectId: string, login: string): Promise<boolean>;
  pendingInvitationsFor(login: string): Promise<{ id: string; project_id: string; role: ProjectRole; invited_by: string | null }[]>;
  markInvitationAccepted(invitationId: string): Promise<void>;
  emitEvent(args: {
    projectId: string;
    type: string;
    payload: Record<string, unknown>;
    actorId: string | null;
  }): Promise<void>;
}

export interface MembersGithub {
  grantAccess(owner: string, repo: string, login: string): Promise<AccessResult>;
  revokeAccess(owner: string, repo: string, login: string): Promise<void>;
}

export interface MembersDeps {
  auth: Pick<AuthDeps, "getRole">;
  db: MembersDb;
  github: MembersGithub;
}

export type MemberAction =
  | { action: "add"; projectId: string; login: string; role: ProjectRole }
  | { action: "remove"; projectId: string; login?: string; userId?: string }
  | { action: "set_role"; projectId: string; login?: string; userId?: string; role: ProjectRole };

function ghFail(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof GithubError) throw new HttpError(502, "github_error", e.message);
  throw e;
}

function lastAdminGuard(e: unknown): never {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? "");
  if (/almeno un amministratore/i.test(msg) || (e as { code?: string })?.code === "23514") {
    throw new HttpError(409, "last_admin", "Il progetto deve avere almeno un amministratore");
  }
  throw e;
}

export async function manageMembers(
  actorId: string,
  req: MemberAction,
  deps: MembersDeps,
): Promise<Record<string, unknown>> {
  // Ruolo verificato lato server, prima di qualsiasi altra cosa.
  await requireProjectRole(deps.auth, req.projectId, actorId, "admin");
  const project = await deps.db.getProject(req.projectId);
  if (!project) throw new HttpError(404, "project_not_found", "Progetto non trovato");
  if (project.archived_at) throw new HttpError(409, "project_archived", "Il progetto è archiviato");

  const resolveTarget = async (login?: string, userId?: string): Promise<ProfileLite | null> => {
    if (userId) return await deps.db.getProfile(userId);
    if (login) return await deps.db.findProfileByLogin(login);
    throw new HttpError(400, "missing_field", "Indica login o userId del membro");
  };

  switch (req.action) {
    case "add": {
      const profile = await deps.db.findProfileByLogin(req.login);
      if (profile && (await deps.db.getMemberRole(project.id, profile.id))) {
        throw new HttpError(409, "already_member", "L'utente fa già parte del progetto");
      }
      let access: AccessResult;
      try {
        access = await deps.github.grantAccess(project.github_owner, project.github_repo, req.login);
      } catch (e) {
        ghFail(e);
      }
      if (profile) {
        await deps.db.addMember(project.id, profile.id, req.role, actorId);
        await deps.db.emitEvent({
          projectId: project.id,
          type: "member.added",
          payload: { targetName: profile.display_name || profile.github_login, role: req.role },
          actorId,
        });
        return { status: "member", userId: profile.id, github: access };
      }
      // Non ha ancora fatto accesso a Rocket Sync: invito in sospeso, accettato al primo accesso.
      const created = await deps.db.createInvitation(project.id, req.login, req.role, actorId);
      if (!created) throw new HttpError(409, "already_invited", "Esiste già un invito in sospeso per questo utente");
      return { status: "invited", github: access };
    }
    case "remove": {
      const target = await resolveTarget(req.login, req.userId);
      if (!target) {
        // Nessun profilo: può essere solo un invito in sospeso.
        const login = req.login;
        if (login && (await deps.db.revokeInvitation(project.id, login))) {
          await deps.github.revokeAccess(project.github_owner, project.github_repo, login).catch(ghFail);
          return { status: "invitation_revoked" };
        }
        throw new HttpError(404, "member_not_found", "Membro non trovato");
      }
      if (!(await deps.db.getMemberRole(project.id, target.id))) {
        throw new HttpError(404, "member_not_found", "L'utente non fa parte del progetto");
      }
      try {
        await deps.db.removeMember(project.id, target.id);
      } catch (e) {
        lastAdminGuard(e);
      }
      await deps.github
        .revokeAccess(project.github_owner, project.github_repo, target.github_login)
        .catch(ghFail);
      await deps.db.emitEvent({
        projectId: project.id,
        type: "member.removed",
        payload: { targetName: target.display_name || target.github_login },
        actorId,
      });
      return { status: "removed", userId: target.id };
    }
    case "set_role": {
      const target = await resolveTarget(req.login, req.userId);
      if (!target) throw new HttpError(404, "member_not_found", "Membro non trovato");
      const current = await deps.db.getMemberRole(project.id, target.id);
      if (!current) throw new HttpError(404, "member_not_found", "L'utente non fa parte del progetto");
      if (current === req.role) return { status: "unchanged", userId: target.id };
      try {
        await deps.db.setMemberRole(project.id, target.id, req.role);
      } catch (e) {
        lastAdminGuard(e);
      }
      await deps.db.emitEvent({
        projectId: project.id,
        type: "member.role_changed",
        payload: { targetName: target.display_name || target.github_login, role: req.role },
        actorId,
      });
      return { status: "role_changed", userId: target.id, role: req.role };
    }
  }
}

/** Dopo il login: trasforma gli inviti in sospeso per il login GitHub dell'utente in membership. */
export async function acceptInvitations(
  userId: string,
  deps: Pick<MembersDeps, "db">,
): Promise<{ accepted: { projectId: string; role: ProjectRole }[] }> {
  const profile = await deps.db.getProfile(userId);
  if (!profile) throw new HttpError(403, "no_profile", "Profilo utente non trovato");
  const invites = await deps.db.pendingInvitationsFor(profile.github_login);
  const accepted: { projectId: string; role: ProjectRole }[] = [];
  for (const inv of invites) {
    const existing = await deps.db.getMemberRole(inv.project_id, userId);
    if (!existing) {
      await deps.db.addMember(inv.project_id, userId, inv.role, inv.invited_by);
      await deps.db.emitEvent({
        projectId: inv.project_id,
        type: "member.added",
        payload: { targetName: profile.display_name || profile.github_login, role: inv.role },
        actorId: inv.invited_by,
      });
    }
    await deps.db.markInvitationAccepted(inv.id);
    accepted.push({ projectId: inv.project_id, role: existing ?? inv.role });
  }
  return { accepted };
}
