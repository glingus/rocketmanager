/**
 * Semantic model of a (simplified) OpenRocket document used by the mock backend,
 * with the same diff / three-way logic the Rust crate `rs-ork` exposes through the IPC contract.
 */
import type {
  ComponentChange,
  ConfigChange,
  DisplayValue,
  OrkDiff,
  OrkSummary,
  OrkThreeWay,
  OverlapItem,
  ParamChange,
  SimulationChange,
  UninterpretedChange,
} from '../types/ipc';
import { toDisplay, describeChange, type Quantity } from '../utils/units';

export type OrkParam = { key: string; value: string };

export type OrkComponent = {
  id: string;
  type: string;
  name: string;
  params: OrkParam[];
  children: OrkComponent[];
};

export type OrkSim = {
  id: string;
  name: string;
  conditions: OrkParam[];
  results: OrkParam[];
  /** Bumped every time flight data is recomputed. */
  dataRev: number;
};

export type OrkConfig = { id: string; name: string; params: OrkParam[] };

export type OrkDoc = {
  container: 'zip' | 'gzip' | 'xml';
  creator: string;
  formatVersion: string;
  rocketName: string;
  stages: OrkComponent[];
  configs: OrkConfig[];
  sims: OrkSim[];
  /** Sections the parser keeps verbatim but cannot interpret. */
  extras: Record<string, { count: number; sample: string }>;
};

// ---- Catalogs --------------------------------------------------------------

export const TYPE_LABELS: Record<string, string> = {
  stage: 'Stadio',
  nosecone: 'Ogiva',
  bodytube: 'Tubo del corpo',
  transition: 'Transizione',
  innertube: 'Tubo interno',
  trapezoidfinset: 'Pinne trapezoidali',
  ellipticalfinset: 'Pinne ellittiche',
  parachute: 'Paracadute',
  streamer: 'Nastro di recupero',
  shockcord: 'Cordino elastico',
  masscomponent: 'Componente di massa',
  centeringring: 'Anello di centraggio',
  engineblock: 'Blocco motore',
  launchlug: 'Guida di lancio',
  railbutton: 'Pattino di guida',
};

type ParamDef = { label: string; quantity: Quantity };

export const PARAM_DEFS: Record<string, ParamDef> = {
  name: { label: 'Nome', quantity: 'text' },
  length: { label: 'Lunghezza', quantity: 'length' },
  diameter: { label: 'Diametro', quantity: 'length' },
  thickness: { label: 'Spessore', quantity: 'length' },
  material: { label: 'Materiale', quantity: 'text' },
  shape: { label: 'Forma', quantity: 'text' },
  mass: { label: 'Massa', quantity: 'mass' },
  position: { label: 'Posizione', quantity: 'length' },
  fincount: { label: 'Numero di pinne', quantity: 'count' },
  rootchord: { label: 'Corda alla radice', quantity: 'length' },
  tipchord: { label: 'Corda all’estremità', quantity: 'length' },
  height: { label: 'Altezza', quantity: 'length' },
  sweeplength: { label: 'Freccia', quantity: 'length' },
  cant: { label: 'Inclinazione', quantity: 'angle' },
  linecount: { label: 'Numero di funi', quantity: 'count' },
  cd: { label: 'Coefficiente di resistenza', quantity: 'ratio' },
  deployevent: { label: 'Evento di apertura', quantity: 'text' },
  deployaltitude: { label: 'Quota di apertura', quantity: 'altitude' },
  deploydelay: { label: 'Ritardo di apertura', quantity: 'time' },
  cordlength: { label: 'Lunghezza del cordino', quantity: 'length' },
  motor: { label: 'Motore', quantity: 'text' },
  ejectiondelay: { label: 'Ritardo di espulsione', quantity: 'time' },
  // simulation conditions
  launchrodlength: { label: 'Lunghezza della rampa', quantity: 'length' },
  windspeed: { label: 'Velocità del vento', quantity: 'velocity' },
  launchtemp: { label: 'Temperatura al lancio', quantity: 'temp' },
  launchaltitude: { label: 'Quota di lancio', quantity: 'altitude' },
  launchangle: { label: 'Angolo di lancio', quantity: 'angle' },
  // simulation results
  apogee: { label: 'Apogeo', quantity: 'altitude' },
  maxvelocity: { label: 'Velocità massima', quantity: 'velocity' },
  maxacceleration: { label: 'Accelerazione massima', quantity: 'accel' },
  flighttime: { label: 'Durata del volo', quantity: 'time' },
  groundhitvelocity: { label: 'Velocità all’atterraggio', quantity: 'velocity' },
  optimaldelay: { label: 'Ritardo ottimale', quantity: 'time' },
  stability: { label: 'Stabilità', quantity: 'ratio' },
};

