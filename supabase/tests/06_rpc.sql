-- RPC: conflitti, prenotazioni dei file, profilo, funzioni riservate al server.
begin;
select plan(26);
select tests.prepare();

select tests.create_user('anna') as anna \gset
select tests.create_user('bruno') as bruno \gset
select tests.create_user('estraneo') as estraneo \gset
select tests.create_project('Progetto A', :'anna') as p \gset
select tests.create_project('Progetto B', :'estraneo') as pb \gset
select tests.add_member(:'p', :'bruno');

-- ---- conflitti -----------------------------------------------------------------------------------
select tests.as_user(:'bruno');
select is(public.report_conflict(:'p', '20261101-a1b2c3', '[{"path":"Razzo.ork","kind":"bothModified"}]', 7, :'anna'),
  '20261101-a1b2c3', 'report_conflict: registra');
select is(public.report_conflict(:'p', '20261101-a1b2c3', '[{"path":"Razzo.ork","kind":"bothModified"}]', 7, :'anna'),
  '20261101-a1b2c3', 'report_conflict: idempotente sull''id');
select is((select count(*)::int from public.activity_log where type = 'conflict.detected'), 1, 'un solo evento conflict.detected');
select is((select remote_branch from public.conflicts), 'conflitti/20261101-a1b2c3', 'branch remoto derivato dall''id');
select is((select ours_user_id from public.conflicts), :'bruno'::uuid, 'ours_user_id = chi segnala');
select throws_ok(format($$select public.report_conflict(%L, 'x-1', '[]')$$, :'p'), '22023', null, 'elenco file vuoto rifiutato');
select throws_ok(format($$select public.report_conflict(%L, 'x-2', '[{"path":"a","kind":"boh"}]')$$, :'p'), '22023', null, 'tipo di conflitto non valido');
select throws_ok(format($$select public.report_conflict(%L, '20261101-a1b2c3', '[{"path":"a.ork","kind":"bothAdded"}]')$$, :'pb'),
  '42501', null, 'non si segnala in un progetto altrui');
select is(public.resolve_conflict_record(:'p', '20261101-a1b2c3', '{"Razzo.ork":"mine"}', 9), true, 'resolve_conflict_record: risolve');
select is(public.resolve_conflict_record(:'p', '20261101-a1b2c3', '{"Razzo.ork":"mine"}', 9), false, 'resolve_conflict_record: idempotente');
select tests.as_admin();
select is((select status::text || ':' || resolved_version from public.conflicts), 'resolved:9', 'conflitto risolto alla versione 9');
select is((select count(*)::int from public.activity_log where type = 'conflict.resolved'), 1, 'evento conflict.resolved registrato');
select is((select count(*)::int from public.notifications where type = 'conflict.detected' and recipient_id = :'anna'), 1, 'gli altri membri sono avvisati del conflitto');

-- ---- prenotazioni ---------------------------------------------------------------------------------
select tests.as_user(:'bruno');
select lives_ok(format($$select public.claim_file(%L, 'Razzo.ork', 'editing', null, 'pc-bruno')$$, :'p'), 'claim_file: editing');
select lives_ok(format($$select public.claim_file(%L, 'Razzo.ork', 'reserved', 'lavoro sulle pinne', 'pc-bruno', now() + interval '1 day')$$, :'p'), 'claim_file: reserved');
select is((select count(*)::int from public.file_claims), 2, 'due prenotazioni');
select throws_ok(format($$select public.claim_file(%L, 'Altro.ork', 'editing', null, 'pc')$$, :'pb'), '42501', null, 'non si prenota in un progetto altrui');
select throws_ok(format($$insert into public.file_claims (project_id, user_id, path, kind, machine_id) values (%L, %L, 'x', 'editing', 'm')$$, :'p', :'bruno'),
  '42501', null, 'niente insert diretto su file_claims');
select is(public.heartbeat_claims(:'p', 'pc-bruno'), 2, 'heartbeat aggiorna le proprie');
select is(public.heartbeat_claims(:'p', 'altro-pc'), 0, 'heartbeat su altra macchina: nulla');
select tests.as_user(:'anna');
select is(public.release_file(:'p', 'Razzo.ork'), 0, 'non si rilasciano prenotazioni altrui');
select tests.as_user(:'bruno');
select is(public.release_file(:'p', 'Razzo.ork', 'editing'), 1, 'release_file di un tipo');
select is(public.release_file(:'p', 'Razzo.ork'), 1, 'release_file di tutto il resto');

-- ---- profilo e funzioni di server -------------------------------------------------------------------
select lives_ok(format($$update public.profiles set display_name = 'Bruno B.', avatar_color = '#112233' where id = %L$$, :'bruno'), 'profilo: modifica nome e colore');
select throws_ok(format($$update public.profiles set github_login = 'hack' where id = %L$$, :'bruno'), '42501', null, 'profilo: login non modificabile');
select throws_ok(format($$select public.create_project_record('X','x','','o','r',1,'main',%L)$$, :'bruno'), '42501', null, 'create_project_record: riservata al server');

select * from finish();
rollback;
