// Parsing del messaggio di commit di Rocket Sync (docs/protocollo-sync.md §3).
//
//   v13 — Aggiornate pinne e paracadute
//
//   <descrizione facoltativa>
//
//   Razzo.ork
//   • Pinne trapezoidali: numero 3 → 4; corda alla radice 80 → 95 mm
//
//   Rocket-Sync-Version: 13
//   Rocket-Sync-Kind: publish
//   Rocket-Sync-Client: 0.1.0

export type CommitKind = "init" | "publish" | "restore" | "conflict-resolution";

export interface ChangelogGroup {
  path: string;
  lines: string[];
  interpreted: boolean;
}

export interface ParsedCommit {
  /** Numero della versione; `null` se manca il trailer, "pending" se provvisoria. */
  version: number | "pending" | null;
  kind: CommitKind | null;
  client: string | null;
  restoredFrom: number | null;
  restoredPaths: string[];
  conflictId: string | null;
  resolution: Record<string, string>;
  title: string;
  description: string;
  changelog: ChangelogGroup[];
  /** Trailer grezzi (chiave minuscola). */
  trailers: Record<string, string>;
}

const SEPARATOR = " — ";
const KINDS: readonly string[] = ["init", "publish", "restore", "conflict-resolution"];
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.*)$/;
/** Righe di changelog generiche (file senza interpretazione semantica). */
const GENERIC_LINES = new Set(["Aggiunto", "Rimosso", "Modificato", "Nessuna modifica"]);

/** Estrae il blocco finale di trailer `Rocket-Sync-*` (ultimo paragrafo). */
function splitTrailers(lines: string[]): { body: string[]; trailers: Record<string, string> } {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  let start = end;
  while (start > 0 && (lines[start - 1] ?? "").trim() !== "") start--;
  const block = lines.slice(start, end);
  const trailers: Record<string, string> = {};
  let valid = block.length > 0;
  for (const l of block) {
    const m = TRAILER_LINE.exec(l);
    if (!m) {
      valid = false;
      break;
    }
    trailers[(m[1] ?? "").toLowerCase()] = (m[2] ?? "").trim();
  }
  if (!valid || !Object.keys(trailers).some((k) => k.startsWith("rocket-sync-"))) {
    return { body: lines, trailers: {} };
  }
  return { body: lines.slice(0, start), trailers };
}

function parseResolution(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.lastIndexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isInterpreted(lines: string[]): boolean {
  return lines.some((l) => !GENERIC_LINES.has(l.trim()) && !/contenuto non interpretato/i.test(l));
}

export function parseCommitMessage(message: string): ParsedCommit {
  const all = message.replace(/\r\n/g, "\n").split("\n");
  const subject = (all[0] ?? "").trim();
  const { body: bodyAll, trailers } = splitTrailers(all.slice(1));

  // Oggetto: "v13 — titolo" oppure "v? — titolo".
  let title = subject;
  const sepIndex = subject.indexOf(SEPARATOR);
  if (/^v(\d+|\?)$/.test(subject.slice(0, Math.max(sepIndex, 0))) && sepIndex > 0) {
    title = subject.slice(sepIndex + SEPARATOR.length).trim();
  }

  // Corpo: descrizione (fino al primo gruppo di changelog) + gruppi "percorso" / "• riga".
  const body = bodyAll;
  const isBullet = (l: string | undefined) => (l ?? "").startsWith("• ");
  let firstGroup = body.length;
  for (let i = 0; i < body.length - 1; i++) {
    const l = body[i] ?? "";
    if (l.trim() !== "" && !isBullet(l) && isBullet(body[i + 1])) {
      firstGroup = i;
      break;
    }
  }
  const description = body.slice(0, firstGroup).join("\n").trim();
  const changelog: ChangelogGroup[] = [];
  let current: ChangelogGroup | null = null;
  for (let i = firstGroup; i < body.length; i++) {
    const l = body[i] ?? "";
    if (l.trim() === "") continue;
    if (isBullet(l)) {
      if (current) current.lines.push(l.slice(2).trim());
    } else if (isBullet(body[i + 1])) {
      current = { path: l.trim(), lines: [], interpreted: false };
      changelog.push(current);
    }
  }
  for (const g of changelog) g.interpreted = isInterpreted(g.lines);

  const rawVersion = trailers["rocket-sync-version"];
  let version: ParsedCommit["version"] = null;
  if (rawVersion !== undefined) {
    if (rawVersion.toLowerCase() === "pending") version = "pending";
    else if (/^\d+$/.test(rawVersion)) version = Number(rawVersion);
  }
  const rawKind = trailers["rocket-sync-kind"];
  const rawRestored = trailers["rocket-sync-restored-from"];

  return {
    version,
    kind: rawKind && KINDS.includes(rawKind) ? (rawKind as CommitKind) : null,
    client: trailers["rocket-sync-client"] ?? null,
    restoredFrom: rawRestored && /^\d+$/.test(rawRestored) ? Number(rawRestored) : null,
    restoredPaths: (trailers["rocket-sync-restored-paths"] ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    conflictId: trailers["rocket-sync-conflict"] ?? null,
    resolution: parseResolution(trailers["rocket-sync-resolution"]),
    title,
    description,
    changelog,
    trailers,
  };
}
