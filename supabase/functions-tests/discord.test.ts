import { describe, expect, it } from "vitest";
import {
  DISCORD_MESSAGE_LIMIT,
  MAX_ATTEMPTS,
  backoffMs,
  discordSettings,
  dispatchOutbox,
  escapeDiscord,
  formatEventBlock,
  formatGroupMessages,
  formatTimeRome,
  groupEvents,
  sendToDiscord,
  type DispatchDb,
  type OutboxRow,
  type SettingsDb,
} from "../functions/_shared/discord.ts";
import { fakeFetch } from "./helpers.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789";
const P1 = "p1";
const P2 = "p2";

function row(id: number, project: string, at: string, over: Partial<OutboxRow> = {}): OutboxRow {
  return { id, project_id: project, summary: `evento ${id}`, payload: {}, attempts: 0, created_at: at, ...over };
}

describe("formattazione", () => {
  it("ora di Roma: inverno (CET) ed estate (CEST)", () => {
    expect(formatTimeRome("2026-11-18T14:22:10Z")).toBe("15:22");
    expect(formatTimeRome("2026-07-01T13:22:10Z")).toBe("15:22");
    expect(formatTimeRome("2026-11-18T23:30:00Z")).toBe("00:30"); // oltre la mezzanotte
  });

  it("messaggio di versione pubblicata nel formato della specifica", () => {
    const r = row(1, P1, "2026-11-18T14:22:10Z", {
      summary: "Simone ha pubblicato la versione 5 di Experimental Rocket",
      payload: {
        number: 5,
        title: "Aggiornate pinne e paracadute",
        changelog: [{ path: "Razzo.ork", lines: ["a", "b", "c"], interpreted: true }],
      },
    });
    expect(formatEventBlock(r)).toBe(
      [
        "15:22 — Simone ha pubblicato la versione 5 di Experimental Rocket",
        "> Aggiornate pinne e paracadute",
        "> Razzo.ork: 3 componenti modificati",
      ].join("\n"),
    );
  });

  it("file non interpretati, singolare, elenchi lunghi e solo l'elenco dei file", () => {
    const r = row(1, P1, "2026-11-18T14:22:10Z", {
      payload: {
        number: 2,
        title: "",
        changelog: [
          { path: "A.ork", lines: ["x"], interpreted: true },
          { path: "B.txt", lines: ["Modificato (contenuto non interpretato)"], interpreted: false },
          ...Array.from({ length: 6 }, (_, i) => ({ path: `F${i}.ork`, lines: ["y"], interpreted: true })),
        ],
      },
    });
    const text = formatEventBlock(r);
    expect(text).toContain("> A.ork: 1 componente modificato");
    expect(text).toContain("> B.txt: modificato (contenuto non interpretato)");
    expect(text).toContain("> … e altri 3 file");
    const onlyFiles = row(2, P1, "2026-11-18T14:22:10Z", { payload: { number: 3, files: [{ path: "a" }, { path: "b" }] } });
    expect(formatEventBlock(onlyFiles)).toContain("> 2 file modificati");
  });

  it("neutralizza formattazione e menzioni scritte dagli utenti", () => {
    expect(escapeDiscord("*grassetto* _x_ ~~y~~ `z` | @everyone @here")).toBe("\\*grassetto\\* \\_x\\_ \\~\\~y\\~\\~ \\`z\\` \\| @​everyone @​here");
    expect(escapeDiscord("> citazione\n# titolo")).toBe("\\> citazione\n\\# titolo");
  });
});

