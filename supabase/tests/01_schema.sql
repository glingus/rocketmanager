-- Struttura, catalogo, privilegi, profilo da auth.users, Realtime, Storage.
begin;
select plan(40);
select tests.prepare();

-- ---- RLS attiva su tutte le tabelle -------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity),
  0, 'RLS attiva su tutte le tabelle di public e private');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  17, 'le tabelle pubbliche sono 17');

-- ---- catalogo eventi -----------------------------------------------------------------------
select is((select count(*)::int from public.event_types), 17, 'catalogo eventi popolato');
select results_eq(
  $$select type from public.event_types where client_allowed order by type$$,
  $$values ('card.assigned'), ('card.commented'), ('card.completed'), ('card.created'),
           ('card.important'), ('card.updated'), ('conflict.detected'), ('conflict.resolved'),
           ('file.editing_started'), ('sync.error')$$,
  'tipi consentiti al client');
select results_eq(
  $$select type from public.event_types where not client_allowed order by type$$,
  $$values ('member.added'), ('member.removed'), ('member.role_changed'), ('project.archived'),
           ('project.created'), ('version.published'), ('version.restored')$$,
  'tipi riservati al server');
select results_eq(
  $$select type from public.event_types where audience = 'private' order by type$$,
  $$values ('card.assigned'), ('sync.error')$$,
  'tipi con destinatari privati');
select is(
  (select importance::text from public.event_types where type = 'conflict.detected'),
  'critical', 'conflict.detected è critico');
select is(
  public.default_discord_event_types(),
  array['card.important', 'conflict.detected', 'conflict.resolved', 'member.added',
        'member.removed', 'member.role_changed', 'project.archived', 'project.created',
        'version.published', 'version.restored'],
  'tipi Discord predefiniti = discord_default');

-- ---- privilegi -----------------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.projects', 'select'), 'anon non legge projects');
select ok(not has_table_privilege('anon', 'public.cards', 'select'), 'anon non legge cards');
select ok(has_table_privilege('authenticated', 'public.cards', 'select'), 'authenticated legge cards (RLS filtra)');
select ok(not has_table_privilege('authenticated', 'public.projects', 'insert'), 'authenticated non inserisce projects');
select ok(not has_table_privilege('authenticated', 'public.project_members', 'insert'), 'authenticated non inserisce project_members');
select ok(not has_table_privilege('authenticated', 'public.versions', 'insert'), 'authenticated non inserisce versions');
select ok(not has_table_privilege('authenticated', 'public.activity_log', 'insert'), 'authenticated non inserisce activity_log');
select ok(not has_table_privilege('authenticated', 'public.notification_events', 'select'), 'authenticated non legge notification_events');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated senza uso dello schema private');
select ok(not has_table_privilege('authenticated', 'private.discord_webhooks', 'select'), 'webhook Discord non leggibili');
select ok(not has_function_privilege('authenticated', 'public.emit_event_server(uuid,text,jsonb,uuid,uuid[])', 'execute'), 'emit_event_server non eseguibile dal client');
select ok(not has_function_privilege('authenticated', 'public.create_project_record(text,text,text,text,text,bigint,text,uuid,uuid)', 'execute'), 'create_project_record non eseguibile dal client');
select ok(has_function_privilege('service_role', 'public.emit_event_server(uuid,text,jsonb,uuid,uuid[])', 'execute'), 'emit_event_server eseguibile dal server');
select ok(not has_function_privilege('anon', 'public.emit_event(uuid,text,jsonb,uuid[])', 'execute'), 'anon non emette eventi');
select ok(has_column_privilege('authenticated', 'public.projects', 'name', 'update'), 'name aggiornabile');
select ok(not has_column_privilege('authenticated', 'public.projects', 'slug', 'update'), 'slug non aggiornabile');
select ok(not has_column_privilege('authenticated', 'public.projects', 'github_repo', 'update'), 'github_repo non aggiornabile');

-- ---- profilo creato dal trigger -----------------------------------------------------------
select tests.create_user('simone', 'Simone Rossi') as simone \gset
select is((select github_login from public.profiles where id = :'simone'), 'simone', 'profilo: login da user_name');
select is((select display_name from public.profiles where id = :'simone'), 'Simone Rossi', 'profilo: nome da full_name');
select is((select avatar_url from public.profiles where id = :'simone'), 'https://avatars.example.test/simone', 'profilo: avatar');
select ok((select github_id from public.profiles where id = :'simone') is not null, 'profilo: github_id da provider_id');
select ok((select avatar_color from public.profiles where id = :'simone') ~ '^#[0-9a-f]{6}$', 'profilo: colore assegnato');
update auth.users set raw_user_meta_data = raw_user_meta_data || '{"user_name":"simone2","full_name":"Altro Nome"}' where id = :'simone';
select is((select github_login from public.profiles where id = :'simone'), 'simone2', 'profilo: login aggiornato con GitHub');
select is((select display_name from public.profiles where id = :'simone'), 'Simone Rossi', 'profilo: il nome scelto non viene sovrascritto');
select lives_ok($$insert into auth.users (id, email) values (gen_random_uuid(), 'senza.metadati@example.test')$$,
  'utente senza metadati: profilo comunque creato');
select is((select github_login from public.profiles where github_login = 'senza.metadati'), 'senza.metadati', 'profilo di ripiego da email');

-- ---- Realtime e Storage -------------------------------------------------------------------
select is(
  (select array_agg(tablename::text order by tablename::text) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'),
  array['activity_log', 'card_comments', 'cards', 'conflicts', 'file_claims',
        'notifications', 'project_members', 'versions'],
  'tabelle pubblicate su Realtime');
select is((select public from storage.buckets where id = 'attachments'), false, 'bucket attachments privato');
select is((select file_size_limit from storage.buckets where id = 'attachments'), 26214400::bigint, 'limite di 25 MB');
select is(public.attachment_project_id('c0ffee00-0000-4000-8000-000000000000/x/y.png'),
  'c0ffee00-0000-4000-8000-000000000000'::uuid, 'attachment_project_id: percorso valido');
select is(public.attachment_project_id('non-un-uuid/x.png'), null::uuid, 'attachment_project_id: percorso non valido');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'), 3, 'tre policy su storage.objects (select, insert, delete)');

select * from finish();
rollback;
