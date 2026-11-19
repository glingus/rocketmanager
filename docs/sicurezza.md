# Rocket Sync — sicurezza

> Per chi **mantiene** il progetto. Descrive come funziona oggi, basandosi sul codice. Dove una cosa
> non è garantita, c'è scritto. Riferimenti: [`modello-dati.md`](modello-dati.md),
> [`contratto-ipc.md`](contratto-ipc.md), [`protocollo-sync.md`](protocollo-sync.md),
> [`installazione.md`](installazione.md), [`../supabase/README.md`](../supabase/README.md),
> [`../apps/desktop/src-tauri/README.md`](../apps/desktop/src-tauri/README.md).

## 1. Il quadro in breve

```
Interfaccia (WebView2, React)  ──IPC (solo i comandi del contratto)──►  Core Rust (Tauri)
   │  supabase-js, chiave anon + sessione utente                           │  git incluso (MinGit)
   ▼                                                                       ▼
Supabase (Auth, Postgres+RLS, Realtime, Storage, Edge Functions) ◄──webhook──  GitHub (repo privati, GitHub App)
```

Principi:

- **L'interfaccia non vede il token GitHub.** Lo custodisce solo il core.
- **Il client usa solo la chiave pubblica (`anon`)** e la sessione dell'utente: la sicurezza dei dati è
  nella **RLS**, non nel nascondere la chiave.
- **Le operazioni privilegiate** (creare repo, gestire membri, Discord, registrare le versioni) passano
  da Edge Functions con la chiave `service_role`, che verificano il ruolo **lato server**.
- **Git è la fonte di verità** per le versioni: l'app non fa mai `--force`.

## 2. Dove stanno i segreti e chi li vede

