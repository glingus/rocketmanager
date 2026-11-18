/** Scripted situations used by the demo seed, the dev panel and the e2e tests. */
import { edit } from './rocket';
import { F1, F2, F3, PROJECT_IDS, buildHistories, seedActivity, seedProjects } from './seed';
import {
  cloneTree,
  describeChanges,
  makeSha,
  type Commit,
  type FileContent,
  type Tree,
} from './repo';
import type { OrkDoc } from './ork';
import type { MockWorld } from './world';
import { PEOPLE } from './world';

/** A colleague publishes a version on the server (what the GitHub webhook would record). */
export function colleaguePublish(
  world: MockWorld,
  projectId: string,
  authorId: string,
  title: string,
  mutate: (tree: Tree) => void,
  description: string | null = null,
): Commit {
  const cloud = world.cloud.get(projectId)!;
  const tip = cloud[cloud.length - 1]!;
  const tree = cloneTree(tip.tree);
  mutate(tree);
  const number = (tip.number ?? 0) + 1;
  const { files, changelog } = describeChanges(tip.tree, tree);
  const commit: Commit = {
    sha: makeSha(`colleague-${projectId}-${number}-${title}`),
    number,
    kind: 'publish',
    title,
    description,
    authorId,
    date: world.iso(),
    tree,
    parentSha: tip.sha,
    restoredFrom: null,
    conflictId: null,
    published: true,
    changelog,
    files,
  };
  cloud.push(commit);
  world.recordVersion(projectId, commit);
  world.touchMember(projectId, authorId);
  const sim = world.sims.get(projectId);
  // The realtime "new version" notification makes the app fetch right away.
  if (sim) world.later(() => void sim.fetchTick(), 700);
  return commit;
}

function orkOf(tree: Tree, path: string): OrkDoc {
  const f: FileContent | undefined = tree[path];
  if (!f || f.kind !== 'ork') throw new Error(`${path} is not an ork file`);
  return f.doc;
}

export const scenarios = {
  /** Marco changes the paracadute of Experimental Rocket (non overlapping with typical local edits). */
  colleagueChangesParachute(world: MockWorld, projectId: string = PROJECT_IDS.experimental, authorId = 'u-marco') {
    return colleaguePublish(world, projectId, authorId, 'Paracadute di recupero più piccolo', (t) => {
      const path = projectId === PROJECT_IDS.vega ? 'Vega.ork' : projectId === PROJECT_IDS.aurora ? 'Aurora.ork' : F2;
      const doc = orkOf(t, path);
      const first = doc.stages[0]!.children.flatMap((c) => [c, ...c.children]).find((c) => c.type === 'parachute');
      if (first) edit.param(doc, first.id, { diameter: 0.8, deployaltitude: 220 });
    });
  },
  /** A colleague edits the main rocket file (can overlap with local edits -> conflict). */
  colleagueEditsRocket(world: MockWorld, projectId: string, authorId: string, values: Record<string, string | number>, compId: string, path: string) {
    return colleaguePublish(world, projectId, authorId, 'Aggiornate le pinne', (t) => {
      edit.param(orkOf(t, path), compId, values);
    });
  },
};

/** Builds the demo world: cloud data for every project. */
export function seedWorld(world: MockWorld): void {
  const now = world.now();
  seedProjects(world, now);
  const histories = buildHistories(now);
  for (const [projectId, commits] of Object.entries(histories)) {
    world.cloud.set(projectId, commits);
    for (const c of commits) world.recordVersion(projectId, c);
  }
  seedActivity(world, now);
}

export const DEFAULT_FOLDERS: Record<string, string> = {
  [PROJECT_IDS.experimental]: 'C:\\Users\\simone\\RocketSync\\Experimental Rocket',
  [PROJECT_IDS.aurora]: 'C:\\Users\\simone\\RocketSync\\Aurora Sounding',
  [PROJECT_IDS.vega]: 'C:\\Users\\simone\\RocketSync\\Vega Booster',
};

/** "Ready" scenario: all projects linked, local changes on one, an open conflict on another. */
export async function applyReadyScenario(world: MockWorld): Promise<void> {
  const speed = world.opts.speed;
  world.opts.speed = 0;
  try {
    world.signedIn = true;
    for (const [id, folder] of Object.entries(DEFAULT_FOLDERS)) {
      const project = world.project(id);
      world.linkedFolders.set(id, { folder, repoFullName: `${project.githubOwner}/${project.githubRepo}`, linkedAt: world.iso(-10 * 86_400_000) });
      world.ensureSim(id, folder);
    }
    // Experimental Rocket: two files saved a few minutes ago -> "Modifiche non pubblicate"
    const exp = world.sim(PROJECT_IDS.experimental);
    exp.save(F1, (c) => {
      if (!c || c.kind !== 'ork') throw new Error('missing rocket');
      edit.param(c.doc, 'er-bt2', { length: 0.6 });
      edit.param(c.doc, 'er-fs1', { rootchord: 0.1 });
      edit.sim(c.doc, 'er-sim1', { results: { apogee: 871, maxvelocity: 224.1 } });
      return c;
    }, { at: world.now() - 190_000 });
    exp.save(F3, (c) => {
      const text = c && c.kind === 'text' ? c.text : '';
      return { kind: 'text', text: `${text}15.0,0,1.0\n15.1,0,1.0\n` };
    }, { at: world.now() - 185_000 });
    exp.lastSaveAt = world.now() - 180_000;

    // Vega Booster: local edit + colleague edit on the same parameter -> conflict
    const vega = world.sim(PROJECT_IDS.vega);
    vega.save('Vega.ork', (c) => {
      if (!c || c.kind !== 'ork') throw new Error('missing rocket');
      edit.param(c.doc, 've-fs1', { rootchord: 0.1, tipchord: 0.045 });
      edit.param(c.doc, 've-nc1', { length: 0.17 });
      edit.sim(c.doc, 've-sim1', { results: { apogee: 515 } });
      return c;
    }, { at: world.now() - 40 * 60_000 });
    colleaguePublish(world, PROJECT_IDS.vega, 'u-giulia', 'Pinne più larghe e ogiva più lunga', (t) => {
      const d = orkOf(t, 'Vega.ork');
      edit.param(d, 've-fs1', { rootchord: 0.105, sweeplength: 0.04 });
      edit.param(d, 've-nc1', { length: 0.19 });
      edit.sim(d, 've-sim1', { results: { apogee: 509 } });
    }, 'Più superficie alare per stabilizzare il volo.');
    await vega.fetchTick();
    const conflict = vega.openConflicts()[0]?.conflict;
    if (conflict) {
      world.conflictRecords.push({
        id: conflict.id,
        projectId: PROJECT_IDS.vega,
        files: conflict.files.map((f) => ({ path: f.path, kind: f.kind })),
        oursUserId: world.me.id,
        theirsUserId: 'u-giulia',
        theirsVersion: conflict.theirsVersion,
        status: 'open',
        resolvedBy: null,
        resolvedVersion: null,
        createdAt: conflict.createdAt,
        resolvedAt: null,
      });
      world.emitEvent(PROJECT_IDS.vega, 'conflict.detected', { files: conflict.files.map((f) => f.path), fileCount: conflict.files.length, conflictId: conflict.id }, { actorId: 'u-giulia' });
    }
    void PEOPLE;
  } finally {
    world.opts.speed = speed;
  }
}
