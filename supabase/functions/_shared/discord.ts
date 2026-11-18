// Discord: formattazione e raggruppamento dei messaggi, impostazioni, invio con ritentativi.
// Funzioni `discord-settings` e `discord-dispatch`.

import { HttpError } from "./http.ts";
import { requireProjectRole, type AuthDeps } from "./auth.ts";

export const TIME_ZONE = "Europe/Rome";
/** Eventi dello stesso progetto entro questa finestra confluiscono in un solo messaggio. */
export const GROUP_WINDOW_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const DISCORD_MESSAGE_LIMIT = 1900; // Discord accetta 2000 caratteri

export const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,200}$/;

// ---------------------------------------------------------------------------------------------
// Formattazione
// ---------------------------------------------------------------------------------------------

export interface OutboxRow {
  id: number;
  project_id: string;
  summary: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
}

/** HH:MM nel fuso di Roma. */
export function formatTimeRome(iso: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Evita che testo scritto dagli utenti diventi formattazione/menzioni Discord. */
export function escapeDiscord(text: string): string {
  return text
    .replace(/([\\*_~`|])/g, "\\$1")
    .replace(/^([>#-]) /gm, "\\$1 ")
    .replace(/@(everyone|here)/g, "@​$1");
}

interface ChangelogGroupLike {
  path?: unknown;
  lines?: unknown;
  interpreted?: unknown;
}

/** Righe di dettaglio ("> ...") di un evento. */
export function detailLines(row: OutboxRow): string[] {
  const p = row.payload ?? {};
  const out: string[] = [];
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (title && (typeof p.number === "number" || typeof p.number === "string")) out.push(title);
  const changelog = Array.isArray(p.changelog) ? (p.changelog as ChangelogGroupLike[]) : [];
  for (const g of changelog.slice(0, 5)) {
    const path = typeof g.path === "string" ? g.path : "";
    const lines = Array.isArray(g.lines) ? g.lines : [];
    if (!path) continue;
    if (g.interpreted === true && lines.length > 0) {
      out.push(`${path}: ${lines.length} ${lines.length === 1 ? "componente modificato" : "componenti modificati"}`);
    } else {
      out.push(`${path}: modificato (contenuto non interpretato)`);
    }
  }
  if (changelog.length > 5) out.push(`… e altri ${changelog.length - 5} file`);
  if (Array.isArray(p.files) && changelog.length === 0) {
    const n = (p.files as unknown[]).length;
    if (n > 0) out.push(`${n} ${n === 1 ? "file modificato" : "file modificati"}`);
  }
  return out;
}

/** Blocco di testo per un evento: "15:22 — riepilogo" + righe "> dettaglio". */
export function formatEventBlock(row: OutboxRow): string {
  const head = `${formatTimeRome(row.created_at)} — ${escapeDiscord(row.summary)}`;
  const details = detailLines(row).map((l) => `> ${escapeDiscord(l)}`);
  return [head, ...details].join("\n");
}

/** Raggruppa per progetto e, dentro ciascun progetto, per finestra di 2 minuti. */
export function groupEvents(rows: OutboxRow[]): OutboxRow[][] {
  const byProject = new Map<string, OutboxRow[]>();
  for (const r of [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)) {
    const list = byProject.get(r.project_id) ?? [];
    list.push(r);
    byProject.set(r.project_id, list);
  }
  const groups: OutboxRow[][] = [];
  for (const list of byProject.values()) {
    let current: OutboxRow[] = [];
    let start = 0;
    for (const r of list) {
      const t = Date.parse(r.created_at);
      if (current.length === 0) {
        start = t;
        current = [r];
      } else if (t - start <= GROUP_WINDOW_MS) {
        current.push(r);
      } else {
        groups.push(current);
        start = t;
        current = [r];
      }
    }
    if (current.length > 0) groups.push(current);
  }
  return groups;
}

/** Messaggi (uno o più, se superano il limite di Discord) per un gruppo di eventi. */
export function formatGroupMessages(group: OutboxRow[]): string[] {
  const blocks = group.map(formatEventBlock);
  const messages: string[] = [];
  let cur = "";
  for (let b of blocks) {
    if (b.length > DISCORD_MESSAGE_LIMIT) b = b.slice(0, DISCORD_MESSAGE_LIMIT - 1) + "…";
    if (cur && cur.length + 2 + b.length > DISCORD_MESSAGE_LIMIT) {
      messages.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) messages.push(cur);
  return messages;
}

/** Attesa prima del prossimo tentativo: 1, 2, 4, 8 minuti (max 30). */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), 30) * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Invio
// ---------------------------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  /** Descrizione dell'errore, senza mai includere l'URL del webhook. */
  error?: string;
  retryAfterMs?: number;
}

export async function sendToDiscord(
  url: string,
  content: string,
  doFetch: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] }, username: "Rocket Sync" }),
    });
    if (res.ok) return { ok: true };
    let retryAfterMs: number | undefined;
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      retryAfterMs = Math.ceil((body.retry_after ?? 1) * 1000);
    } else {
      await res.text().catch(() => "");
    }
    return { ok: false, error: `Discord ha risposto ${res.status}`, retryAfterMs };
  } catch (e) {
    return { ok: false, error: `Invio non riuscito (${e instanceof Error ? e.name : "errore di rete"})` };
  }
}

export interface DispatchDb {
  /** Messaggi `pending` con next_attempt_at <= now, i più vecchi prima. */
  pending(now: Date, limit: number): Promise<OutboxRow[]>;
  getWebhookUrl(projectId: string): Promise<string | null>;
  markSent(ids: number[], now: Date): Promise<void>;
  markFailedAttempt(
    ids: number[],
    args: { attempts: number; status: "pending" | "failed"; nextAttemptAt: Date; error: string },
  ): Promise<void>;
}

export interface DispatchSummary {
  groups: number;
  sent: number;
  retried: number;
  failed: number;
}

export async function dispatchOutbox(
  deps: { db: DispatchDb; fetch?: typeof fetch; now?: () => Date; limit?: number },
): Promise<DispatchSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.db.pending(now, deps.limit ?? 200);
  const summary: DispatchSummary = { groups: 0, sent: 0, retried: 0, failed: 0 };
  const urls = new Map<string, string | null>();

  for (const group of groupEvents(rows)) {
    summary.groups++;
    const ids = group.map((r) => r.id);
    const projectId = group[0]!.project_id;
    if (!urls.has(projectId)) urls.set(projectId, await deps.db.getWebhookUrl(projectId));
    const url = urls.get(projectId);
    const attempts = Math.max(...group.map((r) => r.attempts)) + 1;
    if (!url) {
      await deps.db.markFailedAttempt(ids, {
        attempts,
        status: "failed",
        nextAttemptAt: now,
        error: "Webhook Discord non configurato",
      });
      summary.failed += ids.length;
      continue;
    }
    let failure: SendResult | null = null;
    for (const msg of formatGroupMessages(group)) {
      const r = await sendToDiscord(url, msg, deps.fetch);
      if (!r.ok) {
        failure = r;
        break;
      }
    }
    if (!failure) {
      await deps.db.markSent(ids, now);
      summary.sent += ids.length;
    } else if (attempts >= MAX_ATTEMPTS) {
      await deps.db.markFailedAttempt(ids, {
        attempts,
        status: "failed",
        nextAttemptAt: now,
        error: failure.error ?? "errore",
      });
      summary.failed += ids.length;
    } else {
      const wait = Math.max(backoffMs(attempts), failure.retryAfterMs ?? 0);
      await deps.db.markFailedAttempt(ids, {
        attempts,
        status: "pending",
        nextAttemptAt: new Date(now.getTime() + wait),
        error: failure.error ?? "errore",
      });
      summary.retried += ids.length;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Impostazioni (admin del progetto): salva/rimuove il webhook, messaggio di prova.
// L'URL non viene mai restituito.
// ---------------------------------------------------------------------------------------------

export interface SettingsDb {
  setWebhook(projectId: string, url: string, userId: string): Promise<void>;
  removeWebhook(projectId: string, userId: string): Promise<void>;
  getWebhookUrl(projectId: string): Promise<string | null>;
}

export type DiscordSettingsRequest =
  | { action: "set"; projectId: string; webhookUrl: string; sendTest?: boolean }
  | { action: "remove"; projectId: string }
  | { action: "test"; projectId: string };

export async function discordSettings(
  userId: string,
  req: DiscordSettingsRequest,
  deps: { auth: Pick<AuthDeps, "getRole">; db: SettingsDb; fetch?: typeof fetch },
): Promise<Record<string, unknown>> {
  await requireProjectRole(deps.auth, req.projectId, userId, "admin");
  const testMessage = "Messaggio di prova da Rocket Sync: le notifiche di questo progetto arriveranno qui.";

  if (req.action === "set") {
    if (!DISCORD_WEBHOOK_RE.test(req.webhookUrl.trim())) {
      throw new HttpError(400, "invalid_webhook", "L'URL non sembra un webhook Discord valido");
    }
    const url = req.webhookUrl.trim();
    await deps.db.setWebhook(req.projectId, url, userId);
    let tested: boolean | undefined;
    if (req.sendTest) {
      tested = (await sendToDiscord(url, testMessage, deps.fetch)).ok;
    }
    return { webhookConfigured: true, ...(tested === undefined ? {} : { testSent: tested }) };
  }
  if (req.action === "remove") {
    await deps.db.removeWebhook(req.projectId, userId);
    return { webhookConfigured: false };
  }
  const url = await deps.db.getWebhookUrl(req.projectId);
  if (!url) throw new HttpError(409, "no_webhook", "Nessun webhook Discord configurato");
  const r = await sendToDiscord(url, testMessage, deps.fetch);
  if (!r.ok) throw new HttpError(502, "discord_error", r.error ?? "Invio del messaggio di prova non riuscito");
  return { webhookConfigured: true, testSent: true };
}
