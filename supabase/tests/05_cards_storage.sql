-- Note, commenti, allegati (tabella e Storage), progetti archiviati.
begin;
select plan(35);
select tests.prepare();

select tests.create_user('anna') as anna \gset
select tests.create_user('bruno') as bruno \gset
select tests.create_user('carla') as carla \gset
select tests.create_user('estranea') as estranea \gset
select tests.create_project('Progetto A', :'anna') as p \gset
select tests.add_member(:'p', :'bruno');
select tests.add_member(:'p', :'carla');

select is((select count(*)::int from public.card_categories where project_id = :'p' and is_default), 6, 'sei categorie predefinite');
select is((select array_agg(name order by sort) from public.card_categories where project_id = :'p'),
  array['Nota', 'Problema', 'Attività', 'Acquisto', 'Idea', 'Osservazione tecnica'], 'nomi delle categorie');
select is((select count(*)::int from public.project_discord_settings where project_id = :'p'), 1, 'impostazioni Discord create col progetto');
select is((select count(*)::int from public.activity_log where project_id = :'p' and type = 'project.created'), 1, 'evento project.created registrato');

-- ---- note ---------------------------------------------------------------------------------------
select tests.as_user(:'bruno');
select lives_ok(format($$insert into public.cards (project_id, title, created_by, priority, color) values (%L, 'Ordinare tubi', %L, 'high', 'rosso')$$, :'p', :'bruno'),
  'member: crea una nota');
select throws_ok(format($$insert into public.cards (project_id, title, created_by) values (%L, 'finta', %L)$$, :'p', :'anna'),
  '42501', null, 'non si crea una nota a nome di un altro');
select throws_ok(format($$insert into public.cards (project_id, title, created_by) values (%L, '', %L)$$, :'p', :'bruno'),
  '23514', null, 'titolo vuoto rifiutato');
select throws_ok(format($$insert into public.cards (project_id, title, created_by, assignee_id) values (%L, 'x', %L, %L)$$, :'p', :'bruno', :'estranea'),
  '23514', 'L''assegnatario non fa parte del progetto', 'assegnatario non membro rifiutato');
select id as card from public.cards where title = 'Ordinare tubi' \gset
select lives_ok(format($$update public.cards set status = 'completed', assignee_id = %L where id = %L$$, :'carla', :'card'), 'member: aggiorna e completa una nota');
select ok((select completed_at is not null from public.cards where id = :'card'), 'completed_at impostato dal trigger');
update public.cards set status = 'open' where id = :'card';
select ok((select completed_at is null from public.cards where id = :'card'), 'completed_at azzerato se riaperta');
select throws_ok(format($$update public.cards set created_by = %L where id = %L$$, :'carla', :'card'), '42501', null, 'created_by non modificabile');
select ok((select priority = 'high' and color = 'rosso' from public.cards where id = :'card'), 'colore e priorità sono indipendenti');

-- ---- eliminazione: autore o admin ----------------------------------------------------------------
select tests.as_user(:'carla');
delete from public.cards where id = :'card';
select is((select count(*)::int from public.cards where id = :'card'), 1, 'un altro member non elimina la nota');
select tests.as_user(:'anna');
select lives_ok(format($$delete from public.cards where id = %L$$, :'card'), 'l''admin elimina la nota');
select is((select count(*)::int from public.cards), 0, 'nota eliminata');

-- ---- commenti -----------------------------------------------------------------------------------------
select tests.as_user(:'bruno');
insert into public.cards (project_id, title, created_by) values (:'p', 'Con commenti', :'bruno');
select id as card2 from public.cards where title = 'Con commenti' \gset
select lives_ok(format($$insert into public.card_comments (card_id, project_id, author_id, body) values (%L, %L, %L, 'ciao')$$, :'card2', :'p', :'bruno'), 'member: commenta');
select throws_ok(format($$insert into public.card_comments (card_id, project_id, author_id, body) values (%L, %L, %L, 'falso')$$, :'card2', :'p', :'carla'),
  '42501', null, 'non si commenta a nome di un altro');
select lives_ok(format($$update public.card_comments set body = 'ciao a tutti' where card_id = %L$$, :'card2'), 'l''autore modifica il commento');
select ok((select edited_at is not null from public.card_comments), 'edited_at impostato');
select tests.as_user(:'carla');
update public.card_comments set body = 'manomesso';
select is((select body from public.card_comments), 'ciao a tutti', 'un altro member non modifica il commento');

-- ---- allegati -----------------------------------------------------------------------------------------
select tests.as_user(:'bruno');
select lives_ok(format($$insert into public.card_attachments (card_id, project_id, storage_path, filename, size_bytes, mime_type, uploaded_by) values (%L, %L, %L, 'a.png', 1000, 'image/png', %L)$$,
  :'card2', :'p', :'p' || '/' || :'card2' || '/u1-a.png', :'bruno'), 'member: registra un allegato');
select throws_ok(format($$insert into public.card_attachments (card_id, project_id, storage_path, filename, size_bytes, uploaded_by) values (%L, %L, %L, 'b.png', 26214401, %L)$$,
  :'card2', :'p', :'p' || '/' || :'card2' || '/u2-b.png', :'bruno'), '23514', null, 'allegato oltre 25 MB rifiutato');
select throws_ok(format($$insert into public.card_attachments (card_id, project_id, storage_path, filename, size_bytes, uploaded_by) values (%L, %L, 'altro/percorso.png', 'c.png', 1, %L)$$,
  :'card2', :'p', :'bruno'), '23514', null, 'percorso non conforme rifiutato');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('attachments', %L, %L)$$,
  :'p' || '/' || :'card2' || '/u1-a.png', :'bruno'), 'member: carica il file nel bucket');
select is((select count(*)::int from storage.objects), 1, 'member: vede il file');
select tests.as_user(:'carla');
select is((select count(*)::int from storage.objects), 1, 'altro member: vede il file');
delete from storage.objects where bucket_id = 'attachments';
select is((select count(*)::int from storage.objects), 1, 'altro member non cancella il file altrui');
select tests.as_user(:'anna');
delete from storage.objects where bucket_id = 'attachments';
select is((select count(*)::int from storage.objects), 0, 'l''admin cancella il file');

-- ---- progetto archiviato: sola lettura per note e commenti -----------------------------------------------
select tests.as_user(:'carla');
select throws_ok(format($$select public.archive_project(%L)$$, :'p'), '42501', null, 'solo l''admin archivia');
select tests.as_user(:'anna');
select lives_ok(format($$select public.archive_project(%L)$$, :'p'), 'admin: archivia il progetto');
select tests.as_user(:'bruno');
select throws_ok(format($$insert into public.cards (project_id, title, created_by) values (%L, 'dopo', %L)$$, :'p', :'bruno'),
  '42501', null, 'archiviato: nessuna nuova nota');
select throws_ok(format($$insert into public.card_comments (card_id, project_id, author_id, body) values (%L, %L, %L, 'tardi')$$, :'card2', :'p', :'bruno'),
  '42501', null, 'archiviato: nessun nuovo commento');
select throws_ok(format($$select public.emit_event(%L, 'card.created', '{"title":"x"}')$$, :'p'),
  '42501', 'Il progetto è archiviato', 'archiviato: nessun evento card.*');
select is((select count(*)::int from public.cards where project_id = :'p'), 1, 'archiviato: la lettura resta consentita');

select * from finish();
rollback;
