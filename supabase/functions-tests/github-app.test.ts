import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  GithubApp,
  GithubError,
  base64url,
  createAppJwt,
  importPrivateKey,
  refreshUserToken,
} from "../functions/_shared/github-app.ts";
import { HttpError } from "../functions/_shared/http.ts";
import { fakeFetch, type Rule } from "./helpers.ts";

const pair = (type: "pkcs8" | "pkcs1") =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type, format: "pem" },
  });

function pemToBytes(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

const decodeSegment = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("JWT dell'app (RS256 con Web Crypto)", () => {
  for (const type of ["pkcs8", "pkcs1"] as const) {
    it(`firma con una chiave ${type} e la firma si verifica con la chiave pubblica`, async () => {
      const { publicKey, privateKey } = pair(type);
      expect(privateKey).toContain(type === "pkcs1" ? "BEGIN RSA PRIVATE KEY" : "BEGIN PRIVATE KEY");
      const now = 1_800_000_000;
      const jwt = await createAppJwt("123456", privateKey, now);
      const [h, p, s] = jwt.split(".") as [string, string, string];
      expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeSegment(p)).toEqual({ iat: now - 60, exp: now + 540, iss: "123456" });
      const pub = await crypto.subtle.importKey(
        "spki",
        pemToBytes(publicKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
      expect(ok).toBe(true);
      // una modifica del payload invalida la firma
      const bad = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pub,
        Buffer.from(s, "base64url"),
        new TextEncoder().encode(`${h}.${base64url(JSON.stringify({ iss: "999" }))}`),
      );
      expect(bad).toBe(false);
    });
  }

  it("accetta una chiave con \\n letterali e rifiuta un PEM non valido", async () => {
    const { privateKey } = pair("pkcs8");
    await expect(importPrivateKey(privateKey)).resolves.toBeTruthy();
    await expect(importPrivateKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).rejects.toBeTruthy();
  });
});

function makeApp(rules: Rule[], opts: { now?: () => number } = {}) {
  const { privateKey } = pair("pkcs1");
  const f = fakeFetch(rules);
  const app = new GithubApp({ appId: "42", privateKey, org: "rocket-org", fetch: f.fetch, now: opts.now });
  return { app, calls: f.calls };
}

const tokenRules = (state = { n: 0 }): Rule[] => [
  { match: (c) => c.url.endsWith("/orgs/rocket-org/installation"), respond: () => ({ body: { id: 777 } }) },
  {
    match: (c) => c.url.endsWith("/app/installations/777/access_tokens"),
    respond: () => ({
      status: 201,
      body: { token: `ghs_token_${++state.n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
    }),
  },
];

describe("GithubApp", () => {
  it("ottiene l'installazione dell'organizzazione e riusa il token d'installazione", async () => {
    const { app, calls } = makeApp([
      ...tokenRules(),
      { match: (c) => c.url.endsWith("/users/simone"), respond: () => ({ body: { id: 9, login: "simone" } }) },
    ]);
    await app.getUser("simone");
    await app.getUser("simone");
    const tokenCalls = calls.filter((c) => c.url.includes("access_tokens"));
    expect(tokenCalls).toHaveLength(1);
    // il token d'installazione si ottiene con il JWT dell'app, le altre chiamate con il token
    expect(tokenCalls[0]!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const userCalls = calls.filter((c) => c.url.endsWith("/users/simone"));
    expect(userCalls[0]!.headers.authorization).toBe("Bearer ghs_token_1");
    expect(userCalls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(userCalls[0]!.headers["user-agent"]).toBeTruthy();
  });

  it("rinnova il token d'installazione quando sta per scadere", async () => {
    let now = Date.now();
    const state = { n: 0 };
    const { app, calls } = makeApp(
      [...tokenRules(state), { match: (c) => c.url.includes("/users/"), respond: () => ({ body: { id: 1, login: "x" } }) }],
      { now: () => now },
    );
    await app.getUser("x");
    now += 2 * 3600_000;
    await app.getUser("x");
    expect(calls.filter((c) => c.url.includes("access_tokens"))).toHaveLength(2);
  });

  it("crea il repository privato nell'organizzazione", async () => {
    const { app, calls } = makeApp([
      ...tokenRules(),
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/orgs/rocket-org/repos"),
        respond: () => ({ status: 201, body: { id: 5, name: "razzo", full_name: "rocket-org/razzo", default_branch: "main" } }),
      },
    ]);
    const repo = await app.createRepo("razzo", "Descrizione");
    expect(repo.full_name).toBe("rocket-org/razzo");
    const c = calls.find((x) => x.url.endsWith("/orgs/rocket-org/repos"))!;
    expect(c.body).toMatchObject({ name: "razzo", private: true });
  });

  it("scrive il commit iniziale con l'API Git Data: blob, albero, commit senza genitori, ref", async () => {
    let blob = 0;
    const { app, calls } = makeApp([
      ...tokenRules(),
      { match: (c) => c.url.endsWith("/git/blobs"), respond: () => ({ status: 201, body: { sha: `blob${++blob}` } }) },
      { match: (c) => c.url.endsWith("/git/trees"), respond: () => ({ status: 201, body: { sha: "tree1" } }) },
      { match: (c) => c.url.endsWith("/git/commits"), respond: () => ({ status: 201, body: { sha: "commit1" } }) },
      { match: (c) => c.method === "PATCH" && c.url.endsWith("/git/refs/heads/main"), respond: () => ({ body: {} }) },
    ]);
    const sha = await app.initialCommit(
      "rocket-org",
      "razzo",
      "main",
      [
        { path: ".gitattributes", content: "*.ork binary\n" },
        { path: ".rocketsync/project.json", content: "{}" },
      ],
      "v0 — Creazione\n\nRocket-Sync-Version: 0",
      { name: "Simone", email: "1+simone@users.noreply.github.com" },
      new Date("2026-11-18T10:00:00Z"),
    );
    expect(sha).toBe("commit1");
    const seq = calls.filter((c) => c.url.includes("/git/")).map((c) => `${c.method} ${c.url.split("/git/")[1]}`);
    expect(seq).toEqual(["POST blobs", "POST blobs", "POST trees", "POST commits", "PATCH refs/heads/main"]);
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!.body.tree;
    expect(tree).toEqual([
      { path: ".gitattributes", mode: "100644", type: "blob", sha: "blob1" },
      { path: ".rocketsync/project.json", mode: "100644", type: "blob", sha: "blob2" },
    ]);
    const commit = calls.find((c) => c.url.endsWith("/git/commits"))!.body;
    expect(commit).toMatchObject({ tree: "tree1", parents: [], message: expect.stringContaining("Rocket-Sync-Version") });
    expect(commit.author).toEqual({ name: "Simone", email: "1+simone@users.noreply.github.com", date: "2026-11-18T10:00:00.000Z" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ sha: "commit1", force: true });
  });

  it("concede l'accesso: invito all'organizzazione se non è membro, poi collaboratore con permesso push", async () => {
    const { app, calls } = makeApp([
      ...tokenRules(),
      { match: (c) => c.url.endsWith("/users/lucia"), respond: () => ({ body: { id: 31, login: "lucia" } }) },
      { match: (c) => c.url.includes("/memberships/lucia"), respond: () => ({ status: 404, body: { message: "Not Found" } }) },
      { match: (c) => c.url.endsWith("/orgs/rocket-org/invitations"), respond: () => ({ status: 201, body: { id: 1 } }) },
      {
        match: (c) => c.method === "PUT" && c.url.endsWith("/repos/rocket-org/razzo/collaborators/lucia"),
        respond: () => ({ status: 201, body: { id: 99 } }),
      },
    ]);
    const r = await app.grantAccess("rocket-org", "razzo", "lucia");
    expect(r).toEqual({ orgInvited: true, repoAccess: "invited" });
    expect(calls.find((c) => c.url.endsWith("/orgs/rocket-org/invitations"))!.body).toEqual({ invitee_id: 31, role: "direct_member" });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ permission: "push" });
  });

  it("un membro dell'organizzazione non viene invitato di nuovo; utente inesistente = errore chiaro", async () => {
    const { app, calls } = makeApp([
      ...tokenRules(),
      { match: (c) => c.url.endsWith("/users/marco"), respond: () => ({ body: { id: 2, login: "marco" } }) },
      { match: (c) => c.url.includes("/memberships/marco"), respond: () => ({ body: { state: "active" } }) },
      { match: (c) => c.method === "PUT", respond: () => ({ status: 204 }) },
      { match: (c) => c.url.endsWith("/users/nessuno"), respond: () => ({ status: 404, body: { message: "Not Found" } }) },
    ]);
    expect(await app.grantAccess("rocket-org", "razzo", "marco")).toEqual({ orgInvited: false, repoAccess: "granted" });
    expect(calls.some((c) => c.url.endsWith("/invitations"))).toBe(false);
    await expect(app.grantAccess("rocket-org", "razzo", "nessuno")).rejects.toMatchObject({ status: 404, code: "github_user_not_found" });
  });

  it("revoca l'accesso: collaboratore e invito in sospeso", async () => {
    const { app, calls } = makeApp([
      ...tokenRules(),
      { match: (c) => c.method === "DELETE" && c.url.endsWith("/collaborators/lucia"), respond: () => ({ status: 204 }) },
      { match: (c) => c.method === "GET" && c.url.includes("/invitations"), respond: () => ({ body: [{ id: 7, invitee: { login: "Lucia" } }, { id: 8, invitee: { login: "altro" } }] }) },
      { match: (c) => c.method === "DELETE" && c.url.endsWith("/invitations/7"), respond: () => ({ status: 204 }) },
    ]);
    await app.revokeAccess("rocket-org", "razzo", "lucia");
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/repos/rocket-org/razzo")[1]);
    expect(deleted).toEqual(["/collaborators/lucia", "/invitations/7"]);
  });

  it("gli errori di GitHub diventano GithubError con stato e messaggio, senza token", async () => {
    const { app } = makeApp([
      ...tokenRules(),
      { match: (c) => c.url.endsWith("/orgs/rocket-org/repos"), respond: () => ({ status: 422, body: { message: "name already exists on this account" } }) },
    ]);
    const err = await app.createRepo("x", "").catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("name already exists");
    expect(err.message).not.toContain("ghs_");
  });
});

describe("rinnovo del token utente", () => {
  it("scambia il refresh token usando il client secret (solo lato server)", async () => {
    const f = fakeFetch([
      {
        match: (c) => c.url === "https://github.com/login/oauth/access_token",
        respond: () => ({ body: { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800, refresh_token_expires_in: 15811200 } }),
      },
    ]);
    const t = await refreshUserToken({ clientId: "Iv1.abc", clientSecret: "s3cret", refreshToken: "ghr_old", fetch: f.fetch, now: () => Date.UTC(2026, 10, 18, 0, 0, 0) });
    expect(f.calls[0]!.body).toEqual({ client_id: "Iv1.abc", client_secret: "s3cret", grant_type: "refresh_token", refresh_token: "ghr_old" });
    expect(t).toEqual({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: "2026-11-18T08:00:00.000Z",
      refreshTokenExpiresAt: "2027-05-20T00:00:00.000Z",
    });
  });

  it("token di rinnovo non valido -> 401; altri errori -> 502; nessun segreto nel messaggio", async () => {
    const bad = fakeFetch([{ match: () => true, respond: () => ({ body: { error: "bad_refresh_token" } }) }]);
    await expect(refreshUserToken({ clientId: "a", clientSecret: "b", refreshToken: "c", fetch: bad.fetch })).rejects.toMatchObject({ status: 401, code: "bad_refresh_token" });
    const boom = fakeFetch([{ match: () => true, respond: () => ({ status: 500, body: {} }) }]);
    const e = await refreshUserToken({ clientId: "a", clientSecret: "TOPSECRET", refreshToken: "c", fetch: boom.fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(502);
    expect(e.message).not.toContain("TOPSECRET");
  });
});
