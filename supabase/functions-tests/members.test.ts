import { describe, expect, it } from "vitest";
import { acceptInvitations, manageMembers, type MembersDb, type MembersDeps } from "../functions/_shared/members.ts";
import type { ProjectRole } from "../functions/_shared/auth.ts";

const P = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "bbbbbbbb-0000-4000-8000-000000000002";
const OUTSIDER = "cccccccc-0000-4000-8000-000000000003";

function setup(opts: { archived?: boolean; ghFail?: boolean } = {}) {
  const roles = new Map<string, ProjectRole>([[ADMIN, "admin"], [MEMBER, "member"]]);
  const profiles = new Map([
    [ADMIN, { id: ADMIN, github_login: "simone", display_name: "Simone" }],
    [MEMBER, { id: MEMBER, github_login: "marco", display_name: "Marco" }],
    ["dddddddd-0000-4000-8000-000000000004", { id: "dddddddd-0000-4000-8000-000000000004", github_login: "lucia", display_name: "Lucia" }],
  ]);
  const log: string[] = [];
  const events: any[] = [];
  const invitations: { id: string; login: string; role: ProjectRole; status: string }[] = [];
  let lastAdminError = false;
  const db: MembersDb = {
    async getProject() {
      return { id: P, name: "Razzo", github_owner: "rocket-org", github_repo: "razzo", archived_at: opts.archived ? "2026-01-01" : null };
    },
    async findProfileByLogin(login) {
      return [...profiles.values()].find((p) => p.github_login.toLowerCase() === login.toLowerCase()) ?? null;
    },
    async getProfile(id) {
      return profiles.get(id) ?? null;
    },
    async getMemberRole(_p, u) {
      return roles.get(u) ?? null;
    },
    async addMember(_p, u, role) {
      log.push(`addMember:${u}:${role}`);
      roles.set(u, role);
    },
    async removeMember(_p, u) {
      log.push(`removeMember:${u}`);
      if (lastAdminError) throw Object.assign(new Error("Il progetto deve avere almeno un amministratore"), { code: "23514" });
      roles.delete(u);
    },
    async setMemberRole(_p, u, role) {
      log.push(`setRole:${u}:${role}`);
      if (lastAdminError) throw Object.assign(new Error("Il progetto deve avere almeno un amministratore"), { code: "23514" });
      roles.set(u, role);
    },
    async createInvitation(_p, login, role) {
      if (invitations.some((i) => i.login.toLowerCase() === login.toLowerCase() && i.status === "pending")) return false;
      invitations.push({ id: `inv${invitations.length + 1}`, login, role, status: "pending" });
      return true;
    },
    async revokeInvitation(_p, login) {
      const inv = invitations.find((i) => i.login.toLowerCase() === login.toLowerCase() && i.status === "pending");
      if (inv) inv.status = "revoked";
      return !!inv;
    },
    async pendingInvitationsFor(login) {
      return invitations
        .filter((i) => i.login.toLowerCase() === login.toLowerCase() && i.status === "pending")
        .map((i) => ({ id: i.id, project_id: P, role: i.role, invited_by: ADMIN }));
    },
    async markInvitationAccepted(id) {
      invitations.find((i) => i.id === id)!.status = "accepted";
    },
    async emitEvent(e) {
      events.push(e);
    },
  };
  const deps: MembersDeps = {
    auth: { getRole: async (_p, u) => roles.get(u) ?? null },
    db,
    github: {
      async grantAccess(_o, _r, login) {
        log.push(`grant:${login}`);
        if (opts.ghFail) throw new (await import("../functions/_shared/github-app.ts")).GithubError(502, "GitHub: giù");
        return { orgInvited: false, repoAccess: "granted" };
      },
      async revokeAccess(_o, _r, login) {
        log.push(`revoke:${login}`);
      },
    },
  };
  return { deps, log, events, roles, invitations, setLastAdmin: () => (lastAdminError = true) };
}

describe("manage-members: autorizzazioni", () => {
  it("rifiuta chi non è admin (member o estraneo) prima di toccare GitHub o il database", async () => {
    for (const actor of [MEMBER, OUTSIDER]) {
      const s = setup();
      const err = await manageMembers(actor, { action: "add", projectId: P, login: "lucia", role: "member" }, s.deps).catch((e) => e);
      expect(err.status).toBe(403);
      expect(err.code).toBe(actor === MEMBER ? "admin_required" : "not_a_member");
      expect(s.log).toEqual([]);
      expect(s.events).toEqual([]);
    }
    const s = setup();
    for (const action of [
      { action: "remove", projectId: P, userId: ADMIN },
      { action: "set_role", projectId: P, userId: MEMBER, role: "admin" },
    ] as const) {
      await expect(manageMembers(MEMBER, action, s.deps)).rejects.toMatchObject({ status: 403 });
    }
    expect(s.roles.get(MEMBER)).toBe("member");
  });

  it("non modifica progetti archiviati", async () => {
    const s = setup({ archived: true });
    await expect(manageMembers(ADMIN, { action: "add", projectId: P, login: "lucia", role: "member" }, s.deps)).rejects.toMatchObject({ status: 409, code: "project_archived" });
  });
});

