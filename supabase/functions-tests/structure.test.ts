import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FN = join(ROOT, "functions");
const FUNCTIONS = ["create-project", "manage-members", "accept-invitations", "github-webhook", "discord-settings", "discord-dispatch", "github-token-refresh"];

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return n === "node_modules" ? [] : statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("struttura delle Edge Functions", () => {
  it("esistono tutte e 7 le funzioni, ognuna con una entry sottile", () => {
    for (const f of FUNCTIONS) {
      const src = read("functions", f, "index.ts");
      expect(src.split("\n").length, `${f}/index.ts è troppo lungo per una entry sottile`).toBeLessThan(60);
      expect(src).toContain("Deno.serve");
    }
    const dirs = readdirSync(FN).filter((n) => statSync(join(FN, n)).isDirectory() && !n.startsWith("_"));
    expect(dirs.sort()).toEqual([...FUNCTIONS].sort());
  });

  it("solo le entry e runtime.ts toccano Deno; la logica condivisa no", () => {
    for (const file of walk(join(FN, "_shared"))) {
      const src = readFileSync(file, "utf8");
      const code = src.replace(/\/\/.*$/gm, "");
      if (file.endsWith("runtime.ts")) continue;
      expect(code, file).not.toMatch(/\bDeno\./);
      expect(code, file).not.toMatch(/from "(npm|jsr|node):/);
    }
  });

  it("config.toml elenca le funzioni e disattiva la verifica JWT solo per il webhook GitHub", () => {
    const toml = read("config.toml");
    for (const f of FUNCTIONS) expect(toml, f).toContain(`[functions.${f}]`);
    const sections = toml.split(/\n(?=\[)/).filter((s) => s.startsWith("[functions."));
    for (const s of sections) {
      const name = /\[functions\.([\w-]+)\]/.exec(s)![1];
      const verify = /verify_jwt\s*=\s*(true|false)/.exec(s)?.[1];
      expect(verify, name).toBe(name === "github-webhook" || name === "discord-dispatch" ? "false" : "true");
    }
  });

  it("nessun segreto nel codice e .env.example contiene solo nomi", () => {
    const all = [...walk(FN), ...walk(join(ROOT, "migrations")), join(ROOT, "config.toml")];
    for (const f of all) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{20,}/);
      expect(src, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./); // JWT
      expect(src, f).not.toMatch(/gh[pousr]_[A-Za-z0-9]{30,}/); // token GitHub
      expect(src, f).not.toMatch(/discord(app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{30,}/);
    }
    const env = read(".env.example");
    for (const line of env.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      expect(line, "valore in .env.example").toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
    for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_ORG", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]) {
      expect(env, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    // ogni variabile letta nel codice è documentata
    const used = new Set<string>();
    for (const f of walk(FN).filter((x) => x.endsWith(".ts"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/["'](GITHUB_[A-Z_]+|SUPABASE_[A-Z_]+)["']/g)) used.add(m[1]!);
    }
    for (const n of used) expect(env, n).toMatch(new RegExp(`^#?\\s*${n}=`, "m"));
  });

  it("le RPC chiamate da db.ts esistono nelle migrazioni con gli stessi nomi di parametro", () => {
    const sql = readdirSync(join(ROOT, "migrations")).map((f) => read("migrations", f)).join("\n");
    const db = read("functions/_shared/db.ts");
    const calls = [...db.matchAll(/rpc\(\s*"([a-z_]+)",\s*\{([^}]*)\}/g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const [, name, args] of calls) {
      const m = new RegExp(`create function public\\.${name}\\(([^)]*)\\)`, "s").exec(sql);
      expect(m, `RPC ${name} assente nelle migrazioni`).not.toBeNull();
      const params = [...m![1]!.matchAll(/\b(p_[a-z_]+)\b/g)].map((x) => x[1]);
      const used = [...args!.matchAll(/\b(p_[a-z_]+)\b\s*:/g)].map((x) => x[1]);
      for (const u of used) expect(params, `${name}: parametro ${u}`).toContain(u);
    }
  });

  it("nessuna RPC riservata al server è concessa al client", () => {
    const sql = read("migrations/20261101000005_rls_and_grants.sql");
    const grantAuth = /grant execute on function([\s\S]*?)to authenticated;/.exec(sql)![1]!;
    for (const server of ["emit_event_server", "create_project_record", "set_discord_webhook", "get_discord_webhook", "claim_discord_outbox", "mark_discord_sent", "mark_discord_failed", "remove_discord_webhook"]) {
      expect(grantAuth, server).not.toContain(server);
    }
  });
});
