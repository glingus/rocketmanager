-- Funzioni di server per Discord (schema private non esposto): solo service_role.
begin;
select plan(16);
select tests.prepare();

select tests.create_user('anna') as anna \gset
select tests.create_project('Progetto A', :'anna') as p \gset

select tests.as_user(:'anna');
select throws_ok(format($$select public.set_discord_webhook(%L, 'https://discord.com/api/webhooks/1/x', %L)$$, :'p', :'anna'),
  '42501', null, 'il client non imposta il webhook');
select throws_ok(format($$select public.get_discord_webhook(%L)$$, :'p'), '42501', null, 'il client non legge il webhook');
select throws_ok($$select * from public.claim_discord_outbox(now(), 10)$$, '42501', null, 'il client non prende in carico la coda');

select tests.as_service();
select lives_ok(format($$select public.set_discord_webhook(%L, 'https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz', %L)$$, :'p', :'anna'),
  'service_role imposta il webhook');
select is(public.get_discord_webhook(:'p'), 'https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz', 'service_role legge il webhook');
select is((select webhook_configured from public.project_discord_settings where project_id = :'p'), true, 'flag webhook_configured aggiornato');
select throws_ok(format($$select public.set_discord_webhook(%L, 'http://evil.example/x', %L)$$, :'p', :'anna'),
  '23514', null, 'URL non Discord rifiutato dal vincolo');

-- coda
select public.emit_event_server(:'p', 'version.published', '{"number":1}', :'anna') as _e \gset
select public.emit_event_server(:'p', 'version.published', '{"number":2}', :'anna') as _e \gset
select is((select count(*)::int from public.claim_discord_outbox(now(), 10)), 2, 'claim: due messaggi');
select is((select count(*)::int from public.claim_discord_outbox(now(), 10)), 0, 'claim: affittati, non riconsegnati subito');
select is((select count(*)::int from public.claim_discord_outbox(now() + interval '6 minutes', 10)), 2, 'claim: riconsegnati dopo la scadenza dell''affitto');
select lives_ok($$select public.mark_discord_failed((select array_agg(id) from private.discord_outbox), 1, 'pending', now(), 'Discord ha risposto 500')$$, 'mark_discord_failed');
select is((select count(*)::int from private.discord_outbox where attempts = 1 and last_error = 'Discord ha risposto 500'), 2, 'tentativo registrato');
select throws_ok($$select public.mark_discord_failed(array[1], 1, 'boh', now(), 'x')$$, '22023', null, 'stato non valido rifiutato');
select lives_ok($$select public.mark_discord_sent((select array_agg(id) from private.discord_outbox))$$, 'mark_discord_sent');
select is((select count(*)::int from private.discord_outbox where status = 'sent' and sent_at is not null), 2, 'messaggi segnati inviati');
select lives_ok(format($$select public.remove_discord_webhook(%L, %L)$$, :'p', :'anna'), 'rimozione del webhook');

select * from finish();
rollback;
