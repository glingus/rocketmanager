// Prova end-to-end delle 7 Edge Functions su Deno VERO: ogni funzione parte come processo separato
// (come nel runtime di Supabase, con Deno.serve) e riceve richieste HTTP vere; Supabase, GitHub,
// OAuth di GitHub e Discord sono sostituiti da server finti locali che registrano le chiamate.
//
//   deno run --allow-net --allow-env --allow-run supabase/functions-e2e/run.ts
import assert from "node:assert/strict";
import { APP_ID, ORG, SERVICE_KEY, startFakes, type Fakes, type Rec } from "./fakes.ts";

const here = new URL(".", import.meta.url);
const fnDir = new URL("../functions/", here);
const toPath = (u: URL) => decodeURIComponent(u.pathname);

// ---- chiavi e segreti di prova --------------------------------------------------------------------
const kp = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
const WEBHOOK_SECRET = "segreto-webhook-di-prova";
const fakes = await startFakes(kp.publicKey);

// ---- avvio dei processi ----------------------------------------------------------------------------
const NAMES = [
  "create-project", "manage-members", "accept-invitations", "github-webhook",
  "discord-settings", "discord-dispatch", "github-token-refresh",
] as const;
type Name = (typeof NAMES)[number];

async function freePort(): Promise<number> {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

const procs: Deno.ChildProcess[] = [];
const urls = {} as Record<Name, string>;
const logs: Record<string, string[]> = {};

const env = {
  SUPABASE_URL: fakes.supabase.url,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  GITHUB_APP_ID: APP_ID,
  GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"), // come nei segreti reali: a-capo scritti \n
  GITHUB_ORG: ORG,
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  GITHUB_APP_CLIENT_ID: "Iv1.clientid",
  GITHUB_APP_CLIENT_SECRET: "client-secret-di-prova",
  E2E_FETCH_REDIRECTS: JSON.stringify({
    "https://api.github.com": fakes.github.url,
    "https://github.com": fakes.oauth.url,
    "https://discord.com": fakes.discord.url,
  }),
};

for (const name of NAMES) {
  const port = await freePort();
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--no-prompt", "--allow-net", "--allow-env",
      `--config=${toPath(new URL("deno.json", fnDir))}`,
      `--preload=${toPath(new URL("preload-redirect.ts", here))}`,
      toPath(new URL(`${name}/index.ts`, fnDir)),
    ],
    env: { ...env, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
    clearEnv: false,
  });
  const p = cmd.spawn();
  procs.push(p);
  logs[name] = [];
  for (const s of [p.stdout, p.stderr]) {
    s.pipeTo(new WritableStream({ write(c) { logs[name]!.push(new TextDecoder().decode(c)); } })).catch(() => {});
  }
  urls[name] = `http://127.0.0.1:${port}`;
}

// attende che tutte rispondano
for (const name of NAMES) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await fetch(urls[name], { method: "OPTIONS" });
      await r.body?.cancel();
      break;
    } catch {
      if (Date.now() > deadline) {
        console.error(`La funzione ${name} non è partita:\n${logs[name]!.join("")}`);
        Deno.exit(2);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// ---- mini framework -----------------------------------------------------------------------------------
const results: { name: string; ok: boolean; err?: string }[] = [];
async function test(name: string, fn: () => Promise<void>) {
  fakes.reset();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok - ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e instanceof Error ? e.stack ?? e.message : String(e) });
    console.log(`not ok - ${name}\n${(e instanceof Error ? e.message : String(e)).split("\n").map((l) => "    " + l).join("\n")}`);
  }
}

