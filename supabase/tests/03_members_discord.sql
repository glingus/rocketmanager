-- Gestione membri, ultimo admin, segreti Discord.
begin;
select plan(25);
select tests.prepare();

select tests.create_user('anna') as anna \gset
select tests.create_user('bruno') as bruno \gset
select tests.create_user('carla') as carla \gset
select tests.create_project('Razzo Uno', :'anna') as p \gset
select tests.add_member(:'p', :'bruno');
insert into private.discord_webhooks (project_id, url) values (:'p', 'https://discord.com/api/webhooks/1/segreto');
update public.project_discord_settings set webhook_configured = true where project_id = :'p';

-- ---- un member non gestisce i membri --------------------------------------------------------
select tests.as_user(:'bruno');
select throws_ok(format($$insert into public.project_members (project_id, user_id, role) values (%L, %L, 'member')$$, :'p', :'carla'),
  '42501', null, 'member: non aggiunge membri');
select throws_ok(format($$update public.project_members set role = 'admin' where project_id = %L and user_id = %L$$, :'p', :'bruno'),
  '42501', null, 'member: non si promuove');
select throws_ok(format($$delete from public.project_members where project_id = %L and user_id = %L$$, :'p', :'anna'),
  '42501', null, 'member: non rimuove membri');
select throws_ok(format($$insert into public.project_invitations (project_id, github_login) values (%L, 'carla')$$, :'p'),
  '42501', null, 'member: non invita');
select is((select count(*)::int from public.project_invitations), 0, 'member: non vede gli inviti del progetto');
select lives_ok(format($$update public.projects set name = 'Rubato' where id = %L$$, :'p'), 'member: update del progetto senza effetto (0 righe)');
select is((select name from public.projects where id = :'p'), 'Razzo Uno', 'member: il nome non è cambiato');

-- ---- Discord: nessuno legge l'URL ------------------------------------------------------------
select throws_ok($$select url from private.discord_webhooks$$, '42501', null, 'member: non legge il webhook Discord');
select tests.as_user(:'anna');
select throws_ok($$select url from private.discord_webhooks$$, '42501', null, 'admin: non legge il webhook Discord dall''API');
select throws_ok($$select * from private.discord_outbox$$, '42501', null, 'admin: non legge la coda Discord');
select is((select webhook_configured from public.project_discord_settings), true, 'admin: vede solo il flag webhook_configured');
select lives_ok(format($$update public.project_discord_settings set enabled_event_types = array['version.published'] where project_id = %L$$, :'p'),
  'admin: cambia i tipi di evento Discord');
select throws_ok(format($$update public.project_discord_settings set enabled_event_types = array['inventato'] where project_id = %L$$, :'p'),
  '23514', null, 'admin: tipo Discord non valido rifiutato');
select throws_ok(format($$update public.project_discord_settings set webhook_configured = false where project_id = %L$$, :'p'),
  '42501', null, 'admin: non cambia webhook_configured dal client');
select tests.as_user(:'bruno');
select is((select count(*) from public.project_discord_settings where project_id = :'p' and enabled_event_types = array['version.published'])::int, 1, 'member: legge le impostazioni Discord');
update public.project_discord_settings set enabled_event_types = array['conflict.detected'] where project_id = :'p';
select is((select enabled_event_types from public.project_discord_settings), array['version.published'], 'member: non modifica le impostazioni Discord (0 righe)');

-- ---- admin: modifica consentita ----------------------------------------------------------------
select tests.as_user(:'anna');
select lives_ok(format($$update public.projects set name = 'Razzo Due', description = 'x' where id = %L$$, :'p'), 'admin: rinomina il progetto');
select throws_ok(format($$update public.projects set slug = 'altro' where id = %L$$, :'p'), '42501', null, 'admin: slug non modificabile');
select throws_ok(format($$update public.projects set github_repo = 'altro' where id = %L$$, :'p'), '42501', null, 'admin: repo non modificabile');
select throws_ok(format($$update public.projects set settings = '{"activityRetention": 3}' where id = %L$$, :'p'), '23514', null, 'impostazioni non valide rifiutate');

-- ---- ultimo admin (si testa come server: i client non possono toccare project_members) -------
select tests.as_admin();
select throws_ok(format($$delete from public.project_members where project_id = %L and user_id = %L$$, :'p', :'anna'),
  '23514', 'Il progetto deve avere almeno un amministratore', 'ultimo admin: non si rimuove');
select throws_ok(format($$update public.project_members set role = 'member' where project_id = %L and user_id = %L$$, :'p', :'anna'),
  '23514', 'Il progetto deve avere almeno un amministratore', 'ultimo admin: non si declassa');
select lives_ok(format($$update public.project_members set role = 'admin' where project_id = %L and user_id = %L$$, :'p', :'bruno'),
  'si può promuovere un secondo admin');
select lives_ok(format($$update public.project_members set role = 'member' where project_id = %L and user_id = %L$$, :'p', :'anna'),
  'con due admin se ne può declassare uno');
select throws_ok(format($$delete from public.project_members where project_id = %L and user_id = %L$$, :'p', :'bruno'),
  '23514', null, 'il rimasto è di nuovo l''ultimo admin');

select * from finish();
rollback;
