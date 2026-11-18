import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../functions/_shared/hmac.ts";
import { handleGithubWebhook, type WebhookDb } from "../functions/_shared/webhook.ts";
import { buildVersionRows, commitAuthorLogin, loginFromNoreply, type PushCommit } from "../functions/_shared/versions.ts";
import { jsonOf } from "./helpers.ts";

const SECRET = "segreto-di-prova";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const sha = (n: number) => n.toString(16).padStart(40, "0");

const publishMsg = (n: number, title: string) =>
  `v${n} — ${title}\n\nRazzo.ork\n• Pinne trapezoidali: numero 3 → 4\n\nRocket-Sync-Version: ${n}\nRocket-Sync-Kind: publish\nRocket-Sync-Client: 0.1.0`;

function commit(n: number, extra: Partial<PushCommit> = {}): PushCommit {
  return {
    id: sha(n),
    message: publishMsg(n, `Versione ${n}`),
    timestamp: "2026-11-18T14:22:10+00:00",
    author: { name: "Simone Rossi", email: "123+simone@users.noreply.github.com", username: "simone" },
    added: [".rocketsync/x.json"],
    modified: ["Razzo.ork"],
    removed: ["Vecchio.ork"],
    ...extra,
  };
}

function fakeDb() {
  const state = {
    versions: [] as any[],
    events: [] as any[],
    project: { id: PROJECT, default_branch: "main" } as { id: string; default_branch: string } | null,
  };
  const db: WebhookDb = {
    async findProject() {
      return state.project;
    },
    async findProfilesByLogins(logins) {
      return new Map(logins.includes("simone") ? [["simone", { id: "u-simone", display_name: "Simone" }]] : []);
    },
    async insertVersions(rows) {
      const fresh = rows.filter((r) => !state.versions.some((v) => v.sha === r.sha || v.number === r.number));
      state.versions.push(...fresh);
      return fresh;
    },
    async emitEvent(e) {
      state.events.push(e);
    },
  };
  return { db, state };
}

async function deliver(
  deps: Parameters<typeof handleGithubWebhook>[1],
  payload: unknown,
  opts: { event?: string; secret?: string; tamper?: boolean; signature?: string | null } = {},
) {
  const raw = JSON.stringify(payload);
  const sig = opts.signature !== undefined ? opts.signature : "sha256=" + (await hmacSha256Hex(opts.secret ?? SECRET, raw));
  const headers: Record<string, string> = { "x-github-event": opts.event ?? "push", "content-type": "application/json" };
  if (sig) headers["x-hub-signature-256"] = sig;
  const body = opts.tamper ? raw.replace("main", "mein") : raw;
  return await handleGithubWebhook(new Request("https://example.test/hook", { method: "POST", headers, body }), deps);
}

const push = (commits: PushCommit[], ref = "refs/heads/main") => ({
  ref,
  repository: { id: 42, full_name: "org/razzo", name: "razzo" },
  commits,
});

