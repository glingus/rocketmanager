// Costruzione delle righe `versions` a partire da un evento `push` di GitHub.

import { parseCommitMessage, type ChangelogGroup, type CommitKind } from "./trailers.ts";

export interface PushCommit {
  id: string;
  message: string;
  timestamp?: string;
  distinct?: boolean;
  author?: { name?: string; email?: string; username?: string };
  committer?: { name?: string; email?: string; username?: string };
  added?: string[];
  removed?: string[];
  modified?: string[];
}

export interface PushPayload {
  ref: string;
  deleted?: boolean;
  forced?: boolean;
  repository?: { id?: number; name?: string; full_name?: string; default_branch?: string; owner?: { login?: string; name?: string } };
  commits?: PushCommit[];
  head_commit?: PushCommit | null;
}

export interface FileEntry {
  path: string;
  change: "added" | "modified" | "deleted";
}

export interface VersionRow {
  project_id: string;
  number: number;
  sha: string;
  kind: Exclude<CommitKind, "init">;
  title: string;
  description: string;
  changelog: ChangelogGroup[];
  author_id: string | null;
  author_github_login: string;
  files: FileEntry[];
  restored_from: number | null;
  conflict_id: string | null;
  published_at: string;
}

/** `12345+login@users.noreply.github.com` o `login@users.noreply.github.com` -> login. */
export function loginFromNoreply(email: string | undefined): string | null {
  if (!email) return null;
  const m = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  return m ? (m[1] ?? null) : null;
}

export function commitAuthorLogin(c: PushCommit): string {
  return (
    c.author?.username ??
    loginFromNoreply(c.author?.email) ??
    c.committer?.username ??
    loginFromNoreply(c.committer?.email) ??
    ""
  );
}

export function commitFiles(c: PushCommit): FileEntry[] {
  const files: FileEntry[] = [];
  for (const p of c.added ?? []) files.push({ path: p, change: "added" });
  for (const p of c.modified ?? []) files.push({ path: p, change: "modified" });
  for (const p of c.removed ?? []) files.push({ path: p, change: "deleted" });
  // I file di servizio di Rocket Sync non sono "file del progetto".
  return files.filter((f) => !f.path.startsWith(".rocketsync/")).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Righe da inserire in `versions`. Si saltano i commit senza numero definitivo
 * (iniziale `init`, provvisori `pending`, commit non di Rocket Sync). `resolveAuthorId` associa il
 * login GitHub al profilo (può restituire null).
 */
export function buildVersionRows(
  projectId: string,
  commits: PushCommit[],
  resolveAuthorId: (login: string) => string | null,
): VersionRow[] {
  const rows = new Map<string, VersionRow>();
  for (const c of commits) {
    if (!c.id || rows.has(c.id)) continue;
    const parsed = parseCommitMessage(c.message ?? "");
    if (typeof parsed.version !== "number" || parsed.version < 1) continue;
    if (parsed.kind === null || parsed.kind === "init") continue;
    const login = commitAuthorLogin(c);
    rows.set(c.id, {
      project_id: projectId,
      number: parsed.version,
      sha: c.id.toLowerCase(),
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description,
      changelog: parsed.changelog,
      author_id: login ? resolveAuthorId(login) : null,
      author_github_login: login,
      files: commitFiles(c),
      restored_from: parsed.restoredFrom,
      conflict_id: parsed.conflictId,
      published_at: c.timestamp ? new Date(c.timestamp).toISOString() : new Date().toISOString(),
    });
  }
  return [...rows.values()].sort((a, b) => a.number - b.number);
}

/** Evento da emettere per una versione appena registrata. */
export function eventForVersion(row: VersionRow, authorName: string): { type: string; payload: Record<string, unknown> } {
  const base = {
    number: row.number,
    title: row.title,
    sha: row.sha,
    kind: row.kind,
    authorName,
    files: row.files,
    changelog: row.changelog,
  };
  if (row.kind === "restore") {
    return { type: "version.restored", payload: { ...base, restoredFrom: row.restored_from } };
  }
  return { type: "version.published", payload: base };
}
