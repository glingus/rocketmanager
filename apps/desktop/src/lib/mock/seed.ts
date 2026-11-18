/** Seed data: 4 people, 3 projects with realistic histories, cards, log and notifications. */
import type { ActivityEntry, Card, CardCategory, CardComment, MemberRole } from '../types/data';
import { dayKey } from '../utils/format';
import { edit, makePayload, makeRocket } from './rocket';
import { comp, type OrkDoc } from './ork';
import {
  cloneContent,
  cloneTree,
  describeChanges,
  makeSha,
  type Commit,
  type Tree,
} from './repo';
import type { MockWorld } from './world';
import { PEOPLE } from './world';

const DAY = 86_400_000;

export const PROJECT_IDS = {
  experimental: 'p-experimental',
  aurora: 'p-aurora',
  vega: 'p-vega',
} as const;

export const F1 = 'Experimental Rocket.ork';
export const F2 = 'Carico utile.ork';
export const F3 = 'Dati banco prova.csv';

type StepOpts = {
  author: string;
  daysAgo: number;
  hour?: number;
  title: string;
  description?: string;
  kind?: Commit['kind'];
  restoreFrom?: number;
  conflictId?: string;
  edit?: (tree: Tree) => void;
};

class History {
  commits: Commit[] = [];
  constructor(
    private readonly key: string,
    private readonly now: number,
    initAuthor: string,
    daysAgo: number,
  ) {
    this.commits.push({
      sha: makeSha(`${key}-init`),
      number: 0,
      kind: 'init',
      title: 'Progetto creato',
      description: null,
      authorId: initAuthor,
      date: new Date(now - daysAgo * DAY).toISOString(),
      tree: {},
      parentSha: null,
      restoredFrom: null,
      conflictId: null,
      published: true,
      changelog: [],
      files: [],
    });
  }

  step(o: StepOpts): Commit {
    const prev = this.commits[this.commits.length - 1]!;
    const number = this.commits.length;
    let tree = cloneTree(prev.tree);
    if (o.restoreFrom != null) tree = cloneTree(this.commits[o.restoreFrom]!.tree);
    o.edit?.(tree);
    const { files, changelog } = describeChanges(prev.tree, tree);
    const date = new Date(this.now - o.daysAgo * DAY - (24 - (o.hour ?? 15)) * 3_600_000 + 12 * 3_600_000).toISOString();
    const commit: Commit = {
      sha: makeSha(`${this.key}-${number}-${o.title}`),
      number,
      kind: o.kind ?? 'publish',
      title: o.title,
      description: o.description ?? null,
      authorId: o.author,
      date,
      tree,
      parentSha: prev.sha,
      restoredFrom: o.restoreFrom ?? null,
      conflictId: o.conflictId ?? null,
      published: true,
      changelog,
      files,
    };
    this.commits.push(commit);
    return commit;
  }
}

function ork(tree: Tree, path: string): OrkDoc {
  const f = tree[path];
  if (!f || f.kind !== 'ork') throw new Error(`${path} is not an ork file`);
  return f.doc;
}

function csvRows(from: number, to: number): string {
  const rows: string[] = [];
  for (let i = from; i <= to; i++) {
    const t = (i * 0.1).toFixed(2);
    const thrust = Math.round(360 * Math.sin((Math.min(i, 22) / 22) * Math.PI * 0.9) + (i > 22 ? 40 - (i - 22) * 6 : 0));
    rows.push(`${t},${Math.max(0, thrust)},${(1 + Math.max(0, thrust) / 22).toFixed(1)}`);
  }
  return rows.join('\n');
}

const CSV_HEAD = 'tempo_s,spinta_N,pressione_bar';

