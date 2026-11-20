# Backend Supabase di Rocket Sync

Schema del database, policy, funzioni SQL ed Edge Functions. La specifica vincolante è
[`docs/modello-dati.md`](../docs/modello-dati.md); il formato dei commit letto dal webhook è in
[`docs/protocollo-sync.md`](../docs/protocollo-sync.md) §3.

```
supabase/
├── config.toml                 progetto Supabase CLI (sviluppo locale e deploy)
├── migrations/                 6 migrazioni SQL, da applicare in ordine
├── tests/                      test del database (pgTAP)
├── scripts/
│   ├── test-functions-deno.sh  deno check + lint + end-to-end delle Edge Functions su Deno
│   ├── test-db.sh              avvia un Postgres 16 usa-e-getta, applica tutto, esegue pg_prove
│   ├── stub-supabase.sql       stub minimale degli schemi auth/storage/ruoli (solo test)
│   └── test-helpers.sql        funzioni di supporto dei test (impersonare utenti, ecc.)
├── functions/
│   ├── <nome>/index.ts         entry sottile (Deno) delle 7 Edge Functions
│   ├── _shared/*.ts            logica pura (testata con vitest sotto Node)
│   └── deno.json               import map
├── functions-tests/            test vitest della logica delle funzioni
├── functions-e2e/              prova end-to-end su Deno vero (server finti di Supabase/GitHub/Discord)
├── package.json, package-lock.json   autonomi (npm), NON nel workspace pnpm
└── .env.example                nomi dei segreti (senza valori)
```

> **Scorciatoia.** I passi 1–4 qui sotto sono automatizzati dal configuratore guidato
> `node scripts/setup/setup-backend.mjs` (GitHub App, accesso con GitHub, segreti, migrazioni,
> Vault, Edge Functions, senza copiare segreti a mano). Guida:
> [`docs/configurazione-iniziale.md`](../docs/configurazione-iniziale.md). Questa pagina resta
> la procedura manuale e il riferimento di cosa viene configurato.

## 1. Creare il progetto Supabase

1. Su <https://supabase.com/dashboard> crea un progetto (il piano Free basta per partire; si sospende
   dopo 7 giorni senza attività, Git continua a funzionare). Annota il **project ref**.
2. **Autenticazione con GitHub**: *Authentication → Providers → GitHub*. Usa il Client ID e il
   Client secret della **stessa GitHub App** registrata al §3 (il login unico serve sia per Supabase
   sia per Git). Come *Callback URL* di quell'app metti quella mostrata da Supabase
   (`https://<ref>.supabase.co/auth/v1/callback`). In *Authentication → URL Configuration* imposta
   come *Site URL* `http://127.0.0.1:53682/callback` e aggiungi tra i *Redirect URLs* **tutti e dieci**
   gli indirizzi di ritorno su loopback che l'app prova in ordine (accesso con PKCE, vedi
   [`apps/desktop/src-tauri/README.md`](../apps/desktop/src-tauri/README.md)):
   `http://127.0.0.1:53682/callback`, `http://127.0.0.1:53683/callback`, … fino a
   `http://127.0.0.1:53691/callback`.
3. Installa la CLI (`npm i -g supabase` oppure scoop su Windows) e collega la cartella:

   ```bash
   supabase login
   supabase link --project-ref <ref>
   ```

## 2. Applicare le migrazioni

```bash
supabase db push        # applica supabase/migrations/* al progetto collegato
```

