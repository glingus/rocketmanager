-- emit_event, notifiche private/di progetto, preferenze, coda Discord, testo, conservazione del log.
begin;
select plan(36);
select tests.prepare();

select tests.create_user('simone', 'Simone') as simone \gset
select tests.create_user('marco', 'Marco') as marco \gset
select tests.create_user('lucia', 'Lucia') as lucia \gset
select tests.create_user('fuori', 'Fuori') as fuori \gset
select tests.create_project('Experimental Rocket', :'simone') as p \gset
select tests.add_member(:'p', :'marco');
select tests.add_member(:'p', :'lucia');

-- ---- emit_event: tipi consentiti -------------------------------------------------------------
select tests.as_user(:'marco');
select throws_ok(format($$select public.emit_event(%L, 'version.published', '{"number":9}')$$, :'p'),
  '42501', null, 'emit_event rifiuta version.published (solo webhook)');
select throws_ok(format($$select public.emit_event(%L, 'member.added', '{}')$$, :'p'),
  '42501', null, 'emit_event rifiuta member.added');
select throws_ok(format($$select public.emit_event(%L, 'project.created', '{}')$$, :'p'),
  '42501', null, 'emit_event rifiuta project.created');
select throws_ok(format($$select public.emit_event(%L, 'tipo.inventato', '{}')$$, :'p'),
  '22023', null, 'emit_event rifiuta tipi sconosciuti');
select throws_ok(format($$select public.emit_event(%L, 'card.created', '[1]')$$, :'p'),
  '22023', null, 'emit_event rifiuta payload non oggetto');
select throws_ok(format($$select public.emit_event_server(%L, 'version.published', '{}')$$, :'p'),
  '42501', null, 'il client non può chiamare emit_event_server');
select lives_ok(format($$select public.emit_event(%L, 'card.created', '{"title":"Comprare resina"}')$$, :'p'),
  'emit_event accetta card.created');

-- card.created: info, nessuna notifica, nel log con autore = chi chiama
select tests.as_admin();
select is((select summary from public.activity_log where type = 'card.created'),
  'Marco ha creato la nota «Comprare resina»', 'testo di card.created');
select is((select actor_id from public.activity_log where type = 'card.created'), :'marco'::uuid, 'autore = auth.uid()');
select is((select count(*)::int from public.notifications), 0, 'card.created non genera notifiche');

-- ---- notifiche di progetto: tutti tranne l'autore ------------------------------------------------
select tests.as_user(:'marco');
select public.emit_event(:'p', 'card.important', '{"title":"Foro sbagliato","priority":"critical"}') as _e \gset
select tests.as_admin();
select is((select array_agg(recipient_id order by recipient_id) from public.notifications where type = 'card.important'),
  (select array_agg(x order by x) from unnest(array[:'simone'::uuid, :'lucia'::uuid]) x),
  'card.important: a tutti tranne l''autore');
select is((select summary from public.notifications where type = 'card.important' limit 1),
  'Marco ha segnalato «Foro sbagliato» (priorità critica)', 'testo di card.important');

-- ---- notifiche private: solo i destinatari indicati --------------------------------------------------
select tests.as_user(:'marco');
select public.emit_event(:'p', 'card.assigned', '{"title":"Verniciare ogiva"}', array[:'lucia'::uuid]) as _e \gset
select tests.as_user(:'lucia');
select is((select count(*)::int from public.notifications where type = 'card.assigned'), 1, 'assegnatario: riceve la notifica privata');
select is((select summary from public.notifications where type = 'card.assigned'), 'Marco ti ha assegnato «Verniciare ogiva»', 'testo di card.assigned');
select tests.as_user(:'simone');
select is((select count(*)::int from public.notifications where type = 'card.assigned'), 0, 'altro membro: non riceve la notifica privata');
select is((select count(*)::int from public.activity_log where type = 'card.assigned'), 0, 'eventi privati non finiscono nel log condiviso');
select tests.as_user(:'marco');
select public.emit_event(:'p', 'card.assigned', '{"title":"Fuori"}', array[:'fuori'::uuid]) as _e \gset
select public.emit_event(:'p', 'sync.error', '{"message":"rete assente"}') as _e \gset
select tests.as_admin();
select is((select count(*)::int from public.notifications where recipient_id = :'fuori'), 0, 'un non membro non può essere destinatario');
select is((select array_agg(recipient_id) from public.notifications where type = 'sync.error'), array[:'marco'::uuid],
  'sync.error: solo a sé stesso');