async function call(name: Name, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const res = await fetch(urls[name], {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch { /* non JSON */ }
  return { status: res.status, text, json };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const P = "11111111-1111-4111-8111-111111111111";
const rpcs = (name: string) => fakes.supabase.reqs.filter((r) => r.path === `/rest/v1/rpc/${name}`);
const restWrites = (table: string) => fakes.supabase.reqs.filter((r) => r.path === `/rest/v1/${table}` && r.method !== "GET");
const ghCalls = (re: RegExp, method?: string): Rec[] => fakes.github.reqs.filter((r) => re.test(r.path) && (!method || r.method === method));

async function hmac(secret: string, body: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ====================================================================================================
// github-webhook
// ====================================================================================================
const sha = (n: number) => n.toString(16).padStart(40, "0");
const pushBody = (ref = "refs/heads/main") =>
  JSON.stringify({
    ref,
    repository: { id: 4242, full_name: `${ORG}/experimental-rocket` },
    commits: [
      {
        id: sha(5),
        message: "v5 — Aggiornate pinne e paracadute\n\nRazzo.ork\n• Pinne trapezoidali: numero 3 → 4\n\nRocket-Sync-Version: 5\nRocket-Sync-Kind: publish\nRocket-Sync-Client: 0.1.0",
        timestamp: "2026-11-18T14:22:10+00:00",
        author: { name: "Simone Rossi", email: "123+simone@users.noreply.github.com", username: "simone" },
        modified: ["Razzo.ork"],
      },
      { id: sha(6), message: "v? — Bozza\n\nRocket-Sync-Version: pending\nRocket-Sync-Kind: publish", author: { username: "simone" } },
    ],
  });

async function deliver(body: string, opts: { secret?: string; event?: string; signature?: string | null } = {}) {
  const headers: Record<string, string> = { "x-github-event": opts.event ?? "push" };
  const sig = opts.signature === undefined ? await hmac(opts.secret ?? WEBHOOK_SECRET, body) : opts.signature;
  if (sig) headers["x-hub-signature-256"] = sig;
  return await call("github-webhook", body, headers);
}

await test("github-webhook: push firmato su main -> versione registrata ed evento version.published", async () => {
  const r = await deliver(pushBody());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ok: r.json.ok, inserted: r.json.inserted }, { ok: true, inserted: 1 });
  const w = restWrites("versions");
  assert.equal(w.length, 1, "una sola versione (la provvisoria è saltata)");
  assert.equal(w[0]!.headers.authorization, `Bearer ${SERVICE_KEY}`);
  assert.equal(w[0]!.body.number, 5);
  assert.equal(w[0]!.body.sha, sha(5));
  assert.equal(w[0]!.body.author_id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(w[0]!.body.title, "Aggiornate pinne e paracadute");
  assert.deepEqual(w[0]!.body.files, [{ path: "Razzo.ork", change: "modified" }]);
  const ev = rpcs("emit_event_server");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.body.p_type, "version.published");
  assert.equal(ev[0]!.body.p_project_id, P);
  assert.equal(ev[0]!.body.p_actor_id, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(ev[0]!.body.p_payload.number, 5);
  assert.equal(ev[0]!.body.p_payload.authorName, "Simone Rossi");
});

await test("github-webhook: firma sbagliata, assente o corpo alterato -> 401 e nessuna scrittura", async () => {
  const body = pushBody();
  for (const opts of [{ secret: "sbagliato" }, { signature: null }, { signature: "sha256=" + "0".repeat(64) }, { signature: "sha1=abc" }] as const) {
    const r = await deliver(body, opts);
    assert.equal(r.status, 401, JSON.stringify(opts));
    assert.equal(r.json.error.code, "bad_signature");
  }
  const sig = await hmac(WEBHOOK_SECRET, body);
  const tampered = await call("github-webhook", body.replace("main", "mein"), { "x-github-event": "push", "x-hub-signature-256": sig });
  assert.equal(tampered.status, 401);
  assert.equal(fakes.supabase.reqs.length, 0, "nessuna chiamata a Supabase prima della verifica");
});

await test("github-webhook: ping, altri eventi, altri rami, repository sconosciuto, doppia consegna", async () => {
  assert.equal((await deliver("{}", { event: "ping" })).status, 200);
  assert.equal((await deliver("{}", { event: "issues" })).status, 202);
  const other = await deliver(pushBody("refs/heads/conflitti/20261101-abc123"));
  assert.equal(other.status, 202);
  assert.equal(restWrites("versions").length, 0);
  const unknown = await deliver(pushBody().replace("4242", "999").replace("experimental-rocket", "altro"));
  assert.equal(unknown.status, 202);
  // doppia consegna: la seconda trova lo sha già presente (23505) e non emette un secondo evento
  assert.equal((await deliver(pushBody())).json.inserted, 1);
  const again = await deliver(pushBody());
  assert.equal(again.status, 200);
  assert.equal(again.json.inserted, 0);
  assert.equal(rpcs("emit_event_server").length, 1);
  const get = await call("github-webhook", "", {}, "GET");
  assert.equal(get.status, 405);
});

// ====================================================================================================
// create-project
// ====================================================================================================
await test("create-project: repo, commit iniziale, accesso e record; JWT dell'app valido per GitHub", async () => {
  const r = await call("create-project", { name: "Razzo Nuovo", description: "Prova" }, bearer("jwt-simone"));
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.slug, "razzo-nuovo");
  assert.equal(r.json.repoFullName, `${ORG}/razzo-nuovo`);
  assert.match(r.json.projectId, /^[0-9a-f-]{36}$/);
  const seq = fakes.github.reqs.map((x) => `${x.method} ${x.path.replace(/blob\d+/, "blob")}`);
  assert.deepEqual(seq.filter((s) => !s.startsWith("GET /users") && !s.includes("memberships")), [
    `GET /orgs/${ORG}/installation`,
    `POST /app/installations/777/access_tokens`,
    `POST /orgs/${ORG}/repos`,
    `POST /repos/${ORG}/razzo-nuovo/git/blobs`,
    `POST /repos/${ORG}/razzo-nuovo/git/blobs`,
    `POST /repos/${ORG}/razzo-nuovo/git/blobs`,
    `POST /repos/${ORG}/razzo-nuovo/git/trees`,
    `POST /repos/${ORG}/razzo-nuovo/git/commits`,
    `PATCH /repos/${ORG}/razzo-nuovo/git/refs/heads/main`,
    `PUT /repos/${ORG}/razzo-nuovo/collaborators/simone`,
  ]);
  const repo = ghCalls(/\/repos$/, "POST")[0]!;
  assert.equal(repo.body.private, true);
  assert.equal(repo.body.name, "razzo-nuovo");
  const commit = ghCalls(/git\/commits$/)[0]!;
  assert.deepEqual(commit.body.parents, []);
  assert.match(commit.body.message, /^v0 — Creazione del progetto\n\nRocket-Sync-Version: 0\nRocket-Sync-Kind: init/);
  assert.equal(commit.body.author.email, "123+simone@users.noreply.github.com");
  const blobs = ghCalls(/git\/blobs$/).map((b) => b.body.content as string);
  const projectJson = JSON.parse(blobs.find((b) => b.includes("projectId"))!);
  assert.equal(projectJson.projectId, r.json.projectId);
  assert.ok(blobs.some((b) => b.includes("*.ork-bak")), ".gitignore con *.ork-bak");
  assert.ok(blobs.some((b) => b === "*.ork binary\n* -text\n"), ".gitattributes");
  assert.equal(ghCalls(/git\/refs/, "PATCH")[0]!.body.force, true);
  const rec = rpcs("create_project_record");
  assert.equal(rec.length, 1);
  assert.deepEqual(
    { n: rec[0]!.body.p_name, s: rec[0]!.body.p_slug, o: rec[0]!.body.p_github_owner, id: rec[0]!.body.p_github_repo_id, by: rec[0]!.body.p_created_by, pid: rec[0]!.body.p_id },
    { n: "Razzo Nuovo", s: "razzo-nuovo", o: ORG, id: 9001, by: "aaaaaaaa-0000-4000-8000-000000000001", pid: r.json.projectId },
  );
  assert.equal(ghCalls(/./, "DELETE").length, 0, "nessun rollback in caso di successo");
});

await test("create-project: senza o con JWT non valido -> 401, nessuna chiamata a GitHub", async () => {
  assert.equal((await call("create-project", { name: "X" })).status, 401);
  assert.equal((await call("create-project", { name: "X" }, bearer("jwt-falso"))).status, 401);
  assert.equal((await call("create-project", {}, bearer("jwt-simone"))).status, 400);
  assert.equal((await call("create-project", "non json", bearer("jwt-simone"))).status, 400);
  assert.equal(fakes.github.reqs.length, 0);
  const pre = await fetch(urls["create-project"], { method: "OPTIONS" });
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  await pre.body?.cancel();
});

await test("create-project: errore di GitHub a metà -> 502 e il repository creato viene eliminato", async () => {
  fakes.github.state.failOn = "/git/commits";
  const r = await call("create-project", { name: "Razzo Rotto" }, bearer("jwt-simone"));
  assert.equal(r.status, 502, r.text);
  assert.equal(r.json.error.code, "github_error");
  assert.equal(ghCalls(/^\/repos\/[^/]+\/razzo-rotto$/, "DELETE").length, 1, "rollback: repository eliminato");
  assert.equal(rpcs("create_project_record").length, 0);
  assert.ok(!r.text.includes("ghs_"), "nessun token nella risposta");
});

// ====================================================================================================
// manage-members
// ====================================================================================================
await test("manage-members: un member viene rifiutato (403) senza toccare GitHub né il database", async () => {
  for (const body of [
    { projectId: P, action: "add", login: "lucia" },
    { projectId: P, action: "remove", login: "marco" },
    { projectId: P, action: "set_role", login: "marco", role: "admin" },
  ]) {
    const r = await call("manage-members", body, bearer("jwt-marco"));
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.code, "admin_required");
  }
  assert.equal(fakes.github.reqs.length, 0);
  assert.equal(fakes.supabase.reqs.filter((x) => x.method !== "GET").length, 0);
  // un estraneo (non membro) e nessun token
  assert.equal((await call("manage-members", { projectId: P, action: "add", login: "x" }, bearer("jwt-lucia"))).json.error.code, "not_a_member");
  assert.equal((await call("manage-members", { projectId: P, action: "add", login: "x" })).status, 401);
  assert.equal((await call("manage-members", { projectId: "no", action: "add", login: "x" }, bearer("jwt-simone"))).status, 400);
  assert.equal((await call("manage-members", { projectId: P, action: "boh" }, bearer("jwt-simone"))).status, 400);
});

await test("manage-members: l'admin aggiunge un utente registrato (accesso GitHub, riga, evento member.added)", async () => {
  const r = await call("manage-members", { projectId: P, action: "add", login: "lucia", role: "member" }, bearer("jwt-simone"));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "member");
  assert.equal(r.json.github.orgInvited, true);
  assert.equal(ghCalls(/\/invitations$/, "POST")[0]!.body.invitee_id, 789);
  assert.equal(ghCalls(/collaborators\/lucia$/, "PUT")[0]!.body.permission, "push");
  const ins = restWrites("project_members")[0]!;
  assert.deepEqual({ ...ins.body }, { project_id: P, user_id: "cccccccc-0000-4000-8000-000000000003", role: "member", added_by: "aaaaaaaa-0000-4000-8000-000000000001" });
  const ev = rpcs("emit_event_server")[0]!.body;
  assert.equal(ev.p_type, "member.added");
  assert.equal(ev.p_payload.targetName, "Lucia");
  assert.equal(ev.p_actor_id, "aaaaaaaa-0000-4000-8000-000000000001");
});

