import { describe, expect, it } from "vitest";
import { bearerToken, requireProjectRole, requireServiceRole, requireUser, timingSafeEqual } from "../functions/_shared/auth.ts";
import { HttpError, githubLogin, handle, json, readJson, str, uuid } from "../functions/_shared/http.ts";
import { required, githubAppEnv, supabaseEnv } from "../functions/_shared/env.ts";
import { asUser, jsonOf, req } from "./helpers.ts";

describe("autenticazione", () => {
  it("estrae il Bearer token", () => {
    expect(bearerToken(req({}, { authorization: "Bearer abc.def" }))).toBe("abc.def");
    expect(bearerToken(req({}, { authorization: "bearer x" }))).toBe("x");
    expect(bearerToken(req({}, { authorization: "Basic abc" }))).toBeNull();
    expect(bearerToken(req({}))).toBeNull();
  });
  it("requireUser: 401 senza token o con token non valido", async () => {
    const deps = { getUserId: async (t: string) => (t === "buono" ? "u1" : null) };
    await expect(requireUser(req({}), deps)).rejects.toMatchObject({ status: 401 });
    await expect(requireUser(req({}, asUser("cattivo")), deps)).rejects.toMatchObject({ status: 401 });
    expect(await requireUser(req({}, asUser("buono")), deps)).toBe("u1");
  });
  it("requireProjectRole: 403 per estranei e per member quando serve admin", async () => {
    const roles: Record<string, "admin" | "member"> = { a: "admin", m: "member" };
    const deps = { getRole: async (_p: string, u: string) => roles[u] ?? null };
    await expect(requireProjectRole(deps, "p", "x", "member")).rejects.toMatchObject({ status: 403, code: "not_a_member" });
    await expect(requireProjectRole(deps, "p", "m", "admin")).rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(await requireProjectRole(deps, "p", "m", "member")).toBe("member");
    expect(await requireProjectRole(deps, "p", "a", "admin")).toBe("admin");
    expect(await requireProjectRole(deps, "p", "a", "member")).toBe("admin");
  });
  it("requireServiceRole accetta solo la chiave esatta", () => {
    expect(() => requireServiceRole(req({}, asUser("chiave")), "chiave")).not.toThrow();
    expect(() => requireServiceRole(req({}, asUser("altra")), "chiave")).toThrow(HttpError);
    expect(() => requireServiceRole(req({}), "chiave")).toThrow(HttpError);
    expect(() => requireServiceRole(req({}, asUser("")), "")).toThrow(HttpError);
    expect(() => requireServiceRole(req({}, asUser("chiave2")), "chiave")).toThrow(HttpError);
  });
  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("http", () => {
  it("handle: preflight, metodo, errori tipizzati e interni senza dettagli", async () => {
    const pre = await handle(new Request("https://x.test", { method: "OPTIONS" }), async () => json(200, {}));
    expect(pre.status).toBe(200);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await handle(new Request("https://x.test", { method: "GET" }), async () => json(200, {}))).status).toBe(405);
    const typed = await handle(req({}), async () => {
      throw new HttpError(403, "x", "Vietato");
    });
    expect(typed.status).toBe(403);
    expect(await jsonOf(typed)).toEqual({ error: { code: "x", message: "Vietato" } });
    const internal = await handle(req({}), async () => {
      throw new Error("password=supersegreta");
    });
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await jsonOf(internal))).not.toContain("supersegreta");
  });
  it("validazione dei campi", async () => {
    await expect(readJson(req("non json"))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(req("[1]"))).rejects.toMatchObject({ status: 400 });
    expect(str({ a: "x" }, "a", { required: true })).toBe("x");
    expect(() => str({}, "a", { required: true })).toThrow(HttpError);
    expect(() => str({ a: 1 }, "a")).toThrow(HttpError);
    expect(() => str({ a: "xxx" }, "a", { max: 2 })).toThrow(HttpError);
    expect(uuid({ id: "AAAAAAAA-0000-4000-8000-000000000001" }, "id")).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(() => uuid({ id: "no" }, "id")).toThrow(HttpError);
    expect(githubLogin({ l: "@Marco-R" }, "l")).toBe("Marco-R");
    for (const bad of ["-x", "x-", "a--b", "a b", "a/b", "x".repeat(40), "a_b"]) expect(() => githubLogin({ l: bad }, "l")).toThrow(HttpError);
  });
});

describe("variabili d'ambiente", () => {
  it("legge i segreti dall'ambiente iniettato e non rivela quale manca", () => {
    const env: Record<string, string> = {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----",
      GITHUB_ORG: "org",
    };
    const read = (n: string) => env[n];
    expect(supabaseEnv(read)).toEqual({ url: "https://x.supabase.co", serviceRoleKey: "k" });
    expect(githubAppEnv(read).privateKey).toContain("\nAAA\n");
    expect(githubAppEnv(read).installationId).toBeUndefined();
    let err: any;
    try {
      required(() => undefined, "GITHUB_WEBHOOK_SECRET");
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(500);
    expect(err.message).not.toContain("GITHUB_WEBHOOK_SECRET");
  });
});
