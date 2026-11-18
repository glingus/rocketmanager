import { describe, expect, it } from "vitest";
import { hmacSha256Hex, verifyGithubSignature } from "../functions/_shared/hmac.ts";
import { parseCommitMessage } from "../functions/_shared/trailers.ts";

describe("firma del webhook GitHub", () => {
  // Vettore di prova della documentazione GitHub.
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("calcola l'HMAC-SHA256 atteso", async () => {
    expect(await hmacSha256Hex(secret, body)).toBe(good.slice(7));
  });
  it("accetta la firma corretta (stringa o byte)", async () => {
    expect(await verifyGithubSignature(secret, body, good)).toBe(true);
    expect(await verifyGithubSignature(secret, new TextEncoder().encode(body), good.toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
  });
  it("rifiuta corpo alterato, segreto sbagliato, intestazione assente o malformata", async () => {
    expect(await verifyGithubSignature(secret, body + " ", good)).toBe(false);
    expect(await verifyGithubSignature("altro", body, good)).toBe(false);
    expect(await verifyGithubSignature(secret, body, null)).toBe(false);
    expect(await verifyGithubSignature(secret, body, "")).toBe(false);
    expect(await verifyGithubSignature(secret, body, good.slice(7))).toBe(false);
    expect(await verifyGithubSignature(secret, body, "sha1=" + good.slice(7))).toBe(false);
    expect(await verifyGithubSignature(secret, body, good.slice(0, -1) + "0")).toBe(false);
    expect(await verifyGithubSignature("", body, good)).toBe(false);
  });
});

const MSG = `v13 — Aggiornate pinne e paracadute

Ho cambiato il disegno delle pinne
dopo il test di sabato.

Razzo.ork
• Pinne trapezoidali: numero 3 → 4; corda alla radice 80 → 95 mm
• Aggiunto: Paracadute principale (Ø 900 mm)

Note.txt
• Modificato (contenuto non interpretato)

Rocket-Sync-Version: 13
Rocket-Sync-Kind: publish
Rocket-Sync-Client: 0.1.0`;

describe("parsing del messaggio di commit", () => {
  it("legge oggetto, descrizione, changelog e trailer", () => {
    const p = parseCommitMessage(MSG);
    expect(p.version).toBe(13);
    expect(p.kind).toBe("publish");
    expect(p.client).toBe("0.1.0");
    expect(p.title).toBe("Aggiornate pinne e paracadute");
    expect(p.description).toBe("Ho cambiato il disegno delle pinne\ndopo il test di sabato.");
    expect(p.changelog).toEqual([
      {
        path: "Razzo.ork",
        lines: ["Pinne trapezoidali: numero 3 → 4; corda alla radice 80 → 95 mm", "Aggiunto: Paracadute principale (Ø 900 mm)"],
        interpreted: true,
      },
      { path: "Note.txt", lines: ["Modificato (contenuto non interpretato)"], interpreted: false },
    ]);
    expect(p.restoredFrom).toBeNull();
  });

  it("gestisce versioni in attesa, righe generiche e CRLF", () => {
    const p = parseCommitMessage("v? — Bozza\r\n\r\nFoto.png\r\n• Aggiunto\r\n\r\nRocket-Sync-Version: pending\r\nRocket-Sync-Kind: publish");
    expect(p.version).toBe("pending");
    expect(p.title).toBe("Bozza");
    expect(p.changelog).toEqual([{ path: "Foto.png", lines: ["Aggiunto"], interpreted: false }]);
  });

  it("ripristino e risoluzione di conflitto", () => {
    const r = parseCommitMessage(
      "v20 — Ripristinata la versione 7\n\nRocket-Sync-Version: 20\nRocket-Sync-Kind: restore\nRocket-Sync-Client: 0.1.0\nRocket-Sync-Restored-From: 7\nRocket-Sync-Restored-Paths: Razzo.ork;Motori.ork",
    );
    expect(r.kind).toBe("restore");
    expect(r.restoredFrom).toBe(7);
    expect(r.restoredPaths).toEqual(["Razzo.ork", "Motori.ork"]);
    const c = parseCommitMessage(
      "v21 — Conflitto risolto\n\nRocket-Sync-Version: 21\nRocket-Sync-Kind: conflict-resolution\nRocket-Sync-Conflict: 20261101-abc123\nRocket-Sync-Resolution: Razzo.ork=mine;Note a=b.txt=theirs",
    );
    expect(c.kind).toBe("conflict-resolution");
    expect(c.conflictId).toBe("20261101-abc123");
    expect(c.resolution).toEqual({ "Razzo.ork": "mine", "Note a=b.txt": "theirs" });
  });

  it("commit iniziale e commit senza trailer", () => {
    const i = parseCommitMessage("v0 — Creazione del progetto\n\nRocket-Sync-Version: 0\nRocket-Sync-Kind: init\nRocket-Sync-Client: server");
    expect(i.version).toBe(0);
    expect(i.kind).toBe("init");
    const x = parseCommitMessage("Fix typo\n\nCo-authored-by: Qualcuno <q@example.com>");
    expect(x.version).toBeNull();
    expect(x.kind).toBeNull();
    expect(x.title).toBe("Fix typo");
    expect(parseCommitMessage("").version).toBeNull();
  });

  it("un oggetto con trattino lungo nel titolo e valori anomali non confondono il parser", () => {
    const p = parseCommitMessage("v5 — Pinne — versione B\n\nRocket-Sync-Version: abc\nRocket-Sync-Kind: boh");
    expect(p.title).toBe("Pinne — versione B");
    expect(p.version).toBeNull();
    expect(p.kind).toBeNull();
    // un titolo che inizia con "v" ma non è un numero di versione resta intero
    expect(parseCommitMessage("vero — non una versione").title).toBe("vero — non una versione");
  });
});
