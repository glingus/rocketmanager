// Client minimale della GitHub App (JWT RS256 con Web Crypto, token di installazione, REST).
// `fetch` e l'orologio sono iniettabili per i test. Nessun segreto nel codice.

import { HttpError } from "./http.ts";

export interface GithubAppConfig {
  appId: string;
  /** Chiave privata PEM (PKCS#8 "BEGIN PRIVATE KEY" oppure PKCS#1 "BEGIN RSA PRIVATE KEY"). */
  privateKey: string;
  /** Organizzazione proprietaria dei repository dei progetti. */
  org: string;
  /** Se noto; altrimenti si ricava da `GET /orgs/{org}/installation`. */
  installationId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

const enc = new TextEncoder();

export function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): { der: Uint8Array<ArrayBuffer>; pkcs1: boolean } {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1 };
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Avvolge una chiave RSA PKCS#1 in una struttura PKCS#8 (Web Crypto importa solo PKCS#8). */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING }
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const innerLen = version.length + algorithm.length + octet.length + pkcs1.length;
  const header = [0x30, ...derLength(innerLen)];
  const out = new Uint8Array(header.length + innerLen);
  out.set(header, 0);
  let o = header.length;
  out.set(version, o);
  o += version.length;
  out.set(algorithm, o);
  o += algorithm.length;
  out.set(octet, o);
  o += octet.length;
  out.set(pkcs1, o);
  return out;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const { der, pkcs1 } = pemToDer(pem);
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** JWT dell'app (RS256). `iat` 60 s nel passato per tollerare differenze di orologio; durata 9 minuti. */
export async function createAppJwt(appId: string, pem: string, nowSeconds: number): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const key = await importPrivateKey(pem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(sig)}`;
}

export interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  html_url?: string;
  clone_url?: string;
}

export interface InitialFile {
  path: string;
  content: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export type AccessResult = {
  orgInvited: boolean;
  repoAccess: "granted" | "invited" | "already";
};

export class GithubApp {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private token: { value: string; expiresAt: number } | null = null;
  private installationId: string | undefined;

  constructor(private readonly cfg: GithubAppConfig) {
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? (() => Date.now());
    this.base = cfg.apiBase ?? "https://api.github.com";
    this.installationId = cfg.installationId;
  }

  get org(): string {
    return this.cfg.org;
  }

  private async raw(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    return await this.f(`${this.base}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "rocket-sync-backend",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async parse(res: Response, what: string): Promise<unknown> {
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : "";
      throw new GithubError(res.status, `GitHub: ${what} non riuscito (${res.status}${msg ? `: ${msg}` : ""})`, data);
    }
    return data;
  }

  /** Chiamata con il JWT dell'app (non d'installazione). */
  private async asApp(method: string, path: string, body?: unknown): Promise<unknown> {
    const jwt = await createAppJwt(this.cfg.appId, this.cfg.privateKey, Math.floor(this.now() / 1000));
    return await this.parse(await this.raw(method, path, jwt, body), `${method} ${path}`);
  }

  async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;
    const data = (await this.asApp("GET", `/orgs/${encodeURIComponent(this.cfg.org)}/installation`)) as { id: number };
    this.installationId = String(data.id);
    return this.installationId;
  }

  /** Token di installazione, riusato finché valido (con 60 s di margine). */
  async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const id = await this.getInstallationId();
    const data = (await this.asApp("POST", `/app/installations/${id}/access_tokens`)) as {
      token: string;
      expires_at: string;
    };
    this.token = { value: data.token, expiresAt: Date.parse(data.expires_at) };
    return data.token;
  }

  /** Chiamata REST con il token d'installazione. `ok404` -> null invece di errore. */
  async api(method: string, path: string, body?: unknown, opts: { ok404?: boolean } = {}): Promise<unknown> {
    const token = await this.installationToken();
    const res = await this.raw(method, path, token, body);
    if (opts.ok404 && res.status === 404) {
      await res.text();
      return null;
    }
    return await this.parse(res, `${method} ${path}`);
  }

  // ---- repository ------------------------------------------------------------------------------

  /** Crea il repository privato nell'organizzazione (con un commit iniziale automatico). */
  async createRepo(name: string, description: string): Promise<RepoInfo> {
    return (await this.api("POST", `/orgs/${encodeURIComponent(this.cfg.org)}/repos`, {
      name,
      description: description.slice(0, 350),
      private: true,
      auto_init: true, // l'API Git Data non funziona su repository vuoti
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    })) as RepoInfo;
  }

  async deleteRepo(owner: string, repo: string): Promise<void> {
    await this.api("DELETE", `/repos/${owner}/${repo}`, undefined, { ok404: true });
  }

  /**
   * Scrive il commit iniziale del progetto con l'API Git Data: blob -> albero -> commit SENZA
   * genitori -> aggiornamento (forzato, solo su questo repository appena creato) del ramo. Il
   * risultato è un unico commit radice con i trailer `Rocket-Sync-Kind: init`.
   */
  async initialCommit(
    owner: string,
    repo: string,
    branch: string,
    files: InitialFile[],
    message: string,
    author: CommitIdentity,
    date: Date = new Date(this.now()),
  ): Promise<string> {
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const f of files) {
      const blob = (await this.api("POST", `/repos/${owner}/${repo}/git/blobs`, {
        content: f.content,
        encoding: "utf-8",
      })) as { sha: string };
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const t = (await this.api("POST", `/repos/${owner}/${repo}/git/trees`, { tree })) as { sha: string };
    const iso = date.toISOString();
    const c = (await this.api("POST", `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: t.sha,
      parents: [],
      author: { ...author, date: iso },
      committer: { ...author, date: iso },
    })) as { sha: string };
    await this.api("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: c.sha, force: true });
    return c.sha;
  }

  // ---- persone ---------------------------------------------------------------------------------

  async getUser(login: string): Promise<{ id: number; login: string } | null> {
    return (await this.api("GET", `/users/${encodeURIComponent(login)}`, undefined, { ok404: true })) as
      | { id: number; login: string }
      | null;
  }

  async isOrgMember(login: string): Promise<boolean> {
    const r = await this.api(
      "GET",
      `/orgs/${encodeURIComponent(this.cfg.org)}/memberships/${encodeURIComponent(login)}`,
      undefined,
      { ok404: true },
    );
    return r !== null && (r as { state?: string }).state === "active";
  }

  /**
   * Garantisce l'accesso `push` al repository: invita nell'organizzazione se non è membro e
   * aggiunge come collaboratore. Un utente inesistente produce un errore 404 esplicito.
   */
  async grantAccess(owner: string, repo: string, login: string): Promise<AccessResult> {
    const user = await this.getUser(login);
    if (!user) throw new HttpError(404, "github_user_not_found", `L'utente GitHub «${login}» non esiste`);
    let orgInvited = false;
    if (!(await this.isOrgMember(user.login))) {
      await this.api("POST", `/orgs/${encodeURIComponent(this.cfg.org)}/invitations`, {
        invitee_id: user.id,
        role: "direct_member",
      }).catch((e) => {
        // 422: invito già in sospeso o utente già membro: non è un errore per noi.
        if (!(e instanceof GithubError && e.status === 422)) throw e;
      });
      orgInvited = true;
    }
    const res = (await this.api("PUT", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(user.login)}`, {
      permission: "push",
    })) as { id?: number } | undefined;
    // 201 con corpo = invito inviato; 204 senza corpo = accesso già presente/concesso.
    const repoAccess: AccessResult["repoAccess"] = res && typeof res === "object" && res.id ? "invited" : "granted";
    return { orgInvited, repoAccess };
  }

  /** Toglie l'accesso al repository (collaboratore e invito in sospeso). */
  async revokeAccess(owner: string, repo: string, login: string): Promise<void> {
    await this.api("DELETE", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}`, undefined, {
      ok404: true,
    });
    const invites = (await this.api("GET", `/repos/${owner}/${repo}/invitations?per_page=100`)) as {
      id: number;
      invitee?: { login?: string };
    }[];
    for (const inv of invites ?? []) {
      if (inv.invitee?.login?.toLowerCase() === login.toLowerCase()) {
        await this.api("DELETE", `/repos/${owner}/${repo}/invitations/${inv.id}`, undefined, { ok404: true });
      }
    }
  }
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  refreshTokenExpiresAt: string | null;
}

/** Rinnova il token utente della GitHub App (il client secret resta sul server). */
export async function refreshUserToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch; now?: () => number },
): Promise<RefreshedTokens> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const res = await f("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "rocket-sync-backend" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    const code = typeof data.error === "string" ? data.error : `http_${res.status}`;
    if (code === "bad_refresh_token" || code === "invalid_grant") {
      throw new HttpError(401, "bad_refresh_token", "Il token di rinnovo non è valido: serve un nuovo accesso");
    }
    throw new HttpError(502, "github_oauth_error", `GitHub ha rifiutato il rinnovo (${code})`);
  }
  const plus = (s: unknown) => (typeof s === "number" ? new Date(now() + s * 1000).toISOString() : null);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt: plus(data.expires_in),
    refreshTokenExpiresAt: plus(data.refresh_token_expires_in),
  };
}
