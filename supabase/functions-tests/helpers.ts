// Utilità condivise dai test.
export function req(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request("https://example.test/fn", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const asUser = (token = "tok") => ({ authorization: `Bearer ${token}` });

export async function jsonOf(res: Response): Promise<any> {
  return await res.json();
}

/** fetch finto: registra le chiamate e risponde con la prima regola che combacia. */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
export type Rule = {
  match: (c: Call) => boolean;
  respond: (c: Call) => { status?: number; body?: unknown };
};

export function fakeFetch(rules: Rule[]) {
  const calls: Call[] = [];
  const fn = (async (input: any, init?: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: any = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers, body };
    calls.push(call);
    const rule = rules.find((r) => r.match(call));
    if (!rule) return new Response(JSON.stringify({ message: `nessuna regola per ${call.method} ${call.url}` }), { status: 599 });
    const out = rule.respond(call);
    const status = out.status ?? 200;
    const text = out.body === undefined ? "" : JSON.stringify(out.body);
    return new Response(status === 204 ? null : text, { status });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}