Le migrazioni creano: tipi, tabelle, vincoli e indici; trigger (profilo da `auth.users`, campi del
progetto non modificabili, ultimo admin, conservazione del log, `updated_at`, coerenza delle
note); schema `private` (webhook Discord e coda, mai esposto da PostgREST: `config.toml` elenca
solo `public` tra gli schemi dell'API); catalogo `event_types` (17 tipi); funzioni RPC; policy RLS;
policy di Storage e bucket privato `attachments` (25 MB); pubblicazione Realtime; job `pg_cron`
`discord-dispatch` (solo se l'estensione esiste).

Sviluppo locale con Docker: `supabase start` applica le stesse migrazioni (non provato qui: nel
container di sviluppo Docker non è disponibile; vedi §6).

### Coda Discord: segreti in Vault

Il job `pg_cron` chiama ogni minuto la Edge Function `discord-dispatch` tramite `pg_net`, leggendo
da **Vault** l'URL del progetto e la chiave `service_role`. Una volta sola, dal *SQL Editor*:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<chiave service_role>', 'service_role_key');
```

Finché i segreti mancano il job non fa nulla (e non dà errori). Verifica con
`select * from cron.job;` e `select * from cron.job_run_details order by start_time desc limit 5;`.

## 3. Registrare la GitHub App

Si registra con l'account dell'organizzazione che ospiterà i repository (*Settings → Developer
settings → GitHub Apps → New GitHub App*):

| Campo | Valore |
|---|---|
| Homepage URL | a piacere (es. la pagina del progetto) |
| Callback URL | `https://<ref>.supabase.co/auth/v1/callback` (login via Supabase) |
| Expire user authorization tokens | **disattivo** (consigliato: Git funziona anche se Supabase è irraggiungibile; vedi `docs/sicurezza.md` §7) — se lo attivi, il rinnovo passa da `github-token-refresh` |
| Request user authorization (OAuth) during installation | attivo |
| Webhook → Active | sì |
| Webhook URL | `https://<ref>.supabase.co/functions/v1/github-webhook` |
| Webhook secret | una stringa casuale lunga (= `GITHUB_WEBHOOK_SECRET`) |
| Where can this app be installed | *Only on this account* |

**Permessi minimi necessari**

- *Repository permissions*
  - **Administration: Read & write** — creare ed eliminare repository (rollback), aggiungere e
    togliere collaboratori.
  - **Contents: Read & write** — commit iniziale con l'API Git Data; i client (token utente) leggono
    e scrivono i `.ork` con git.
  - **Metadata: Read-only** (obbligatorio).
- *Organization permissions*
  - **Members: Read & write** — verificare l'appartenenza e invitare nell'organizzazione.
- *Account permissions*: nessuno.

**Eventi a cui iscriversi**: solo **Push**. (`ping` arriva da solo.) Il webhook ignora tutti i rami
diversi dal ramo principale del progetto (`conflitti/<id>` compresi) e i commit senza trailer
`Rocket-Sync-*`.

Dopo la creazione:

1. *Generate a private key* → scarica il `.pem`; **Client secret** → *Generate*. Annota App ID,
   Client ID.
2. *Install App* sull'organizzazione, scegliendo **All repositories** (l'app deve poter agire sui
   repository che crea).
3. Imposta i segreti delle funzioni (file `supabase/.env`, non versionato, partendo da
   `.env.example`):

   ```bash
   cp supabase/.env.example supabase/.env      # compila i valori
   supabase secrets set --env-file supabase/.env
   ```

   `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` esistono già nel runtime delle Edge Functions:
   non vanno impostati. La chiave privata si può scrivere su una riga con `\n` al posto degli a-capo.
   I segreti **non** compaiono mai nel codice né nei messaggi di errore.
4. Il webhook Discord *non* è un segreto di ambiente: lo inserisce un admin dall'app
   (funzione `discord-settings`) e finisce in `private.discord_webhooks`.

## 4. Pubblicare le Edge Functions

```bash
supabase functions deploy create-project manage-members accept-invitations \
  github-webhook discord-settings discord-dispatch github-token-refresh
```

`config.toml` disattiva la verifica JWT di piattaforma solo per `github-webhook` (autenticata dalla
firma HMAC `X-Hub-Signature-256`) e `discord-dispatch` (autenticata confrontando il Bearer con la
chiave `service_role`). Tutte le altre verificano il JWT dell'utente e poi il suo **ruolo nel
progetto lato server** (`admin` richiesto per `manage-members` e `discord-settings`).

| Funzione | Chiamata da | Note |
|---|---|---|
| `create-project` | utente | repo privato, commit iniziale (`v0`, `Rocket-Sync-Kind: init`), record; annulla tutto se fallisce |
| `manage-members` | admin del progetto | `add` / `remove` / `set_role`; ultimo admin protetto |
| `accept-invitations` | utente, dopo il login | inviti in sospeso → membership |
| `github-webhook` | GitHub | firma, trailer, `versions`, eventi; idempotente sullo sha |
| `discord-settings` | admin | `set` / `remove` / `test`; non restituisce mai l'URL |
| `discord-dispatch` | `pg_cron` ogni minuto | raggruppa (2 min), ora di Roma, 5 tentativi con attesa crescente |
| `github-token-refresh` | utente | rinnova il token utente con il client secret (resta sul server) |