await test("manage-members: login sconosciuto -> invito in sospeso; ultimo admin protetto (409)", async () => {
  fakes.github.state.users.set("nuova-persona", 4000);
  const inv = await call("manage-members", { projectId: P, action: "add", login: "nuova-persona", role: "member" }, bearer("jwt-simone"));
  assert.equal(inv.status, 200, inv.text);
  assert.equal(inv.json.status, "invited");
  assert.equal(restWrites("project_invitations")[0]!.body.github_login, "nuova-persona");
  const dup = await call("manage-members", { projectId: P, action: "add", login: "nuova-persona" }, bearer("jwt-simone"));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "already_invited");
  const last = await call("manage-members", { projectId: P, action: "remove", userId: "aaaaaaaa-0000-4000-8000-000000000001" }, bearer("jwt-simone"));
  assert.equal(last.status, 409, last.text);
  assert.equal(last.json.error.code, "last_admin");
  const demote = await call("manage-members", { projectId: P, action: "set_role", userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "member" }, bearer("jwt-simone"));
  assert.equal(demote.json.error.code, "last_admin");
  const nope = await call("manage-members", { projectId: P, action: "add", login: "inesistente" }, bearer("jwt-simone"));
  assert.equal(nope.status, 404);
  assert.equal(nope.json.error.code, "github_user_not_found");
});

