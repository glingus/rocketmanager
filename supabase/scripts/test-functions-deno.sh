#!/usr/bin/env bash
# Prova le Edge Functions su Deno VERO (senza Docker, senza Supabase):
#   1. deno check di tutte le entry supabase/functions/*/index.ts (con l'import map);
#   2. deno lint;
#   3. test end-to-end: ogni funzione parte come processo Deno e riceve richieste HTTP vere; Supabase
#      (Auth + PostgREST + RPC), GitHub, OAuth di GitHub e Discord sono server finti locali.
#
#   supabase/scripts/test-functions-deno.sh
#   DENO_BIN=/percorso/deno supabase/scripts/test-functions-deno.sh
#
# Deno: $DENO_BIN, oppure `deno` nel PATH, oppure scaricato da npm (npx deno@$DENO_VERSION).
set -euo pipefail

DENO_VERSION="${DENO_VERSION:-2.9.6}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -n "${DENO_BIN:-}" ]; then
  DENO=("$DENO_BIN")
elif command -v deno >/dev/null 2>&1; then
  DENO=(deno)
else
  command -v npx >/dev/null 2>&1 || { echo "Servono deno (o DENO_BIN) oppure npx per scaricarlo da npm" >&2; exit 2; }
  DENO=(npx --yes "deno@${DENO_VERSION}")
fi
"${DENO[@]}" --version | head -1

echo "==> deno check"
"${DENO[@]}" check --config functions/deno.json functions/*/index.ts

echo "==> deno lint"
"${DENO[@]}" lint --config functions/deno.json functions

echo "==> test end-to-end delle 7 funzioni"
"${DENO[@]}" run --allow-net --allow-env --allow-run functions-e2e/run.ts
