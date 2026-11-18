-- 4/6: funzioni SQL (RPC). Tutte `security definer`, con search_path fissato e controllo
-- esplicito di auth.uid(). I privilegi di esecuzione sono assegnati in 20261101000005_rls.sql.

-- ---------------------------------------------------------------------------------------------
-- Helper per le policy
-- ---------------------------------------------------------------------------------------------
create function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project_id and m.user_id = auth.uid()
  );
$$;

create function public.is_project_admin(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project_id and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

create function public.is_project_active(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.projects p where p.id = p_project_id and p.archived_at is null
  );
$$;

-- Progetto indicato nel primo livello del percorso di un file in storage (<project_id>/...).
create function public.attachment_project_id(p_name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when (storage.foldername(p_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (storage.foldername(p_name))[1]::uuid
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Testo degli eventi (in italiano)
--
-- Chiavi del payload usate: number, restoredFrom, authorName, title, priority, categoryName,
-- conflictId, fileCount, files[], targetName, role, path, message, projectName, actorName.
-- ---------------------------------------------------------------------------------------------
create function private.clip(p_text text, p_max integer default 160)
returns text
language sql
immutable
as $$
  select case when char_length(p_text) > p_max then left(p_text, p_max - 1) || '…' else p_text end;
$$;

create function private.format_event_summary(
  p_type text,
  p_payload jsonb,
  p_actor_id uuid,
  p_project_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_actor   text;
  v_project text;
  v_title   text := private.clip(coalesce(p_payload ->> 'title', 'senza titolo'), 120);
  v_target  text := private.clip(coalesce(p_payload ->> 'targetName', 'un utente'), 80);
  v_files   integer;
  v_prio    text;
begin
  select coalesce(nullif(p_payload ->> 'actorName', ''), pr.display_name, pr.github_login)
    into v_actor
    from (select 1) one
    left join public.profiles pr on pr.id = p_actor_id;
  v_actor := private.clip(coalesce(v_actor, nullif(p_payload ->> 'authorName', ''), 'Qualcuno'), 80);

  select coalesce(p.name, nullif(p_payload ->> 'projectName', ''), 'il progetto')
    into v_project
    from (select 1) one
    left join public.projects p on p.id = p_project_id;

  v_files := coalesce(
    nullif(p_payload ->> 'fileCount', '')::integer,
    case when jsonb_typeof(p_payload -> 'files') = 'array' then jsonb_array_length(p_payload -> 'files') end,
    0
  );
  v_prio := case p_payload ->> 'priority'
              when 'low' then 'bassa' when 'medium' then 'media'
              when 'high' then 'alta' when 'critical' then 'critica' else null end;

  return case p_type
    when 'version.published' then
      format('%s ha pubblicato la versione %s di %s', v_actor, coalesce(p_payload ->> 'number', '?'), v_project)
    when 'version.restored' then
      format('%s ha ripristinato la versione %s di %s (nuova versione %s)', v_actor,
             coalesce(p_payload ->> 'restoredFrom', '?'), v_project, coalesce(p_payload ->> 'number', '?'))
    when 'conflict.detected' then
      format('Conflitto in %s: %s ha modifiche in conflitto su %s', v_project, v_actor,
             case when v_files = 1 then '1 file' else v_files || ' file' end)
    when 'conflict.resolved' then
      format('%s ha risolto il conflitto in %s%s', v_actor, v_project,
             case when p_payload ? 'number' then ' (versione ' || (p_payload ->> 'number') || ')' else '' end)
    when 'member.added' then format('%s ha aggiunto %s a %s', v_actor, v_target, v_project)
    when 'member.removed' then format('%s ha rimosso %s da %s', v_actor, v_target, v_project)
    when 'member.role_changed' then
      format('%s ha reso %s %s in %s', v_actor, v_target,
             case p_payload ->> 'role' when 'admin' then 'amministratore' else 'membro' end, v_project)
    when 'project.created' then format('%s ha creato il progetto %s', v_actor, v_project)
    when 'project.archived' then format('%s ha archiviato il progetto %s', v_actor, v_project)
    when 'card.created' then format('%s ha creato la nota «%s»', v_actor, v_title)
    when 'card.important' then
      format('%s ha segnalato «%s»%s', v_actor, v_title,
             case when v_prio is not null then ' (priorità ' || v_prio || ')' else '' end)
    when 'card.assigned' then format('%s ti ha assegnato «%s»', v_actor, v_title)
    when 'card.completed' then format('%s ha completato «%s»', v_actor, v_title)
    when 'card.updated' then format('%s ha aggiornato «%s»', v_actor, v_title)
    when 'card.commented' then format('%s ha commentato «%s»', v_actor, v_title)
    when 'file.editing_started' then
      format('%s sta modificando %s', v_actor, private.clip(coalesce(p_payload ->> 'path', 'un file'), 120))
    when 'sync.error' then
      format('Errore di sincronizzazione in %s: %s', v_project,
             private.clip(coalesce(p_payload ->> 'message', 'errore sconosciuto'), 200))
    else p_type
  end;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Scrittura di un evento: activity_log, notifiche, coda Discord
-- ---------------------------------------------------------------------------------------------
-- Ritorna l'id della riga di activity_log (eventi di progetto) o di notification_events
-- (eventi privati, che non compaiono nel registro condiviso), oppure null.
create function private.emit_event_core(
  p_project_id uuid,
  p_type text,
  p_payload jsonb,
  p_actor_id uuid,
  p_recipients uuid[]
)
returns bigint
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_type       public.event_types%rowtype;
  v_payload    jsonb := coalesce(p_payload, '{}'::jsonb);
  v_summary    text;
  v_recipients uuid[];
  v_settings   public.project_discord_settings%rowtype;
  v_discord    boolean := false;
  v_event_id   bigint;
  v_result     bigint;
begin
  select * into v_type from public.event_types where type = p_type;
  if not found then
    raise exception 'Tipo di evento sconosciuto: %', p_type using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Il payload deve essere un oggetto JSON' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'Progetto inesistente' using errcode = '23503';
  end if;

  v_summary := private.format_event_summary(p_type, v_payload, p_actor_id, p_project_id);

  -- Destinatari
  if v_type.audience = 'project' then
    select coalesce(array_agg(m.user_id), '{}') into v_recipients
      from public.project_members m
     where m.project_id = p_project_id
       and (p_actor_id is null or m.user_id <> p_actor_id);
  else
    select coalesce(array_agg(m.user_id), '{}') into v_recipients
      from public.project_members m
     where m.project_id = p_project_id
       and m.user_id = any (coalesce(p_recipients, case when p_actor_id is null then '{}'::uuid[] else array[p_actor_id] end));
  end if;
  -- Preferenze: in_app = false -> nessuna riga per quell'utente
  select coalesce(array_agg(r), '{}') into v_recipients
    from unnest(v_recipients) as r
   where not exists (
     select 1 from public.notification_preferences np
     where np.user_id = r and np.event_type = p_type and not np.in_app
   );

  -- Discord (solo eventi di progetto, solo se il webhook è configurato e il tipo abilitato)
  if v_type.audience = 'project' then
    select * into v_settings from public.project_discord_settings where project_id = p_project_id;
    v_discord := found and v_settings.webhook_configured and p_type = any (v_settings.enabled_event_types);
  end if;

  if v_type.audience = 'project' then
    insert into public.activity_log (project_id, actor_id, type, importance, summary, payload)
    values (p_project_id, p_actor_id, p_type, v_type.importance, v_summary, v_payload)
    returning id into v_result;
  end if;

  if v_type.notify or v_discord then
    insert into public.notification_events (project_id, type, importance, audience, summary, payload, actor_id)
    values (p_project_id, p_type, v_type.importance, v_type.audience, v_summary, v_payload, p_actor_id)
    returning id into v_event_id;
    if v_type.audience = 'private' then
      v_result := v_event_id;
    end if;

    if v_type.notify and coalesce(array_length(v_recipients, 1), 0) > 0 then
      insert into public.notifications (event_id, recipient_id, project_id, type, importance, summary, payload)
      select v_event_id, r, p_project_id, p_type, v_type.importance, v_summary, v_payload
        from unnest(v_recipients) as r;
    end if;

    if v_discord then
      insert into private.discord_outbox (project_id, event_id, summary, payload)
      values (p_project_id, v_event_id, v_summary, v_payload);
    end if;
  end if;

  return v_result;
end;
$$;

-- Evento dal client: solo tipi con client_allowed, solo membri, l'autore è sempre chi chiama.
create function public.emit_event(
  p_project_id uuid,
  p_type text,
  p_payload jsonb default '{}'::jsonb,
  p_recipients uuid[] default null
)
returns bigint
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_type public.event_types%rowtype;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  if not public.is_project_member(p_project_id) then
    raise exception 'Non fai parte di questo progetto' using errcode = '42501';
  end if;
  select * into v_type from public.event_types where type = p_type;
  if not found then
    raise exception 'Tipo di evento sconosciuto: %', p_type using errcode = '22023';
  end if;
  if not v_type.client_allowed then
    raise exception 'Il tipo di evento % non può essere registrato dal client', p_type
      using errcode = '42501';
  end if;
  if (p_type like 'card.%' or p_type like 'file.%') and not public.is_project_active(p_project_id) then
    raise exception 'Il progetto è archiviato' using errcode = '42501';
  end if;
  return private.emit_event_core(p_project_id, p_type, p_payload, v_uid, p_recipients);
end;
$$;

-- Evento dal server (Edge Functions con service_role): tutti i tipi.
create function public.emit_event_server(
  p_project_id uuid,
  p_type text,
  p_payload jsonb default '{}'::jsonb,
  p_actor_id uuid default null,
  p_recipients uuid[] default null
)
returns bigint
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  -- Doppia difesa oltre ai GRANT: se la chiamata arriva con un JWT diverso da service_role, rifiuta.
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'Funzione riservata al server' using errcode = '42501';
  end if;
  return private.emit_event_core(p_project_id, p_type, p_payload, p_actor_id, p_recipients);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Progetti
-- ---------------------------------------------------------------------------------------------
-- Crea progetto, primo admin, categorie predefinite, impostazioni Discord ed evento
-- `project.created` in un'unica transazione. Solo server.
create function public.create_project_record(
  p_name text,
  p_slug text,
  p_description text,
  p_github_owner text,
  p_github_repo text,
  p_github_repo_id bigint,
  p_default_branch text,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'Funzione riservata al server' using errcode = '42501';
  end if;

  insert into public.projects (name, slug, description, github_owner, github_repo, github_repo_id, default_branch, created_by)
  values (p_name, p_slug, coalesce(p_description, ''), p_github_owner, p_github_repo, p_github_repo_id,
          coalesce(p_default_branch, 'main'), p_created_by)
  returning id into v_id;

  insert into public.project_members (project_id, user_id, role, added_by)
  values (v_id, p_created_by, 'admin', p_created_by);

  insert into public.card_categories (project_id, name, icon, sort, is_default) values
    (v_id, 'Nota',                  'sticky-note',    1, true),
    (v_id, 'Problema',              'alert-triangle', 2, true),
    (v_id, 'Attività',              'check-square',   3, true),
    (v_id, 'Acquisto',              'shopping-cart',  4, true),
    (v_id, 'Idea',                  'lightbulb',      5, true),
    (v_id, 'Osservazione tecnica',  'wrench',         6, true);

  insert into public.project_discord_settings (project_id, updated_by) values (v_id, p_created_by);

  perform private.emit_event_core(v_id, 'project.created', jsonb_build_object('projectName', p_name), p_created_by, null);
  return v_id;
end;
$$;

-- Archivia (o riattiva) un progetto: solo admin del progetto.
create function public.archive_project(p_project_id uuid, p_archived boolean default true)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  if not public.is_project_admin(p_project_id) then
    raise exception 'Solo un amministratore può archiviare il progetto' using errcode = '42501';
  end if;
  update public.projects
     set archived_at = case when p_archived then coalesce(archived_at, now()) else null end
   where id = p_project_id;
  if p_archived then
    perform private.emit_event_core(p_project_id, 'project.archived', '{}'::jsonb, v_uid, null);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Conflitti
-- ---------------------------------------------------------------------------------------------
create function public.report_conflict(
  p_project_id uuid,
  p_conflict_id text,
  p_files jsonb,
  p_theirs_version integer default null,
  p_theirs_user_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_existing  public.conflicts%rowtype;
  v_paths     jsonb;
  v_theirs    uuid := p_theirs_user_id;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  if not public.is_project_member(p_project_id) then
    raise exception 'Non fai parte di questo progetto' using errcode = '42501';
  end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'Serve l''elenco dei file in conflitto' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_files) f
    where jsonb_typeof(f) <> 'object'
       or coalesce(f ->> 'path', '') = ''
       or coalesce(f ->> 'kind', '') not in ('bothModified', 'bothAdded', 'modifiedDeleted', 'deletedModified')
  ) then
    raise exception 'Elenco dei file non valido' using errcode = '22023';
  end if;

  select * into v_existing from public.conflicts where id = p_conflict_id;
  if found then
    if v_existing.project_id <> p_project_id then
      raise exception 'Identificatore di conflitto già usato' using errcode = '23505';
    end if;
    return v_existing.id;  -- idempotente
  end if;

  if v_theirs is not null and not exists (
    select 1 from public.project_members m where m.project_id = p_project_id and m.user_id = v_theirs
  ) then
    v_theirs := null;
  end if;

  insert into public.conflicts (id, project_id, files, ours_user_id, theirs_user_id, theirs_version, remote_branch)
  values (p_conflict_id, p_project_id, p_files, v_uid, v_theirs, p_theirs_version, 'conflitti/' || p_conflict_id);

  select coalesce(jsonb_agg(f ->> 'path'), '[]'::jsonb) into v_paths
    from (select f from jsonb_array_elements(p_files) f limit 20) s;

  perform private.emit_event_core(
    p_project_id, 'conflict.detected',
    jsonb_build_object('conflictId', p_conflict_id, 'files', v_paths, 'fileCount', jsonb_array_length(p_files)),
    v_uid, null);
  return p_conflict_id;
end;
$$;

create function public.resolve_conflict_record(
  p_project_id uuid,
  p_conflict_id text,
  p_resolution jsonb,
  p_resolved_version integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.conflicts%rowtype;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  if not public.is_project_member(p_project_id) then
    raise exception 'Non fai parte di questo progetto' using errcode = '42501';
  end if;
  select * into v_row from public.conflicts where id = p_conflict_id and project_id = p_project_id;
  if not found then
    raise exception 'Conflitto inesistente' using errcode = 'P0002';
  end if;
  if v_row.status = 'resolved' then
    return false;  -- idempotente
  end if;

  update public.conflicts
     set status = 'resolved', resolution = p_resolution, resolved_by = v_uid,
         resolved_version = p_resolved_version, resolved_at = now()
   where id = p_conflict_id;

  perform private.emit_event_core(
    p_project_id, 'conflict.resolved',
    jsonb_strip_nulls(jsonb_build_object('conflictId', p_conflict_id, 'number', p_resolved_version)),
    v_uid, null);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Chi sta lavorando su cosa (solo righe proprie)
-- ---------------------------------------------------------------------------------------------
create function public.claim_file(
  p_project_id uuid,
  p_path text,
  p_kind public.claim_kind,
  p_note text,
  p_machine_id text,
  p_expires_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  if not public.is_project_member(p_project_id) then
    raise exception 'Non fai parte di questo progetto' using errcode = '42501';
  end if;
  insert into public.file_claims (project_id, user_id, path, kind, note, machine_id, expires_at)
  values (p_project_id, v_uid, p_path, p_kind, p_note, p_machine_id, p_expires_at)
  on conflict (project_id, user_id, path, kind) do update
    set note = excluded.note,
        machine_id = excluded.machine_id,
        expires_at = excluded.expires_at,
        heartbeat_at = now();
end;
$$;

create function public.release_file(
  p_project_id uuid,
  p_path text,
  p_kind public.claim_kind default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  delete from public.file_claims
   where project_id = p_project_id and user_id = v_uid and path = p_path
     and (p_kind is null or kind = p_kind);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.heartbeat_claims(p_project_id uuid, p_machine_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  update public.file_claims
     set heartbeat_at = now()
   where project_id = p_project_id and user_id = v_uid and machine_id = p_machine_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Notifiche
-- ---------------------------------------------------------------------------------------------
create function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'Autenticazione richiesta' using errcode = '28000';
  end if;
  update public.notifications
     set read_at = now()
   where recipient_id = v_uid and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Invocazione di una Edge Function da pg_cron (via pg_net + Vault)
-- Segreti attesi in Vault: `project_url` (https://<ref>.supabase.co) e `service_role_key`.
-- ---------------------------------------------------------------------------------------------
create function private.invoke_edge_function(p_name text)
returns bigint
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_url text;
  v_key text;
  v_id  bigint;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    return null;  -- pg_net o Vault non disponibili: niente da fare (ambiente locale/di test)
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'service_role_key';
  if v_url is null or v_key is null then
    raise warning 'Segreti Vault project_url/service_role_key mancanti: %', p_name;
    return null;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := $4)'
    into v_id
    using rtrim(v_url, '/') || '/functions/v1/' || p_name,
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
          '{}'::jsonb,
          20000;
  return v_id;
end;
$$;