await test("manage-members: set_role e remove registrano gli eventi e tolgono l'accesso a GitHub", async () => {
  const sr = await call("manage-members", { projectId: P, action: "set_role", userId: "bbbbbbbb-0000-4000-8000-000000000002", role: "admin" }, bearer("jwt-simone"));
  assert.equal(sr.json.status, "role_changed");
  assert.equal(fakes.supabase.state.project_members.find((m) => m.user_id === "bbbbbbbb-0000-4000-8000-000000000002")!.role, "admin");
  assert.equal(rpcs("emit_event_server").at(-1)!.body.p_type, "member.role_changed");
  const rm = await call("manage-members", { projectId: P, action: "remove", login: "marco" }, bearer("jwt-simone"));
  assert.equal(rm.status, 200, rm.text);
  assert.equal(ghCalls(/collaborators\/marco$/, "DELETE").length, 1);
  assert.equal(rpcs("emit_event_server").at(-1)!.body.p_type, "member.removed");
  assert.ok(!fakes.supabase.state.project_members.some((m) => m.user_id === "bbbbbbbb-0000-4000-8000-000000000002"));
});

// ====================================================================================================
// accept-invitations
// ====================================================================================================
await test("accept-invitations: gli inviti in sospeso per il proprio login diventano membership", async () => {
  fakes.supabase.state.project_invitations.push({ id: "inv-9", project_id: P, github_login: "Lucia", role: "member", invited_by: "aaaaaaaa-0000-4000-8000-000000000001", status: "pending" });
  const r = await call("accept-invitations", {}, bearer("jwt-lucia"));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.accepted, [{ projectId: P, role: "member" }]);
  assert.ok(fakes.supabase.state.project_members.some((m) => m.user_id === "cccccccc-0000-4000-8000-000000000003" && m.project_id === P));
  assert.equal(fakes.supabase.state.project_invitations[0].status, "accepted");
  assert.equal(rpcs("emit_event_server")[0]!.body.p_type, "member.added");
  const again = await call("accept-invitations", {}, bearer("jwt-lucia"));
  assert.deepEqual(again.json.accepted, []);
  assert.equal((await call("accept-invitations", {})).status, 401);
});

