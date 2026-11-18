-- Funzioni di supporto per i test pgTAP (schema `tests`, solo database di test).
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Crea un utente (la riga in auth.users fa scattare il trigger che crea il profilo).
create function tests.create_user(p_login text, p_name text default null)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (
    v_id,
    p_login || '@example.test',
    jsonb_build_object(
      'user_name', p_login,
      'full_name', coalesce(p_name, initcap(p_login)),
      'provider_id', abs(hashtext(p_login))::text,
      'avatar_url', 'https://avatars.example.test/' || p_login
    )
  );
  return v_id;
end;
$$;

-- Impersona un utente come fa PostgREST: ruolo `authenticated` + request.jwt.claims.
create function tests.as_user(p_uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function tests.as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;

create function tests.as_service()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
end;
$$;

-- Torna al superutente del test (nessun JWT).
create function tests.as_admin()
returns void
language plpgsql
as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- pgTAP scrive i risultati in tabelle temporanee del superutente: i ruoli client devono poterle usare.
-- Da chiamare subito dopo plan().
create function tests.prepare()
returns void
language plpgsql
as $$
begin
  execute 'grant all on all tables in schema pg_temp to anon, authenticated, service_role';
  execute 'grant all on all sequences in schema pg_temp to anon, authenticated, service_role';
end;
$$;

-- Progetto di prova con un admin (usa la stessa funzione del server).
create function tests.create_project(p_name text, p_admin uuid, p_slug text default null)
returns uuid
language plpgsql
as $$
declare
  v_slug text := coalesce(p_slug, lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')));
begin
  return public.create_project_record(p_name, v_slug, '', 'rocket-org', v_slug, 1000 + abs(hashtext(v_slug)), 'main', p_admin);
end;
$$;

create function tests.add_member(p_project uuid, p_user uuid, p_role public.member_role default 'member')
returns void
language sql
as $$
  insert into public.project_members (project_id, user_id, role, added_by)
  values (p_project, p_user, p_role, null);
$$;
