import { MockWorld, type WorldOptions } from './world';
import { DEFAULT_FOLDERS, applyReadyScenario, seedWorld } from './scenario';
import { PROJECT_IDS } from './seed';

export { MockWorld, PROJECT_IDS, DEFAULT_FOLDERS };
export type { WorldOptions };

/** Creates a seeded world. `world.ready` resolves once the optional demo scenario is applied. */
export function createMockWorld(opts: Partial<WorldOptions> = {}): MockWorld {
  const world = new MockWorld(opts);
  seedWorld(world);
  world.ready = (async () => {
    if (world.opts.seed === 'ready') {
      await applyReadyScenario(world);
      return;
    }
    const saved = world.restoreSession();
    if (saved.signedIn) {
      world.signedIn = true;
      for (const [id, info] of saved.linked) {
        if (world.projects.some((p) => p.id === id)) {
          world.linkedFolders.set(id, info);
          world.ensureSim(id, info.folder);
        }
      }
    }
  })();
  return world;
}

let singleton: MockWorld | null = null;

/** Process-wide world used by the mock backend and the mock data service. */
export function getMockWorld(): MockWorld {
  if (!singleton) {
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const ready = params.get('ready') === '1' || params.get('mock') === 'ready';
    const instant = params.get('instant') === '1';
    singleton = createMockWorld({ seed: ready ? 'ready' : 'fresh', speed: instant ? 0 : 1, persist: !ready });
    if (typeof window !== 'undefined') (window as unknown as { __mockWorld?: MockWorld }).__mockWorld = singleton;
  }
  return singleton;
}

export function resetMockWorld(opts: Partial<WorldOptions> = {}): MockWorld {
  singleton?.dispose();
  singleton = createMockWorld(opts);
  return singleton;
}
