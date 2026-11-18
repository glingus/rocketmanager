// Utilità HTTP comuni (nessun riferimento a Deno: testabili sotto Node).

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return json(e.status, { error: { code: e.code, message: e.message } });
  }
  // Mai restituire dettagli interni (potrebbero contenere segreti).
  console.error("errore non gestito:", e instanceof Error ? e.message : String(e));
  return json(500, { error: { code: "internal", message: "Errore interno del server" } });
}

/** Esegue `fn` gestendo CORS preflight, metodo POST ed errori. */
export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Usa POST" } });
  try {
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Il corpo della richiesta non è JSON valido");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Il corpo della richiesta deve essere un oggetto JSON");
  }
  return body as Record<string, unknown>;
}

export function str(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; max?: number } = {},
): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new HttpError(400, "missing_field", `Campo obbligatorio mancante: ${key}`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_field", `Il campo ${key} deve essere un testo`);
  if (opts.max !== undefined && v.length > opts.max) {
    throw new HttpError(400, "invalid_field", `Il campo ${key} è troppo lungo (massimo ${opts.max})`);
  }
  return v;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(body: Record<string, unknown>, key: string): string {
  const v = str(body, key, { required: true })!;
  if (!UUID_RE.test(v)) throw new HttpError(400, "invalid_field", `Il campo ${key} non è un identificatore valido`);
  return v.toLowerCase();
}

/** Login GitHub: 1-39 caratteri alfanumerici o trattini, senza trattino iniziale/finale. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function githubLogin(body: Record<string, unknown>, key: string): string {
  const v = str(body, key, { required: true })!.trim().replace(/^@/, "");
  if (!GITHUB_LOGIN_RE.test(v)) throw new HttpError(400, "invalid_field", "Login GitHub non valido");
  return v;
}