export function paramDef(key: string): ParamDef {
  return PARAM_DEFS[key] ?? { label: key, quantity: 'text' };
}

export function displayParam(p: OrkParam): DisplayValue {
  return toDisplay(p.value, paramDef(p.key).quantity);
}

// ---- Builders / helpers ----------------------------------------------------

export function comp(
  id: string,
  type: string,
  name: string,
  params: Record<string, string | number>,
  children: OrkComponent[] = [],
): OrkComponent {
  return {
    id,
    type,
    name,
    params: Object.entries(params).map(([key, value]) => ({ key, value: String(value) })),
    children,
  };
}

export function cloneDoc(doc: OrkDoc): OrkDoc {
  return structuredClone(doc);
}

export function* walk(
  components: OrkComponent[],
  ancestors: OrkComponent[] = [],
): Generator<{ component: OrkComponent; ancestors: OrkComponent[]; index: number }> {
  for (let i = 0; i < components.length; i++) {
    const component = components[i]!;
    yield { component, ancestors, index: i };
    yield* walk(component.children, [...ancestors, component]);
  }
}

export function findComponent(doc: OrkDoc, id: string): OrkComponent | undefined {
  for (const { component } of walk(doc.stages)) if (component.id === id) return component;
  return undefined;
}

function paramMap(params: OrkParam[]): Map<string, string> {
  return new Map(params.map((p) => [p.key, p.value]));
}

export function setParam(params: OrkParam[], key: string, value: string | number): void {
  const found = params.find((p) => p.key === key);
  if (found) found.value = String(value);
  else params.push({ key, value: String(value) });
}

export function summarize(doc: OrkDoc): OrkSummary {
  let count = 0;
  for (const { component } of walk(doc.stages)) if (component.type !== 'stage') count++;
  return {
    container: doc.container,
    creator: doc.creator,
    formatVersion: doc.formatVersion,
    rocketName: doc.rocketName,
    stageCount: doc.stages.length,
    componentCount: count,
    simulationCount: doc.sims.length,
  };
}

/** Deterministic byte size, so versions show believable file sizes. */
export function approxSize(doc: OrkDoc): number {
  const s = summarize(doc);
  return 9_200 + s.componentCount * 640 + doc.sims.reduce((acc, sim) => acc + 2_400 + sim.dataRev * 310, 0);
}

// ---- Diff ------------------------------------------------------------------

function paramChanges(before: OrkParam[] | null, after: OrkParam[] | null): ParamChange[] {
  const b = paramMap(before ?? []);
  const a = paramMap(after ?? []);
  const keys = [...new Set([...b.keys(), ...a.keys()])];
  const out: ParamChange[] = [];
  for (const key of keys) {
    const bv = b.get(key);
    const av = a.get(key);
    if (bv === av) continue;
    const def = paramDef(key);
    out.push({
      key,
      label: def.label,
      before: bv == null ? null : toDisplay(bv, def.quantity),
      after: av == null ? null : toDisplay(av, def.quantity),
    });
  }
  return out;
}

type Flat = { component: OrkComponent; path: string[]; parentId: string | null };

function flatten(doc: OrkDoc | null): Map<string, Flat> {
  const map = new Map<string, Flat>();
  if (!doc) return map;
  for (const { component, ancestors } of walk(doc.stages)) {
    map.set(component.id, {
      component,
      path: ancestors.map((a) => a.name),
      parentId: ancestors.length ? ancestors[ancestors.length - 1]!.id : null,
    });
  }
  return map;
}

function componentChange(
  kind: ComponentChange['kind'],
  flat: Flat,
  params: ParamChange[],
): ComponentChange {
  return {
    kind,
    componentType: flat.component.type,
    typeLabel: TYPE_LABELS[flat.component.type] ?? flat.component.type,
    name: flat.component.name,
    path: flat.path,
    params,
  };
}

function uninterpretedChanges(before: OrkDoc | null, after: OrkDoc | null): UninterpretedChange[] {
  const b = before?.extras ?? {};
  const a = after?.extras ?? {};
  const out: UninterpretedChange[] = [];
  for (const section of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const bv = b[section];
    const av = a[section];
    if (bv && av && bv.count === av.count && bv.sample === av.sample) continue;
    const count = Math.max(1, Math.abs((av?.count ?? 0) - (bv?.count ?? 0)));
    out.push({ section, count, sample: av?.sample ?? bv?.sample ?? null });
  }
  return out;
}

