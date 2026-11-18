// Edge Function `create-project`: repo privato + commit iniziale + record su Supabase.
// In caso di errore a metà annulla ciò che ha creato.

import { HttpError } from "./http.ts";
import type { AccessResult, CommitIdentity, InitialFile, RepoInfo } from "./github-app.ts";
import { GithubError } from "./github-app.ts";

export interface CreateProjectGithub {
  org: string;
  createRepo(name: string, description: string): Promise<RepoInfo>;
  deleteRepo(owner: string, repo: string): Promise<void>;
  initialCommit(
    owner: string,
    repo: string,
    branch: string,
    files: InitialFile[],
    message: string,
    author: CommitIdentity,
  ): Promise<string>;
  grantAccess(owner: string, repo: string, login: string): Promise<AccessResult>;
}

export interface CreatorProfile {
  id: string;
  github_login: string;
  github_id: number | null;
  display_name: string;
}

export interface CreateProjectDb {
  getProfile(userId: string): Promise<CreatorProfile | null>;
  slugExists(slug: string): Promise<boolean>;
  createProjectRecord(args: {
    id: string;
    name: string;
    slug: string;
    description: string;
    githubOwner: string;
    githubRepo: string;
    githubRepoId: number;
    defaultBranch: string;
    createdBy: string;
  }): Promise<string>;
  deleteProject(projectId: string): Promise<void>;
}

export interface CreateProjectDeps {
  github: CreateProjectGithub;
  db: CreateProjectDb;
  newId?: () => string;
  clientVersion?: string;
}

export interface CreateProjectInput {
  userId: string;
  name: string;
  description?: string;
}

export interface CreateProjectResult {
  projectId: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  repoFullName: string;
  defaultBranch: string;
}

/** "Experimental Rocket!" -> "experimental-rocket"; accenti rimossi. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "progetto";
}

/** File scritti nel commit iniziale (docs/protocollo-sync.md §2). */
export function initialFiles(projectId: string): InitialFile[] {
  return [
    { path: ".gitattributes", content: "*.ork binary\n* -text\n" },
    {
      path: ".gitignore",
      content: [
        ".rocketsync/local/",
        "*.tmp",
        "~$*",
        "*.swp",
        "*.bak",
        // OpenRocket salva su un temporaneo e tiene un `<nome>.ork-bak` durante il salvataggio.
        "*.ork-bak",
        "Thumbs.db",
        "desktop.ini",
        ".DS_Store",
        "",
      ].join("\n"),
    },
    {
      path: ".rocketsync/project.json",
      content: JSON.stringify({ projectId, schema: 1 }, null, 2) + "\n",
    },
  ];
}

export function initialCommitMessage(clientVersion: string): string {
  return [
    "v0 — Creazione del progetto",
    "",
    "Rocket-Sync-Version: 0",
    "Rocket-Sync-Kind: init",
    `Rocket-Sync-Client: ${clientVersion}`,
  ].join("\n");
}

export function commitIdentity(p: CreatorProfile): CommitIdentity {
  // Mai l'email reale: noreply GitHub.
  const email = p.github_id
    ? `${p.github_id}+${p.github_login}@users.noreply.github.com`
    : `${p.github_login}@users.noreply.github.com`;
  return { name: p.display_name || p.github_login, email };
}

export async function createProject(input: CreateProjectInput, deps: CreateProjectDeps): Promise<CreateProjectResult> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new HttpError(400, "invalid_name", "Il nome del progetto deve avere da 1 a 80 caratteri");
  }
  const description = (input.description ?? "").trim().slice(0, 500);
  const profile = await deps.db.getProfile(input.userId);
  if (!profile) throw new HttpError(403, "no_profile", "Profilo utente non trovato");

  const baseSlug = slugify(name);
  let slug = baseSlug;
  for (let n = 2; await deps.db.slugExists(slug); n++) {
    if (n > 50) throw new HttpError(409, "slug_taken", "Esistono troppi progetti con un nome simile");
    slug = `${baseSlug}-${n}`.slice(0, 80);
  }

  const projectId = (deps.newId ?? (() => crypto.randomUUID()))();
  const undo: (() => Promise<void>)[] = [];
  const rollback = async () => {
    for (const fn of undo.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error("rollback non riuscito:", e instanceof Error ? e.message : String(e));
      }
    }
  };

  try {
    // 1. Repository privato (se il nome è occupato su GitHub si prova con un suffisso).
    let repo: RepoInfo | null = null;
    let repoName = slug;
    for (let n = 2; repo === null; n++) {
      try {
        repo = await deps.github.createRepo(repoName, description || name);
      } catch (e) {
        if (e instanceof GithubError && e.status === 422 && n <= 50) {
          repoName = `${slug}-${n}`.slice(0, 80);
          continue;
        }
        throw e;
      }
    }
    const owner = deps.github.org;
    const created = repo;
    undo.push(() => deps.github.deleteRepo(owner, created.name));

    // 2. Commit iniziale.
    await deps.github.initialCommit(
      owner,
      created.name,
      created.default_branch || "main",
      initialFiles(projectId),
      initialCommitMessage(deps.clientVersion ?? "server"),
      commitIdentity(profile),
    );

    // 3. Accesso del creatore al repository.
    await deps.github.grantAccess(owner, created.name, profile.github_login);

    // 4. Record su Supabase (progetto, admin, categorie, Discord, evento).
    await deps.db.createProjectRecord({
      id: projectId,
      name,
      slug,
      description,
      githubOwner: owner,
      githubRepo: created.name,
      githubRepoId: created.id,
      defaultBranch: created.default_branch || "main",
      createdBy: input.userId,
    });
    undo.push(() => deps.db.deleteProject(projectId));

    return {
      projectId,
      slug,
      githubOwner: owner,
      githubRepo: created.name,
      repoFullName: created.full_name,
      defaultBranch: created.default_branch || "main",
    };
  } catch (e) {
    await rollback();
    if (e instanceof HttpError) throw e;
    if (e instanceof GithubError) {
      throw new HttpError(502, "github_error", `Creazione del progetto annullata: ${e.message}`);
    }
    throw new HttpError(500, "create_failed", "Creazione del progetto annullata per un errore interno");
  }
}