describe("manage-members: azioni", () => {
  it("add: utente già registrato -> accesso GitHub, membro, evento member.added", async () => {
    const s = setup();
    const r = await manageMembers(ADMIN, { action: "add", projectId: P, login: "Lucia", role: "member" }, s.deps);
    expect(r).toMatchObject({ status: "member" });
    expect(s.log).toEqual(["grant:Lucia", "addMember:dddddddd-0000-4000-8000-000000000004:member"]);
    expect(s.events).toEqual([
      { projectId: P, type: "member.added", payload: { targetName: "Lucia", role: "member" }, actorId: ADMIN },
    ]);
  });

  it("add: utente mai visto -> invito in sospeso (nessun evento finché non accetta); doppio invito = 409", async () => {
    const s = setup();
    const r = await manageMembers(ADMIN, { action: "add", projectId: P, login: "nuovo-utente", role: "admin" }, s.deps);
    expect(r).toMatchObject({ status: "invited" });
    expect(s.invitations).toEqual([{ id: "inv1", login: "nuovo-utente", role: "admin", status: "pending" }]);
    expect(s.events).toEqual([]);
    await expect(manageMembers(ADMIN, { action: "add", projectId: P, login: "Nuovo-Utente", role: "member" }, s.deps)).rejects.toMatchObject({ status: 409, code: "already_invited" });
  });

  it("add: già membro -> 409; errore GitHub -> 502 e nessuna riga", async () => {
    const s = setup();
    await expect(manageMembers(ADMIN, { action: "add", projectId: P, login: "marco", role: "member" }, s.deps)).rejects.toMatchObject({ status: 409, code: "already_member" });
    const g = setup({ ghFail: true });
    await expect(manageMembers(ADMIN, { action: "add", projectId: P, login: "lucia", role: "member" }, g.deps)).rejects.toMatchObject({ status: 502 });
    expect(g.log.some((l) => l.startsWith("addMember"))).toBe(false);
  });

  it("remove: toglie l'accesso al repo, il membro e registra member.removed", async () => {
    const s = setup();
    const r = await manageMembers(ADMIN, { action: "remove", projectId: P, userId: MEMBER }, s.deps);
    expect(r).toMatchObject({ status: "removed" });
    expect(s.log).toEqual([`removeMember:${MEMBER}`, "revoke:marco"]);
    expect(s.events[0]).toMatchObject({ type: "member.removed", payload: { targetName: "Marco" } });
  });

  it("remove/set_role: l'ultimo admin è protetto (409) e nulla viene toccato su GitHub", async () => {
    const s = setup();
    s.setLastAdmin();
    await expect(manageMembers(ADMIN, { action: "remove", projectId: P, userId: ADMIN }, s.deps)).rejects.toMatchObject({ status: 409, code: "last_admin" });
    await expect(manageMembers(ADMIN, { action: "set_role", projectId: P, userId: ADMIN, role: "member" }, s.deps)).rejects.toMatchObject({ status: 409, code: "last_admin" });
    expect(s.log.filter((l) => l.startsWith("revoke"))).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("remove: invito in sospeso revocato; membro inesistente = 404", async () => {
    const s = setup();
    await manageMembers(ADMIN, { action: "add", projectId: P, login: "nuovo", role: "member" }, s.deps);
    const r = await manageMembers(ADMIN, { action: "remove", projectId: P, login: "nuovo" }, s.deps);
    expect(r).toMatchObject({ status: "invitation_revoked" });
    await expect(manageMembers(ADMIN, { action: "remove", projectId: P, login: "mai-esistito" }, s.deps)).rejects.toMatchObject({ status: 404 });
    await expect(manageMembers(ADMIN, { action: "remove", projectId: P, login: "lucia" }, s.deps)).rejects.toMatchObject({ status: 404 });
  });

  it("set_role: cambia il ruolo e registra l'evento; nessun cambiamento = nessun evento", async () => {
    const s = setup();
    const r = await manageMembers(ADMIN, { action: "set_role", projectId: P, userId: MEMBER, role: "admin" }, s.deps);
    expect(r).toMatchObject({ status: "role_changed", role: "admin" });
    expect(s.events[0]).toMatchObject({ type: "member.role_changed", payload: { targetName: "Marco", role: "admin" } });
    const again = await manageMembers(ADMIN, { action: "set_role", projectId: P, userId: MEMBER, role: "admin" }, s.deps);
    expect(again).toMatchObject({ status: "unchanged" });
    expect(s.events).toHaveLength(1);
  });
});

describe("accept-invitations", () => {
  it("trasforma gli inviti in sospeso del proprio login in membership, una volta sola", async () => {
    const s = setup();
    const lucia = "dddddddd-0000-4000-8000-000000000004";
    await manageMembers(ADMIN, { action: "add", projectId: P, login: "lucia", role: "member" }, s.deps); // già profilo: diretta
    // un invito per un login che poi si registra
    s.invitations.push({ id: "invX", login: "LUCIA", role: "admin", status: "pending" });
    s.roles.delete(lucia);
    const r = await acceptInvitations(lucia, { db: s.deps.db });
    expect(r.accepted).toEqual([{ projectId: P, role: "admin" }]);
    expect(s.roles.get(lucia)).toBe("admin");
    expect(s.events.at(-1)).toMatchObject({ type: "member.added", payload: { targetName: "Lucia", role: "admin" } });
    const again = await acceptInvitations(lucia, { db: s.deps.db });
    expect(again.accepted).toEqual([]);
  });

  it("senza profilo -> 403", async () => {
    const s = setup();
    await expect(acceptInvitations("eeeeeeee-0000-4000-8000-000000000009", { db: s.deps.db })).rejects.toMatchObject({ status: 403 });
  });
});