export function diffOrk(path: string, before: OrkDoc | null, after: OrkDoc | null): OrkDiff {
  const fb = flatten(before);
  const fa = flatten(after);
  const components: ComponentChange[] = [];

  for (const [id, flat] of fa) {
    const old = fb.get(id);
    if (!old) {
      components.push(componentChange('added', flat, paramChanges(null, withName(flat.component))));
      continue;
    }
    const params = paramChanges(withName(old.component), withName(flat.component));
    const moved = old.parentId !== flat.parentId;
    if (params.length > 0) components.push(componentChange('modified', flat, params));
    else if (moved) components.push(componentChange('moved', flat, []));
  }
  for (const [id, flat] of fb) {
    if (!fa.has(id)) components.push(componentChange('removed', flat, paramChanges(withName(flat.component), null)));
  }

  const motorConfigurations: ConfigChange[] = [];
  const cb = new Map((before?.configs ?? []).map((c) => [c.id, c]));
  const ca = new Map((after?.configs ?? []).map((c) => [c.id, c]));
  for (const [id, c] of ca) {
    const old = cb.get(id);
    if (!old) motorConfigurations.push({ kind: 'added', name: c.name, params: paramChanges(null, c.params) });
    else {
      const params = [...paramChanges([{ key: 'name', value: old.name }], [{ key: 'name', value: c.name }]), ...paramChanges(old.params, c.params)];
      if (params.length) motorConfigurations.push({ kind: 'modified', name: c.name, params });
    }
  }
  for (const [id, c] of cb) {
    if (!ca.has(id)) motorConfigurations.push({ kind: 'removed', name: c.name, params: paramChanges(c.params, null) });
  }

  const simulations: SimulationChange[] = [];
  const sb = new Map((before?.sims ?? []).map((s) => [s.id, s]));
  const sa = new Map((after?.sims ?? []).map((s) => [s.id, s]));
  for (const [id, s] of sa) {
    const old = sb.get(id);
    if (!old) {
      simulations.push({
        kind: 'added',
        name: s.name,
        conditions: paramChanges(null, s.conditions),
        results: paramChanges(null, s.results),
        dataUpdated: true,
      });
      continue;
    }
    const conditions = paramChanges(old.conditions, s.conditions);
    const results = paramChanges(old.results, s.results);
    const dataUpdated = old.dataRev !== s.dataRev;
    if (conditions.length || results.length || dataUpdated || old.name !== s.name) {
      simulations.push({ kind: 'modified', name: s.name, conditions, results, dataUpdated });
    }
  }
  for (const [id, s] of sb) {
    if (!sa.has(id)) {
      simulations.push({
        kind: 'removed',
        name: s.name,
        conditions: paramChanges(s.conditions, null),
        results: paramChanges(s.results, null),
        dataUpdated: false,
      });
    }
  }

  return {
    path,
    before: before ? summarize(before) : null,
    after: after ? summarize(after) : null,
    components,
    motorConfigurations,
    simulations,
    uninterpreted: uninterpretedChanges(before, after),
    parseError: null,
  };
}

function withName(c: OrkComponent): OrkParam[] {
  return [{ key: 'name', value: c.name }, ...c.params];
}

export function isEmptyDiff(diff: OrkDiff): boolean {
  return (
    diff.components.length === 0 &&
    diff.motorConfigurations.length === 0 &&
    diff.simulations.length === 0 &&
    diff.uninterpreted.length === 0
  );
}

// ---- Three-way -------------------------------------------------------------

function displayEq(a: DisplayValue | null, b: DisplayValue | null): boolean {
  return (a?.raw ?? null) === (b?.raw ?? null);
}

