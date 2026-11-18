/**
 * Static contract tests: what `supabaseData` asks of Supabase must exist in the SQL migrations
 * and in the Edge Functions (`supabase/`), with the exact names, argument names and columns.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { errorResponse, HttpError } from '../../../../../supabase/functions/_shared/http.ts';
import { acceptInvitations } from '../../../../../supabase/functions/_shared/members.ts';
import { EVENT_CATALOG } from '../mock/summary';
import { EDGE_FUNCTIONS, createProjectBody, discordBody, memberBody, type EdgeErrorBody } from './edgeContract';

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE = join(here, '../../../../../supabase');
const read = (p: string) => readFileSync(join(SUPABASE, p), 'utf8');

const sql = readdirSync(join(SUPABASE, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => read(`migrations/${f}`))
  .join('\n')
  .replace(/--[^\n]*/g, '');
const source = readFileSync(join(here, 'supabase.ts'), 'utf8');

// ---- SQL model -------------------------------------------------------------------------------

type Fn = { name: string; params: Array<{ name: string; hasDefault: boolean }> };

function parseTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const m of sql.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    const cols: string[] = [];
    for (const line of m[2]!.split('\n')) {
      const c = /^ {2}([a-z_]+)\s+\S/.exec(line);
      if (c && !['constraint', 'primary', 'unique', 'foreign', 'check'].includes(c[1]!)) cols.push(c[1]!);
    }
    tables.set(m[1]!, cols);
  }
  return tables;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseFunctions(): Map<string, Fn> {
  const fns = new Map<string, Fn>();
  for (const m of sql.matchAll(/create function public\.(\w+)\(([\s\S]*?)\)\s*returns/g)) {
    const params = splitTopLevel(m[2]!)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ name: /^(\w+)/.exec(p)![1]!, hasDefault: /\bdefault\b/i.test(p) }));
    fns.set(m[1]!, { name: m[1]!, params });
  }
  return fns;
}

const tables = parseTables();
const functions = parseFunctions();

