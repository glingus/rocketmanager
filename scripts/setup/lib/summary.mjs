// Riepilogo finale: valori pubblici per le variabili Actions del repository.

export const VARIABLE_NAMES = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PROJECTS_ORG'];

export function publicValues({ ref, org, anonKey }) {
  return {
    SUPABASE_URL: `https://${ref}.supabase.co`,
    SUPABASE_ANON_KEY: anonKey,
    PROJECTS_ORG: org,
  };
}

/**
 * Se `gh` è installato e autenticato, offre di impostare le variabili (solo con conferma).
 * @returns {Promise<'impostate'|'rifiutato'|'non-disponibile'|'errore'>}
 */
export async function offerGhVariables({ run, prompter, values, log, assumeYes = false, cwd }) {
  const auth = await run('gh', ['auth', 'status'], { cwd }).catch(() => ({ code: 127 }));
  if (auth.code !== 0) return 'non-disponibile';
  const repoRes = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd }).catch(() => ({ code: 1, stdout: '' }));
  const repo = repoRes.code === 0 ? repoRes.stdout.trim() : '';
  if (!repo) {
    log('gh è autenticato ma non riesco a capire il repository: imposta le variabili a mano.', 'warn');
    return 'non-disponibile';
  }
  const ok = assumeYes || (await prompter.confirm(`Imposto le variabili Actions (${VARIABLE_NAMES.join(', ')}) nel repository ${repo} con "gh variable set"?`));
  if (!ok) return 'rifiutato';
  for (const name of VARIABLE_NAMES) {
    const r = await run('gh', ['variable', 'set', name, '--body', values[name], '--repo', repo], { cwd });
    if (r.code !== 0) {
      log(`Non sono riuscito a impostare ${name}: ${r.stderr.trim().split('\n').pop()}`, 'warn');
      return 'errore';
    }
    log(`variabile ${name} impostata in ${repo}`, 'ok');
  }
  return 'impostate';
}
