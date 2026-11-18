#!/usr/bin/env bash
# Esegue i test del database (pgTAP) su un Postgres 16 locale usa-e-getta.
#
#   supabase/scripts/test-db.sh              # tutti i test in supabase/tests/*.sql
#   supabase/scripts/test-db.sh tests/02_*.sql   # solo alcuni file
#   KEEP=1 supabase/scripts/test-db.sh       # lascia acceso il cluster e stampa come collegarsi
#
# Passi: initdb in una cartella temporanea -> avvio su una porta libera -> stub degli schemi
# Supabase (scripts/stub-supabase.sql) -> pgTAP -> migrazioni in ordine -> pg_prove -> arresto.
# Richiede i binari di PostgreSQL 16 (PG_BIN, default /usr/lib/postgresql/16/bin), pgTAP e pg_prove.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DB="rocketsync_test"

for bin in initdb pg_ctl psql; do
  [ -x "$PG_BIN/$bin" ] || { echo "Manca $PG_BIN/$bin (imposta PG_BIN)" >&2; exit 2; }
done
command -v pg_prove >/dev/null || { echo "pg_prove non trovato (pacchetto pgtap / libtap-parser-sourcehandler-pgtap-perl)" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/rocketsync-pg.XXXXXX")"
chmod 755 "$TMP"

# initdb rifiuta di girare come root: in quel caso si passa all'utente `postgres`.
RUN=()
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "Esegui come utente non-root oppure crea l'utente postgres" >&2; exit 2; }
  chown postgres "$TMP"
  RUN=(runuser -u postgres --)
fi

PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

cleanup() {
  if [ -d "$TMP/data" ] && [ -z "${KEEP:-}" ]; then
    "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [ -z "${KEEP:-}" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

echo "==> initdb in $TMP/data (porta $PORT)"
"${RUN[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres --auth=trust -E UTF8 --no-locale >"$TMP/initdb.log" 2>&1 \
  || { cat "$TMP/initdb.log" >&2; exit 1; }

"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/postgres.log" -w \
  -o "-p $PORT -k $TMP -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=logical" \
  start >/dev/null || { cat "$TMP/postgres.log" >&2; exit 1; }

PSQL=("$PG_BIN/psql" -X -q -h "$TMP" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null

echo "==> stub degli schemi Supabase + pgTAP"
"${PSQL[@]}" -d "$DB" -f "$HERE/stub-supabase.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -c "create extension pgtap with schema extensions" >/dev/null
"${PSQL[@]}" -d "$DB" -c "alter database $DB set search_path = public, extensions" >/dev/null

echo "==> migrazioni"
for f in "$ROOT"/migrations/*.sql; do
  echo "    $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -1 -f "$f" >/dev/null
done

"${PSQL[@]}" -d "$DB" -f "$HERE/test-helpers.sql" >/dev/null

echo "==> pgTAP"
if [ "$#" -gt 0 ]; then
  FILES=()
  for a in "$@"; do FILES+=("$ROOT/${a#supabase/}"); done
else
  FILES=("$ROOT"/tests/*.sql)
fi
set +e
pg_prove -h "$TMP" -p "$PORT" -U postgres -d "$DB" --verbose "${FILES[@]}" 2>&1 | tee "$TMP/prove.log" | { if [ -n "${VERBOSE:-}" ]; then cat; else grep -v '^[[:space:]]*ok ' ; fi; }
STATUS=${PIPESTATUS[0]}
set -e

if [ -n "${KEEP:-}" ]; then
  echo "Cluster lasciato acceso: psql -h $TMP -p $PORT -U postgres $DB   (arresto: pg_ctl -D $TMP/data stop)"
fi
exit "$STATUS"
