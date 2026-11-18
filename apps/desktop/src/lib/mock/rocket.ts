import { comp, setParam, type OrkComponent, type OrkDoc, type OrkSim, walk, findComponent } from './ork';

type RocketSpec = {
  /** Prefix for stable component ids. */
  prefix: string;
  rocketName: string;
  diameter: number;
  finCount: number;
  twoStage?: boolean;
  creator?: string;
  apogee?: number;
};

/** Builds a plausible OpenRocket document. All values are SI (m, kg, s). */
export function makeRocket(spec: RocketSpec): OrkDoc {
  const p = spec.prefix;
  const d = spec.diameter;
  const upper = comp(`${p}-st1`, 'stage', 'Sustainer', {}, [
    comp(`${p}-nc1`, 'nosecone', 'Ogiva', {
      shape: 'Ogiva tangente',
      length: d * 2.2,
      diameter: d,
      thickness: 0.003,
      material: 'Fibra di vetro',
      mass: 0.085,
    }),
    comp(`${p}-bt1`, 'bodytube', 'Tubo del carico utile', {
      length: 0.38,
      diameter: d,
      thickness: 0.002,
      material: 'Fibra di vetro',
    }, [
      comp(`${p}-pc1`, 'parachute', 'Paracadute principale', {
        diameter: 0.9,
        linecount: 8,
        cd: 0.8,
        deployevent: 'Quota',
        deployaltitude: 300,
        deploydelay: 0,
      }),
      comp(`${p}-sc1`, 'shockcord', 'Cordino principale', { cordlength: 1.5, material: 'Kevlar' }),
      comp(`${p}-mc1`, 'masscomponent', 'Elettronica di bordo', { mass: 0.21, length: 0.08, position: 0.1 }),
    ]),
    comp(`${p}-bt2`, 'bodytube', 'Tubo del motore', {
      length: 0.52,
      diameter: d,
      thickness: 0.002,
      material: 'Fibra di vetro',
    }, [
      comp(`${p}-it1`, 'innertube', 'Alloggiamento motore', { length: 0.32, diameter: 0.054, thickness: 0.002 }),
      comp(`${p}-cr1`, 'centeringring', 'Anello superiore', { diameter: d, thickness: 0.006 }),
      comp(`${p}-cr2`, 'centeringring', 'Anello inferiore', { diameter: d, thickness: 0.006 }),
      comp(`${p}-eb1`, 'engineblock', 'Blocco motore', { length: 0.01 }),
      comp(`${p}-fs1`, 'trapezoidfinset', 'Pinne trapezoidali', {
        fincount: spec.finCount,
        rootchord: 0.08,
        tipchord: 0.04,
        height: 0.07,
        sweeplength: 0.03,
        thickness: 0.003,
        material: 'Fibra di carbonio',
      }),
      comp(`${p}-rb1`, 'railbutton', 'Pattino di guida', { diameter: 0.01, position: 0.3 }),
    ]),
  ]);
  const stages: OrkComponent[] = [upper];
  if (spec.twoStage) {
    stages.push(
      comp(`${p}-st2`, 'stage', 'Booster', {}, [
        comp(`${p}-bt3`, 'bodytube', 'Tubo del booster', { length: 0.46, diameter: d, thickness: 0.002, material: 'Fibra di vetro' }, [
          comp(`${p}-it2`, 'innertube', 'Alloggiamento motore booster', { length: 0.3, diameter: 0.054, thickness: 0.002 }),
          comp(`${p}-fs2`, 'trapezoidfinset', 'Pinne del booster', {
            fincount: spec.finCount,
            rootchord: 0.11,
            tipchord: 0.05,
            height: 0.09,
            sweeplength: 0.05,
            thickness: 0.003,
            material: 'Fibra di carbonio',
          }),
        ]),
      ]),
    );
  }
  const apogee = spec.apogee ?? 812;
  const sims: OrkSim[] = [
    {
      id: `${p}-sim1`,
      name: 'Volo nominale',
      conditions: [
        { key: 'launchrodlength', value: '2' },
        { key: 'windspeed', value: '2' },
        { key: 'launchtemp', value: '20' },
        { key: 'launchaltitude', value: '120' },
      ],
      results: [
        { key: 'apogee', value: String(apogee) },
        { key: 'maxvelocity', value: '214.3' },
        { key: 'maxacceleration', value: '98' },
        { key: 'flighttime', value: '78.6' },
        { key: 'groundhitvelocity', value: '6.2' },
      ],
      dataRev: 1,
    },
    {
      id: `${p}-sim2`,
      name: 'Vento forte',
      conditions: [
        { key: 'launchrodlength', value: '2' },
        { key: 'windspeed', value: '8' },
        { key: 'launchtemp', value: '28' },
        { key: 'launchaltitude', value: '120' },
      ],
      results: [
        { key: 'apogee', value: String(Math.round(apogee * 0.91)) },
        { key: 'maxvelocity', value: '203.8' },
        { key: 'flighttime', value: '71.2' },
        { key: 'groundhitvelocity', value: '6.2' },
      ],
      dataRev: 1,
    },
  ];
  return {
    container: 'zip',
    creator: spec.creator ?? 'OpenRocket 23.09',
    formatVersion: '1.9',
    rocketName: spec.rocketName,
    stages,
    configs: [
      { id: `${p}-cfg1`, name: 'Aerotech J350W', params: [{ key: 'motor', value: 'J350W' }, { key: 'ejectiondelay', value: '14' }] },
      { id: `${p}-cfg2`, name: 'Cesaroni I285', params: [{ key: 'motor', value: 'I285' }, { key: 'ejectiondelay', value: '10' }] },
    ],
    sims,
    extras: {
      photostudio: { count: 1, sample: '<photostudio><camera x="0.3" y="0.2" /></photostudio>' },
      'simulation/flightdata': { count: 2, sample: '<databranch name="Flight" typecount="24">' },
    },
  };
}

