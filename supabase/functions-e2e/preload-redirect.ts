// Eseguito PRIMA di ogni funzione (deno run --preload): reindirizza le chiamate verso host esterni
// (api.github.com, github.com, discord.com) ai server finti locali del test. Il codice delle funzioni
// non cambia: solo `fetch` globale, e solo se E2E_FETCH_REDIRECTS è impostata (mai in produzione).
const raw = Deno.env.get("E2E_FETCH_REDIRECTS");
if (raw) {
  const map = JSON.parse(raw) as Record<string, string>;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target = map[url.origin];
    if (target) {
      const t = new URL(target);
      url.protocol = t.protocol;
      url.host = t.host;
      return original(url.toString(), init ?? (input instanceof Request ? input : undefined));
    }
    return original(input, init);
  }) as typeof fetch;
}
