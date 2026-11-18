-- Rocket Sync — modello dati condiviso (docs/modello-dati.md)
-- 1/6: tipi, schema private, catalogo degli eventi.
--
-- Convenzioni:
--  * RLS attiva su ogni tabella di `public`; le policy sono in 20261101000005_rls.sql.
--  * Lo schema `private` non è esposto dall'API REST (vedi config.toml) e nessun ruolo client
--    ha privilegi sulle sue tabelle.
--  * Le funzioni `security definer` fissano `search_path` e controllano `auth.uid()`.

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tipi enumerati
-- ---------------------------------------------------------------------------------------------
create type public.member_role as enum ('admin', 'member');
create type public.card_priority as enum ('low', 'medium', 'high', 'critical');
create type public.card_status as enum ('open', 'in_progress', 'completed', 'archived');
create type public.importance as enum ('info', 'important', 'critical');
create type public.conflict_status as enum ('open', 'resolved');
-- editing: automatica (modifiche non pubblicate); reserved: prenotazione manuale
create type public.claim_kind as enum ('editing', 'reserved');
create type public.invitation_status as enum ('pending', 'accepted', 'revoked');

-- ---------------------------------------------------------------------------------------------
-- Catalogo degli eventi (dati di sistema)
-- ---------------------------------------------------------------------------------------------
create table public.event_types (
  type             text primary key,
  importance       public.importance not null,
  audience         text not null check (audience in ('project', 'private')),
  notify           boolean not null,
  discord_default  boolean not null,
  client_allowed   boolean not null,
  label_it         text not null
);
comment on table public.event_types is
  'Catalogo dei tipi di evento. I tipi ai.* (AI admin) sono riservati alla V2 e si aggiungeranno qui.';

insert into public.event_types (type, importance, audience, notify, discord_default, client_allowed, label_it) values
  ('version.published',      'important', 'project', true,  true,  false, 'Versione pubblicata'),
  ('version.restored',       'important', 'project', true,  true,  false, 'Versione ripristinata'),
  ('conflict.detected',      'critical',  'project', true,  true,  true,  'Conflitto rilevato'),
  ('conflict.resolved',      'important', 'project', true,  true,  true,  'Conflitto risolto'),
  ('member.added',           'important', 'project', true,  true,  false, 'Membro aggiunto'),
  ('member.removed',         'important', 'project', true,  true,  false, 'Membro rimosso'),
  ('member.role_changed',    'important', 'project', true,  true,  false, 'Ruolo cambiato'),
  ('project.created',        'important', 'project', true,  true,  false, 'Progetto creato'),
  ('project.archived',       'important', 'project', true,  true,  false, 'Progetto archiviato'),
  ('card.created',           'info',      'project', false, false, true,  'Nota creata'),
  ('card.important',         'important', 'project', true,  true,  true,  'Nota importante'),
  ('card.assigned',          'info',      'private', true,  false, true,  'Nota assegnata a te'),
  ('card.completed',         'info',      'project', false, false, true,  'Nota completata'),
  ('card.updated',           'info',      'project', false, false, true,  'Nota aggiornata'),
  ('card.commented',         'info',      'project', false, false, true,  'Nuovo commento'),
  ('file.editing_started',   'info',      'project', false, false, true,  'Modifica di un file iniziata'),
  ('sync.error',             'important', 'private', true,  false, true,  'Errore di sincronizzazione');

-- Valore predefinito delle impostazioni Discord di un progetto: i tipi con discord_default.
create function public.default_discord_event_types()
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(type order by type), '{}'::text[])
  from public.event_types
  where discord_default and audience = 'project';
$$;