export function threeWay(path: string, base: OrkDoc | null, mine: OrkDoc | null, theirs: OrkDoc | null): OrkThreeWay {
  const mineDiff = diffOrk(path, base, mine);
  const theirsDiff = diffOrk(path, base, theirs);
  const overlapping: OverlapItem[] = [];

  const key = (c: ComponentChange) => `${c.path.join('/')}/${c.name}/${c.componentType}`;
  const theirsMap = new Map(theirsDiff.components.map((c) => [key(c), c]));
  for (const m of mineDiff.components) {
    const t = theirsMap.get(key(m));
    if (!t) continue;
    if (m.kind === 'removed' || t.kind === 'removed') {
      if (m.kind === t.kind) continue; // both removed: no disagreement
      overlapping.push({
        componentPath: m.path,
        componentName: m.name,
        key: null,
        label: m.typeLabel,
        mine: m.kind === 'removed' ? null : { raw: 'modified', display: 'modificato', unit: null },
        theirs: t.kind === 'removed' ? null : { raw: 'modified', display: 'modificato', unit: null },
      });
      continue;
    }
    const tParams = new Map(t.params.map((p) => [p.key, p]));
    for (const mp of m.params) {
      const tp = tParams.get(mp.key);
      if (!tp) continue;
      if (displayEq(mp.after, tp.after)) continue; // same final value: not a disagreement
      overlapping.push({
        componentPath: m.path,
        componentName: m.name,
        key: mp.key,
        label: mp.label,
        mine: mp.after,
        theirs: tp.after,
      });
    }
  }

  const tSims = new Map(theirsDiff.simulations.map((s) => [s.name, s]));
  for (const m of mineDiff.simulations) {
    const t = tSims.get(m.name);
    if (!t) continue;
    const tParams = new Map([...t.conditions, ...t.results].map((p) => [p.key, p]));
    for (const mp of [...m.conditions, ...m.results]) {
      const tp = tParams.get(mp.key);
      if (!tp || displayEq(mp.after, tp.after)) continue;
      overlapping.push({
        componentPath: ['Simulazioni'],
        componentName: m.name,
        key: mp.key,
        label: mp.label,
        mine: mp.after,
        theirs: tp.after,
      });
    }
  }

  return { path, mine: mineDiff, theirs: theirsDiff, overlapping, independent: overlapping.length === 0 };
}

// ---- Changelog lines (Italian, deterministic) --------------------------------

function paramFragment(p: ParamChange): string {
  const label = p.label.toLowerCase();
  if (p.before && p.after) {
    // "numero 3 → 4" ; keep unit only on the last value when equal
    if (p.before.unit && p.before.unit === p.after.unit) {
      const bNum = p.before.display.replace(/\s*\S+$/, '');
      return `${label} ${bNum} → ${p.after.display}`;
    }
    return `${label} ${p.before.display} → ${p.after.display}`;
  }
  return describeChange(p.label, p.before, p.after);
}

function addedSummary(c: ComponentChange): string {
  const dims = c.params.find((p) => p.key === 'diameter')?.after ?? c.params.find((p) => p.key === 'length')?.after;
  return dims ? `${c.name} (${c.params.find((p) => p.key === 'diameter') ? 'Ø ' : ''}${dims.display})` : c.name;
}

export function changelogFromDiff(diff: OrkDiff): string[] {
  const lines: string[] = [];
  if (!diff.before) return [`Aggiunto il file (${diff.after?.componentCount ?? 0} componenti)`];
  if (!diff.after) return ['File rimosso'];
  for (const c of diff.components) {
    if (c.kind === 'added') lines.push(`Aggiunto: ${addedSummary(c)}`);
    else if (c.kind === 'removed') lines.push(`Rimosso: ${c.name}`);
    else if (c.kind === 'moved') lines.push(`Spostato: ${c.name}`);
    else {
      const frag = c.params
        .filter((p) => p.key !== 'name')
        .map(paramFragment)
        .join('; ');
      const rename = c.params.find((p) => p.key === 'name');
      const head = rename ? `${rename.before?.display ?? ''} → ${rename.after?.display ?? ''}` : c.typeLabel === c.name ? c.name : c.name;
      lines.push(frag ? `${head}: ${frag}` : `${head}: rinominato`);
    }
  }
  for (const m of diff.motorConfigurations) {
    if (m.kind === 'added') lines.push(`Aggiunta configurazione motore: ${m.name}`);
    else if (m.kind === 'removed') lines.push(`Rimossa configurazione motore: ${m.name}`);
    else lines.push(`Configurazione motore "${m.name}": ${m.params.map(paramFragment).join('; ')}`);
  }
  for (const s of diff.simulations) {
    if (s.kind === 'added') lines.push(`Aggiunta simulazione "${s.name}"`);
    else if (s.kind === 'removed') lines.push(`Rimossa simulazione "${s.name}"`);
    else {
      const frag = [...s.conditions, ...s.results].map(paramFragment).join('; ');
      lines.push(`Simulazione "${s.name}": ${frag || 'dati di volo ricalcolati'}`);
    }
  }
  for (const u of diff.uninterpreted) {
    lines.push(`${u.count} ${u.count === 1 ? 'modifica non interpretata' : 'modifiche non interpretate'} nella sezione ${u.section}`);
  }
  return lines;
}