/** A small payload bay document. */
export function makePayload(prefix: string): OrkDoc {
  return {
    container: 'zip',
    creator: 'OpenRocket 23.09',
    formatVersion: '1.9',
    rocketName: 'Carico utile',
    stages: [
      comp(`${prefix}-st1`, 'stage', 'Carico utile', {}, [
        comp(`${prefix}-nc1`, 'nosecone', 'Ogiva del carico', { shape: 'Conica', length: 0.12, diameter: 0.07, thickness: 0.002, material: 'PLA', mass: 0.04 }),
        comp(`${prefix}-bt1`, 'bodytube', 'Vano strumenti', { length: 0.22, diameter: 0.07, thickness: 0.002, material: 'Fibra di vetro' }, [
          comp(`${prefix}-mc1`, 'masscomponent', 'Sensore di pressione', { mass: 0.032, length: 0.03, position: 0.05 }),
          comp(`${prefix}-mc2`, 'masscomponent', 'Batteria LiPo', { mass: 0.085, length: 0.05, position: 0.12 }),
          comp(`${prefix}-pc1`, 'parachute', 'Paracadute del carico', { diameter: 0.45, linecount: 6, cd: 0.75, deployevent: 'Apogeo', deploydelay: 0 }),
        ]),
      ]),
    ],
    configs: [],
    sims: [
      {
        id: `${prefix}-sim1`,
        name: 'Discesa',
        conditions: [{ key: 'windspeed', value: '3' }],
        results: [{ key: 'groundhitvelocity', value: '5.1' }, { key: 'flighttime', value: '64.2' }],
        dataRev: 1,
      },
    ],
    extras: { photostudio: { count: 1, sample: '<photostudio />' } },
  };
}

// ---- Edit helpers (used to script a believable history) --------------------

export const edit = {
  param(doc: OrkDoc, id: string, values: Record<string, string | number>): OrkDoc {
    const c = findComponent(doc, id);
    if (!c) throw new Error(`component ${id} not found`);
    for (const [k, v] of Object.entries(values)) setParam(c.params, k, v);
    return doc;
  },
  rename(doc: OrkDoc, id: string, name: string): OrkDoc {
    const c = findComponent(doc, id);
    if (!c) throw new Error(`component ${id} not found`);
    c.name = name;
    return doc;
  },
  add(doc: OrkDoc, parentId: string, component: OrkComponent): OrkDoc {
    const parent = findComponent(doc, parentId);
    if (!parent) throw new Error(`component ${parentId} not found`);
    parent.children.push(component);
    return doc;
  },
  remove(doc: OrkDoc, id: string): OrkDoc {
    const strip = (list: OrkComponent[]) => {
      const idx = list.findIndex((c) => c.id === id);
      if (idx >= 0) list.splice(idx, 1);
      else list.forEach((c) => strip(c.children));
    };
    strip(doc.stages);
    return doc;
  },
  sim(
    doc: OrkDoc,
    simId: string,
    patch: { conditions?: Record<string, string | number>; results?: Record<string, string | number>; recompute?: boolean },
  ): OrkDoc {
    const s = doc.sims.find((x) => x.id === simId);
    if (!s) throw new Error(`simulation ${simId} not found`);
    for (const [k, v] of Object.entries(patch.conditions ?? {})) setParam(s.conditions, k, v);
    for (const [k, v] of Object.entries(patch.results ?? {})) setParam(s.results, k, v);
    if (patch.recompute !== false) s.dataRev += 1;
    return doc;
  },
  config(doc: OrkDoc, cfgId: string, values: Record<string, string | number>): OrkDoc {
    const c = doc.configs.find((x) => x.id === cfgId);
    if (!c) throw new Error(`config ${cfgId} not found`);
    for (const [k, v] of Object.entries(values)) setParam(c.params, k, v);
    return doc;
  },
  extra(doc: OrkDoc, section: string, count: number, sample: string): OrkDoc {
    doc.extras[section] = { count, sample };
    return doc;
  },
  componentIds(doc: OrkDoc): string[] {
    return [...walk(doc.stages)].map((x) => x.component.id);
  },
};
