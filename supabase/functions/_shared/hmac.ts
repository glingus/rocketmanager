// Verifica della firma dei webhook GitHub (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 hex).

import { timingSafeEqual } from "./auth.ts";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, payload: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const data: Uint8Array<ArrayBuffer> = typeof payload === "string" ? enc.encode(payload) : new Uint8Array(payload);
  return toHex(await crypto.subtle.sign("HMAC", key, data));
}

/** `rawBody` deve essere il corpo ESATTO ricevuto (non ri-serializzato). */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): Promise<boolean> {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected, (m[1] ?? "").toLowerCase());
}
