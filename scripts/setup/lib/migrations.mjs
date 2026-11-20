// Applica le migrazioni di supabase/migrations con l'endpoint SQL della Management API,
// registrandole in supabase_migrations.schema_migrations come fa la CLI (versione, nome, statements),
// così `supabase db push` resta compatibile.
// Tabella della CLI (supabase/cli pkg/migration/history.go):
//   CREATE SCHEMA IF NOT EXISTS supabase_migrations
//   CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)
//   ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements text[] / name text

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SetupError } from './errors.mjs';

export const ENSURE_HISTORY_SQL = `create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;`;

/** Letterale SQL tra apici (raddoppia gli apici; con standard_conforming_strings i backslash sono letterali). */
export function sqlString(value) {
  if (String(value).includes('\0')) throw new SetupError('Il testo SQL contiene un carattere non valido.', { code: 'sql' });
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function parseMigrationName(file) {
  const m = /^(\d{8,})_(.+)\.sql$/.exec(file);
  return m ? { version: m[1], name: m[2] } : null;
}

export async function listMigrationFiles(dir) {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out = [];
  for (const file of names) {
    const parsed = parseMigrationName(file);
    if (!parsed) throw new SetupError(`Il nome della migrazione "${file}" non è nel formato <versione>_<nome>.sql.`, { code: 'migration-name' });
    out.push({ ...parsed, file, sql: await readFile(join(dir, file), 'utf8') });
  }
  const versions = new Set();
  for (const m of out) {
    if (versions.has(m.version)) throw new SetupError(`Due migrazioni hanno la stessa versione (${m.version}).`, { code: 'migration-name' });
    versions.add(m.version);
  }
  return out;
}

/** Una transazione per file: il codice della migrazione e la riga della cronologia insieme. */
export function buildMigrationSql(m) {
  return `begin;
${m.sql}
;
insert into supabase_migrations.schema_migrations (version, name, statements)
values (${sqlString(m.version)}, ${sqlString(m.name)}, array[${sqlString(m.sql)}]);
commit;`;
}

/**
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function applyMigrations({ api, ref, dir, log = () => {} }) {
  const files = await listMigrationFiles(dir);
  if (files.length === 0) throw new SetupError('Non ho trovato nessuna migrazione da applicare.', { code: 'migration-none' });
  await api.query(ref, ENSURE_HISTORY_SQL, { what: 'preparazione della cronologia delle migrazioni' });
  const rows = await api.query(ref, 'select version from supabase_migrations.schema_migrations order by version', {
    what: 'lettura delle migrazioni già applicate',
  });
  const done = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.version)));
  const applied = [];
  const skipped = [];
  for (const m of files) {
    if (done.has(m.version)) {
      skipped.push(m.file);
      log(`già applicata: ${m.file}`, 'skip');
      continue;
    }
    try {
      await api.query(ref, buildMigrationSql(m), { what: `migrazione ${m.file}` });
    } catch (e) {
      if (e instanceof SetupError) {
        throw new SetupError(`La migrazione ${m.file} non è riuscita: ${e.message}`, {
          code: e.code,
          status: e.status ?? undefined,
          hint: 'Le migrazioni precedenti restano applicate e questa è stata annullata (transazione). Correggi e rilancia: riparte da qui.',
        });
      }
      throw e;
    }
    applied.push(m.file);
    log(`applicata: ${m.file}`, 'ok');
  }
  return { applied, skipped };
}
