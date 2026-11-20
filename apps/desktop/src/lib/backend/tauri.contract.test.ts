/**
 * Keeps `tauriBackend` aligned with docs/contratto-ipc.md and, once it exists, with the
 * `#[tauri::command]` functions of the shell (apps/desktop/src-tauri/src).
 * Tauri converts camelCase JS argument names to snake_case Rust parameters.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../../../..');
const tauriSource = readFileSync(join(here, 'tauri.ts'), 'utf8');
const doc = readFileSync(join(ROOT, 'docs/contratto-ipc.md'), 'utf8');
const typesSource = readFileSync(join(here, '../types/ipc.ts'), 'utf8');

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** command -> argument names (as written in the JS call) */
function jsCommands(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of tauriSource.matchAll(/(?:call|invoke)(?:<[^>]*>)?\('(\w+)'(?:,\s*(\{[^}]*\}|args))?\)/g)) {
    const raw = m[2];
    const keys = raw && raw.startsWith('{') ? [...raw.matchAll(/(\w+)(?:\s*:[^,}]*)?/g)].map((k) => k[1]!) : [];
    out.set(m[1]!, keys);
  }
  return out;
}

function documentedCommands(): string[] {
  const names = new Set<string>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = line.split('|')[1] ?? '';
    for (const m of first.matchAll(/`(\w+)`/g)) names.add(m[1]!);
  }
  // table headers / event names are not commands
  for (const e of ['Comando', 'Evento']) names.delete(e);
  return [...names].filter((n) => /_/.test(n) || ['publish'].includes(n));
}

/** command -> argument names documented in the contract tables (second column). */
function documentedArgs(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|');
    const names = [...(cols[1] ?? '').matchAll(/`(\w+)`/g)].map((m) => m[1]!).filter((n) => /_/.test(n) || n === 'publish');
    if (names.length === 0) continue;
    const parts = (cols[2] ?? '').split(' / ');
    names.forEach((name, i) => {
      const cell = parts.length === names.length ? parts[i]! : (cols[2] ?? '');
      const inner = /\{([^}]*)\}/.exec(cell)?.[1] ?? '';
      out.set(name, inner.split(',').map((a) => a.trim().split(':')[0]!.trim().replace(/\?$/, '')).filter(Boolean));
    });
  }
  return out;
}

function documentedEvents(): string[] {
  const section = doc.slice(doc.indexOf('## 6. Eventi'), doc.indexOf('## 7.'));
  return [...section.matchAll(/^\|\s*`([\w-]+)`/gm)].map((m) => m[1]!);
}

function rustFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? rustFiles(p) : p.endsWith('.rs') ? [p] : [];
  });
}

type RustCommand = { name: string; params: string[] };
function rustCommands(): RustCommand[] {
  const code = rustFiles(join(ROOT, 'apps/desktop/src-tauri/src'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const cmds: RustCommand[] = [];
  for (const m of code.matchAll(/#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([\s\S]*?)\)\s*(?:->|\{|where)/g)) {
    const params = splitParams(m[2]!)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ name: /^(?:mut\s+)?(\w+)\s*:/.exec(p)?.[1] ?? '', type: p.slice(p.indexOf(':') + 1) }))
      .filter((p) => !/\b(State|AppHandle|Window|WebviewWindow|Webview)\b/.test(p.type))
      .map((p) => p.name);
    cmds.push({ name: m[1]!, params });
  }
  return cmds;
}

function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('<([{'.includes(ch)) depth++;
    if ('>)]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe('tauriBackend vs docs/contratto-ipc.md', () => {
  const js = jsCommands();
  it('invokes every command of the contract, and only those', () => {
    const documented = documentedCommands();
    expect(documented.length).toBeGreaterThan(30);
    for (const name of documented) expect([...js.keys()], `${name} missing in tauriBackend`).toContain(name);
    for (const name of js.keys()) expect(documented, `${name} is not in the contract`).toContain(name);
  });

  it('declares every event of the contract in the event map', () => {
    const events = documentedEvents();
    expect(events).toHaveLength(9);
    for (const e of events) expect(typesSource).toContain(`'${e}'`);
  });

  it('documents the arguments of the commands the UI sends', () => {
    const args = documentedArgs();
    expect(args.get('publish')).toEqual(['projectId', 'title', 'description', 'paths']);
    expect(args.get('set_app_settings')).toEqual(['settings']);
    expect(args.get('get_app_settings')).toEqual([]);
    expect(args.get('get_public_config')).toEqual([]);
    expect(args.get('answer_stale_save')).toEqual(['projectId', 'path', 'reopened']);
  });

  it('includes the latest contract additions', () => {
    expect(js.has('notify_remote_changed')).toBe(true);
    expect(js.has('get_public_config')).toBe(true);
    expect(typesSource).toContain("'staleSavePending'");
  });
});

describe('tauriBackend vs the Rust shell (src-tauri/src)', () => {
  const rust = rustCommands();
  const js = jsCommands();

  it.skipIf(rust.length === 0)('every command exists in Rust with the same argument names (camelCase -> snake_case)', () => {
    const rustByName = new Map(rust.map((c) => [c.name, c.params]));
    const missing = [...js.keys()].filter((n) => !rustByName.has(n));
    expect(missing, `commands invoked by the UI but not defined in Rust: ${missing.join(', ')}`).toEqual([]);
    const docArgs = documentedArgs();
    for (const [name, jsKeys] of js) {
      const params = rustByName.get(name)!;
      const keys = new Set([...jsKeys, ...(docArgs.get(name) ?? [])]);
      for (const k of keys) expect(params, `${name}: argument "${k}" has no Rust parameter "${snake(k)}"`).toContain(snake(k));
    }
  });

  it('reports how many commands the shell defines so far', () => {
    console.info(`[tauri contract] Rust commands found: ${rust.length}`);
    expect(rust.length).toBeGreaterThanOrEqual(0);
  });
});