## 5. Eventi, payload e testi

`emit_event` (client, solo tipi con `client_allowed`) ed `emit_event_server` (solo `service_role`)
costruiscono il testo italiano con `private.format_event_summary`. Chiavi del payload usate:
`number`, `restoredFrom`, `authorName`, `title`, `priority`, `conflictId`, `files`/`fileCount`,
`targetName`, `role`, `path`, `message`, `actorName`. Gli eventi con destinatari **privati**
(`card.assigned`, `sync.error`) generano solo notifiche ai destinatari indicati (che devono essere
membri) e non compaiono nel registro attività condiviso né su Discord.

Funzioni aggiunte rispetto alla specifica: `archive_project(project_id, archived)` (admin; la
specifica non indica come si archivia), `create_project_record(...)` (service), e le RPC di
servizio `set/remove/get_discord_webhook`, `claim/mark_discord_*` (service) con cui le Edge
Functions accedono allo schema `private`, che PostgREST non espone.

## 6. Test

Tutti i test girano **senza Docker e senza Supabase**.

```bash
# Database: Postgres 16 usa-e-getta + stub degli schemi Supabase + pgTAP (209 asserzioni)
supabase/scripts/test-db.sh                 # tutti i file in supabase/tests/
supabase/scripts/test-db.sh tests/04_*.sql  # solo alcuni
VERBOSE=1 supabase/scripts/test-db.sh       # mostra anche le righe "ok"
KEEP=1 supabase/scripts/test-db.sh          # lascia acceso il cluster per ispezionarlo

# Edge Functions (logica pura, vitest sotto Node) e controllo dei tipi
cd supabase && npm ci && npm test && npm run typecheck

# Edge Functions su Deno VERO (da npm, nessuna installazione globale): deno check + lint + prova
# end-to-end con Supabase, GitHub e Discord finti in locale
supabase/scripts/test-functions-deno.sh
```

Requisiti di `test-db.sh`: binari PostgreSQL 16 (`PG_BIN`, default `/usr/lib/postgresql/16/bin`),
estensione pgTAP e `pg_prove`. Se lanciato come root passa all'utente `postgres` (initdb non gira
come root). Lo script usa una porta libera, una cartella temporanea e arresta tutto alla fine.

Cosa è coperto:
- **Database** (`tests/*.sql`): isolamento tra non membri e tra progetti, notifiche private,
  membri e Discord non leggibili, ultimo admin, conservazione del log (e `versions` intatta),
  `emit_event` che rifiuta i tipi non consentiti, privilegi di tabella/colonna/funzione, trigger,
  note/commenti/allegati, policy di Storage, progetti archiviati, conflitti, prenotazioni.
- **Edge Functions** (`functions-tests/*.test.ts`): firma HMAC del webhook, parsing dei trailer,
  costruzione di `versions`, idempotenza, formattazione e raggruppamento Discord (ora di Roma),
  invio con ritentativi, autorizzazioni per ruolo, client GitHub App (JWT RS256 PKCS#1/PKCS#8,
  token d'installazione, repo, commit iniziale Git Data, collaboratori, inviti), adattatore
  supabase-js (con client finto), coerenza RPC ↔ SQL, assenza di segreti nel codice.

### Limiti noti dei test

- Le Edge Functions girano su **Deno 2.9.6 vero** (`test-functions-deno.sh`: `deno check`, `deno lint` e
  18 scenari end-to-end con richieste HTTP vere a ogni funzione), ma **non sono mai state eseguite sul
  runtime di Supabase** né contro un Supabase vero: lì mancano ancora una prova con
  `supabase functions serve` e una chiamata di prova per funzione.
- Le chiamate a GitHub e Discord sono simulate (`fetch` finto nei test vitest, server locali nell'end-to-end su Deno): nessuna è stata fatta
  contro i servizi veri (servono l'organizzazione e l'app reali).
- Lo stub di `auth`/`storage` riproduce ciò da cui dipendono le migrazioni, non l'intero
  comportamento di Supabase (per esempio `storage.objects.owner_id` è valorizzato a mano nei test).
- `pg_cron`, `pg_net` e Vault non esistono nel Postgres di test: la parte di cron delle migrazioni
  è esercitata solo nel ramo "estensione assente".
