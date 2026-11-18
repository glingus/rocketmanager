# Modello dati condiviso (Supabase)

> Specifica vincolante per `supabase/` (migrazioni, policy, funzioni) e per il livello dati
> dell'interfaccia. Git resta la fonte di verità per le versioni: la tabella `versions` è solo
> un indice ricostruibile.

## 1. Principi

- **RLS attiva su tutte le tabelle**, tutto negato salvo policy esplicite.
- Il client usa solo la chiave pubblica (`anon`) e la sessione dell'utente.
- La chiave `service_role`, la chiave privata della GitHub App, il client secret e i webhook
  Discord esistono **solo** nei segreti delle Edge Functions o nello schema `private`.
- Lo schema `private` non è esposto dalle API REST.
- Operazioni privilegiate (creare progetti, gestire membri, configurare Discord) solo tramite
  Edge Functions che verificano il ruolo lato server.
- Orari salvati in UTC; i testi per gli utenti usano il fuso `Europe/Rome`.

## 2. Tipi enumerati

| Tipo | Valori |
|---|---|
| `member_role` | `admin`, `member` |
| `card_priority` | `low`, `medium`, `high`, `critical` |
| `card_status` | `open`, `in_progress`, `completed`, `archived` |
| `importance` | `info`, `important`, `critical` |
| `conflict_status` | `open`, `resolved` |
| `claim_kind` | `editing` (automatica: modifiche non pubblicate), `reserved` (prenotazione manuale) |
| `invitation_status` | `pending`, `accepted`, `revoked` |

## 3. Tabelle (schema `public`)

### `profiles`
`id uuid PK → auth.users`, `github_id bigint unique`, `github_login text unique`,
`display_name text`, `avatar_url text`, `avatar_color text`, `created_at`, `updated_at`.
Creata da un trigger su `auth.users` (dati da `raw_user_meta_data`: `user_name`,
`provider_id`, `full_name`, `avatar_url`).

### `projects`
`id uuid PK`, `name text` (1–80), `slug text unique`, `description text`,
`github_owner text`, `github_repo text`, `github_repo_id bigint`, `default_branch text default 'main'`,
`created_by uuid`, `created_at`, `updated_at`, `archived_at timestamptz null`,
`ai_admin_id uuid null` (riservato a V2), `settings jsonb` con default:

```json
{
  "publishPolicy": { "mode": "assisted", "idleMinutes": 10 },
  "activityRetention": 100
}
```

I campi `github_*`, `slug`, `created_by` non sono modificabili dal client (trigger).