// ====================================================================================================
// discord-settings
// ====================================================================================================
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF0123456789";

await test("discord-settings: member rifiutato; admin salva il webhook, invia la prova e non riceve mai l'URL", async () => {
  const denied = await call("discord-settings", { projectId: P, action: "set", webhookUrl: HOOK }, bearer("jwt-marco"));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "admin_required");
  assert.equal(rpcs("set_discord_webhook").length, 0);
  assert.ok(!denied.text.includes("discord.com"));

  const bad = await call("discord-settings", { projectId: P, action: "set", webhookUrl: "https://evil.example/api/webhooks/1/x" }, bearer("jwt-simone"));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_webhook");

  const ok = await call("discord-settings", { projectId: P, action: "set", webhookUrl: HOOK, sendTest: true }, bearer("jwt-simone"));
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { webhookConfigured: true, testSent: true });
  assert.ok(!ok.text.includes("discord.com") && !ok.text.includes("abcdefgh"), "l'URL non viene mai restituito");
  assert.equal(rpcs("set_discord_webhook")[0]!.body.p_url, HOOK);
  assert.equal(fakes.discord.reqs.length, 1);
  assert.equal(fakes.discord.reqs[0]!.path, "/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF0123456789");
  assert.match(fakes.discord.reqs[0]!.body.content, /Messaggio di prova/);
  assert.deepEqual(fakes.discord.reqs[0]!.body.allowed_mentions, { parse: [] });

  const test2 = await call("discord-settings", { projectId: P, action: "test" }, bearer("jwt-simone"));
  assert.equal(test2.status, 200);
  assert.equal(fakes.discord.reqs.length, 2);
  fakes.discord.state.status = 404;
  const failed = await call("discord-settings", { projectId: P, action: "test" }, bearer("jwt-simone"));
  assert.equal(failed.status, 502);
  assert.ok(!failed.text.includes("discord.com"));
  const rm = await call("discord-settings", { projectId: P, action: "remove" }, bearer("jwt-simone"));
  assert.deepEqual(rm.json, { webhookConfigured: false });
  const none = await call("discord-settings", { projectId: P, action: "test" }, bearer("jwt-simone"));
  assert.equal(none.status, 409);
});