-- ---- notifiche: lettura e segno "letto" --------------------------------------------------------------
select tests.as_user(:'lucia');
select is(public.mark_notifications_read(array[(select id from public.notifications where type = 'card.assigned')]), 1, 'mark_notifications_read: una');
select is((select count(*)::int from public.notifications where read_at is null), 1, 'restano non lette le altre proprie');
select is(public.mark_notifications_read(), 1, 'mark_notifications_read(null): tutte le proprie');
select tests.as_user(:'simone');
select is((select count(*)::int from public.notifications where read_at is null), 1, 'le notifiche altrui non sono toccate');
select throws_ok($$update public.notifications set summary = 'x'$$, '42501', null, 'del destinatario si modifica solo read_at');

-- ---- preferenze ------------------------------------------------------------------------------------
select tests.as_user(:'lucia');
insert into public.notification_preferences (user_id, event_type, in_app) values (:'lucia', 'card.important', false);
select tests.as_user(:'marco');
select public.emit_event(:'p', 'card.important', '{"title":"Seconda"}') as _e \gset
select tests.as_admin();
select is((select count(*)::int from public.notifications where recipient_id = :'lucia' and summary like '%Seconda%'), 0, 'in_app = false: nessuna riga per quell''utente');
select is((select count(*)::int from public.notifications where recipient_id = :'simone' and summary like '%Seconda%'), 1, 'gli altri la ricevono');

-- ---- Discord outbox --------------------------------------------------------------------------------
select is((select count(*)::int from private.discord_outbox), 0, 'senza webhook configurato nessun messaggio in coda');
update public.project_discord_settings set webhook_configured = true where project_id = :'p';
select public.emit_event_server(:'p', 'version.published', '{"number":5,"authorName":"Simone"}', :'simone') as _e \gset
select is((select summary from private.discord_outbox order by id desc limit 1),
  'Simone ha pubblicato la versione 5 di Experimental Rocket', 'testo della versione pubblicata');
select public.emit_event_server(:'p', 'card.created', '{"title":"x"}', :'simone') as _e \gset
select is((select count(*)::int from private.discord_outbox), 1, 'card.created non è abilitato per Discord');
select public.emit_event_server(:'p', 'card.assigned', '{"title":"x"}', :'simone', array[:'marco'::uuid]) as _e \gset
select is((select count(*)::int from private.discord_outbox), 1, 'gli eventi privati non vanno su Discord');
update public.project_discord_settings set enabled_event_types = array['conflict.detected'] where project_id = :'p';
select public.emit_event_server(:'p', 'version.published', '{"number":6}', :'simone') as _e \gset
select is((select count(*)::int from private.discord_outbox), 1, 'tipo disabilitato: non accodato');

-- ---- testo ---------------------------------------------------------------------------------------------
select is(private.format_event_summary('conflict.detected', '{"fileCount":2}', :'marco', :'p'),
  'Conflitto in Experimental Rocket: Marco ha modifiche in conflitto su 2 file', 'testo conflitto');
select is(private.format_event_summary('member.role_changed', '{"targetName":"Lucia","role":"admin"}', :'simone', :'p'),
  'Simone ha reso Lucia amministratore in Experimental Rocket', 'testo cambio ruolo');

-- ---- conservazione del log ----------------------------------------------------------------------------
update public.projects set settings = jsonb_set(settings, '{activityRetention}', '10') where id = :'p';
insert into public.versions (project_id, number, sha, kind, author_github_login)
  select :'p', n, lpad(n::text, 40, '0'), 'publish', 'simone' from generate_series(1, 3) n;
select count(public.emit_event_server(:'p', 'card.updated', jsonb_build_object('title', 'n' || n), :'simone')) as _e
  from generate_series(1, 25) n \gset
select is((select count(*)::int from public.activity_log where project_id = :'p'), 10, 'conservati esattamente gli ultimi 10 eventi');
select is((select count(*)::int from public.activity_log where project_id = :'p' and summary like '%«n25»'), 1, 'il più recente è conservato');
select is((select count(*)::int from public.activity_log where project_id = :'p' and summary like '%«n15»'), 0, 'i più vecchi sono eliminati');
select is((select count(*)::int from public.versions where project_id = :'p'), 3, 'la conservazione non tocca versions');

select * from finish();
rollback;