### `project_members`
`project_id`, `user_id`, `role member_role`, `added_by`, `added_at`; PK `(project_id, user_id)`.
Vincolo: ogni progetto ha almeno un admin (trigger che impedisce di rimuovere o declassare l'ultimo).

### `project_invitations`
`id uuid`, `project_id`, `github_login text`, `role`, `invited_by`, `status invitation_status`,
`created_at`, `accepted_at`. Unico `(project_id, lower(github_login))` tra quelli `pending`.

### `versions` (indice derivato da Git)
`project_id`, `number int`, `sha text`, `kind text` (`publish|restore|conflict-resolution`),
`title`, `description`, `changelog jsonb` (array di `{path, lines[], interpreted}`),
`author_id uuid null`, `author_github_login text`, `files jsonb` (array di `{path, change}`),
`restored_from int null`, `conflict_id text null`, `published_at timestamptz`;
PK `(project_id, number)`, unico `(project_id, sha)`. Scritta solo dal webhook GitHub.

### `conflicts`
`id text PK` (generato dal client, vedi protocollo §7.5), `project_id`, `files jsonb`
(array di `{path, kind}`), `ours_user_id`, `theirs_user_id null`, `theirs_version int null`,
`remote_branch text`, `status conflict_status`, `resolution jsonb null`, `resolved_by uuid null`,
`resolved_version int null`, `created_at`, `resolved_at`.

### `file_claims` (chi sta lavorando su cosa)
`project_id`, `user_id`, `path text`, `kind claim_kind`, `note text null`, `machine_id text`,
`started_at`, `heartbeat_at`, `expires_at null`; PK `(project_id, user_id, path, kind)`.
Una riga `editing` senza heartbeat da più di 10 minuti viene mostrata come "ultimo segnale …".

### `card_categories`
`id uuid`, `project_id`, `name text`, `icon text`, `sort int`, `is_default bool`, `created_at`;
unico `(project_id, lower(name))`. Alla creazione del progetto si inseriscono le 6 predefinite:
Nota, Problema, Attività, Acquisto, Idea, Osservazione tecnica.

### `cards`
`id uuid`, `project_id`, `title text not null` (1–200), `description text`,
`color text` (nome di un colore della palette dell'interfaccia),
`priority card_priority null`, `category_id uuid null`, `status card_status default 'open'`,
`created_by`, `assignee_id uuid null`, `due_date date null`, `position double precision`
(ordinamento frazionario), `linked_version int null`, `converted_at timestamptz null`
(quando una nota libera è diventata attività strutturata), `created_at`, `updated_at`,
`completed_at null`.
Colore e priorità sono indipendenti: nessun vincolo li collega.

### `card_comments`
`id uuid`, `card_id`, `project_id` (copiato per le policy), `author_id`, `body text` (1–5000),
`created_at`, `edited_at null`.

### `card_attachments`
`id uuid`, `card_id`, `project_id`, `storage_path text`, `filename text`, `size_bytes bigint`
(≤ 25 MB), `mime_type text`, `uploaded_by`, `created_at`.
File nel bucket privato `attachments`, percorso `<project_id>/<card_id>/<uuid>-<filename>`.

### `event_types` (catalogo, dati di sistema)
`type text PK`, `importance importance`, `audience text` (`project|private`),
`notify bool`, `discord_default bool`, `client_allowed bool`, `label_it text`.

| Tipo | Importanza | Destinatari | Notifica | Discord | Dal client |
|---|---|---|---|---|---|
| `version.published` | important | progetto | sì | sì | no (webhook) |
| `version.restored` | important | progetto | sì | sì | no (webhook) |
| `conflict.detected` | critical | progetto | sì | sì | sì |
| `conflict.resolved` | important | progetto | sì | sì | sì |
| `member.added` / `member.removed` / `member.role_changed` | important | progetto | sì | sì | no |
| `project.created` / `project.archived` | important | progetto | sì | sì | no |
| `card.created` | info | progetto | no | no | sì |
| `card.important` (creata o portata a priorità alta/critica, o categoria Problema) | important | progetto | sì | sì | sì |
| `card.assigned` | info | privato (assegnatario) | sì | no | sì |
| `card.completed` / `card.updated` / `card.commented` | info | progetto | no | no | sì |
| `file.editing_started` | info | progetto | no | no | sì |
| `sync.error` | important | privato (sé stesso) | sì | no | sì |
| `ai.*` | — | privato (AI admin) | — | no | riservato a V2 |

### `activity_log`
`id bigint identity`, `project_id`, `actor_id uuid null`, `type text → event_types`,
`importance`, `summary text` (italiano, già formattato), `payload jsonb`, `created_at`.
**Conservazione:** dopo ogni inserimento un trigger elimina le righe più vecchie oltre
`projects.settings.activityRetention` (default 100) per quel progetto.
Questa pulizia **non tocca mai Git** né la tabella `versions`.

### `notification_events` / `notifications`
- `notification_events`: `id bigint identity`, `project_id null`, `type`, `importance`,
  `audience`, `summary`, `payload`, `actor_id`, `created_at`.
- `notifications` (una riga per destinatario): `id bigint identity`, `event_id`, `recipient_id`,
  `project_id`, `type`, `importance`, `summary`, `payload`, `created_at`, `read_at null`.
- Destinatari: `audience = project` → tutti i membri del progetto tranne l'autore;
  `audience = private` → solo i destinatari indicati (es. l'assegnatario, o l'AI admin in V2).
- Si rispettano le preferenze (`in_app = false` → nessuna riga per quell'utente).

### `notification_preferences`
`user_id`, `event_type`, `in_app bool default true`, `desktop bool default true`;
PK `(user_id, event_type)`. Assenza di riga = valori predefiniti.

### `project_discord_settings`
`project_id PK`, `enabled_event_types text[]` (default: tutti i tipi con `discord_default`),
`webhook_configured bool`, `updated_by`, `updated_at`. Leggibile dai membri, modificabile dagli
admin (solo `enabled_event_types`).

## 4. Schema `private` (non esposto)

- `private.discord_webhooks (project_id PK, url text)` — scritto solo dalla Edge Function
  `discord-settings`.
- `private.discord_outbox (id, project_id, event_id, summary, payload, status
  'pending'|'sent'|'failed', attempts, next_attempt_at, last_error, created_at, sent_at)`.

## 5. Funzioni SQL (RPC)

Tutte `security definer`, con `search_path` fissato e controllo esplicito di `auth.uid()`.

| Funzione | Chi | Cosa fa |
|---|---|---|
| `is_project_member(project_id)` / `is_project_admin(project_id)` | uso interno nelle policy | — |
| `emit_event(project_id, type, payload, recipients uuid[] default null)` | membri | Solo tipi con `client_allowed`. Scrive `activity_log`, e se `notify`: `notification_events`, `notifications` (rispettando audience e preferenze) e, se il tipo è abilitato per Discord nel progetto, `private.discord_outbox`. Genera `summary` in italiano. |
| `emit_event_server(...)` | solo `service_role` | Come sopra, per tutti i tipi (usata dalle Edge Functions). |
| `report_conflict(project_id, conflict_id, files, theirs_version, theirs_user_id)` | membri | Inserisce `conflicts` + evento `conflict.detected`. Idempotente sull'id. |
| `resolve_conflict_record(project_id, conflict_id, resolution, resolved_version)` | membri | Aggiorna `conflicts` + evento `conflict.resolved`. |
| `claim_file(project_id, path, kind, note, machine_id, expires_at)` / `release_file(...)` / `heartbeat_claims(project_id, machine_id)` | membri | Gestione di `file_claims` (solo righe proprie). |
| `mark_notifications_read(ids bigint[] default null)` | utente | `null` = tutte le proprie. |
| `format_event_summary(type, payload, actor_id, project_id)` | uso interno | Testo italiano, es. "Simone ha pubblicato la versione 5 di Experimental Rocket". |

## 6. Policy RLS (sintesi)

| Tabella | select | insert | update | delete |
|---|---|---|---|---|
| `profiles` | utenti autenticati | trigger | solo sé stessi (`display_name`, `avatar_color`) | — |
| `projects` | membri | Edge Function | admin (`name`, `description`, `settings`, `ai_admin_id`) | — (si archivia) |
| `project_members` | membri del progetto | Edge Function | Edge Function | Edge Function |
| `project_invitations` | admin del progetto + l'invitato (per login) | Edge Function | Edge Function | — |
| `versions` | membri | webhook | — | — |
| `conflicts` | membri | RPC | RPC | — |
| `file_claims` | membri | RPC | RPC | RPC |
| `card_categories` | membri | membri | membri | admin |
| `cards` | membri | membri (`created_by = auth.uid()`) | membri | autore o admin |
| `card_comments` | membri | membri (come sé stessi) | autore | autore o admin |
| `card_attachments` | membri | membri | — | autore o admin |
| `activity_log` | membri | RPC | — | trigger di conservazione |
| `notifications` | destinatario | RPC | destinatario (solo `read_at`) | — |
| `notification_preferences` | sé stessi | sé stessi | sé stessi | sé stessi |
| `project_discord_settings` | membri | Edge Function | admin (`enabled_event_types`) | — |
| `event_types` | autenticati | — | — | — |
| storage `attachments` | membri del progetto nel percorso | membri | — | autore o admin |

Progetti archiviati: lettura consentita, scritture su card/commenti bloccate (policy con
`archived_at is null`).

Pubblicazione Realtime: `cards`, `card_comments`, `activity_log`, `notifications`, `versions`,
`conflicts`, `file_claims`, `project_members`.

## 7. Edge Functions

| Funzione | Chiamata da | Cosa fa |
|---|---|---|
| `create-project` | utente autenticato | Crea il repo privato nell'organizzazione (token di installazione della GitHub App), scrive il commit iniziale (`.gitattributes`, `.gitignore`, `.rocketsync/project.json`, trailer `init`), inserisce progetto, membro admin, categorie predefinite, impostazioni Discord, evento `project.created`. In caso di errore a metà annulla ciò che ha creato. |
| `manage-members` | admin del progetto | `add` (per login GitHub: invito all'organizzazione se serve, accesso `push` al repo, riga in `project_members` o `project_invitations`), `remove` (toglie accesso al repo e membership), `set_role`. Protegge l'ultimo admin. Eventi `member.*`. |
| `accept-invitations` | utente autenticato | Dopo il login: trasforma gli inviti `pending` per il suo login in membership. |
| `github-webhook` | GitHub App | Verifica `X-Hub-Signature-256`. Sugli eventi `push` verso `main`: legge i trailer dei commit, inserisce in `versions`, emette `version.published` / `version.restored`. Ignora gli altri branch. Idempotente sullo sha. |
| `discord-settings` | admin del progetto | Salva/rimuove il webhook in `private.discord_webhooks`, aggiorna `webhook_configured`, invia un messaggio di prova se richiesto. Non restituisce mai l'URL. |
| `discord-dispatch` | pg_cron ogni minuto | Prende da `private.discord_outbox` gli eventi in attesa, li raggruppa per progetto (eventi entro 2 minuti → un solo messaggio), invia, ritenta con attesa crescente (max 5 tentativi), registra l'esito. |
| `github-token-refresh` | utente autenticato | Rinnova il token utente della GitHub App usando il client secret (che resta sul server). |

Formato dei messaggi Discord (italiano, ora di Roma):

```
15:22 — Simone ha pubblicato la versione 5 di Experimental Rocket
> Aggiornate pinne e paracadute
> Razzo.ork: 3 componenti modificati
```

## 8. Test obbligatori (`supabase/tests/`)

- Un utente non membro non vede nulla di un progetto (card, log, versioni, notifiche, allegati).
- Card e log di un progetto non compaiono in un altro progetto.
- Le notifiche private arrivano solo ai destinatari indicati.
- Un member non può gestire membri né leggere il webhook Discord; un admin non può leggerlo
  dall'API REST.
- L'ultimo admin non può essere rimosso o declassato.
- La conservazione tiene esattamente gli ultimi N eventi e non tocca `versions`.
- `emit_event` rifiuta i tipi non consentiti al client.
- Le Edge Functions: verifica della firma del webhook, parsing dei trailer, raggruppamento e
  formattazione dei messaggi Discord, rifiuto delle richieste senza ruolo adeguato.
