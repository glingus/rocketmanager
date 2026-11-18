-- 6/6: bucket e policy di Storage, pubblicazione Realtime, job pg_cron.

-- ---------------------------------------------------------------------------------------------
-- Storage: bucket privato `attachments`, percorso <project_id>/<card_id>/<uuid>-<filename>
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

create policy attachments_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_project_member(public.attachment_project_id(name))
  );

create policy attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and public.is_project_member(public.attachment_project_id(name))
    and public.is_project_active(public.attachment_project_id(name))
  );

-- Nessun update. Cancellazione: autore del file (o dell'allegato) o admin del progetto.
create policy attachments_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_project_member(public.attachment_project_id(name))
    and public.is_project_active(public.attachment_project_id(name))
    and (
      owner_id = auth.uid()::text
      or public.is_project_admin(public.attachment_project_id(name))
      or exists (
        select 1 from public.card_attachments a
        where a.storage_path = name and a.uploaded_by = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------------------------
alter table public.cards replica identity full;
alter table public.card_comments replica identity full;
alter table public.file_claims replica identity full;
alter table public.project_members replica identity full;
alter table public.notifications replica identity full;

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'cards', 'card_comments', 'activity_log', 'notifications',
      'versions', 'conflicts', 'file_claims', 'project_members'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  else
    raise notice 'Pubblicazione supabase_realtime assente: tabelle non aggiunte a Realtime.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- pg_cron: invia ogni minuto la coda Discord chiamando la Edge Function `discord-dispatch`.
-- Si crea solo se l'estensione è disponibile (su Supabase lo è; nei test locali no).
-- Prima del primo uso: salvare in Vault i segreti `project_url` e `service_role_key`
-- (vedi supabase/README.md).
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'discord-dispatch') then
      perform cron.unschedule('discord-dispatch');
    end if;
    perform cron.schedule('discord-dispatch', '* * * * *', $cmd$select private.invoke_edge_function('discord-dispatch')$cmd$);
  else
    raise notice 'pg_cron non disponibile: job discord-dispatch non pianificato.';
  end if;
end;
$$;