const grantedExecute = new Set<string>();
for (const m of sql.matchAll(/grant execute on function([\s\S]*?)\bto authenticated;/g)) {
  for (const f of m[1]!.matchAll(/public\.(\w+)\(/g)) grantedExecute.add(f[1]!);
}
const grantedSelect = new Set<string>();
for (const m of sql.matchAll(/grant select on([\s\S]*?)\bto authenticated;/g)) {
  for (const t of m[1]!.matchAll(/public\.(\w+)/g)) grantedSelect.add(t[1]!);
}
const grantedInsert = new Set<string>();
for (const m of sql.matchAll(/grant insert on([\s\S]*?)\bto authenticated;/g)) {
  for (const t of m[1]!.matchAll(/public\.(\w+)/g)) grantedInsert.add(t[1]!);
}
const grantedUpdate = new Map<string, Set<string>>();
for (const m of sql.matchAll(/grant update \(([\s\S]*?)\) on public\.(\w+) to authenticated;/g)) {
  grantedUpdate.set(m[2]!, new Set(m[1]!.split(',').map((c) => c.trim())));
}
const allColumns = new Set([...tables.values()].flat());
const allUpdatable = new Set([...grantedUpdate.values()].flatMap((s) => [...s]));

// ---- what supabaseData uses ------------------------------------------------------------------

function rpcCalls(): Array<{ name: string; args: string[] }> {
  return [...source.matchAll(/\.rpc\('(\w+)',\s*\{([^}]*)\}/g)].map((m) => ({
    name: m[1]!,
    args: [...m[2]!.matchAll(/\b(p_\w+)\s*:/g)].map((a) => a[1]!),
  }));
}

function tableChains(): Array<{ table: string; chain: string }> {
  const out: Array<{ table: string; chain: string }> = [];
  for (const m of source.matchAll(/\.from\('(\w+)'\)/g)) {
    const before = source.slice(Math.max(0, m.index! - 40), m.index!);
    if (/storage\s*$/.test(before)) continue; // storage bucket, not a table
    const end = source.indexOf(';', m.index!);
    out.push({ table: m[1]!, chain: source.slice(m.index!, end) });
  }
  return out;
}

describe('SQL parsing sanity', () => {
  it('finds the schema the UI depends on', () => {
    expect(tables.size).toBeGreaterThanOrEqual(15);
    expect(tables.get('cards')).toContain('converted_at');
    expect(functions.get('report_conflict')?.params.map((p) => p.name)).toEqual(['p_project_id', 'p_conflict_id', 'p_files', 'p_theirs_version', 'p_theirs_user_id']);
    expect(functions.get('release_file')?.params).toHaveLength(3);
  });
});

describe('RPC calls of supabaseData', () => {
  const calls = rpcCalls();
  it('calls the RPC the contract lists', () => {
    expect(calls.map((c) => c.name).sort()).toEqual(
      ['claim_file', 'emit_event', 'heartbeat_claims', 'mark_notifications_read', 'release_file', 'report_conflict', 'resolve_conflict_record'].sort(),
    );
  });

  for (const call of calls) {
    it(`${call.name}: exists, is granted to authenticated and uses the exact p_ argument names`, () => {
      const fn = functions.get(call.name);
      expect(fn, `function public.${call.name} not found in migrations`).toBeDefined();
      expect(grantedExecute.has(call.name), `${call.name} is not granted to authenticated`).toBe(true);
      const known = fn!.params.map((p) => p.name);
      for (const arg of call.args) expect(known, `${call.name} has no argument ${arg}`).toContain(arg);
      for (const p of fn!.params.filter((x) => !x.hasDefault)) {
        expect(call.args, `${call.name} requires ${p.name}`).toContain(p.name);
      }
    });
  }
});

describe('tables and columns used by supabaseData', () => {
  const chains = tableChains();

  it('only reads tables that exist and are selectable by the client', () => {
    expect(chains.length).toBeGreaterThan(20);
    for (const { table } of chains) {
      expect(tables.has(table), `table public.${table} not found`).toBe(true);
      expect(grantedSelect.has(table), `no select grant on ${table}`).toBe(true);
    }
  });

  it('uses only existing columns in select / filters / order', () => {
    for (const { table, chain } of chains) {
      const cols = new Set(tables.get(table));
      const used: string[] = [];
      for (const m of chain.matchAll(/\.select\('([^']*)'/g)) {
        for (const c of m[1]!.split(',').map((x) => x.trim())) if (c && c !== '*') used.push(c);
      }
      for (const m of chain.matchAll(/\.(?:eq|neq|in|is|gte|lte|order)\('(\w+)'/g)) used.push(m[1]!);
      for (const c of used) expect(cols.has(c), `${table}.${c} does not exist`).toBe(true);
    }
  });

  it('inserts only existing columns, on tables with an insert grant', () => {
    for (const { table, chain } of chains) {
      for (const m of chain.matchAll(/\.(?:insert|upsert)\(\{([^}]*)\}/g)) {
        expect(grantedInsert.has(table), `no insert grant on ${table}`).toBe(true);
        for (const k of m[1]!.matchAll(/\b([a-z_]+)\s*:/g)) {
          expect(tables.get(table)).toContain(k[1]!);
        }
      }
    }
  });

  it('updates only columns granted to authenticated (server-maintained columns are never sent)', () => {
    for (const { table, chain } of chains) {
      for (const m of chain.matchAll(/\.update\(\{([^}]*)\}/g)) {
        const granted = grantedUpdate.get(table);
        expect(granted, `no update grant on ${table}`).toBeDefined();
        for (const k of m[1]!.matchAll(/\b([a-z_]+)\s*:/g)) expect(granted!.has(k[1]!), `${table}.${k[1]} is not updatable`).toBe(true);
      }
    }
    for (const m of source.matchAll(/\bupdate\.(\w+)\s*=/g)) expect(allUpdatable.has(m[1]!), `update.${m[1]} is not updatable`).toBe(true);
    for (const forbidden of ['updated_at', 'completed_at', 'edited_at', 'updated_by']) {
      expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\s*[:=]`));
    }
  });

  it('writes card columns that the cards update grant allows', () => {
    const map = /const CARD_COLUMNS[^{]*\{([\s\S]*?)\n\};/.exec(source)![1]!;
    const cols = [...map.matchAll(/:\s*'(\w+)'/g)].map((m) => m[1]!);
    expect(cols.length).toBe(11);
    for (const c of cols) expect(grantedUpdate.get('cards')!.has(c), `cards.${c}`).toBe(true);
  });

  it('reads only existing column names in the row mappers', () => {
    const mapperReads = new Set([...source.matchAll(/\br\.([a-z_]+)\b/g)].map((m) => m[1]!));
    for (const c of mapperReads) expect(allColumns.has(c), `unknown column ${c}`).toBe(true);
  });

  it('keeps the card palette / category icons stored in free text columns', () => {
    expect(tables.get('cards')).toContain('color');
    expect(tables.get('card_categories')).toContain('icon');
  });
});

describe('Realtime subscription', () => {
  it('subscribes only to tables published to Supabase Realtime', () => {
    const published = new Set<string>();
    const block = /foreach t in array array\[([\s\S]*?)\]/.exec(sql)![1]!;
    for (const m of block.matchAll(/'(\w+)'/g)) published.add(m[1]!);
    const listed = /\? \[([^\]]*)\]\s*:\s*\[([^\]]*)\]/.exec(source)!;
    const tablesUsed = [...listed[1]!.matchAll(/'(\w+)'/g), ...listed[2]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(tablesUsed.length).toBeGreaterThan(5);
    for (const t of tablesUsed) expect(published.has(t), `${t} is not in the supabase_realtime publication`).toBe(true);
  });
});

describe('event catalogue', () => {
  it('the mock catalogue equals the event_types rows of the migration', () => {
    const rows = [...sql.matchAll(/\('([\w.]+)',\s*'(\w+)',\s*'(\w+)',\s*(true|false),\s*(true|false),\s*(true|false),\s*'([^']+)'\)/g)].map((m) => ({
      type: m[1]!,
      importance: m[2]!,
      audience: m[3]!,
      notify: m[4] === 'true',
      discordDefault: m[5] === 'true',
      clientAllowed: m[6] === 'true',
      labelIt: m[7]!,
    }));
    expect(rows.length).toBe(17);
    expect(EVENT_CATALOG).toEqual(rows);
  });
});

// ---- Edge Functions --------------------------------------------------------------------------

function bodyKeys(fn: string): Set<string> {
  const code = readFileSync(join(SUPABASE, 'functions', fn, 'index.ts'), 'utf8');
  const keys = new Set<string>();
  for (const m of code.matchAll(/\b(?:str|uuid|githubLogin)\(body,\s*"(\w+)"/g)) keys.add(m[1]!);
  for (const m of code.matchAll(/\bbody\.(\w+)/g)) keys.add(m[1]!);
  return keys;
}

describe('Edge Function payloads', () => {
  it('calls only Edge Functions that exist, and never github-token-refresh (core only)', () => {
    const called = [...source.matchAll(/this\.fn(?:<[^>]*>)?\(\s*'([\w-]+)'/g)].map((m) => m[1]!);
    expect(called.length).toBeGreaterThan(5);
    for (const name of called) {
      expect(EDGE_FUNCTIONS as readonly string[]).toContain(name);
      expect(existsSync(join(SUPABASE, 'functions', name, 'index.ts'))).toBe(true);
    }
    expect(source).not.toContain('github-token-refresh');
  });

  it('create-project body fields are the ones the function reads', () => {
    const keys = bodyKeys('create-project');
    for (const k of Object.keys(createProjectBody('n', 'd'))) expect(keys.has(k), `create-project does not read ${k}`).toBe(true);
  });

  it('manage-members bodies use fields and actions the function accepts', () => {
    const code = read('functions/manage-members/index.ts');
    const keys = bodyKeys('manage-members');
    const bodies = [memberBody.add('p', 'login', 'member'), memberBody.remove('p', 'u'), memberBody.revokeInvitation('p', 'login'), memberBody.setRole('p', 'u', 'admin')];
    for (const b of bodies) {
      for (const k of Object.keys(b)) expect(keys.has(k), `manage-members does not read ${k}`).toBe(true);
      expect(code).toContain(`action === "${b.action}"`);
    }
  });

  it('discord-settings bodies use fields and actions the function accepts', () => {
    const code = read('functions/discord-settings/index.ts');
    const keys = bodyKeys('discord-settings');
    for (const b of [discordBody.set('p', 'https://discord.com/api/webhooks/1/x'), discordBody.remove('p'), discordBody.test('p')]) {
      for (const k of Object.keys(b)) expect(keys.has(k), `discord-settings does not read ${k}`).toBe(true);
      expect(code).toContain(`"${b.action}"`);
    }
  });

  it('errors come back as { error: { code, message } }, which fn() unwraps', async () => {
    const res = errorResponse(new HttpError(403, 'admin_required', 'Serve il ruolo di amministratore del progetto'));
    const body = (await res.json()) as EdgeErrorBody;
    expect(body).toEqual({ error: { code: 'admin_required', message: 'Serve il ruolo di amministratore del progetto' } });
    expect(res.status).toBe(403);
    expect(source).toContain('payload?.error?.message');
  });

  it('accept-invitations answers { accepted: [...] }, which acceptInvitations() counts', async () => {
    const db = {
      getProfile: async () => ({ id: 'u', github_login: 'x', display_name: 'X' }),
      pendingInvitationsFor: async () => [],
    };
    const result = await acceptInvitations('u', { db: db as never });
    expect(result).toEqual({ accepted: [] });
    expect(source).toContain('res.accepted.length');
  });
});
