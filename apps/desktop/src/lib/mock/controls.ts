/**
 * High level "what if" actions for the mock world. They back the Simulatore panel shown in
 * mock mode and the Playwright flows, so every situation of the sync protocol can be reproduced.
 */
import { edit } from './rocket';
import { walk, setParam, type OrkDoc } from './ork';
import { colleaguePublish } from './scenario';
import { PROJECT_IDS } from './seed';
import type { MockWorld } from './world';
import type { Tree } from './repo';

export function mainFile(world: MockWorld, projectId: string): string {
  const sim = world.sim(projectId);
  const paths = Object.keys(sim.head().tree);
  return paths.find((p) => p.endsWith('.ork') && !p.startsWith('Carico')) ?? paths[0] ?? 'Razzo.ork';
}

function finsetOf(doc: OrkDoc) {
  for (const { component } of walk(doc.stages)) if (component.type === 'trapezoidfinset') return component;
  return undefined;
}

function bumpDoc(doc: OrkDoc, step: number): void {
  const fins = finsetOf(doc);
  if (fins) {
    const current = Number(fins.params.find((p) => p.key === 'rootchord')?.value ?? 0.08);
    setParam(fins.params, 'rootchord', (current + 0.005 * step).toFixed(3));
  }
  const sim = doc.sims[0];
  if (sim) {
    const apogee = Number(sim.results.find((p) => p.key === 'apogee')?.value ?? 800);
    setParam(sim.results, 'apogee', apogee + 4 * step);
    sim.dataRev += 1;
  }
}

let counter = 1;

export const controls = {
  /** Simulates OpenRocket saving the main file (changes fins + simulation). */
  save(world: MockWorld, projectId: string, path?: string): void {
    const sim = world.sim(projectId);
    const file = path ?? mainFile(world, projectId);
    const step = counter++;
    sim.save(file, (c) => {
      if (c && c.kind === 'ork') {
        bumpDoc(c.doc, step);
        return c;
      }
      if (c && c.kind === 'text') return { kind: 'text', text: `${c.text}${step}.0,0,1.0\n` };
      throw new Error(`cannot edit ${file}`);
    });
  },

  /** A truncated ZIP: the file must not enter any version. */
  saveInvalid(world: MockWorld, projectId: string): void {
    const sim = world.sim(projectId);
    const file = mainFile(world, projectId);
    const step = counter++;
    sim.save(
      file,
      (c) => {
        if (c && c.kind === 'ork') bumpDoc(c.doc, step);
        return c ?? { kind: 'text', text: '' };
      },
      { invalid: 'archivio ZIP troncato' },
    );
  },

  /** A colleague publishes a change that does not overlap with local edits (parachute). */
  colleaguePublish(world: MockWorld, projectId: string, authorId = 'u-marco'): void {
    const path = projectId === PROJECT_IDS.vega ? 'Vega.ork' : projectId === PROJECT_IDS.aurora ? 'Aurora.ork' : 'Carico utile.ork';
    colleaguePublish(world, projectId, authorId, 'Paracadute di recupero più piccolo', (t: Tree) => {
      const f = t[path];
      if (!f || f.kind !== 'ork') return;
      for (const { component } of walk(f.doc.stages)) {
        if (component.type === 'parachute') {
          edit.param(f.doc, component.id, { diameter: 0.8, deployaltitude: 220 });
          break;
        }
      }
    });
  },

  /** A colleague changes the same parameter the user changed locally -> conflict. */
  colleagueOverlap(world: MockWorld, projectId: string, authorId = 'u-marco'): void {
    const path = mainFile(world, projectId);
    colleaguePublish(world, projectId, authorId, 'Pinne più grandi per la stabilità', (t: Tree) => {
      const f = t[path];
      if (!f || f.kind !== 'ork') return;
      const fins = finsetOf(f.doc);
      if (fins) edit.param(f.doc, fins.id, { rootchord: 0.115, sweeplength: 0.04 });
      edit.sim(f.doc, f.doc.sims[0]!.id, { results: { apogee: 889 } });
    });
  },

  editorOpen(world: MockWorld, projectId: string, files: string[] | null): void {
    world.sim(projectId).setEditor(true, files);
  },

  editorClose(world: MockWorld, projectId: string): void {
    world.sim(projectId).setEditor(false);
  },

  offline(world: MockWorld, value: boolean): void {
    world.setOffline(value);
  },

  appUpdate(world: MockWorld): void {
    world.updateInfo = { available: true, version: '0.2.0', notes: 'Miglioramenti alla risoluzione dei conflitti e al Version History.' };
  },
};

export type MockControls = typeof controls;

declare global {
  interface Window {
    __mock?: { world: MockWorld; controls: MockControls };
  }
}

export function installGlobalControls(world: MockWorld): void {
  if (typeof window === 'undefined') return;
  window.__mock = { world, controls };
}