describe("github-webhook", () => {
  it("rifiuta firma assente, errata o su corpo alterato (401) senza toccare il database", async () => {
    const { db, state } = fakeDb();
    const deps = { secret: SECRET, db };
    expect((await deliver(deps, push([commit(1)]), { signature: null })).status).toBe(401);
    expect((await deliver(deps, push([commit(1)]), { secret: "sbagliato" })).status).toBe(401);
    expect((await deliver(deps, push([commit(1)]), { tamper: true })).status).toBe(401);
    expect((await handleGithubWebhook(new Request("https://x.test", { method: "GET" }), deps)).status).toBe(405);
    expect(state.versions).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("risponde al ping e ignora gli altri eventi", async () => {
    const { db } = fakeDb();
    expect((await deliver({ secret: SECRET, db }, { zen: "x" }, { event: "ping" })).status).toBe(200);
    const r = await deliver({ secret: SECRET, db }, { action: "opened" }, { event: "pull_request" });
    expect(r.status).toBe(202);
  });

  it("registra le versioni di un push su main e emette gli eventi", async () => {
    const { db, state } = fakeDb();
    const res = await deliver({ secret: SECRET, db }, push([commit(1), commit(2)]));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, inserted: 2 });
    expect(state.versions.map((v) => v.number)).toEqual([1, 2]);
    const v = state.versions[0];
    expect(v).toMatchObject({
      project_id: PROJECT,
      sha: sha(1),
      kind: "publish",
      title: "Versione 1",
      author_id: "u-simone",
      author_github_login: "simone",
      restored_from: null,
    });
    expect(v.files).toEqual([
      { path: "Razzo.ork", change: "modified" },
      { path: "Vecchio.ork", change: "deleted" },
    ]); // i file di servizio .rocketsync/ sono esclusi
    expect(v.changelog[0]).toEqual({ path: "Razzo.ork", lines: ["Pinne trapezoidali: numero 3 → 4"], interpreted: true });
    expect(v.published_at).toBe("2026-11-18T14:22:10.000Z");
    expect(state.events.map((e) => e.type)).toEqual(["version.published", "version.published"]);
    expect(state.events[0]).toMatchObject({ projectId: PROJECT, actorId: "u-simone" });
    expect(state.events[0].payload).toMatchObject({ number: 1, authorName: "Simone", title: "Versione 1" });
  });

  it("è idempotente sullo sha: la stessa consegna ripetuta non duplica versioni né eventi", async () => {
    const { db, state } = fakeDb();
    const deps = { secret: SECRET, db };
    await deliver(deps, push([commit(5)]));
    const again = await deliver(deps, push([commit(5)]));
    expect(await jsonOf(again)).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(state.versions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it("ignora gli altri rami (es. conflitti/<id>) e i rami eliminati", async () => {
    const { db, state } = fakeDb();
    const deps = { secret: SECRET, db };
    const other = await deliver(deps, push([commit(1)], "refs/heads/conflitti/20261101-abc123"));
    expect(other.status).toBe(202);
    const del = await deliver(deps, { ...push([]), deleted: true });
    expect(del.status).toBe(202);
    expect(state.versions).toHaveLength(0);
  });

  it("ignora i repository non collegati a un progetto", async () => {
    const { db, state } = fakeDb();
    state.project = null;
    const r = await deliver({ secret: SECRET, db }, push([commit(1)]));
    expect(r.status).toBe(202);
  });

  it("salta commit iniziale, provvisori e non di Rocket Sync; ripristino -> version.restored", async () => {
    const { db, state } = fakeDb();
    const init = commit(100, { message: "v0 — Creazione\n\nRocket-Sync-Version: 0\nRocket-Sync-Kind: init" });
    const pending = commit(101, { message: "v? — Bozza\n\nRocket-Sync-Version: pending\nRocket-Sync-Kind: publish" });
    const foreign = commit(102, { message: "Modifica manuale su GitHub" });
    const restore = commit(7, {
      message: "v7 — Ripristinata la versione 3\n\nRocket-Sync-Version: 7\nRocket-Sync-Kind: restore\nRocket-Sync-Restored-From: 3",
    });
    const res = await deliver({ secret: SECRET, db }, push([init, pending, foreign, restore]));
    expect(await jsonOf(res)).toMatchObject({ inserted: 1 });
    expect(state.versions[0]).toMatchObject({ number: 7, kind: "restore", restored_from: 3 });
    expect(state.events[0].type).toBe("version.restored");
    expect(state.events[0].payload.restoredFrom).toBe(3);
  });

  it("non perde l'autore quando manca il profilo (usa il login GitHub)", async () => {
    const { db, state } = fakeDb();
    const c = commit(9, { author: { name: "Esterno", email: "5+esterno@users.noreply.github.com" } });
    await deliver({ secret: SECRET, db }, push([c]));
    expect(state.versions[0]).toMatchObject({ author_id: null, author_github_login: "esterno" });
    expect(state.events[0].payload.authorName).toBe("esterno");
  });
});

describe("costruzione delle righe versions", () => {
  it("deduplica per sha e ordina per numero", () => {
    const rows = buildVersionRows(PROJECT, [commit(3), commit(1), commit(3)], () => null);
    expect(rows.map((r) => r.number)).toEqual([1, 3]);
  });
  it("ricava il login dall'email noreply", () => {
    expect(loginFromNoreply("12345+marco-r@users.noreply.github.com")).toBe("marco-r");
    expect(loginFromNoreply("marco@users.noreply.github.com")).toBe("marco");
    expect(loginFromNoreply("marco@example.com")).toBeNull();
    expect(commitAuthorLogin({ id: "x", message: "", committer: { username: "web-flow" } })).toBe("web-flow");
  });
});
