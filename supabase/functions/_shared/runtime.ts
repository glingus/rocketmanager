// Collegamento al runtime Deno di Supabase: SOLO le entry `index.ts` importano questo file
// (usa `Deno.env`). Tutta la logica testabile sta negli altri moduli di _shared.

import { createClient } from "@supabase/supabase-js";
import { makeDb } from "./db.ts";
import { GithubApp } from "./github-app.ts";
import { githubAppEnv, supabaseEnv, type EnvReader } from "./env.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

export const read: EnvReader = (name) => Deno.env.get(name);

export function serviceDb() {
  const { url, serviceRoleKey } = supabaseEnv(read);
  const sb = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return { db: makeDb(sb), serviceRoleKey };
}

export function githubApp(): GithubApp {
  const c = githubAppEnv(read);
  return new GithubApp({ appId: c.appId, privateKey: c.privateKey, org: c.org, installationId: c.installationId });
}