export function buildHistories(now: number): Record<string, Commit[]> {
  const S = 'u-simone';
  const M = 'u-marco';
  const L = 'u-luca';
  const G = 'u-giulia';

  // ---- Experimental Rocket ---------------------------------------------------
  const h1 = new History('exp', now, S, 53);
  h1.step({
    author: M, daysAgo: 52, hour: 18, title: 'Prima versione del razzo',
    description: 'Struttura di base in fibra di vetro, motore da 54 mm.',
    edit: (t) => { t[F1] = { kind: 'ork', doc: makeRocket({ prefix: 'er', rocketName: 'Experimental Rocket', diameter: 0.098, finCount: 3, apogee: 790 }) }; },
  });
  h1.step({
    author: S, daysAgo: 47, hour: 11, title: 'Aggiunto il carico utile',
    edit: (t) => { t[F2] = { kind: 'ork', doc: makePayload('pl') }; },
  });
  h1.step({
    author: L, daysAgo: 41, hour: 21, title: 'Pinne più lunghe',
    description: 'Per recuperare stabilità con il motore J350W.',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-fs1', { rootchord: 0.095, height: 0.08 });
      edit.sim(d, 'er-sim1', { results: { apogee: 845, maxvelocity: 219.8 } });
    },
  });
  h1.step({
    author: G, daysAgo: 36, hour: 16, title: 'Dati del primo banco prova',
    description: 'Prova statica del 12 ottobre, motore J350W.',
    edit: (t) => { t[F3] = { kind: 'text', text: `${CSV_HEAD}\n${csvRows(0, 14)}\n` }; },
  });
  h1.step({
    author: S, daysAgo: 30, hour: 10, title: 'Paracadute principale più grande',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-pc1', { diameter: 1.05, cd: 0.82 });
      edit.sim(d, 'er-sim1', { results: { groundhitvelocity: 5.1 } });
      edit.sim(d, 'er-sim2', { results: { groundhitvelocity: 5.4 } });
    },
  });
  h1.step({
    author: M, daysAgo: 26, hour: 19, title: 'Nuova ogiva Von Kármán',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-nc1', { shape: 'Von Kármán', length: 0.24, mass: 0.092 });
      edit.sim(d, 'er-sim1', { results: { apogee: 851, maxvelocity: 218.6 } });
    },
  });
  h1.step({
    author: L, daysAgo: 21, hour: 14, title: 'Prova con quattro pinne',
    description: 'Esperimento: più pinne ma più corte.',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-fs1', { fincount: 4, rootchord: 0.085 });
      edit.sim(d, 'er-sim1', { results: { apogee: 838 } });
      edit.extra(d, 'photostudio', 3, '<photostudio><camera x="0.31" y="0.18" /></photostudio>');
    },
  });
  h1.step({
    author: S, daysAgo: 17, hour: 9, title: 'Ripristinata la versione 6', kind: 'restore', restoreFrom: 6,
    description: 'Le quattro pinne peggioravano l\u2019apogeo.',
  });
  h1.step({
    author: G, daysAgo: 12, hour: 17, title: 'Nuova massa dell\u2019elettronica',
    description: 'Aggiunto il nuovo flight computer.',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-mc1', { mass: 0.245 });
      edit.sim(d, 'er-sim1', { results: { apogee: 844 } });
      const csv = t[F3];
      if (csv && csv.kind === 'text') csv.text += `${csvRows(15, 24)}\n`;
    },
  });
  h1.step({
    author: M, daysAgo: 8, hour: 12, title: 'Nastro di recupero per il carico utile',
    edit: (t) => {
      const d = ork(t, F2);
      edit.add(d, 'pl-bt1', comp('pl-sh1', 'streamer', 'Nastro di recupero', { length: 0.9, diameter: 0.05, cd: 0.4 }));
      edit.sim(d, 'pl-sim1', { results: { groundhitvelocity: 4.6 } });
    },
  });
  h1.step({
    author: L, daysAgo: 5, hour: 20, title: 'Risoluzione conflitto su Experimental Rocket.ork',
    kind: 'conflictResolution', conflictId: '20261113-a8f3kq',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-pc1', { cordlength: 1.8 });
      edit.param(d, 'er-fs1', { sweeplength: 0.035 });
    },
  });
  h1.step({
    author: M, daysAgo: 3, hour: 15, title: 'Tubo del motore più lungo',
    description: 'Serve spazio per il motore da 54 mm lungo.',
    edit: (t) => {
      const d = ork(t, F1);
      edit.param(d, 'er-bt2', { length: 0.56 });
      edit.config(d, 'er-cfg1', { ejectiondelay: 12 });
      edit.sim(d, 'er-sim1', { results: { apogee: 859, flighttime: 80.4 } });
    },
  });

  // ---- Aurora Sounding -------------------------------------------------------
  const A = 'au';
  const AF = 'Aurora.ork';
  const h2 = new History('aur', now, M, 41);
  h2.step({
    author: M, daysAgo: 40, hour: 10, title: 'Primo progetto a due stadi',
    edit: (t) => { t[AF] = { kind: 'ork', doc: makeRocket({ prefix: A, rocketName: 'Aurora Sounding', diameter: 0.115, finCount: 4, twoStage: true, apogee: 2350 }) }; },
  });
  h2.step({
    author: L, daysAgo: 33, hour: 15, title: 'Booster più lungo',
    edit: (t) => { const d = ork(t, AF); edit.param(d, 'au-bt3', { length: 0.52 }); edit.sim(d, 'au-sim1', { results: { apogee: 2410 } }); },
  });
  h2.step({
    author: M, daysAgo: 27, hour: 18, title: 'Pinne del booster maggiorate',
    edit: (t) => { const d = ork(t, AF); edit.param(d, 'au-fs2', { rootchord: 0.125, height: 0.1 }); edit.sim(d, 'au-sim1', { results: { apogee: 2385 } }); },
  });
  h2.step({
    author: S, daysAgo: 19, hour: 11, title: 'Paracadute di recupero',
    edit: (t) => { const d = ork(t, AF); edit.param(d, 'au-pc1', { diameter: 1.2, deployaltitude: 250 }); edit.sim(d, 'au-sim1', { results: { groundhitvelocity: 4.8 } }); },
  });
  h2.step({
    author: L, daysAgo: 13, hour: 16, title: 'Simulazione con vento forte',
    edit: (t) => { const d = ork(t, AF); edit.sim(d, 'au-sim2', { conditions: { windspeed: 10 }, results: { apogee: 2110 } }); },
  });
  h2.step({
    author: M, daysAgo: 6, hour: 9, title: 'Aggiornamento masse',
    edit: (t) => { const d = ork(t, AF); edit.param(d, 'au-mc1', { mass: 0.26 }); edit.sim(d, 'au-sim1', { results: { apogee: 2362 } }); },
  });
  h2.step({
    author: L, daysAgo: 2, hour: 19, title: 'Nuovo motore del booster',
    edit: (t) => {
      const d = ork(t, AF);
      d.configs.push({ id: 'au-cfg3', name: 'Cesaroni K550', params: [{ key: 'motor', value: 'K550' }, { key: 'ejectiondelay', value: '12' }] });
    },
  });

  // ---- Vega Booster ----------------------------------------------------------
  const VF = 'Vega.ork';
  const h3 = new History('vega', now, G, 31);
  h3.step({
    author: G, daysAgo: 30, hour: 14, title: 'Primo schema del booster',
    edit: (t) => { t[VF] = { kind: 'ork', doc: makeRocket({ prefix: 've', rocketName: 'Vega Booster', diameter: 0.075, finCount: 3, apogee: 480 }) }; },
  });
  h3.step({
    author: L, daysAgo: 22, hour: 17, title: 'Ogiva stampata in 3D',
    edit: (t) => { const d = ork(t, VF); edit.param(d, 've-nc1', { material: 'PLA', mass: 0.052 }); edit.sim(d, 've-sim1', { results: { apogee: 495 } }); },
  });
  h3.step({
    author: S, daysAgo: 14, hour: 10, title: 'Pinne in fibra di vetro',
    edit: (t) => { const d = ork(t, VF); edit.param(d, 've-fs1', { material: 'Fibra di vetro', thickness: 0.002 }); },
  });
  h3.step({
    author: G, daysAgo: 8, hour: 13, title: 'Rampa di lancio più lunga',
    edit: (t) => { const d = ork(t, VF); edit.sim(d, 've-sim1', { conditions: { launchrodlength: 3 }, results: { apogee: 503, maxvelocity: 188.2 } }); },
  });
  h3.step({
    author: S, daysAgo: 3, hour: 18, title: 'Taratura del paracadute',
    edit: (t) => { const d = ork(t, VF); edit.param(d, 've-pc1', { diameter: 0.75, deployaltitude: 200 }); },
  });

  return {
    [PROJECT_IDS.experimental]: h1.commits,
    [PROJECT_IDS.aurora]: h2.commits,
    [PROJECT_IDS.vega]: h3.commits,
  };
}

