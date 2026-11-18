-- 2/6: tabelle, vincoli, indici (schema public e private).

-- ---------------------------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  github_id     bigint unique,
  github_login  text not null,
  display_name  text not null,
  avatar_url    text,
  avatar_color  text not null default '#8b5e3c',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 80)
);
create unique index profiles_github_login_key on public.profiles (lower(github_login));

-- ---------------------------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------------------------
create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  description      text not null default '',
  github_owner     text not null,
  github_repo      text not null,
  github_repo_id   bigint,
  default_branch   text not null default 'main',
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz,
  ai_admin_id      uuid references public.profiles (id),  -- riservato alla V2
  settings         jsonb not null default
    '{"publishPolicy": {"mode": "assisted", "idleMinutes": 10}, "activityRetention": 100}'::jsonb,
  constraint projects_name_len check (char_length(name) between 1 and 80),
  constraint projects_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  constraint projects_settings_object check (jsonb_typeof(settings) = 'object'),
  constraint projects_repo_unique unique (github_owner, github_repo)
);

-- ---------------------------------------------------------------------------------------------
-- project_members / project_invitations
-- ---------------------------------------------------------------------------------------------
create table public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.member_role not null default 'member',
  added_by    uuid references public.profiles (id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members (user_id);

create table public.project_invitations (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  github_login  text not null,
  role          public.member_role not null default 'member',
  invited_by    uuid references public.profiles (id) on delete set null,
  status        public.invitation_status not null default 'pending',
  created_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  constraint project_invitations_login_len check (char_length(github_login) between 1 and 39)
);
create unique index project_invitations_pending_key
  on public.project_invitations (project_id, lower(github_login))
  where status = 'pending';
create index project_invitations_login_idx on public.project_invitations (lower(github_login));

-- ---------------------------------------------------------------------------------------------
-- versions: indice derivato da Git (scritto solo dal webhook GitHub)
-- ---------------------------------------------------------------------------------------------
create table public.versions (
  project_id           uuid not null references public.projects (id) on delete cascade,
  number               integer not null check (number >= 1),
  sha                  text not null check (sha ~ '^[0-9a-f]{40}$'),
  kind                 text not null check (kind in ('publish', 'restore', 'conflict-resolution')),
  title                text not null default '',
  description          text not null default '',
  changelog            jsonb not null default '[]'::jsonb check (jsonb_typeof(changelog) = 'array'),
  author_id            uuid references public.profiles (id) on delete set null,
  author_github_login  text not null default '',
  files                jsonb not null default '[]'::jsonb check (jsonb_typeof(files) = 'array'),
  restored_from        integer,
  conflict_id          text,
  published_at         timestamptz not null default now(),
  primary key (project_id, number),
  unique (project_id, sha)
);
create index versions_published_idx on public.versions (project_id, published_at desc);

-- ---------------------------------------------------------------------------------------------
-- conflicts
-- ---------------------------------------------------------------------------------------------
create table public.conflicts (
  id                text primary key check (char_length(id) between 3 and 64),
  project_id        uuid not null references public.projects (id) on delete cascade,
  files             jsonb not null default '[]'::jsonb check (jsonb_typeof(files) = 'array'),
  ours_user_id      uuid not null references public.profiles (id),
  theirs_user_id    uuid references public.profiles (id) on delete set null,
  theirs_version    integer,
  remote_branch     text not null,
  status            public.conflict_status not null default 'open',
  resolution        jsonb,
  resolved_by       uuid references public.profiles (id) on delete set null,
  resolved_version  integer,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);
create index conflicts_project_idx on public.conflicts (project_id, status, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- file_claims: chi sta lavorando su cosa
-- ---------------------------------------------------------------------------------------------
create table public.file_claims (
  project_id    uuid not null references public.projects (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  path          text not null check (char_length(path) between 1 and 500),
  kind          public.claim_kind not null,
  note          text check (note is null or char_length(note) <= 500),
  machine_id    text not null check (char_length(machine_id) between 1 and 100),
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz,
  primary key (project_id, user_id, path, kind)
);
create index file_claims_machine_idx on public.file_claims (project_id, user_id, machine_id);

-- ---------------------------------------------------------------------------------------------
-- Note e attività
-- ---------------------------------------------------------------------------------------------
create table public.card_categories (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  icon        text not null default 'note',
  sort        integer not null default 0,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (id, project_id)
);
create unique index card_categories_name_key on public.card_categories (project_id, lower(name));

create table public.cards (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 200),
  description     text not null default '',
  color           text not null default 'default',
  priority        public.card_priority,
  category_id     uuid,
  status          public.card_status not null default 'open',
  created_by      uuid not null references public.profiles (id),
  assignee_id     uuid references public.profiles (id) on delete set null,
  due_date        date,
  position        double precision not null default 0,
  linked_version  integer,
  converted_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (id, project_id),
  foreign key (category_id, project_id) references public.card_categories (id, project_id)
);
create index cards_project_idx on public.cards (project_id, status, position);
create index cards_assignee_idx on public.cards (assignee_id) where assignee_id is not null;

create table public.card_comments (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null,
  project_id  uuid not null,
  author_id   uuid not null references public.profiles (id),
  body        text not null check (char_length(body) between 1 and 5000),
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  foreign key (card_id, project_id) references public.cards (id, project_id) on delete cascade
);
create index card_comments_card_idx on public.card_comments (card_id, created_at);

create table public.card_attachments (
  id            uuid primary key default gen_random_uuid(),
  card_id       uuid not null,
  project_id    uuid not null,
  storage_path  text not null,
  filename      text not null check (char_length(filename) between 1 and 255),
  size_bytes    bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  mime_type     text not null default 'application/octet-stream',
  uploaded_by   uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  foreign key (card_id, project_id) references public.cards (id, project_id) on delete cascade,
  -- percorso: <project_id>/<card_id>/<uuid>-<filename>
  constraint card_attachments_path check (
    storage_path like (project_id::text || '/' || card_id::text || '/%')
    and storage_path not like '%..%'
  )
);
create unique index card_attachments_path_key on public.card_attachments (storage_path);
create index card_attachments_card_idx on public.card_attachments (card_id);

create table public.activity_log (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  type        text not null references public.event_types (type),
  importance  public.importance not null,
  summary     text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index activity_log_project_idx on public.activity_log (project_id, id desc);

-- ---------------------------------------------------------------------------------------------
-- Notifiche
-- ---------------------------------------------------------------------------------------------
create table public.notification_events (
  id          bigint generated always as identity primary key,
  project_id  uuid references public.projects (id) on delete cascade,
  type        text not null references public.event_types (type),
  importance  public.importance not null,
  audience    text not null check (audience in ('project', 'private')),
  summary     text not null,
  payload     jsonb not null default '{}'::jsonb,
  actor_id    uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.notifications (
  id            bigint generated always as identity primary key,
  event_id      bigint not null references public.notification_events (id) on delete cascade,
  recipient_id  uuid not null references public.profiles (id) on delete cascade,
  project_id    uuid references public.projects (id) on delete cascade,
  type          text not null references public.event_types (type),
  importance    public.importance not null,
  summary       text not null,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_id) where read_at is null;

create table public.notification_preferences (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  event_type  text not null references public.event_types (type),
  in_app      boolean not null default true,
  desktop     boolean not null default true,
  primary key (user_id, event_type)
);

-- ---------------------------------------------------------------------------------------------
-- Discord
-- ---------------------------------------------------------------------------------------------
create table public.project_discord_settings (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  enabled_event_types  text[] not null default public.default_discord_event_types(),
  webhook_configured   boolean not null default false,
  updated_by           uuid references public.profiles (id) on delete set null,
  updated_at           timestamptz not null default now()
);

create table private.discord_webhooks (
  project_id  uuid primary key references public.projects (id) on delete cascade,
  url         text not null check (url ~ '^https://(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)/api/webhooks/'),
  updated_at  timestamptz not null default now()
);

create table private.discord_outbox (
  id               bigint generated always as identity primary key,
  project_id       uuid not null references public.projects (id) on delete cascade,
  event_id         bigint references public.notification_events (id) on delete set null,
  summary          text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index discord_outbox_pending_idx on private.discord_outbox (next_attempt_at) where status = 'pending';
create index discord_outbox_project_idx on private.discord_outbox (project_id, created_at);
