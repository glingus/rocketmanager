-- 5/6: Row Level Security, privilegi e policy.
-- Principio: tutto negato salvo policy esplicite. Il client (`authenticated`) non ha INSERT/UPDATE su
-- projects, project_members, project_invitations, versions, conflicts, file_claims, activity_log,
-- notification_events: si scrive solo tramite RPC o Edge Functions (service_role).

-- ---------------------------------------------------------------------------------------------
-- Abilita RLS ovunque
-- ---------------------------------------------------------------------------------------------
alter table public.profiles                  enable row level security;
alter table public.projects                  enable row level security;
alter table public.project_members           enable row level security;
alter table public.project_invitations       enable row level security;
alter table public.versions                  enable row level security;
alter table public.conflicts                 enable row level security;
alter table public.file_claims               enable row level security;
alter table public.card_categories           enable row level security;
alter table public.cards                     enable row level security;
alter table public.card_comments             enable row level security;
alter table public.card_attachments          enable row level security;
alter table public.event_types               enable row level security;
alter table public.activity_log              enable row level security;
alter table public.notification_events       enable row level security;
alter table public.notifications             enable row level security;
alter table public.notification_preferences  enable row level security;
alter table public.project_discord_settings  enable row level security;
alter table private.discord_webhooks         enable row level security;
alter table private.discord_outbox           enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Privilegi di tabella (RLS poi filtra le righe)
-- ---------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

grant usage on schema public to anon, authenticated, service_role;

-- Lettura
grant select on
  public.profiles, public.projects, public.project_members, public.project_invitations,
  public.versions, public.conflicts, public.file_claims, public.card_categories, public.cards,
  public.card_comments, public.card_attachments, public.activity_log, public.notifications,
  public.notification_preferences, public.project_discord_settings, public.event_types
  to authenticated;

-- Scrittura diretta consentita al client (le colonne protette sono escluse)
grant insert on public.card_categories, public.cards, public.card_comments,
  public.card_attachments, public.notification_preferences to authenticated;
grant update (display_name, avatar_color) on public.profiles to authenticated;
grant update (name, description, settings, ai_admin_id) on public.projects to authenticated;
grant update (name, icon, sort) on public.card_categories to authenticated;
grant update (title, description, color, priority, category_id, status, assignee_id, due_date,
              position, linked_version, converted_at) on public.cards to authenticated;
grant update (body) on public.card_comments to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant update (in_app, desktop) on public.notification_preferences to authenticated;
grant update (enabled_event_types) on public.project_discord_settings to authenticated;
grant delete on public.card_categories, public.cards, public.card_comments,
  public.card_attachments, public.notification_preferences to authenticated;

-- service_role: accesso completo (le Edge Functions verificano il ruolo dell'utente prima).
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;
grant all on all sequences in schema private to service_role;

-- ---------------------------------------------------------------------------------------------
-- Privilegi di esecuzione delle funzioni
-- ---------------------------------------------------------------------------------------------
grant execute on function
  public.is_project_member(uuid), public.is_project_admin(uuid), public.is_project_active(uuid),
  public.attachment_project_id(text), public.default_discord_event_types(),
  public.emit_event(uuid, text, jsonb, uuid[]),
  public.report_conflict(uuid, text, jsonb, integer, uuid),
  public.resolve_conflict_record(uuid, text, jsonb, integer),
  public.claim_file(uuid, text, public.claim_kind, text, text, timestamptz),
  public.release_file(uuid, text, public.claim_kind),
  public.heartbeat_claims(uuid, text),
  public.mark_notifications_read(bigint[]),
  public.archive_project(uuid, boolean)
  to authenticated;

grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;

-- ---------------------------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------------------------
-- profiles
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- projects (insert/delete: solo Edge Function / nessuno; si archivia con archive_project)
create policy projects_select on public.projects
  for select to authenticated using (public.is_project_member(id));
create policy projects_update_admin on public.projects
  for update to authenticated
  using (public.is_project_admin(id)) with check (public.is_project_admin(id));

-- project_members (scrittura: Edge Function manage-members)
create policy project_members_select on public.project_members
  for select to authenticated using (public.is_project_member(project_id));

-- project_invitations: admin del progetto e invitato (per login GitHub)
create policy project_invitations_select on public.project_invitations
  for select to authenticated
  using (
    public.is_project_admin(project_id)
    or lower(github_login) = (select lower(p.github_login) from public.profiles p where p.id = auth.uid())
  );

-- versions, conflicts, file_claims: lettura ai membri; scrittura via webhook / RPC
create policy versions_select on public.versions
  for select to authenticated using (public.is_project_member(project_id));
create policy conflicts_select on public.conflicts
  for select to authenticated using (public.is_project_member(project_id));
create policy file_claims_select on public.file_claims
  for select to authenticated using (public.is_project_member(project_id));

-- card_categories
create policy card_categories_select on public.card_categories
  for select to authenticated using (public.is_project_member(project_id));
create policy card_categories_insert on public.card_categories
  for insert to authenticated
  with check (public.is_project_member(project_id) and public.is_project_active(project_id));
create policy card_categories_update on public.card_categories
  for update to authenticated
  using (public.is_project_member(project_id) and public.is_project_active(project_id))
  with check (public.is_project_member(project_id) and public.is_project_active(project_id));
create policy card_categories_delete on public.card_categories
  for delete to authenticated
  using (public.is_project_admin(project_id) and public.is_project_active(project_id));

-- cards
create policy cards_select on public.cards
  for select to authenticated using (public.is_project_member(project_id));
create policy cards_insert on public.cards
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.is_project_member(project_id) and public.is_project_active(project_id)
  );
