import { describe, expect, it } from "vitest";
import {
  commitIdentity,
  createProject,
  initialCommitMessage,
  initialFiles,
  slugify,
  type CreateProjectDb,
  type CreateProjectGithub,
} from "../functions/_shared/create-project.ts";
import { GithubError } from "../functions/_shared/github-app.ts";
import { parseCommitMessage } from "../functions/_shared/trailers.ts";

const PID = "22222222-2222-4222-8222-222222222222";

function fakes(opts: { failAt?: "createRepo" | "initialCommit" | "grantAccess" | "record"; takenSlugs?: string[]; takenRepos?: string[] } = {}) {
  const log: string[] = [];
  const github: CreateProjectGithub = {
    org: "rocket-org",
    async createRepo(name) {
      log.push(`createRepo:${name}`);
      if (opts.failAt === "createRepo") throw new GithubError(403, "GitHub: no");
      if (opts.takenRepos?.includes(name)) throw new GithubError(422, "GitHub: name already exists");
      return { id: 555, name, full_name: `rocket-org/${name}`, default_branch: "main" };
    },
    async deleteRepo(owner, repo) {
      log.push(`deleteRepo:${owner}/${repo}`);
    },
    async initialCommit(owner, repo, branch, files, message, author) {
      log.push(`initialCommit:${repo}:${branch}`);
      if (opts.failAt === "initialCommit") throw new GithubError(500, "GitHub: boom");
      (github as any).last = { files, message, author };
      return "c".repeat(40);
    },
    async grantAccess(_o, repo, login) {
      log.push(`grantAccess:${repo}:${login}`);
      if (opts.failAt === "grantAccess") throw new GithubError(404, "GitHub: no user");
      return { orgInvited: false, repoAccess: "granted" as const };
    },
  };
  const db: CreateProjectDb = {
    async getProfile(id) {
      return { id, github_login: "simone", github_id: 123, display_name: "Simone Rossi" };
    },
    async slugExists(slug) {
      return opts.takenSlugs?.includes(slug) ?? false;
    },
    async createProjectRecord(a) {
      log.push(`record:${a.slug}:${a.githubRepo}:${a.id}`);
      if (opts.failAt === "record") throw new Error("db giù");
      return a.id;
    },
    async deleteProject(id) {
      log.push(`deleteProject:${id}`);
    },
  };
  return { github, db, log, deps: { github, db, newId: () => PID } };
}

describe("create-project", () => {
  it("crea repo, commit iniziale, accesso e record, in quest'ordine", async () => {
    const f = fakes();
    const r = await createProject({ userId: "u1", name: "Experimental Rocket", description: "Test" }, f.deps);
    expect(r).toMatchObject({ projectId: PID, slug: "experimental-rocket", githubOwner: "rocket-org", githubRepo: "experimental-rocket", repoFullName: "rocket-org/experimental-rocket" });
    expect(f.log).toEqual([
      "createRepo:experimental-rocket",
      "initialCommit:experimental-rocket:main",
      "grantAccess:experimental-rocket:simone",
      `record:experimental-rocket:experimental-rocket:${PID}`,
    ]);
  });

  it("il commit iniziale contiene i file del protocollo e i trailer init, con l'email noreply", async () => {
    const f = fakes();
    await createProject({ userId: "u1", name: "Razzo" }, f.deps);
    const { files, message, author } = (f.github as any).last;
    expect(files.map((x: any) => x.path)).toEqual([".gitattributes", ".gitignore", ".rocketsync/project.json"]);
    expect(files[0].content).toBe("*.ork binary\n* -text\n");
    const ignore = files[1].content.split("\n");
    for (const l of [".rocketsync/local/", "*.tmp", "~$*", "*.swp", "*.bak", "Thumbs.db", "desktop.ini", ".DS_Store", "*.ork-bak"]) expect(ignore).toContain(l);
    expect(JSON.parse(files[2].content)).toEqual({ projectId: PID, schema: 1 });
    const p = parseCommitMessage(message);
    expect(p.version).toBe(0);
    expect(p.kind).toBe("init");
    expect(author).toEqual({ name: "Simone Rossi", email: "123+simone@users.noreply.github.com" });
  });

  it("se qualcosa fallisce a metà annulla ciò che ha creato", async () => {
    for (const failAt of ["initialCommit", "grantAccess", "record"] as const) {
      const f = fakes({ failAt });
      await expect(createProject({ userId: "u1", name: "Razzo" }, f.deps)).rejects.toMatchObject({ status: failAt === "record" ? 500 : 502 });
      expect(f.log).toContain("deleteRepo:rocket-org/razzo");
      expect(f.log.some((l) => l.startsWith("deleteProject"))).toBe(false); // il record non era stato creato
    }
    // Il record non c'è se fallisce la creazione del repository: nulla da annullare
    const f = fakes({ failAt: "createRepo" });
    await expect(createProject({ userId: "u1", name: "Razzo" }, f.deps)).rejects.toMatchObject({ status: 502 });
    expect(f.log.filter((l) => l.startsWith("delete"))).toEqual([]);
  });

  it("evita collisioni di slug e di nome del repository", async () => {
    const f = fakes({ takenSlugs: ["razzo", "razzo-2"], takenRepos: ["razzo-3"] });
    const r = await createProject({ userId: "u1", name: "Razzo" }, f.deps);
    expect(r.slug).toBe("razzo-3");
    expect(r.githubRepo).toBe("razzo-3-2");
  });

  it("valida il nome e richiede il profilo", async () => {
    const f = fakes();
    await expect(createProject({ userId: "u1", name: "   " }, f.deps)).rejects.toMatchObject({ status: 400 });
    await expect(createProject({ userId: "u1", name: "x".repeat(81) }, f.deps)).rejects.toMatchObject({ status: 400 });
    f.db.getProfile = async () => null;
    await expect(createProject({ userId: "u1", name: "Razzo" }, f.deps)).rejects.toMatchObject({ status: 403 });
    expect(f.log).toEqual([]);
  });
});

describe("helper di create-project", () => {
  it("slugify", () => {
    expect(slugify("Experimental Rocket!")).toBe("experimental-rocket");
    expect(slugify("Razzo Città — Prova n°2")).toBe("razzo-citta-prova-n-2");
    expect(slugify("***")).toBe("progetto");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });
  it("identità senza github_id e messaggio di commit", () => {
    expect(commitIdentity({ id: "x", github_login: "lucia", github_id: null, display_name: "" })).toEqual({ name: "lucia", email: "lucia@users.noreply.github.com" });
    expect(initialCommitMessage("0.1.0")).toContain("Rocket-Sync-Client: 0.1.0");
    expect(initialFiles(PID)).toHaveLength(3);
  });
});