describe("raggruppamento", () => {
  it("eventi dello stesso progetto entro 2 minuti -> un solo messaggio; progetti diversi separati", () => {
    const rows = [
      row(1, P1, "2026-11-18T14:00:00Z"),
      row(2, P1, "2026-11-18T14:01:59Z"),
      row(3, P2, "2026-11-18T14:00:30Z"),
      row(4, P1, "2026-11-18T14:02:01Z"), // oltre 2 minuti dal primo: nuovo gruppo
      row(5, P1, "2026-11-18T14:03:00Z"),
    ];
    const groups = groupEvents(rows).map((g) => g.map((r) => r.id));
    expect(groups).toEqual([[1, 2], [4, 5], [3]]);
  });

  it("un gruppo diventa un messaggio con i blocchi in ordine di tempo; si divide oltre il limite", () => {
    const g = [row(1, P1, "2026-11-18T14:00:00Z", { summary: "uno" }), row(2, P1, "2026-11-18T14:01:00Z", { summary: "due" })];
    expect(formatGroupMessages(g)).toEqual(["15:00 — uno\n\n15:01 — due"]);
    const big = Array.from({ length: 30 }, (_, i) => row(i, P1, "2026-11-18T14:00:00Z", { summary: "x".repeat(150) }));
    const msgs = formatGroupMessages(big);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const huge = formatGroupMessages([row(1, P1, "2026-11-18T14:00:00Z", { summary: "y".repeat(5000) })]);
    expect(huge[0]!.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(huge[0]!.endsWith("…")).toBe(true);
  });

  it("attesa crescente tra i tentativi", () => {
    expect([1, 2, 3, 4, 5, 10].map((a) => backoffMs(a) / 60000)).toEqual([1, 2, 4, 8, 16, 30]);
  });
});

function dispatchDb(rows: OutboxRow[], urls: Record<string, string | null>) {
  const state = { sent: [] as number[][], failed: [] as any[], claimed: 0 };
  const db: DispatchDb = {
    async pending() {
      state.claimed++;
      return rows;
    },
    async getWebhookUrl(p) {
      return urls[p] ?? null;
    },
    async markSent(ids) {
      state.sent.push(ids);
    },
    async markFailedAttempt(ids, a) {
      state.failed.push({ ids, ...a });
    },
  };
  return { db, state };
}

const NOW = new Date("2026-11-18T14:10:00Z");

describe("discord-dispatch", () => {
  it("invia un messaggio per gruppo e segna i messaggi come inviati", async () => {
    const rows = [row(1, P1, "2026-11-18T14:00:00Z", { summary: "uno" }), row(2, P1, "2026-11-18T14:01:00Z", { summary: "due" }), row(3, P2, "2026-11-18T14:00:00Z")];
    const { db, state } = dispatchDb(rows, { [P1]: WEBHOOK, [P2]: WEBHOOK });
    const f = fakeFetch([{ match: () => true, respond: () => ({ status: 204 }) }]);
    const s = await dispatchOutbox({ db, fetch: f.fetch, now: () => NOW });
    expect(s).toEqual({ groups: 2, sent: 3, retried: 0, failed: 0 });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe(WEBHOOK);
    expect(f.calls[0]!.body.content).toBe("15:00 — uno\n\n15:01 — due");
    expect(f.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(state.sent).toEqual([[1, 2], [3]]);
  });

  it("errore transitorio: ritenta con attesa crescente senza includere l'URL nell'errore", async () => {
    const { db, state } = dispatchDb([row(1, P1, "2026-11-18T14:00:00Z", { attempts: 1 })], { [P1]: WEBHOOK });
    const f = fakeFetch([{ match: () => true, respond: () => ({ status: 500, body: { message: "boom" } }) }]);
    const s = await dispatchOutbox({ db, fetch: f.fetch, now: () => NOW });
    expect(s).toMatchObject({ retried: 1, sent: 0, failed: 0 });
    expect(state.failed[0]).toMatchObject({ ids: [1], attempts: 2, status: "pending", error: "Discord ha risposto 500" });
    expect(state.failed[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 2 * 60_000));
    expect(JSON.stringify(state.failed)).not.toContain("discord.com");
  });

  it("rispetta retry_after di Discord (429)", async () => {
    const { db, state } = dispatchDb([row(1, P1, "2026-11-18T14:00:00Z")], { [P1]: WEBHOOK });
    const f = fakeFetch([{ match: () => true, respond: () => ({ status: 429, body: { retry_after: 600 } }) }]);
    await dispatchOutbox({ db, fetch: f.fetch, now: () => NOW });
    expect(state.failed[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 600_000));
  });

  it(`dopo ${MAX_ATTEMPTS} tentativi il messaggio passa a failed`, async () => {
    const { db, state } = dispatchDb([row(1, P1, "2026-11-18T14:00:00Z", { attempts: MAX_ATTEMPTS - 1 })], { [P1]: WEBHOOK });
    const f = fakeFetch([{ match: () => true, respond: () => ({ status: 502 }) }]);
    const s = await dispatchOutbox({ db, fetch: f.fetch, now: () => NOW });
    expect(s.failed).toBe(1);
    expect(state.failed[0]).toMatchObject({ attempts: MAX_ATTEMPTS, status: "failed" });
  });

  it("senza webhook configurato: failed subito, nessuna chiamata di rete", async () => {
    const { db, state } = dispatchDb([row(1, P1, "2026-11-18T14:00:00Z")], {});
    const f = fakeFetch([]);
    const s = await dispatchOutbox({ db, fetch: f.fetch, now: () => NOW });
    expect(s.failed).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(state.failed[0].status).toBe("failed");
  });

  it("un errore di rete (eccezione) non fa cadere il job e non rivela l'URL", async () => {
    const { db, state } = dispatchDb([row(1, P1, "2026-11-18T14:00:00Z")], { [P1]: WEBHOOK });
    const boom = (async () => {
      throw new TypeError(`fetch failed ${WEBHOOK}`);
    }) as unknown as typeof fetch;
    const s = await dispatchOutbox({ db, fetch: boom, now: () => NOW });
    expect(s.retried).toBe(1);
    expect(state.failed[0].error).toBe("Invio non riuscito (TypeError)");
    const r = await sendToDiscord(WEBHOOK, "x", boom);
    expect(JSON.stringify(r)).not.toContain("discord.com");
  });

  it("coda vuota: nessun lavoro", async () => {
    const { db } = dispatchDb([], {});
    expect(await dispatchOutbox({ db, now: () => NOW })).toEqual({ groups: 0, sent: 0, retried: 0, failed: 0 });
  });
});

describe("discord-settings", () => {
  const ADMIN = "u-admin";
  function settingsDeps(role: "admin" | "member" | null, url: string | null = WEBHOOK, f = fakeFetch([{ match: () => true, respond: () => ({ status: 204 }) }])) {
    const calls: string[] = [];
    const db: SettingsDb = {
      async setWebhook(p, u) {
        calls.push(`set:${p}:${u}`);
        url = u;
      },
      async removeWebhook(p) {
        calls.push(`remove:${p}`);
        url = null;
      },
      async getWebhookUrl() {
        return url;
      },
    };
    return { deps: { auth: { getRole: async () => role }, db, fetch: f.fetch }, calls, f };
  }

  it("rifiuta chi non è admin (member o estraneo) senza salvare nulla", async () => {
    for (const role of ["member", null] as const) {
      const s = settingsDeps(role);
      for (const action of [
        { action: "set", projectId: "p", webhookUrl: WEBHOOK },
        { action: "remove", projectId: "p" },
        { action: "test", projectId: "p" },
      ] as const) {
        await expect(discordSettings("u", action, s.deps)).rejects.toMatchObject({ status: 403 });
      }
      expect(s.calls).toEqual([]);
      expect(s.f.calls).toHaveLength(0);
    }
  });

  it("set: valida l'URL, lo salva e non lo restituisce mai", async () => {
    const s = settingsDeps("admin", null);
    await expect(discordSettings(ADMIN, { action: "set", projectId: "p", webhookUrl: "http://evil.example/api/webhooks/1/x" }, s.deps)).rejects.toMatchObject({ status: 400, code: "invalid_webhook" });
    await expect(discordSettings(ADMIN, { action: "set", projectId: "p", webhookUrl: "https://discord.com.evil.example/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz" }, s.deps)).rejects.toMatchObject({ status: 400 });
    const r = await discordSettings(ADMIN, { action: "set", projectId: "p", webhookUrl: ` ${WEBHOOK} `, sendTest: true }, s.deps);
    expect(r).toEqual({ webhookConfigured: true, testSent: true });
    expect(JSON.stringify(r)).not.toContain("discord.com");
    expect(s.calls).toEqual([`set:p:${WEBHOOK}`]);
    expect(s.f.calls[0]!.body.content).toContain("Messaggio di prova");
  });

  it("test: senza webhook 409; con errore di Discord 502 senza URL; remove cancella", async () => {
    const none = settingsDeps("admin", null);
    await expect(discordSettings(ADMIN, { action: "test", projectId: "p" }, none.deps)).rejects.toMatchObject({ status: 409 });
    const bad = settingsDeps("admin", WEBHOOK, fakeFetch([{ match: () => true, respond: () => ({ status: 404 }) }]));
    const err = await discordSettings(ADMIN, { action: "test", projectId: "p" }, bad.deps).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain("discord.com");
    const ok = settingsDeps("admin");
    expect(await discordSettings(ADMIN, { action: "test", projectId: "p" }, ok.deps)).toEqual({ webhookConfigured: true, testSent: true });
    expect(await discordSettings(ADMIN, { action: "remove", projectId: "p" }, ok.deps)).toEqual({ webhookConfigured: false });
    expect(ok.calls).toEqual(["remove:p"]);
  });
});
