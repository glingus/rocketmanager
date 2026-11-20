// Vault: `project_url` e `service_role_key` letti da private.invoke_edge_function (pg_cron).
// Crea se mancano, aggiorna se esistono (vault.create_secret / vault.update_secret).

import { sqlString } from './migrations.mjs';

export function vaultUpsertSql(name, value) {
  return `do $vault$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = ${sqlString(name)};
  if v_id is null then
    perform vault.create_secret(${sqlString(value)}, ${sqlString(name)});
  else
    perform vault.update_secret(v_id, ${sqlString(value)}, ${sqlString(name)});
  end if;
end
$vault$;`;
}

export async function upsertVaultSecrets({ api, ref, projectUrl, serviceRoleKey }) {
  await api.query(ref, 'create extension if not exists supabase_vault', { what: 'attivazione di Vault' });
  await api.query(ref, vaultUpsertSql('project_url', projectUrl), { what: 'salvataggio di project_url in Vault' });
  await api.query(ref, vaultUpsertSql('service_role_key', serviceRoleKey), { what: 'salvataggio di service_role_key in Vault' });
}
