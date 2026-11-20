// Server finti per il test end-to-end delle Edge Functions: Supabase (Auth + PostgREST + RPC),
// API di GitHub (con verifica del JWT RS256 dell'app), OAuth di GitHub e Discord.

export interface Rec {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: any;
}

export interface Fakes {
  supabase: { url: string; reqs: Rec[]; state: SbState };
  github: { url: string; reqs: Rec[]; state: GhState };
  oauth: { url: string; reqs: Rec[]; state: { response: { status: number; body: unknown } } };
  discord: { url: string; reqs: Rec[]; state: { status: number; body?: unknown } };
  reset(): void;
  stop(): Promise<void>;
}

export interface SbState {
  users: Map<string, { id: string; email: string }>;
  profiles: any[];
  project_members: any[];
  projects: any[];
  project_invitations: any[];
  versions: any[];
  outbox: any[];
  webhooks: Map<string, string>;
  events: any[];
}

export interface GhState {
  users: Map<string, number>;
  orgMembers: Set<string>;
  failOn: string | null;
  installationToken: string;
}

export const SERVICE_KEY = "service-role-key-for-test";
export const APP_ID = "12345";
export const ORG = "rocket-org";
export const INSTALLATION_ID = "777";

const json = (status: number, body: unknown, extra: HeadersInit = {}) =>
  new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

async function record(req: Request, store: Rec[]): Promise<Rec> {
  const u = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  let body: any = undefined;
  const text = await req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const rec = { method: req.method, path: u.pathname, query: u.search, headers, body };
  store.push(rec);
  return rec;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Come farebbe GitHub: firma RS256, `iss` = id dell'app, `exp` nel futuro e non oltre 10 minuti. */
async function verifyAppJwt(token: string, publicKey: CryptoKey): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return "JWT malformato";
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  if (header.alg !== "RS256") return "alg diverso da RS256";
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return "firma non valida";
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== APP_ID) return "iss errato";
  if (!(claims.exp > now) || claims.exp - now > 600) return "exp non valido";
  if (!(claims.iat <= now)) return "iat nel futuro";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------------------------
function filterRows(rows: any[], params: URLSearchParams): any[] {
  let out = rows;
  for (const [key, value] of params) {
    if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(key)) continue;
    const m = /^(eq|ilike|in|neq)\.(.*)$/s.exec(value);
    if (!m) continue;
    const [, op, arg] = m as unknown as [string, string, string];
    out = out.filter((r) => {
      const v = r[key];
      if (op === "eq") return String(v) === arg;
      if (op === "neq") return String(v) !== arg;
      if (op === "ilike") return String(v).toLowerCase() === arg.toLowerCase();
      if (op === "in") return arg.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(v));
      return true;
    });
  }
  return out;
}

const dbError = (status: number, code: string, message: string) => json(status, { code, message, details: null, hint: null });

function newSbState(): SbState {
  return {
    users: new Map([
      ["jwt-simone", { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "simone@example.test" }],
      ["jwt-marco", { id: "bbbbbbbb-0000-4000-8000-000000000002", email: "marco@example.test" }],
      ["jwt-lucia", { id: "cccccccc-0000-4000-8000-000000000003", email: "lucia@example.test" }],
    ]),
    profiles: [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", github_login: "simone", github_id: 123, display_name: "Simone Rossi" },
      { id: "bbbbbbbb-0000-4000-8000-000000000002", github_login: "marco", github_id: 456, display_name: "Marco" },
      { id: "cccccccc-0000-4000-8000-000000000003", github_login: "lucia", github_id: 789, display_name: "Lucia" },
    ],
    project_members: [
      { project_id: "11111111-1111-4111-8111-111111111111", user_id: "aaaaaaaa-0000-4000-8000-000000000001", role: "admin" },
      { project_id: "11111111-1111-4111-8111-111111111111", user_id: "bbbbbbbb-0000-4000-8000-000000000002", role: "member" },
    ],
    projects: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Experimental Rocket",
        slug: "experimental-rocket",
        github_owner: ORG,
        github_repo: "experimental-rocket",
        github_repo_id: 4242,
        default_branch: "main",
        archived_at: null,
      },
    ],
    project_invitations: [],
    versions: [],
    outbox: [],
    webhooks: new Map(),
    events: [],
  };
}

function rpc(state: SbState, name: string, a: any): Response {
  switch (name) {
    case "create_project_record":
      state.projects.push({
        id: a.p_id,
        name: a.p_name,
        slug: a.p_slug,
        github_owner: a.p_github_owner,
        github_repo: a.p_github_repo,
        github_repo_id: a.p_github_repo_id,
        default_branch: a.p_default_branch,
        archived_at: null,
      });
      state.project_members.push({ project_id: a.p_id, user_id: a.p_created_by, role: "admin" });
      return json(200, a.p_id);
    case "emit_event_server":
      state.events.push(a);
      return json(200, state.events.length);
    case "set_discord_webhook":
      state.webhooks.set(a.p_project_id, a.p_url);
      return json(204, undefined);
    case "remove_discord_webhook":
      state.webhooks.delete(a.p_project_id);
      return json(204, undefined);
    case "get_discord_webhook":
      return json(200, state.webhooks.get(a.p_project_id) ?? null);
    case "claim_discord_outbox":
      return json(200, state.outbox.filter((r) => r.status === "pending"));
    case "mark_discord_sent":
      for (const r of state.outbox) if (a.p_ids.includes(r.id)) r.status = "sent";
      return json(204, undefined);
    case "mark_discord_failed":
      for (const r of state.outbox) {
        if (a.p_ids.includes(r.id)) Object.assign(r, { status: a.p_status, attempts: a.p_attempts, last_error: a.p_error });
      }
      return json(204, undefined);
    default:
      return dbError(404, "PGRST202", `funzione sconosciuta ${name}`);
  }
}

