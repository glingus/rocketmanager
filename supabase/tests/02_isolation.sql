-- Un non membro non vede nulla; i dati di un progetto non compaiono in un altro.
begin;
select plan(31);
select tests.prepare();

select tests.create_user('anna') as anna \gset
select tests.create_user('bruno') as bruno \gset
select tests.create_user('carla') as carla \gset
select tests.create_user('estraneo') as estraneo \gset

select tests.create_project('Progetto A', :'anna') as pa \gset
select tests.create_project('Progetto B', :'carla') as pb \gset
select tests.add_member(:'pa', :'bruno');

-- Dati del progetto A e del progetto B
insert into public.cards (project_id, title, created_by) values (:'pa', 'Nota di A', :'anna');
insert into public.cards (project_id, title, created_by) values (:'pb', 'Nota di B', :'carla');
select id as card_a from public.cards where project_id = :'pa' \gset
select id as card_b from public.cards where project_id = :'pb' \gset
insert into public.card_comments (card_id, project_id, author_id, body) values (:'card_a', :'pa', :'anna', 'commento A');
insert into public.card_attachments (card_id, project_id, storage_path, filename, size_bytes, mime_type, uploaded_by)
  values (:'card_a', :'pa', :'pa' || '/' || :'card_a' || '/x-foto.png', 'foto.png', 100, 'image/png', :'anna');
insert into public.versions (project_id, number, sha, kind, title, author_github_login)
  values (:'pa', 1, repeat('a', 40), 'publish', 'Prima versione', 'anna');
insert into public.conflicts (id, project_id, files, ours_user_id, remote_branch)
  values ('20261101-abcdef', :'pa', '[{"path":"Razzo.ork","kind":"bothModified"}]', :'anna', 'conflitti/20261101-abcdef');
insert into public.file_claims (project_id, user_id, path, kind, machine_id)
  values (:'pa', :'anna', 'Razzo.ork', 'editing', 'pc-anna');
insert into public.project_invitations (project_id, github_login, invited_by) values (:'pa', 'estraneo', :'anna');
select public.emit_event_server(:'pa', 'version.published', '{"number":1}', :'anna') as _ev \gset
insert into storage.objects (bucket_id, name, owner_id) values ('attachments', :'pa' || '/' || :'card_a' || '/x-foto.png', :'anna');

-- ---- Estraneo (utente autenticato non membro di nulla) ------------------------------------
select tests.as_user(:'estraneo');
select is((select count(*)::int from public.projects), 0, 'estraneo: nessun progetto');
select is((select count(*)::int from public.cards), 0, 'estraneo: nessuna nota');
select is((select count(*)::int from public.card_comments), 0, 'estraneo: nessun commento');
select is((select count(*)::int from public.card_attachments), 0, 'estraneo: nessun allegato');
select is((select count(*)::int from public.card_categories), 0, 'estraneo: nessuna categoria');
select is((select count(*)::int from public.activity_log), 0, 'estraneo: nessun log');
select is((select count(*)::int from public.versions), 0, 'estraneo: nessuna versione');
select is((select count(*)::int from public.conflicts), 0, 'estraneo: nessun conflitto');
select is((select count(*)::int from public.file_claims), 0, 'estraneo: nessuna prenotazione');
select is((select count(*)::int from public.project_members), 0, 'estraneo: nessun membro');
select is((select count(*)::int from public.notifications), 0, 'estraneo: nessuna notifica');
select is((select count(*)::int from public.project_discord_settings), 0, 'estraneo: nessuna impostazione Discord');
select is((select count(*)::int from storage.objects), 0, 'estraneo: nessun file in storage');
select is((select count(*)::int from public.project_invitations), 1, 'estraneo: vede solo l''invito a proprio nome');
select throws_ok(
  format($$insert into public.cards (project_id, title, created_by) values (%L, 'intrusa', %L)$$, :'pa', :'estraneo'),
  '42501', null, 'estraneo: non crea note in un progetto altrui');
select throws_ok(
  format($$select public.emit_event(%L, 'card.created', '{"title":"x"}')$$, :'pa'),
  '42501', 'Non fai parte di questo progetto', 'estraneo: non emette eventi in un progetto altrui');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name, owner_id) values ('attachments', %L, %L)$$,
         :'pa' || '/' || :'card_a' || '/intruso.png', :'estraneo'),
  '42501', null, 'estraneo: non carica file in un progetto altrui');

-- ---- Anonimo -------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok($$select count(*) from public.cards$$, '42501', null, 'anon: nessun accesso alle note');
select throws_ok($$select count(*) from public.profiles$$, '42501', null, 'anon: nessun accesso ai profili');

-- ---- Progetto A vs progetto B --------------------------------------------------------------
select tests.as_user(:'anna');
select is((select array_agg(title) from public.cards), array['Nota di A'], 'anna vede solo le note di A');
select is((select array_agg(name order by name) from public.projects), array['Progetto A'], 'anna vede solo il progetto A');
select is((select count(*)::int from public.activity_log where project_id = :'pb'), 0, 'anna non vede il log di B');
select is((select count(*)::int from public.card_categories where project_id = :'pb'), 0, 'anna non vede le categorie di B');
select throws_ok(
  format($$insert into public.cards (project_id, title, created_by) values (%L, 'in B', %L)$$, :'pb', :'anna'),
  '42501', null, 'anna non crea note in B');

select tests.as_user(:'carla');
select is((select array_agg(title) from public.cards), array['Nota di B'], 'carla vede solo le note di B');
select is((select count(*)::int from public.activity_log where project_id = :'pa'), 0, 'carla non vede il log di A');
select is((select count(*)::int from public.versions), 0, 'carla non vede le versioni di A');
select is((select count(*)::int from storage.objects), 0, 'carla non vede i file di A');

-- Una nota di A non si può "spostare" in B: project_id è immutabile e l'update non è consentito su colonne protette.
select throws_ok(
  format($$update public.cards set project_id = %L where id = %L$$, :'pa', :'card_b'),
  '42501', null, 'project_id di una nota non è modificabile');

select tests.as_user(:'bruno');
select is((select array_agg(title) from public.cards), array['Nota di A'], 'bruno (membro di A) vede le note di A');
select is((select count(*)::int from public.versions), 1, 'bruno vede le versioni di A');

select * from finish();
rollback;
