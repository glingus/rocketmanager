import { describe, expect, it } from "vitest";
import { makeDb } from "../functions/_shared/db.ts";

/** Client supabase-js finto: registra la catena di chiamate e risponde con i risultati in coda. */
function fakeSb(results: { data?: unknown; error?: { message: string; code?: string } | null }[]) {
  const rec: [string, unknown[]][] = [];
  const queue = [...results];
  const builder = (res: (typeof results)[number]): any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: res.data ?? null, error: res.error ?? null });
          return (...args: unknown[]) => {
            rec.push([prop, args]);
            return builder(res);
          };
        },
      },
    );
  const sb: any = {
    from: (t: string) => {
      rec.push(["from", [t]]);
      return builder(queue.shift() ?? {});
    },
    rpc: (n: string, a: unknown) => {
      rec.push(["rpc", [n, a]]);
      return builder(queue.shift() ?? {});
    },
    auth: {
      getUser: async (token: string) => {
        rec.push(["getUser", [token]]);
        return token === "ok" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } };
      },
    },
  };
  return { sb, rec };
}

const find = (rec: [string, unknown[]][], name: string) => rec.filter(([n]) => n === name).map(([, a]) => a);

describe("adattatore supabase-js", () => {
  it("getUserId e getRole", async () => {
    const { sb, rec } = fakeSb([{ data: { role: "admin" } }]);
    const db = makeDb(sb);
    expect(await db.getUserId("ok")).toBe("u1");
    expect(await db.getUserId("ko")).toBeNull();
    expect(await db.getRole("p", "u")).toBe("admin");
    expect(find(rec, "from")).toEqual([["project_members"]]);
    expect(find(rec, "eq")).toEqual([["project_id", "p"], ["user_id", "u"]]);
  });

  it("getRole propaga gli errori del database", async () => {
    const { sb } = fakeSb([{ error: { message: "rls", code: "42501" } }]);
    await expect(makeDb(sb).getRole("p", "u")).rejects.toMatchObject({ code: "42501" });
  });

  it("createProjectRecord chiama la RPC con i parametri attesi", async () => {
    const { sb, rec } = fakeSb([{ data: "pid" }]);
    const id = await makeDb(sb).createProjectRecord({
      id: "pid", name: "N", slug: "n", description: "d", githubOwner: "o", githubRepo: "r", githubRepoId: 5, defaultBranch: "main", createdBy: "u",
    });
    expect(id).toBe("pid");
    expect(find(rec, "rpc")[0]).toEqual([
      "create_project_record",
      { p_name: "N", p_slug: "n", p_description: "d", p_github_owner: "o", p_github_repo: "r", p_github_repo_id: 5, p_default_branch: "main", p_created_by: "u", p_id: "pid" },
    ]);
  });

  it("insertVersions salta i duplicati (23505) e fallisce sugli altri errori", async () => {
    const rows = [{ number: 1 }, { number: 2 }, { number: 3 }] as any[];
    const { sb } = fakeSb([{}, { error: { message: "dup", code: "23505" } }, {}]);
    expect(await makeDb(sb).insertVersions(rows)).toEqual([rows[0], rows[2]]);
    const bad = fakeSb([{ error: { message: "boom", code: "XX000" } }]);
    await expect(makeDb(bad.sb).insertVersions(rows)).rejects.toThrow(/boom/);
  });

  it("inviti: duplicato -> false; revoca e lettura", async () => {
    const dup = fakeSb([{ error: { message: "dup", code: "23505" } }]);
    expect(await makeDb(dup.sb).createInvitation("p", "x", "member", "u")).toBe(false);
    const ok = fakeSb([{}]);
    expect(await makeDb(ok.sb).createInvitation("p", "x", "member", "u")).toBe(true);
    const rev = fakeSb([{ data: [{ id: "1" }] }]);
    expect(await makeDb(rev.sb).revokeInvitation("p", "x")).toBe(true);
    expect(find(rev.rec, "ilike")).toEqual([["github_login", "x"]]);
  });

  it("webhook Discord e coda passano da RPC riservate al server", async () => {
    const { sb, rec } = fakeSb([{}, {}, { data: "https://discord.com/api/webhooks/1/x" }, { data: [{ id: 1 }] }, {}, {}]);
    const db = makeDb(sb);
    await db.setWebhook("p", "url", "u");
    await db.removeWebhook("p", "u");
    expect(await db.getWebhookUrl("p")).toBe("https://discord.com/api/webhooks/1/x");
    expect(await db.pending(new Date("2026-01-01T00:00:00Z"), 50)).toEqual([{ id: 1 }]);
    await db.markSent([1], new Date("2026-01-01T00:00:00Z"));
    await db.markFailedAttempt([1], { attempts: 2, status: "pending", nextAttemptAt: new Date("2026-01-01T00:01:00Z"), error: "e" });
    expect(find(rec, "rpc").map((a) => a[0])).toEqual([
      "set_discord_webhook", "remove_discord_webhook", "get_discord_webhook", "claim_discord_outbox", "mark_discord_sent", "mark_discord_failed",
    ]);
    expect(find(rec, "rpc")[3]).toEqual(["claim_discord_outbox", { p_now: "2026-01-01T00:00:00.000Z", p_limit: 50 }]);
  });

  it("findProject cerca per id del repository e poi per nome", async () => {
    const { sb, rec } = fakeSb([{ data: null }, { data: { id: "p", default_branch: "main" } }]);
    expect(await makeDb(sb).findProject(42, "org/razzo")).toEqual({ id: "p", default_branch: "main" });
    expect(find(rec, "eq")).toEqual([["github_repo_id", 42], ["github_owner", "org"], ["github_repo", "razzo"]]);
  });
});
