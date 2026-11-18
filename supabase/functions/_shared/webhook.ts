// Logica del webhook GitHub (Edge Function `github-webhook`).

import { HttpError, json } from "./http.ts";
import { verifyGithubSignature } from "./hmac.ts";
import { buildVersionRows, eventForVersion, type PushPayload, type VersionRow } from "./versions.ts";

export interface WebhookProject {
  id: string;
  default_branch: string;
}

export interface WebhookDb {
  findProject(repoId: number | undefined, fullName: string | undefined): Promise<WebhookProject | null>;
  /** login GitHub -> profilo (id e nome visualizzato). */
  findProfilesByLogins(logins: string[]): Promise<Map<string, { id: string; display_name: string }>>;
  /** Inserisce ignorando i duplicati (stesso sha o stesso numero): ritorna le righe NUOVE. */
  insertVersions(rows: VersionRow[]): Promise<VersionRow[]>;
  emitEvent(args: {
    projectId: string;
    type: string;
    payload: Record<string, unknown>;
    actorId: string | null;
  }): Promise<void>;
}

export interface WebhookDeps {
  secret: string;
  db: WebhookDb;
}

export async function handleGithubWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Usa POST" } });
  // Il corpo va letto grezzo: la firma è calcolata sui byte ricevuti.
  const raw = await req.text();
  const ok = await verifyGithubSignature(deps.secret, raw, req.headers.get("x-hub-signature-256"));
  if (!ok) return json(401, { error: { code: "bad_signature", message: "Firma non valida" } });

  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return json(200, { ok: true, pong: true });
  if (event !== "push") return json(202, { ok: true, ignored: `evento ${event || "sconosciuto"}` });

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw) as PushPayload;
  } catch {
    throw new HttpError(400, "invalid_json", "Payload non valido");
  }
  if (payload.deleted) return json(202, { ok: true, ignored: "ramo eliminato" });

  const project = await deps.db.findProject(payload.repository?.id, payload.repository?.full_name);
  if (!project) return json(202, { ok: true, ignored: "repository non collegato a un progetto" });

  // Solo il ramo principale (nessun'altra branch, es. conflitti/<id>).
  const expectedRef = `refs/heads/${project.default_branch || "main"}`;
  if (payload.ref !== expectedRef) return json(202, { ok: true, ignored: `ramo ${payload.ref}` });

  const commits = payload.commits ?? [];
  // Prima si risolvono gli autori (una sola query), poi si costruiscono le righe.
  const logins = new Set<string>();
  for (const c of commits) {
    const l = c.author?.username ?? c.committer?.username;
    if (l) logins.add(l);
  }
  const profiles = await deps.db.findProfilesByLogins([...logins]);
  const byLogin = new Map([...profiles].map(([k, v]) => [k.toLowerCase(), v]));
  const rows = buildVersionRows(project.id, commits, (login) => byLogin.get(login.toLowerCase())?.id ?? null);
  if (rows.length === 0) return json(200, { ok: true, inserted: 0, skipped: commits.length });

  const inserted = await deps.db.insertVersions(rows);
  for (const row of inserted) {
    const profile = byLogin.get(row.author_github_login.toLowerCase());
    const name = profile?.display_name ?? row.author_github_login ?? "Qualcuno";
    const ev = eventForVersion(row, name);
    await deps.db.emitEvent({ projectId: project.id, type: ev.type, payload: ev.payload, actorId: row.author_id });
  }
  return json(200, { ok: true, inserted: inserted.length, duplicates: rows.length - inserted.length });
}