// ====================================================================================================
// discord-dispatch
// ====================================================================================================
const outboxRows = () => [
  { id: 1, project_id: P, summary: "Simone ha pubblicato la versione 5 di Experimental Rocket", payload: { number: 5, title: "Aggiornate pinne e paracadute", changelog: [{ path: "Razzo.ork", lines: ["a", "b", "c"], interpreted: true }] }, attempts: 0, created_at: "2026-11-18T14:22:10Z", status: "pending" },
  { id: 2, project_id: P, summary: "Marco ha segnalato «Foro sbagliato» (priorità critica)", payload: {}, attempts: 0, created_at: "2026-11-18T14:23:00Z", status: "pending" },
];

await test("discord-dispatch: senza Bearer o con Bearer sbagliato -> 401 e nessun accesso ai dati", async () => {
  for (const h of [{}, bearer("sbagliato"), bearer(SERVICE_KEY + "x"), bearer("jwt-simone")]) {
    const r = await call("discord-dispatch", {}, h);
    assert.equal(r.status, 401, JSON.stringify(h));
    assert.equal(r.json.error.code, "unauthorized");
  }
  assert.equal(rpcs("claim_discord_outbox").length, 0);
  assert.equal(fakes.discord.reqs.length, 0);
});

await test("discord-dispatch: con la chiave giusta raggruppa (2 minuti), formatta con l'ora di Roma e segna inviato", async () => {
  fakes.supabase.state.outbox.push(...outboxRows());
  fakes.supabase.state.webhooks.set(P, HOOK);
  const r = await call("discord-dispatch", {}, bearer(SERVICE_KEY));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { groups: 1, sent: 2, retried: 0, failed: 0 });
  assert.equal(fakes.discord.reqs.length, 1, "un solo messaggio per il gruppo");
  assert.equal(
    fakes.discord.reqs[0]!.body.content,
    [
      "15:22 — Simone ha pubblicato la versione 5 di Experimental Rocket",
      "> Aggiornate pinne e paracadute",
      "> Razzo.ork: 3 componenti modificati",
      "",
      "15:23 — Marco ha segnalato «Foro sbagliato» (priorità critica)",
    ].join("\n"),
  );
  assert.deepEqual(rpcs("mark_discord_sent")[0]!.body.p_ids, [1, 2]);
  assert.ok(fakes.supabase.state.outbox.every((o) => o.status === "sent"));
});