async function supabaseHandler(req: Request, state: SbState, reqs: Rec[]): Promise<Response> {
  const rec = await record(req, reqs);
  const u = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";

  if (u.pathname === "/auth/v1/user") {
    const token = auth.replace(/^Bearer\s+/i, "");
    const user = state.users.get(token);
    if (!user) return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    return json(200, { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
  }

  if (!u.pathname.startsWith("/rest/v1/")) return json(404, { message: "not found" });
  // Le Edge Functions usano la chiave service_role per PostgREST.
  if (auth !== `Bearer ${SERVICE_KEY}`) return dbError(401, "PGRST301", "JWT non valido");

  const target = u.pathname.slice("/rest/v1/".length);
  if (target.startsWith("rpc/")) return rpc(state, target.slice(4), rec.body ?? {});

  const table = (state as any)[target] as any[] | undefined;
  if (!Array.isArray(table)) return dbError(404, "42P01", `tabella ${target} sconosciuta`);
  const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
  const wantsRows = (req.headers.get("prefer") ?? "").includes("return=representation");

  if (req.method === "GET") {
    const rows = filterRows(table, u.searchParams);
    if (wantsObject) return rows.length === 1 ? json(200, rows[0]) : dbError(406, "PGRST116", "righe non uniche");
    return json(200, rows);
  }
  if (req.method === "POST") {
    const items = Array.isArray(rec.body) ? rec.body : [rec.body];
    for (const row of items) {
      if (target === "project_members" && table.some((r) => r.project_id === row.project_id && r.user_id === row.user_id)) {
        return dbError(409, "23505", "duplicate key (project_members)");
      }
      if (target === "versions" && table.some((r) => r.sha === row.sha || (r.project_id === row.project_id && r.number === row.number))) {
        return dbError(409, "23505", "duplicate key (versions)");
      }
      if (target === "project_invitations" && table.some((r) => r.project_id === row.project_id && r.github_login.toLowerCase() === row.github_login.toLowerCase() && r.status === "pending")) {
        return dbError(409, "23505", "duplicate key (project_invitations)");
      }
      table.push(target === "project_invitations" ? { id: `inv-${table.length + 1}`, status: "pending", ...row } : row);
    }
    return wantsRows ? json(201, items) : new Response(null, { status: 201 });
  }
  if (req.method === "PATCH") {
    const rows = filterRows(table, u.searchParams);
    for (const r of rows) {
      if (target === "project_members" && r.role === "admin" && rec.body.role === "member" && table.filter((x) => x.project_id === r.project_id && x.role === "admin").length <= 1) {
        return dbError(400, "23514", "Il progetto deve avere almeno un amministratore");
      }
      Object.assign(r, rec.body);
    }
    return wantsRows ? json(200, rows) : new Response(null, { status: 204 });
  }
  if (req.method === "DELETE") {
    const rows = filterRows(table, u.searchParams);
    for (const r of rows) {
      if (target === "project_members" && r.role === "admin" && table.filter((x) => x.project_id === r.project_id && x.role === "admin").length <= 1) {
        return dbError(400, "23514", "Il progetto deve avere almeno un amministratore");
      }
    }
    for (const r of rows) table.splice(table.indexOf(r), 1);
    return new Response(null, { status: 204 });
  }
  return json(405, { message: "metodo non gestito" });
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------
async function githubHandler(req: Request, state: GhState, reqs: Rec[], publicKey: CryptoKey): Promise<Response> {
  const rec = await record(req, reqs);
  const p = rec.path;
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (req.headers.get("x-github-api-version") !== "2022-11-28" || !req.headers.get("user-agent")) {
    return json(400, { message: "intestazioni mancanti (X-GitHub-Api-Version, User-Agent)" });
  }
  // Endpoint che richiedono il JWT dell'app.
  if (p === `/orgs/${ORG}/installation` || /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
    const err = await verifyAppJwt(auth, publicKey);
    if (err) return json(401, { message: `Bad credentials (${err})` });
    if (p.endsWith("/installation")) return json(200, { id: Number(INSTALLATION_ID) });
    if (!p.includes(`/${INSTALLATION_ID}/`)) return json(404, { message: "Not Found" });
    return json(201, { token: state.installationToken, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (auth !== state.installationToken) return json(401, { message: "Bad credentials (token di installazione)" });
  if (state.failOn && p.includes(state.failOn)) return json(500, { message: `errore simulato su ${state.failOn}` });

  let m: RegExpExecArray | null;
  if (req.method === "POST" && p === `/orgs/${ORG}/repos`) {
    const name = rec.body.name as string;
    if (name === "taken-name") return json(422, { message: "name already exists on this account" });
    return json(201, { id: 9001, name, full_name: `${ORG}/${name}`, default_branch: "main", private: rec.body.private });
  }
  if (req.method === "POST" && /\/git\/blobs$/.test(p)) return json(201, { sha: `blob${reqs.filter((r) => r.path.endsWith("/git/blobs")).length}` });
  if (req.method === "POST" && /\/git\/trees$/.test(p)) return json(201, { sha: "tree-sha" });
  if (req.method === "POST" && /\/git\/commits$/.test(p)) return json(201, { sha: "c".repeat(40) });
  if (req.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(p)) return json(200, { ref: "refs/heads/main" });
  if (req.method === "DELETE" && /^\/repos\/[^/]+\/[^/]+$/.test(p)) return new Response(null, { status: 204 });
  if ((m = /^\/users\/([^/]+)$/.exec(p)) && req.method === "GET") {
    const id = state.users.get(m[1]!.toLowerCase());
    return id ? json(200, { id, login: m[1] }) : json(404, { message: "Not Found" });
  }
  if ((m = /^\/orgs\/[^/]+\/memberships\/([^/]+)$/.exec(p))) {
    return state.orgMembers.has(m[1]!.toLowerCase()) ? json(200, { state: "active" }) : json(404, { message: "Not Found" });
  }
  if (req.method === "POST" && p === `/orgs/${ORG}/invitations`) return json(201, { id: 1 });
  if ((m = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)$/.exec(p))) {
    if (req.method === "PUT") return state.orgMembers.has(m[1]!.toLowerCase()) ? new Response(null, { status: 204 }) : json(201, { id: 55 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
  }
  if (req.method === "GET" && /\/invitations$/.test(p)) return json(200, [{ id: 7, invitee: { login: "lucia" } }]);
  if (req.method === "DELETE" && /\/invitations\/\d+$/.test(p)) return new Response(null, { status: 204 });
  return json(404, { message: `GitHub finto: nessuna regola per ${req.method} ${p}` });
}

// ---------------------------------------------------------------------------------------------
export async function startFakes(publicKey: CryptoKey): Promise<Fakes> {
  const sbState = newSbState();
  const sbReqs: Rec[] = [];
  const ghState: GhState = { users: new Map(), orgMembers: new Set(), failOn: null, installationToken: "ghs_fake_installation_token" };
  const ghReqs: Rec[] = [];
  const oauthReqs: Rec[] = [];
  const oauthState = { response: { status: 200, body: {} as unknown } };
  const dcReqs: Rec[] = [];
  const dcState: { status: number; body?: unknown } = { status: 204 };

  const resetGh = () => {
    ghState.users = new Map([["simone", 123], ["marco", 456], ["lucia", 789]]);
    ghState.orgMembers = new Set(["simone", "marco"]);
    ghState.failOn = null;
  };
  resetGh();

  const serve = (h: (r: Request) => Response | Promise<Response>) => {
    const s = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, h);
    return { s, url: `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}` };
  };
  const sb = serve((r) => supabaseHandler(r, sbState, sbReqs));
  const gh = serve((r) => githubHandler(r, ghState, ghReqs, publicKey));
  const oa = serve(async (r) => {
    await record(r, oauthReqs);
    return json(oauthState.response.status, oauthState.response.body);
  });
  const dc = serve(async (r) => {
    await record(r, dcReqs);
    return dcState.status === 204 ? new Response(null, { status: 204 }) : json(dcState.status, dcState.body ?? {});
  });

  const baseState = () => JSON.stringify({
    pm: sbState.project_members,
    pr: sbState.projects,
    inv: sbState.project_invitations,
  });
  const initial = baseState();

  return {
    supabase: { url: sb.url, reqs: sbReqs, state: sbState },
    github: { url: gh.url, reqs: ghReqs, state: ghState },
    oauth: { url: oa.url, reqs: oauthReqs, state: oauthState },
    discord: { url: dc.url, reqs: dcReqs, state: dcState },
    reset() {
      sbReqs.length = 0;
      ghReqs.length = 0;
      oauthReqs.length = 0;
      dcReqs.length = 0;
      const base = JSON.parse(initial);
      sbState.project_members.splice(0, sbState.project_members.length, ...base.pm);
      sbState.projects.splice(0, sbState.projects.length, ...base.pr);
      sbState.project_invitations.splice(0, sbState.project_invitations.length, ...base.inv);
      sbState.versions.length = 0;
      sbState.outbox.length = 0;
      sbState.webhooks.clear();
      sbState.events.length = 0;
      resetGh();
      oauthState.response = { status: 200, body: {} };
      dcState.status = 204;
      dcState.body = undefined;
    },
    async stop() {
      await Promise.all([sb.s.shutdown(), gh.s.shutdown(), oa.s.shutdown(), dc.s.shutdown()]);
    },
  };
}