| Segreto | Dove sta | Chi lo vede | Note |
|---|---|---|---|
| **Token GitHub** dell'utente (`provider_token` + `provider_refresh_token`, GitHub App, scade dopo ~8 ore) | Windows Credential Manager, servizio `it.rocketsync.app`, voce `auth.github` (`src-tauri/src/secrets.rs`, `auth/mod.rs`) | Solo il core. Git lo riceve dall'eseguibile stesso come **askpass** (`askpass.rs`). | Mai nell'interfaccia (`AuthStatus` non lo contiene), mai in URL, riga di comando o `.git/config`. |
| **Sessione Supabase** (access e refresh token dell'utente) | Credential Manager, voce `auth.session`; l'interfaccia la riceve in `auth_status` per `supabase-js` e la salva con `secure_store_*` (voci `store.<chiave>`) | Core e interfaccia (serve a `supabase-js`) | È un token **dell'utente**, limitato dalla RLS. Non è mai in `localStorage` (`SupabaseData` usa `secure_store_*` in Tauri). |
| **Profilo GitHub** (login, nome, avatar) | Credential Manager, `auth.profile` | Core | Serve per l'identità dei commit. |
| **Chiave `anon` di Supabase** | Nel binario o in `%APPDATA%\it.rocketsync.app\config.json` (`ROCKETSYNC_SUPABASE_ANON_KEY` / `supabaseAnonKey`) | Chiunque abbia l'app | **Pubblica per progetto.** Protegge la RLS. Nei diagnostici compare come `***` (`AppConfig::redacted`). |
| **Chiave `service_role` di Supabase** | Runtime delle Edge Functions (`SUPABASE_SERVICE_ROLE_KEY`) e **Vault** (`service_role_key`, per `pg_cron`) | Solo chi amministra Supabase | Mai nell'app, mai nel repository. |
| **Chiave privata della GitHub App** | Segreto Edge `GITHUB_APP_PRIVATE_KEY` | Solo le Edge Functions (`_shared/github-app.ts`, per firmare il JWT dell'app) | Va tenuta anche in un archivio sicuro fuori da Supabase. |
| **Client secret della GitHub App** | Segreto Edge `GITHUB_APP_CLIENT_SECRET`; lo stesso valore è configurato nel provider GitHub di Supabase Auth | Solo `github-token-refresh` e Supabase Auth | Il rinnovo del token utente passa dalla funzione: il secret non arriva mai al client. |
| **Segreto del webhook GitHub** | Segreto Edge `GITHUB_WEBHOOK_SECRET` + configurazione della GitHub App | Edge Function `github-webhook` | Serve a verificare `X-Hub-Signature-256`. |
| **Webhook Discord** | Tabella `private.discord_webhooks` (schema non esposto dall'API REST) | Solo `service_role`, tramite le RPC `set_discord_webhook`, `get_discord_webhook`, `remove_discord_webhook` | `discord-settings` **non restituisce mai l'URL**: il client sa solo `webhook_configured`. |
| **Chiave di firma dell'updater** (minisign) | Segreti GitHub Actions `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Solo il workflow `release.yml` | La parte **pubblica** (`UPDATER_PUBKEY`, variabile Actions) è incorporata nell'app e verifica ogni aggiornamento. Chi la perde non può più pubblicare aggiornamenti validi per le app già installate. |

Come sono protetti gli **esempi nei log**: `rs_git::redact` (`crates/rs-git/src/redact.rs`) toglie user-info degli URL,
token `gh*_`/`github_pat_`, header `Authorization`, `x-access-token:` e coppie `password|token|secret|api_key=`.
Si applica ai comandi git registrati, al file di log (`logging.rs`, `%APPDATA%\it.rocketsync.app\logs\rocketsync.log`) e a
ogni voce dell'archivio diagnostico (`diagnostics::write_zip`).

## 3. Flusso di accesso

1. **Avvio dell'accesso** (`auth_sign_in`): l'app apre il browser su
   `{SUPABASE_URL}/auth/v1/authorize?provider=github&…&code_challenge=…&code_challenge_method=s256`.
2. **PKCE con ritorno in loopback.** `auth/pkce.rs` genera verifier e challenge; `auth/callback.rs` apre un server su
   `127.0.0.1`, prima porta libera tra **53682 e 53691**, con scadenza. Quegli indirizzi (`http://127.0.0.1:<porta>/callback`)
   vanno registrati in Supabase → Authentication → URL Configuration.
3. **Scambio del codice**: `POST /auth/v1/token?grant_type=pkce` con la chiave `anon`. La sessione e il token GitHub finiscono
   in Credential Manager.
4. **Dopo il login** l'interfaccia chiama la Edge Function `accept-invitations`: gli inviti in sospeso per il login GitHub diventano
   membership.
5. **Rinnovi** (`ensure_github_token`): il token GitHub si rinnova 15 minuti prima della scadenza tramite
   `github-token-refresh` (richiede un JWT valido). Se GitHub rifiuta il refresh token, la voce viene cancellata e serve un nuovo accesso.
6. **Uscita** (`auth_sign_out`): logout su Supabase e cancellazione delle voci locali.

Un utente che entra con GitHub deve anche essere **membro del progetto** (`project_members`) per vedere qualcosa, e avere
accesso `push` al repository, che dà la GitHub App (`manage-members`).

## 4. Permessi lato server

### 4.1 Database (`supabase/migrations`)

- **RLS attiva ovunque**, tutto negato salvo policy esplicite. Nella migrazione 5 si revocano tutti i privilegi a `anon` e
  `authenticated` e si concedono solo select, e write mirati a livello di colonna (per esempio `update (title, description, color,
  priority, category_id, status, assignee_id, due_date, position, linked_version, converted_at)` su `cards`).
- **`anon` non ha accesso** a nessuna tabella. Le funzioni sono revocate a `public` e `anon`.
- Le colonne gestite dal server non sono scrivibili dal client: `updated_at`, `completed_at`, `edited_at`, `updated_by` sono
  impostate da trigger (`cards_guard`, `card_comments_guard`, `discord_settings_guard`).
- **Funzioni `security definer`** con `set search_path` fissato e controllo esplicito di `auth.uid()` e dell'appartenenza
  (`is_project_member`, `is_project_admin`, `is_project_active`).
- **Schema `private`** (webhook Discord, coda): non è nell'elenco degli schemi dell'API (`config.toml`), privilegi revocati a
  `anon`/`authenticated`, accessibile solo da `service_role`.
- **Ultimo admin protetto** dal trigger `project_members_last_admin`. Campi del progetto non modificabili dal client
  (`id`, `slug`, `github_*`, `created_by`, `archived_at`) dal trigger `projects_protect`. Impostazioni validate da
  `projects_validate_settings`.
- **Eventi**: `emit_event` solo per i tipi con `client_allowed`, solo per i membri, autore sempre `auth.uid()`;
  `emit_event_server` solo `service_role`. `create_project_record` e le RPC Discord rifiutano chiamate con un altro ruolo.
- **Storage** `attachments`: bucket privato (25 MB), policy sul percorso `<project_id>/<card_id>/…`; la cartella è legata al
  progetto dal vincolo `card_attachments_path`.
- **Progetti archiviati**: scrittura su card e commenti bloccata (`is_project_active`).

### 4.2 Edge Functions (`supabase/functions`)

| Funzione | `verify_jwt` | Autorizzazione |
|---|---|---|
| `create-project` | sì | `requireUser` (JWT valido) |
| `manage-members` | sì | `requireUser` + `requireProjectRole(…, "admin")` **prima di qualsiasi altra operazione** |
| `accept-invitations` | sì | `requireUser`; agisce solo sul login GitHub dell'utente stesso |
| `discord-settings` | sì | `requireUser` + ruolo `admin` del progetto |
| `github-token-refresh` | sì | `requireUser` |
| `github-webhook` | **no** (GitHub non ha un token Supabase) | Firma HMAC-SHA256 `X-Hub-Signature-256` sul corpo grezzo, confronto a tempo costante (`hmac.ts`, `timingSafeEqual`); considera solo `push` sul ramo principale; idempotente sullo sha |
| `discord-dispatch` | **no** (la chiama `pg_cron`) | `requireServiceRole`: il `Bearer` deve coincidere con la chiave `service_role` |

Gli errori non rivelano dettagli interni (`errorResponse`) e la mancanza di un segreto produce solo "Configurazione del server
incompleta" (`env.ts`).

### 4.3 Cosa può fare un Member e un Administrator

| Azione | Member | Administrator |
|---|---|---|
| Leggere progetto, versioni, card, log, membri | sì | sì |
| Pubblicare, aggiornare, ripristinare, risolvere conflitti (comandi del core, accesso `push` al repo) | sì | sì |
| Creare/modificare card, commenti, allegati, categorie | sì | sì |
| Eliminare **le proprie** card, commenti, allegati | sì | sì |
| Eliminare card, commenti, allegati **di altri** | no | sì |
| Eliminare una categoria | no | sì |
| Cambiare nome, descrizione, politica di pubblicazione, conservazione del log, `ai_admin_id` | no | sì |
| Invitare, rimuovere, cambiare il ruolo dei membri | no | sì (l'ultimo admin è protetto) |
| Configurare Discord (webhook, eventi) | no | sì |
| Leggere l'URL del webhook Discord | no | **no** (nessuno dal client) |
| Scrivere direttamente `versions`, `conflicts`, `project_members`, `activity_log` | no | no |
| Registrare eventi `version.*`, `member.*`, `project.*` dal client | no | no |

Rimuovere un membro (`manage-members`, `remove`) toglie anche l'accesso al repository con la GitHub App. Non cancella i file che la
persona ha già scaricato: quelli restano sul suo PC.

## 5. Integrità dei dati

- **Mai `--force`.** I fetch non usano refspec con `+`; il push è sempre `git push --atomic origin main:refs/heads/main vN:refs/tags/vN …`
  (`rs-git/src/repo.rs`). Il registro dei comandi (`CommandLog`, `crates/rs-git/src/exec.rs`) serve a un test che verifica che nessun
  comando contenga `--force`. Numero di versione e tag partono insieme: due versioni non possono avere lo stesso numero.
- **Copie di sicurezza.** Prima di aggiornare, pubblicare, ripristinare, scartare, risolvere un conflitto o recuperare dopo un crash
  il core salva l'intera cartella in `refs/rocketsync/safety/<unix-ms>-<operazione>` (`rs-core/src/project/snapshot.rs`) con un indice
  temporaneo, senza toccare la cartella di lavoro. Conservazione: 30 giorni, massimo 50 per progetto (`Timing`).
- **Materializzazione sicura** (`materialize.rs`): prima di sovrascrivere si verifica che il file su disco coincida con ciò che ci si aspetta;
  altrimenti si ferma senza scrivere.
- **Guardia "editor non aggiornato"**: un salvataggio sospetto dopo un aggiornamento forzato non viene pubblicato e può diventare un conflitto
  (`protocollo-sync.md` §7.8).
- **Journal** (`rs-store`, `rocketsync.db`): ogni operazione registra il passo raggiunto. All'avvio `recovery.rs` rimuove i lock rimasti
  (più vecchi di 60 s), annulla gli stati Git a metà e completa o ripristina l'operazione interrotta.
- **Indice `versions` ricostruibile**: scritto solo dal webhook, idempotente; la fonte di verità resta Git.
- **Pulizia del log** (`activity_log`): non tocca mai Git né `versions`.
- **Git isolato**: ambiente con `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<%APPDATA%\it.rocketsync.app\gitconfig>`, `GIT_TERMINAL_PROMPT=0`,
  `LC_ALL=C`, opzioni `core.hooksPath=<cartella vuota>`, `credential.helper=`, `core.autocrlf=false`, `core.longpaths=true`. Gli hook e le
  impostazioni Git dell'utente non influiscono.

## 6. Superficie esposta dall'interfaccia

- **Capability minima** (`src-tauri/capabilities/default.json`): solo `core:event:allow-listen/unlisten` e i **42 permessi `allow-*`** dei comandi del
  contratto. Nessun accesso generico a file system, shell, rete o `opener` dall'interfaccia. Una sola finestra (`main`).
- **CSP** (`tauri.conf.json`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost
  https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`. Niente script esterni,
  font inclusi nell'app. `withGlobalTauri` è `false`.
- **Percorsi dall'interfaccia**: `open_in_openrocket` accetta solo un percorso relativo, con `/`, senza `..`, senza `.git`, e solo file del progetto
  collegato (`shell.rs`). `export_*` validano i percorsi e scrivono solo nella cartella indicata. `secure_store_*` accettano chiavi
  `[A-Za-z0-9._:-]` fino a 200 caratteri e valori fino a 64 KB, sotto il prefisso `store.`: l'interfaccia **non può** leggere le voci
  `auth.*`.
- **Contenuto non fidato**: il testo di card, commenti e nomi file è mostrato da React (escape di default); non c'è `dangerouslySetInnerHTML`.
  Gli allegati si aprono con URL firmati a tempo di Supabase Storage.
- **Una sola istanza** dell'app (`tauri-plugin-single-instance`).
- **Archivio diagnostico**: ogni file è passato da `redact`; `config.json` compare con la chiave `anon` oscurata.

## 7. Limiti noti

1. **GitHub Free non permette di proteggere i branch dei repo privati.** Chi ha accesso `push` e usa Git a mano (fuori da Rocket Sync) potrebbe
   riscrivere `main`. L'app non lo fa mai, ma non lo impedisce a un altro client. Mitigazioni: ogni clone ha tutto lo storico, i tag `vN` e il
   webhook registrano ogni push; passare a un piano con protezione dei branch (o a un'organizzazione a pagamento) lo chiude davvero.
2. **Installer e programma non firmati** con certificato di firma del codice (§8.5 di `installazione.md`): Windows SmartScreen mostra un avviso.
   Gli aggiornamenti sono invece **firmati** (minisign) e verificati con la chiave pubblica incorporata.
3. **I file `.ork` sono binari**: Git non li fonde e non può dire cosa contengono. Il diff semantico (`rs-ork`) è un aiuto, non una garanzia: ciò che il parser non
   riconosce viene dichiarato "non interpretato".
4. **La sessione Supabase è visibile all'interfaccia** (serve a `supabase-js`). Una vulnerabilità XSS nel WebView permetterebbe di usarla con i permessi
   dell'utente, ma non di leggere il token GitHub né di toccare il file system fuori dai comandi del contratto. La CSP riduce il rischio.
5. **`open_folder` apre qualunque cartella esistente** indicata dall'interfaccia (mostra la cartella in Esplora risorse; non esegue nulla).
6. **Il ritorno OAuth usa un server su loopback**: durante l'accesso, un altro programma dello stesso PC potrebbe tentare di collegarsi alla porta.
   PKCE impedisce di usare un codice rubato senza il verifier, che resta nel processo.
7. **`style-src 'unsafe-inline'`** è presente nella CSP (CSS Modules e stili dei componenti).
8. **Il token GitHub dura ~8 ore** e si rinnova solo tramite Supabase: se Supabase è irraggiungibile o sospeso a lungo, le operazioni Git verso GitHub si fermano
   a scadenza (il lavoro locale e le versioni in attesa restano al sicuro). Vedi il runbook.
9. **Chi ha il PC sbloccato ha accesso a tutto**: Credential Manager protegge dagli altri utenti Windows, non dall'utente stesso o da un malware nello stesso account.
10. La **rimozione di un membro non invalida i token già emessi**: la RLS gli toglie subito i dati e `manage-members` gli toglie l'accesso al repository, ma la sua sessione Supabase e il suo token
    GitHub restano validi fino alla scadenza (il token GitHub dura ~8 ore). Per un PC rubato serve anche disconnettere la sessione dal pannello Supabase (vedi il runbook).

## 8. Checklist di messa in produzione

**Supabase**
- [ ] Migrazioni applicate in ordine (`supabase db push`); nessun accesso `anon` alle tabelle (test del database in `supabase/tests` verdi: `npm run test:db` dentro `supabase/`).
- [ ] `config.toml` non espone `private` tra gli schemi dell'API.
- [ ] Segreti impostati con `supabase secrets set --env-file supabase/.env` (file **non versionato**): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
      `GITHUB_ORG`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.
- [ ] Vault: `project_url` e `service_role_key` creati; job `discord-dispatch` attivo.
- [ ] Funzioni pubblicate; **`github-webhook` e `discord-dispatch` senza verifica JWT, tutte le altre con** (`config.toml`).
- [ ] Authentication → provider GitHub con Client ID/secret della **GitHub App**; Redirect URL: le **dieci** `http://127.0.0.1:53682…53691/callback`.
- [ ] Piano e promemoria: il piano Free si sospende dopo 7 giorni senza attività (vedi runbook).

**GitHub**
- [ ] GitHub App con i permessi minimi (Administration, Contents e Members: lettura e scrittura; nessun permesso account), installata **solo** nell'organizzazione dei progetti.
- [ ] Scadenza dei token utente **attiva** (altrimenti il rinnovo non serve).
- [ ] Webhook dell'app verso `…/functions/v1/github-webhook` con il segreto; evento `push`.
- [ ] Chiave privata dell'app scaricata e archiviata in un luogo sicuro, non nel repository.
- [ ] Piano dell'organizzazione valutato per la protezione dei branch (limite §7.1).

**App e rilascio**
- [ ] Build con `ROCKETSYNC_SUPABASE_URL`, `ROCKETSYNC_SUPABASE_ANON_KEY` (**mai** la `service_role`), `ROCKETSYNC_GITHUB_ORG`.
- [ ] `UPDATER_PUBKEY` (variabile) e `TAURI_SIGNING_PRIVATE_KEY` (+ password) (segreti) impostati; copia **offline** della chiave privata dell'updater.
- [ ] MinGit con SHA-256 verificato dallo script `fetch-mingit.ps1`.
- [ ] `RocketSync-setup.exe.sha256` pubblicato e controllato; valutare il certificato di firma del codice.
- [ ] Verificata una installazione pulita (Windows Sandbox) e `--self-test`.
- [ ] CSP aggiornata se si usa un dominio Supabase personalizzato (`connect-src`).
- [ ] Nessun `.env` o chiave nel repository (`.gitignore` esclude `.env.*`, `*.pem`, `*.key`); controllare con la scansione dei segreti del repository.

**Operazioni**
- [ ] Almeno **due** amministratori per progetto.
- [ ] Un piano per la **rotazione**: chiave privata della GitHub App, client secret, segreto del webhook, chiave `service_role` (Supabase → Settings → API), webhook Discord.
- [ ] Persona incaricata di leggere il runbook di recupero e di fare una prova di ripristino.