// ---- Cards -------------------------------------------------------------------

export const DEFAULT_CATEGORIES: Array<{ key: string; name: string; icon: string }> = [
  { key: 'nota', name: 'Nota', icon: 'sticky-note' },
  { key: 'problema', name: 'Problema', icon: 'triangle-alert' },
  { key: 'attivita', name: 'Attività', icon: 'list-checks' },
  { key: 'acquisto', name: 'Acquisto', icon: 'shopping-cart' },
  { key: 'idea', name: 'Idea', icon: 'lightbulb' },
  { key: 'osservazione', name: 'Osservazione tecnica', icon: 'microscope' },
];

export function defaultCategories(world: MockWorld, projectId: string): CardCategory[] {
  return DEFAULT_CATEGORIES.map((c, i) => ({
    id: `cat-${projectId}-${c.key}`,
    projectId,
    name: c.name,
    icon: c.icon,
    sort: i,
    isDefault: true,
  })).map((c) => {
    void world;
    return c;
  });
}

function dateOffset(days: number): string {
  return dayKey(Date.now() + days * DAY);
}

export function seedProjects(world: MockWorld, now: number): void {
  const iso = (daysAgo: number, hour = 12) => new Date(now - daysAgo * DAY - (12 - hour) * 3_600_000).toISOString();
  const policy = { mode: 'assisted', idleMinutes: 10 } as const;

  world.profiles = PEOPLE.map((p, i) => ({
    id: p.id,
    githubId: 1001 + i,
    githubLogin: p.login,
    displayName: p.name,
    avatarUrl: null,
    avatarColor: p.color,
  }));

  const mk = (id: string, name: string, slug: string, description: string, createdBy: string, daysAgo: number) => {
    world.projects.push({
      id,
      name,
      slug,
      description,
      githubOwner: 'rocketsync-team',
      githubRepo: slug,
      defaultBranch: 'main',
      createdBy,
      createdAt: iso(daysAgo),
      archivedAt: null,
      settings: { publishPolicy: { ...policy }, activityRetention: 100 },
    });
  };
  mk(PROJECT_IDS.experimental, 'Experimental Rocket', 'experimental-rocket', 'Razzo sperimentale da 98 mm per il lancio di primavera, con carico utile e recupero a doppio paracadute.', 'u-simone', 53);
  mk(PROJECT_IDS.aurora, 'Aurora Sounding', 'aurora-sounding', 'Razzo sonda a due stadi per misure di pressione e temperatura in quota.', 'u-marco', 41);
  mk(PROJECT_IDS.vega, 'Vega Booster', 'vega-booster', 'Booster compatto per i test dei motori ibridi del secondo semestre.', 'u-giulia', 31);

  const member = (projectId: string, userId: string, role: MemberRole, daysAgo: number, lastActive: number) => {
    world.members.push({ projectId, userId, role, addedAt: iso(daysAgo), lastActivityAt: new Date(now - lastActive * 60_000).toISOString() });
  };
  member(PROJECT_IDS.experimental, 'u-simone', 'admin', 53, 6);
  member(PROJECT_IDS.experimental, 'u-marco', 'member', 52, 190);
  member(PROJECT_IDS.experimental, 'u-luca', 'member', 41, 60 * 30);
  member(PROJECT_IDS.experimental, 'u-giulia', 'member', 36, 60 * 24 * 4);
  member(PROJECT_IDS.aurora, 'u-marco', 'admin', 41, 190);
  member(PROJECT_IDS.aurora, 'u-simone', 'member', 19, 6);
  member(PROJECT_IDS.aurora, 'u-luca', 'member', 33, 60 * 30);
  member(PROJECT_IDS.vega, 'u-simone', 'admin', 14, 6);
  member(PROJECT_IDS.vega, 'u-giulia', 'member', 31, 60 * 24 * 4);
  member(PROJECT_IDS.vega, 'u-luca', 'member', 22, 60 * 30);

  world.invitations.push({
    id: 'inv-1', projectId: PROJECT_IDS.experimental, githubLogin: 'fbianchi', role: 'member', status: 'pending', createdAt: iso(1),
  });

  for (const p of world.projects) world.categories.push(...defaultCategories(world, p.id));
  world.categories.push({ id: `cat-${PROJECT_IDS.experimental}-sicurezza`, projectId: PROJECT_IDS.experimental, name: 'Sicurezza', icon: 'shield', sort: 6, isDefault: false });

  world.discord.set(PROJECT_IDS.experimental, { projectId: PROJECT_IDS.experimental, enabledEventTypes: world.eventTypes.filter((e) => e.discordDefault).map((e) => e.type), webhookConfigured: true, updatedAt: iso(30) });
  world.discord.set(PROJECT_IDS.aurora, { projectId: PROJECT_IDS.aurora, enabledEventTypes: world.eventTypes.filter((e) => e.discordDefault).map((e) => e.type), webhookConfigured: false, updatedAt: null });
  world.discord.set(PROJECT_IDS.vega, { projectId: PROJECT_IDS.vega, enabledEventTypes: ['conflict.detected', 'conflict.resolved', 'version.published'], webhookConfigured: true, updatedAt: iso(12) });

  // ---- cards
  let pos = 0;
  const cat = (p: string, k: string) => `cat-${p}-${k}`;
  const card = (c: Partial<Card> & Pick<Card, 'projectId' | 'title'>): Card => {
    pos += 1000;
    const created = c.createdAt ?? iso(5);
    const full: Card = {
      id: world.uid('card'),
      description: '',
      color: 'crema',
      priority: null,
      categoryId: null,
      status: 'open',
      createdBy: 'u-simone',
      assigneeId: null,
      dueDate: null,
      position: pos,
      linkedVersion: null,
      convertedAt: null,
      createdAt: created,
      updatedAt: created,
      completedAt: null,
      ...c,
    };
    world.cards.push(full);
    return full;
  };
  const E = PROJECT_IDS.experimental;
  card({ projectId: E, title: 'Verificare il peso dell\u2019ogiva Von Kármán', description: 'Pesare l\u2019ogiva stampata e confrontarla con la massa dichiarata in OpenRocket (92 g).', color: 'ottone', priority: 'medium', categoryId: cat(E, 'osservazione'), createdBy: 'u-marco', createdAt: iso(4) });
  const crit = card({ projectId: E, title: 'Cedimento del giunto paracadute al test di trazione', description: 'Il cordino si è sfilato dal giunto a 38 kg. Rifare il nodo e ripetere la prova con il Kevlar da 3 mm.', color: 'ruggine', priority: 'critical', categoryId: cat(E, 'problema'), createdBy: 'u-luca', assigneeId: 'u-luca', dueDate: dateOffset(2), status: 'in_progress', convertedAt: iso(3), linkedVersion: 11, createdAt: iso(3) });
  card({ projectId: E, title: 'Ordinare motori Cesaroni I285 (x4)', description: 'Preventivo del fornitore valido fino a venerdì.', color: 'cobalto', priority: 'medium', categoryId: cat(E, 'acquisto'), createdBy: 'u-simone', assigneeId: 'u-simone', dueDate: dateOffset(5), convertedAt: iso(2), createdAt: iso(2) });
  card({ projectId: E, title: 'Idea: paratia stampata in 3D per separare il vano elettronica', color: 'prugna', priority: 'low', categoryId: cat(E, 'idea'), createdBy: 'u-giulia', createdAt: iso(6) });
  const overdue = card({ projectId: E, title: 'Allineare le pinne con la dima', color: 'oliva', priority: 'high', categoryId: cat(E, 'attivita'), createdBy: 'u-marco', assigneeId: 'u-marco', dueDate: dateOffset(-2), status: 'in_progress', convertedAt: iso(7), createdAt: iso(7) });
  card({ projectId: E, title: 'Controllare il tracking del GPS prima del lancio', color: 'petrolio', priority: 'high', categoryId: cat(E, 'attivita'), createdBy: 'u-simone', assigneeId: 'u-giulia', dueDate: dateOffset(1), convertedAt: iso(1), createdAt: iso(1) });
  card({ projectId: E, title: 'Il ritardo di espulsione di 14 s sembra troppo lungo', description: 'Dalle simulazioni l\u2019apogeo arriva a circa 11 s. Da rivedere con i dati del banco prova.', color: 'crema', categoryId: cat(E, 'nota'), createdBy: 'u-luca', createdAt: iso(2) });
  card({ projectId: E, title: 'Pulire il banco prova e archiviare i dati', color: 'grafite', priority: 'low', categoryId: cat(E, 'attivita'), createdBy: 'u-giulia', assigneeId: 'u-giulia', status: 'completed', completedAt: iso(9), convertedAt: iso(12), createdAt: iso(13) });
  const leak = card({ projectId: E, title: 'Perdite di pressione nel vano motore', description: 'Si vede del fumo dalla ghiera inferiore durante la prova statica.', color: 'rame', priority: 'high', categoryId: cat(E, 'problema'), createdBy: 'u-giulia', linkedVersion: 12, createdAt: iso(1) });
  card({ projectId: E, title: 'Comprare nastro Kevlar per il cordino', color: 'acciaio', priority: 'low', categoryId: cat(E, 'acquisto'), createdBy: 'u-marco', assigneeId: 'u-marco', status: 'completed', completedAt: iso(10), convertedAt: iso(15), createdAt: iso(16) });
  card({ projectId: E, title: 'Revisione della checklist di lancio', color: 'ottone', priority: 'medium', categoryId: cat(E, 'attivita'), createdBy: 'u-simone', assigneeId: 'u-luca', dueDate: dateOffset(9), convertedAt: iso(2), createdAt: iso(2) });
  card({ projectId: E, title: 'Foto del banco prova per il report', color: 'acciaio', categoryId: cat(E, 'nota'), createdBy: 'u-giulia', status: 'archived', createdAt: iso(20) });
  card({ projectId: E, title: 'Permesso di lancio al campo di Aprilia', description: 'Serve la conferma scritta del responsabile del campo entro due settimane.', color: 'cobalto', priority: 'critical', categoryId: cat(E, 'sicurezza'), createdBy: 'u-simone', assigneeId: 'u-simone', dueDate: dateOffset(12), convertedAt: iso(4), createdAt: iso(4) });

  const A = PROJECT_IDS.aurora;
  card({ projectId: A, title: 'Verificare la separazione degli stadi', description: 'Ripetere la prova a terra con la carica ridotta.', color: 'ruggine', priority: 'high', categoryId: cat(A, 'problema'), createdBy: 'u-luca', assigneeId: 'u-marco', dueDate: dateOffset(3), convertedAt: iso(2), createdAt: iso(2) });
  card({ projectId: A, title: 'Sensore di pressione BMP388', color: 'cobalto', priority: 'medium', categoryId: cat(A, 'acquisto'), createdBy: 'u-marco', createdAt: iso(5) });
  card({ projectId: A, title: 'Idea: registrare la temperatura a ogni 500 m', color: 'prugna', categoryId: cat(A, 'idea'), createdBy: 'u-simone', createdAt: iso(7) });
  card({ projectId: A, title: 'Aggiornare il piano di volo', color: 'oliva', priority: 'low', categoryId: cat(A, 'attivita'), createdBy: 'u-marco', assigneeId: 'u-luca', dueDate: dateOffset(7), convertedAt: iso(3), createdAt: iso(3) });
  card({ projectId: A, title: 'Nota: il vento sopra i 25 km/h annulla il lancio', color: 'crema', categoryId: cat(A, 'nota'), createdBy: 'u-marco', createdAt: iso(9) });

  const V = PROJECT_IDS.vega;
  card({ projectId: V, title: 'Il file Vega.ork non si apre dopo la fusione', description: 'Due persone hanno cambiato la corda alla radice delle pinne.', color: 'ruggine', priority: 'critical', categoryId: cat(V, 'problema'), createdBy: 'u-giulia', createdAt: iso(0) });
  card({ projectId: V, title: 'Stampare le pinne di riserva', color: 'oliva', priority: 'medium', categoryId: cat(V, 'attivita'), createdBy: 'u-simone', assigneeId: 'u-luca', dueDate: dateOffset(4), convertedAt: iso(2), createdAt: iso(2) });
  card({ projectId: V, title: 'Prova di tenuta del serbatoio', color: 'petrolio', priority: 'high', categoryId: cat(V, 'attivita'), createdBy: 'u-giulia', assigneeId: 'u-giulia', dueDate: dateOffset(6), convertedAt: iso(2), createdAt: iso(2) });
  card({ projectId: V, title: 'Idea: valvola di sfiato con molla regolabile', color: 'prugna', priority: 'low', categoryId: cat(V, 'idea'), createdBy: 'u-luca', createdAt: iso(4) });

  const comment = (cardId: string, authorId: string, body: string, daysAgo: number, hour = 12): CardComment => {
    const c: CardComment = { id: world.uid('cm'), cardId, authorId, body, createdAt: iso(daysAgo, hour), editedAt: null };
    world.comments.push(c);
    return c;
  };
  comment(crit.id, 'u-simone', 'Hai provato con il nodo a otto doppio? Lo usano nei razzi di Aprilia.', 2, 17);
  comment(crit.id, 'u-luca', 'Sì, regge fino a 52 kg ma il Kevlar si taglia sul bordo del giunto. Provo con un anello di rinforzo.', 2, 19);
  comment(crit.id, 'u-marco', 'Ho il filo di nylon da 4 mm in officina, passo a portarlo domani.', 1, 9);
  comment(overdue.id, 'u-simone', 'La dima è in armadio, secondo ripiano.', 3, 10);
  comment(leak.id, 'u-luca', 'Potrebbe essere l\u2019O-ring della ghiera: lo controllo oggi.', 0, 8);

  world.attachments.push(
    { id: world.uid('att'), cardId: crit.id, storagePath: `${E}/${crit.id}/prova-trazione.pdf`, filename: 'prova-trazione.pdf', sizeBytes: 1_250_000, mimeType: 'application/pdf', uploadedBy: 'u-luca', createdAt: iso(3), blobUrl: null },
    { id: world.uid('att'), cardId: leak.id, storagePath: `${E}/${leak.id}/foto-giunto.jpg`, filename: 'foto-giunto.jpg', sizeBytes: 842_000, mimeType: 'image/jpeg', uploadedBy: 'u-giulia', createdAt: iso(1), blobUrl: null },
  );

  // ---- file claims (who is working on what)
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  world.claims.push(
    { projectId: E, userId: 'u-marco', path: F2, kind: 'editing', note: null, machineId: 'pc-marco', startedAt: minutesAgo(52), heartbeatAt: minutesAgo(2), expiresAt: null },
    { projectId: E, userId: 'u-giulia', path: F3, kind: 'reserved', note: 'Aggiungo le prove di venerdì', machineId: 'pc-giulia', startedAt: minutesAgo(60 * 20), heartbeatAt: minutesAgo(60 * 20), expiresAt: new Date(now + 18 * 3_600_000).toISOString() },
    { projectId: E, userId: 'u-luca', path: F1, kind: 'editing', note: null, machineId: 'pc-luca', startedAt: minutesAgo(130), heartbeatAt: minutesAgo(25), expiresAt: null },
  );
}