await test("discord-dispatch: Discord risponde 500 -> tentativo registrato, resta in coda, errore senza URL", async () => {
  fakes.supabase.state.outbox.push(outboxRows()[0]!);
  fakes.supabase.state.webhooks.set(P, HOOK);
  fakes.discord.state.status = 500;
  const r = await call("discord-dispatch", {}, bearer(SERVICE_KEY));
  assert.deepEqual(r.json, { groups: 1, sent: 0, retried: 1, failed: 0 });
  const f = rpcs("mark_discord_failed")[0]!.body;
  assert.equal(f.p_attempts, 1);
  assert.equal(f.p_status, "pending");
  assert.equal(f.p_error, "Discord ha risposto 500");
  const wait = Date.parse(f.p_next_attempt_at) - Date.now();
  assert.ok(wait > 50_000 && wait <= 61_000, `attesa di circa 1 minuto (${wait} ms)`);
  assert.ok(!JSON.stringify(f).includes("discord.com"));
});

await test("discord-dispatch: nessun webhook configurato -> failed senza chiamate di rete", async () => {
  fakes.supabase.state.outbox.push(outboxRows()[0]!);
  const r = await call("discord-dispatch", {}, bearer(SERVICE_KEY));
  assert.deepEqual(r.json, { groups: 1, sent: 0, retried: 0, failed: 1 });
  assert.equal(rpcs("mark_discord_failed")[0]!.body.p_status, "failed");
  assert.equal(fakes.discord.reqs.length, 0);
});

// ====================================================================================================
// github-token-refresh
// ====================================================================================================
await test("github-token-refresh: scambia il refresh token con il client secret (solo lato server)", async () => {
  fakes.oauth.state.response = { status: 200, body: { access_token: "ghu_nuovo", refresh_token: "ghr_nuovo", expires_in: 28800, refresh_token_expires_in: 15811200 } };
  const r = await call("github-token-refresh", { refreshToken: "ghr_vecchio" }, bearer("jwt-simone"));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.accessToken, "ghu_nuovo");
  assert.equal(r.json.refreshToken, "ghr_nuovo");
  assert.ok(Date.parse(r.json.expiresAt) > Date.now());
  assert.ok(!r.text.includes("client-secret-di-prova"), "il client secret non esce dal server");
  const o = fakes.oauth.reqs[0]!;
  assert.equal(o.path, "/login/oauth/access_token");
  assert.deepEqual(o.body, { client_id: "Iv1.clientid", client_secret: "client-secret-di-prova", grant_type: "refresh_token", refresh_token: "ghr_vecchio" });
});

await test("github-token-refresh: senza sessione 401; refresh token non valido 401; errore GitHub 502", async () => {
  assert.equal((await call("github-token-refresh", { refreshToken: "x" })).status, 401);
  assert.equal(fakes.oauth.reqs.length, 0);
  assert.equal((await call("github-token-refresh", {}, bearer("jwt-simone"))).status, 400);
  fakes.oauth.state.response = { status: 200, body: { error: "bad_refresh_token" } };
  const bad = await call("github-token-refresh", { refreshToken: "x" }, bearer("jwt-simone"));
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "bad_refresh_token");
  fakes.oauth.state.response = { status: 500, body: {} };
  const boom = await call("github-token-refresh", { refreshToken: "x" }, bearer("jwt-simone"));
  assert.equal(boom.status, 502);
  assert.ok(!boom.text.includes("client-secret-di-prova"));
});

// ====================================================================================================
const failed = results.filter((r) => !r.ok);
console.log(`\n# ${results.length - failed.length}/${results.length} scenari superati`);
for (const p of procs) {
  try { p.kill("SIGTERM"); } catch { /* già terminato */ }
}
await Promise.all(procs.map((p) => p.status.catch(() => {})));
await fakes.stop();
if (failed.length) {
  for (const n of NAMES) {
    const l = logs[n]!.join("");
    if (l.trim()) console.error(`\n--- log di ${n} ---\n${l}`);
  }
  Deno.exit(1);
}
