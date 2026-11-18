-- 3/6: trigger (profilo da auth.users, campi non modificabili, ultimo admin, conservazione del log,
-- updated_at, coerenza delle note).

-- ---------------------------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------------------------
create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger projects_touch before update on public.projects
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Profilo creato (e aggiornato) da auth.users
-- Dati da raw_user_meta_data: user_name, provider_id, full_name, avatar_url.
-- ---------------------------------------------------------------------------------------------
create function private.handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_login  text;
  v_name   text;
  v_gid    text;
  v_colors text[] := array['#8b5e3c', '#a23b3b', '#c9772b', '#7a8b3c', '#3f7f6e', '#3d6a9a', '#6b4f8a', '#9a4f6d'];
begin
  v_login := coalesce(
    nullif(meta ->> 'user_name', ''),
    nullif(meta ->> 'preferred_username', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'utente-' || left(new.id::text, 8)
  );
  v_name := left(coalesce(nullif(meta ->> 'full_name', ''), nullif(meta ->> 'name', ''), v_login), 80);
  v_gid := coalesce(meta ->> 'provider_id', meta ->> 'sub');

  insert into public.profiles (id, github_id, github_login, display_name, avatar_url, avatar_color)
  values (
    new.id,
    case when v_gid ~ '^[0-9]{1,18}$' then v_gid::bigint end,
    v_login,
    v_name,
    nullif(meta ->> 'avatar_url', ''),
    v_colors[1 + (('x' || substr(md5(new.id::text), 1, 7))::bit(28)::int % array_length(v_colors, 1))]
  )
  on conflict (id) do update
    set github_login = excluded.github_login,
        github_id    = coalesce(excluded.github_id, public.profiles.github_id),
        avatar_url   = excluded.avatar_url;
  -- display_name e avatar_color scelti dall'utente non vengono sovrascritti.
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_auth_user();
create trigger on_auth_user_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function private.handle_auth_user();

-- ---------------------------------------------------------------------------------------------
-- projects: campi non modificabili dal client, impostazioni valide
-- ---------------------------------------------------------------------------------------------
create function private.protect_project_columns()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  -- Il client (ruoli anon/authenticated) può cambiare solo name, description, settings, ai_admin_id.
  -- Le funzioni security definer e il service_role passano da altri ruoli.
  if current_user in ('anon', 'authenticated') then
    if new.id is distinct from old.id
       or new.slug is distinct from old.slug
       or new.github_owner is distinct from old.github_owner
       or new.github_repo is distinct from old.github_repo
       or new.github_repo_id is distinct from old.github_repo_id
       or new.default_branch is distinct from old.default_branch
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or new.archived_at is distinct from old.archived_at then
      raise exception 'Questo campo del progetto non è modificabile dal client'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger projects_protect before update on public.projects
  for each row execute function private.protect_project_columns();

create function private.validate_project_settings()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
declare
  v_mode text := coalesce(new.settings #>> '{publishPolicy,mode}', 'assisted');
  v_ret  numeric;
begin
  if jsonb_typeof(new.settings) <> 'object' then
    raise exception 'Le impostazioni devono essere un oggetto JSON' using errcode = '23514';
  end if;
  if v_mode not in ('assisted', 'manual', 'onSave') then
    raise exception 'Modalità di pubblicazione non valida: %', v_mode using errcode = '23514';
  end if;
  if new.settings ? 'activityRetention' then
    if jsonb_typeof(new.settings -> 'activityRetention') <> 'number' then
      raise exception 'activityRetention deve essere un numero' using errcode = '23514';
    end if;
    v_ret := (new.settings ->> 'activityRetention')::numeric;
    if v_ret <> floor(v_ret) or v_ret < 10 or v_ret > 10000 then
      raise exception 'activityRetention deve essere un intero tra 10 e 10000' using errcode = '23514';
    end if;
  end if;
  if new.settings #> '{publishPolicy,idleMinutes}' is not null then
    if jsonb_typeof(new.settings #> '{publishPolicy,idleMinutes}') <> 'number'
       or (new.settings #>> '{publishPolicy,idleMinutes}')::numeric < 1
       or (new.settings #>> '{publishPolicy,idleMinutes}')::numeric > 1440 then
      raise exception 'idleMinutes deve essere tra 1 e 1440' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger projects_validate_settings before insert or update of settings on public.projects
  for each row execute function private.validate_project_settings();

-- ---------------------------------------------------------------------------------------------
-- project_members: ogni progetto ha almeno un admin
-- ---------------------------------------------------------------------------------------------
create function private.protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.user_id <> old.user_id) then
    raise exception 'Progetto e utente di un membro non sono modificabili' using errcode = '42501';
  end if;

  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.projects p where p.id = old.project_id)
     and not exists (
       select 1 from public.project_members m
       where m.project_id = old.project_id and m.role = 'admin' and m.user_id <> old.user_id
     ) then
    raise exception 'Il progetto deve avere almeno un amministratore'
      using errcode = '23514', hint = 'last_admin';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger project_members_last_admin before update or delete on public.project_members
  for each row execute function private.protect_last_admin();

-- ---------------------------------------------------------------------------------------------
-- activity_log: conservazione degli ultimi N eventi per progetto (mai toccato Git né `versions`)
-- ---------------------------------------------------------------------------------------------
create function private.trim_activity_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keep   integer;
  v_cutoff bigint;
begin
  select coalesce((p.settings ->> 'activityRetention')::numeric::integer, 100)
    into v_keep
    from public.projects p
   where p.id = new.project_id;
  v_keep := greatest(coalesce(v_keep, 100), 1);

  select a.id into v_cutoff
    from public.activity_log a
   where a.project_id = new.project_id
   order by a.id desc
   offset v_keep limit 1;

  if v_cutoff is not null then
    delete from public.activity_log a
     where a.project_id = new.project_id and a.id <= v_cutoff;
  end if;
  return null;
end;
$$;

create trigger activity_log_trim after insert on public.activity_log
  for each row execute function private.trim_activity_log();

-- ---------------------------------------------------------------------------------------------
-- cards / card_comments
-- ---------------------------------------------------------------------------------------------
create function private.cards_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.project_id <> old.project_id
       or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'Progetto, autore e data di creazione di una nota non sono modificabili'
        using errcode = '42501';
    end if;
  end if;

  if new.assignee_id is not null and not exists (
    select 1 from public.project_members m
    where m.project_id = new.project_id and m.user_id = new.assignee_id
  ) then
    raise exception 'L''assegnatario non fa parte del progetto' using errcode = '23514';
  end if;

  if new.status = 'completed' then
    if tg_op = 'INSERT' or old.status <> 'completed' then
      new.completed_at := now();
    end if;
  elsif new.status in ('open', 'in_progress') then
    new.completed_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger cards_guard_trg before insert or update on public.cards
  for each row execute function private.cards_guard();

create function private.card_comments_guard()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  if new.id <> old.id or new.card_id <> old.card_id or new.project_id <> old.project_id
     or new.author_id <> old.author_id or new.created_at <> old.created_at then
    raise exception 'Di un commento si può modificare solo il testo' using errcode = '42501';
  end if;
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger card_comments_guard_trg before update on public.card_comments
  for each row execute function private.card_comments_guard();

-- ---------------------------------------------------------------------------------------------
-- project_discord_settings: solo tipi di evento del catalogo con destinatari di progetto
-- ---------------------------------------------------------------------------------------------
create function private.discord_settings_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bad text;
begin
  select t into v_bad
    from unnest(new.enabled_event_types) as t
   where not exists (
     select 1 from public.event_types e where e.type = t and e.audience = 'project'
   )
   limit 1;
  if v_bad is not null then
    raise exception 'Tipo di evento non valido per Discord: %', v_bad using errcode = '23514';
  end if;
  new.enabled_event_types := (select coalesce(array_agg(distinct t order by t), '{}') from unnest(new.enabled_event_types) t);
  new.updated_at := now();
  if tg_op = 'UPDATE' and current_user in ('anon', 'authenticated') then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger discord_settings_guard_trg before insert or update on public.project_discord_settings
  for each row execute function private.discord_settings_guard();