/** Extra activity that does not come from versions (cards, conflicts, files). */
export function seedActivity(world: MockWorld, now: number): void {
  const at = (daysAgo: number, hour: number) => new Date(now - daysAgo * DAY - (12 - hour) * 3_600_000).toISOString();
  const E = PROJECT_IDS.experimental;
  const cards = world.cards.filter((c) => c.projectId === E);
  const byTitle = (s: string) => cards.find((c) => c.title.startsWith(s));
  const crit = byTitle('Cedimento');
  const leak = byTitle('Perdite');
  const overdue = byTitle('Allineare');
  world.emitEvent(E, 'conflict.detected', { files: [F1], fileCount: 1, conflictId: '20261113-a8f3kq' }, { actorId: 'u-luca', at: at(6, 19) });
  world.emitEvent(E, 'file.editing_started', { path: F2 }, { actorId: 'u-marco', at: at(0, 11) });
  if (crit) {
    world.emitEvent(E, 'card.important', { title: crit.title, cardId: crit.id, priority: 'critical' }, { actorId: 'u-luca', at: at(3, 18) });
    world.emitEvent(E, 'card.commented', { title: crit.title, cardId: crit.id }, { actorId: 'u-luca', at: at(2, 19) });
  }
  if (leak) world.emitEvent(E, 'card.important', { title: leak.title, cardId: leak.id, priority: 'high' }, { actorId: 'u-giulia', at: at(1, 8) });
  if (overdue) world.emitEvent(E, 'card.assigned', { title: overdue.title, cardId: overdue.id }, { actorId: 'u-simone', at: at(7, 10), recipients: ['u-marco'] });
  world.emitEvent(E, 'card.created', { title: 'Revisione della checklist di lancio' }, { actorId: 'u-simone', at: at(2, 14) });
  world.emitEvent(E, 'card.completed', { title: 'Pulire il banco prova e archiviare i dati' }, { actorId: 'u-giulia', at: at(9, 17) });
  world.emitEvent(E, 'member.added', { targetName: 'Giulia Rinaldi', role: 'member' }, { actorId: 'u-simone', at: at(36, 9) });
  world.emitEvent(E, 'card.assigned', { title: 'Controllare il tracking del GPS prima del lancio' }, { actorId: 'u-simone', at: at(1, 12), recipients: ['u-giulia'] });
  world.emitEvent(PROJECT_IDS.aurora, 'card.important', { title: 'Verificare la separazione degli stadi', priority: 'high' }, { actorId: 'u-luca', at: at(2, 16) });
  world.emitEvent(PROJECT_IDS.vega, 'member.added', { targetName: 'Luca Conti', role: 'member' }, { actorId: 'u-giulia', at: at(22, 15) });

  world.conflictRecords.push({
    id: '20261113-a8f3kq',
    projectId: E,
    files: [{ path: F1, kind: 'bothModified' }],
    oursUserId: 'u-luca',
    theirsUserId: 'u-marco',
    theirsVersion: 10,
    status: 'resolved',
    resolvedBy: 'u-luca',
    resolvedVersion: 11,
    createdAt: at(6, 19),
    resolvedAt: at(5, 20),
  });

  // Keep notifications believable: everything is read except the most recent few.
  const sorted = [...world.notifications].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  sorted.forEach((n, i) => {
    if (i >= 5) n.readAt = new Date(Date.parse(n.createdAt) + 3_600_000).toISOString();
  });
}

export function cloneHistory(commits: Commit[]): Commit[] {
  return commits.map((c) => ({ ...c, tree: cloneTree(c.tree) }));
}

export function cloneTreeContents(tree: Tree): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(tree)) out[k] = cloneContent(v);
  return out;
}

export type { ActivityEntry };