create policy cards_update on public.cards
  for update to authenticated
  using (public.is_project_member(project_id) and public.is_project_active(project_id))
  with check (public.is_project_member(project_id) and public.is_project_active(project_id));
create policy cards_delete on public.cards
  for delete to authenticated
  using (
    public.is_project_active(project_id)
    and (created_by = auth.uid() or public.is_project_admin(project_id))
  );

-- card_comments
create policy card_comments_select on public.card_comments
  for select to authenticated using (public.is_project_member(project_id));
create policy card_comments_insert on public.card_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.is_project_member(project_id) and public.is_project_active(project_id)
  );
create policy card_comments_update on public.card_comments
  for update to authenticated
  using (author_id = auth.uid() and public.is_project_member(project_id) and public.is_project_active(project_id))
  with check (author_id = auth.uid());
create policy card_comments_delete on public.card_comments
  for delete to authenticated
  using (
    public.is_project_active(project_id)
    and (author_id = auth.uid() or public.is_project_admin(project_id))
  );

-- card_attachments (nessun update)
create policy card_attachments_select on public.card_attachments
  for select to authenticated using (public.is_project_member(project_id));
create policy card_attachments_insert on public.card_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_project_member(project_id) and public.is_project_active(project_id)
  );
create policy card_attachments_delete on public.card_attachments
  for delete to authenticated
  using (
    public.is_project_active(project_id)
    and (uploaded_by = auth.uid() or public.is_project_admin(project_id))
  );

-- activity_log: lettura ai membri; scrittura via RPC; pulizia con trigger
create policy activity_log_select on public.activity_log
  for select to authenticated using (public.is_project_member(project_id));

-- notifications: solo il destinatario
create policy notifications_select on public.notifications
  for select to authenticated using (recipient_id = auth.uid());
create policy notifications_update on public.notifications
  for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- notification_preferences: solo le proprie
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated using (user_id = auth.uid());
create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated with check (user_id = auth.uid());
create policy notification_preferences_update on public.notification_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated using (user_id = auth.uid());

-- project_discord_settings: lettura ai membri, modifica agli admin (solo enabled_event_types)
create policy project_discord_settings_select on public.project_discord_settings
  for select to authenticated using (public.is_project_member(project_id));
create policy project_discord_settings_update on public.project_discord_settings
  for update to authenticated
  using (public.is_project_admin(project_id) and public.is_project_active(project_id))
  with check (public.is_project_admin(project_id));

-- event_types: catalogo leggibile da tutti gli utenti autenticati
create policy event_types_select on public.event_types
  for select to authenticated using (true);

-- notification_events, private.discord_webhooks, private.discord_outbox: nessuna policy
-- (nessun accesso per i ruoli client; il service_role bypassa RLS).
