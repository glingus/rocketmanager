// Autenticazione e autorizzazione basata sul ruolo del progetto (verificata lato server).

import { HttpError } from "./http.ts";

export type ProjectRole = "admin" | "member";

export interface AuthDeps {
  /** Valida il JWT dell'utente e ne restituisce l'id (supabase.auth.getUser). */
  getUserId(token: string): Promise<string | null>;
  /** Ruolo dell'utente nel progetto, o null se non è membro (letto con la chiave service_role). */
  getRole(projectId: string, userId: string): Promise<ProjectRole | null>;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? (m[1] ?? null) : null;
}

/** Richiede un utente autenticato; ritorna il suo id. */
export async function requireUser(req: Request, deps: Pick<AuthDeps, "getUserId">): Promise<string> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthenticated", "Accesso richiesto");
  const id = await deps.getUserId(token);
  if (!id) throw new HttpError(401, "unauthenticated", "Sessione non valida o scaduta");
  return id;
}

/** Richiede che l'utente abbia (almeno) il ruolo indicato nel progetto. */
export async function requireProjectRole(
  deps: Pick<AuthDeps, "getRole">,
  projectId: string,
  userId: string,
  needed: ProjectRole,
): Promise<ProjectRole> {
  const role = await deps.getRole(projectId, userId);
  if (role === null) throw new HttpError(403, "not_a_member", "Non fai parte di questo progetto");
  if (needed === "admin" && role !== "admin") {
    throw new HttpError(403, "admin_required", "Serve il ruolo di amministratore del progetto");
  }
  return role;
}

/** Confronto a tempo costante di due stringhe (segreti, firme). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Autorizza le chiamate interne (pg_cron) che portano la chiave service_role come Bearer. */
export function requireServiceRole(req: Request, serviceRoleKey: string): void {
  const token = bearerToken(req);
  if (!serviceRoleKey || !token || !timingSafeEqual(token, serviceRoleKey)) {
    throw new HttpError(401, "unauthorized", "Chiamata non autorizzata");
  }
}
