# Rocket Sync — shell Tauri (`apps/desktop/src-tauri`)

Crate `rocket-sync` (Tauri 2, identificativo `it.rocketsync.app`, prodotto «Rocket Sync»).
La shell collega l'interfaccia (`apps/desktop/src`) al motore di sincronizzazione (`crates/rs-core`)
e al sistema operativo. I comandi e gli eventi sono quelli di [`docs/contratto-ipc.md`](../../../docs/contratto-ipc.md)
(§5 e §6), con JSON in camelCase.

## Struttura

| File | Contenuto |
|---|---|
| `src/main.rs` | Punto d'ingresso. Prima di Tauri gestisce **askpass** (`ROCKETSYNC_ASKPASS=1`) e **`--self-test`** |
| `src/app.rs` | Plugin, tray, comportamento della finestra, avvio dei servizi (motore, recupero, token) |
| `src/commands.rs` | I 42 comandi del contratto: attendono i servizi e delegano a `Shell` |
| `src/shell.rs` | Logica dei comandi, testabile senza finestra (`tests/shell_engine.rs`) |
| `src/auth/` | Accesso Supabase/GitHub: PKCE (`pkce.rs`), server di ritorno (`callback.rs`), chiamate HTTP (`supabase.rs`), sessione e identità (`mod.rs`) |
| `src/askpass.rs` | Credential helper di git (stesso eseguibile) |
| `src/secrets.rs` | Windows Credential Manager (crate `keyring`), con suddivisione in blocchi |
| `src/enrich.rs` | `FileInspector` → `rs-ork`; diff semantico `.ork`, diff testuale (`similar`), diff a tre vie dei conflitti |
| `src/openrocket.rs` | Rilevamento e avvio di OpenRocket |
| `src/selftest.rs` | Controllo dell'installazione per installer e CI |
| `src/diagnostics.rs`, `src/logging.rs` | Archivio diagnostico e log con token oscurati |
| `build.rs`, `capabilities/default.json` | Elenco dei comandi ammessi all'interfaccia |
| `tauri.conf.json`, `tauri.windows.conf.json` | Configurazione; la seconda aggiunge NSIS, WebView2 e MinGit **solo su Windows** |
| `scripts/fetch-mingit.ps1`, `scripts/make-icons.py` | Scarico di MinGit; generazione delle icone |

## Configurazione

Valori letti, in quest'ordine, da (1) variabili d'ambiente **al momento della compilazione** (`option_env!`),
(2) file `config.json` nella cartella dati dell'app (`%APPDATA%\it.rocketsync.app\config.json`), che prevale.
Nel binario non c'è nessun segreto: la chiave `anon` di Supabase è pubblica per progetto (la protezione è la RLS).

| Variabile di build | Chiave in `config.json` | Significato |
|---|---|---|
| `ROCKETSYNC_SUPABASE_URL` | `supabaseUrl` | `https://<progetto>.supabase.co` |
| `ROCKETSYNC_SUPABASE_ANON_KEY` | `supabaseAnonKey` | chiave pubblica (anon) |
| `ROCKETSYNC_GITHUB_ORG` | `githubOrg` | organizzazione GitHub dei repository dei progetti |
| `ROCKETSYNC_UPDATER_ENDPOINT` | `updaterEndpoint` | URL del manifesto dell'updater (accetta `{{target}}`, `{{arch}}`, `{{current_version}}`) |
| `ROCKETSYNC_UPDATER_PUBKEY` | `updaterPubkey` | chiave pubblica minisign (base64) che verifica le firme degli aggiornamenti |

Senza URL e chiave Supabase l'app parte, ma `auth_sign_in` risponde con un errore chiaro. Senza endpoint e
chiave dell'updater `check_for_update` risponde «nessun aggiornamento».

Variabili solo per sviluppo: `ROCKETSYNC_DATA_DIR` (cartella dati), `ROCKETSYNC_GIT` (percorso di git),
`ROCKETSYNC_OPENROCKET` (percorso di OpenRocket), `ROCKETSYNC_REMOTE_BASE` (es. `file:///srv/repos`:
i repository diventano `<base>/<owner>/<repo>.git` invece di GitHub).

### Porte del ritorno OAuth (da registrare in Supabase)

L'accesso usa PKCE con redirect su loopback. L'app prova, in ordine, le porte **53682–53691** su `127.0.0.1`
e usa la prima libera. In Supabase (Authentication → URL Configuration → *Redirect URLs*) vanno registrati
**tutti e dieci** gli indirizzi:

```
http://127.0.0.1:53682/callback
http://127.0.0.1:53683/callback
…
http://127.0.0.1:53691/callback
```

Flusso: browser di sistema su `{SUPABASE_URL}/auth/v1/authorize?provider=github&redirect_to=…&code_challenge=…&code_challenge_method=s256`
→ ritorno su `/callback?code=…` (pagina «Puoi tornare a Rocket Sync») → `POST /auth/v1/token?grant_type=pkce`.
La sessione Supabase e il **token GitHub** (`provider_token` + `provider_refresh_token`) finiscono in Credential
Manager (servizio `it.rocketsync.app`); il token GitHub non arriva mai all'interfaccia. Il rinnovo passa dalla Edge
Function `github-token-refresh` (il client secret resta sul server).

### Content Security Policy

`tauri.conf.json` ammette solo `self`, `https://*.supabase.co` e `wss://*.supabase.co`. Con un dominio Supabase
personalizzato va aggiunto sovrascrivendo la configurazione in fase di build, ad esempio:
`TAURI_CONFIG='{"app":{"security":{"csp":"default-src '"'"'self'"'"'; … connect-src '"'"'self'"'"' https://auth.esempio.it wss://auth.esempio.it"}}}'`.

## Askpass e git incluso

* Git riceve `GIT_ASKPASS=<questo eseguibile>` e `ROCKETSYNC_ASKPASS=1` (solo nel suo ambiente). Avviato così,
  l'eseguibile risponde `x-access-token` a «Username…» e il token del Credential Manager a «Password…», poi termina,
  prima di inizializzare Tauri. Il token non compare mai in URL, riga di comando o `.git/config`.
* Su Windows git è `resources\mingit\cmd\git.exe` (accanto all'eseguibile). La cartella **non è nel repository**:
  si popola con `pwsh -File apps/desktop/src-tauri/scripts/fetch-mingit.ps1` (MinGit 2.47.1 64 bit, SHA-256 fissato
  nello script; se non corrisponde non estrae nulla). Serve git ≥ 2.40: se manca o è più vecchio i comandi
  rispondono con l'errore `gitMissing`.
* Su Linux/sviluppo si usa il `git` di sistema (o `ROCKETSYNC_GIT`).

## Self-test (installer e CI)

```
"Rocket Sync.exe" --self-test C:\temp\selftest.json
```

Non apre finestre, non richiede accesso né rete. Scrive
`{ ok, appVersion, gitPath, gitVersion, webview2Version, configOk, dataDirWritable, credentialStoreOk, errors[] }`
(`webview2Version` è `null` fuori da Windows; `credentialStoreOk` = scrittura, lettura e cancellazione di una voce di
prova) ed esce con 0 se tutto è a posto, 1 altrimenti (2 se manca il percorso del file).

## Sicurezza

* `build.rs` dichiara solo i 42 comandi del contratto; `capabilities/default.json` li concede alla finestra `main`
  insieme a `core:event:allow-listen`/`unlisten`. Nessun accesso generico a file system, shell, rete o plugin dal
  frontend (un test verifica che build.rs, capability e `invoke_handler` coincidano e coprano il contratto).
* I percorsi che arrivano dall'interfaccia (`open_in_openrocket`, `open_folder`, esportazioni) sono validati:
  niente `..`, percorsi assoluti, `.git`; `open_folder` apre solo cartelle.
* `secure_store_*` lavora in uno spazio di nomi separato dalle credenziali dell'app (`store.<chiave>`).
* Log e diagnostica passano da `rs_git::redact` (token, credenziali negli URL, header `Authorization`).

## Compilare e provare

```
cargo build -p rocket-sync          # Linux: serve webkit2gtk-4.1; apps/desktop/dist deve esistere (pnpm --dir apps/desktop build)
cargo test  -p rocket-sync          # test unitari e di integrazione (motore reale + remoto bare locale)
cargo clippy -p rocket-sync --all-targets -- -D warnings
cargo check -p rocket-sync --target x86_64-pc-windows-gnu
```

Su Linux l'archivio delle credenziali è solo in memoria (si riaccede a ogni avvio): serve unicamente allo sviluppo.

## Installer per Windows

1. Dipendenze: Rust (target `x86_64-pc-windows-msvc`), Node 22 + pnpm, `@tauri-apps/cli` v2
   (`pnpm dlx @tauri-apps/cli@2 …`, oppure aggiungerlo a `apps/desktop/package.json`).
2. `pwsh -File apps/desktop/src-tauri/scripts/fetch-mingit.ps1` (popola `resources\mingit`).
3. Imposta le variabili di build della tabella sopra, e le chiavi di firma dell'updater:
   `TAURI_SIGNING_PRIVATE_KEY` (e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), generata con
   `pnpm dlx @tauri-apps/cli@2 signer generate`; la parte pubblica va in `ROCKETSYNC_UPDATER_PUBKEY`.
4. Da `apps/desktop/src-tauri`: `pnpm dlx @tauri-apps/cli@2 build` (esegue `pnpm build` del frontend). Lavorando da
   quella cartella cargo legge `.cargo/config.toml`, che collega staticamente il runtime C (`+crt-static`) sui target MSVC.
5. Risultato in `target\release\bundle\nsis\`: installer NSIS **per utente** (`installMode: currentUser`, nessun
   permesso di amministratore), italiano, con collegamenti nel menu Start e opzione per il desktop, WebView2
   incorporato (`embedBootstrapper`), `resources\mingit\**` incluso, più gli artefatti dell'updater (`.nsis.zip` + `.sig`).
6. Prova: installare e lanciare `"Rocket Sync.exe" --self-test out.json`.

`tauri.windows.conf.json` viene unito automaticamente alla configurazione solo per i target Windows, quindi su
Linux non serve la cartella `resources\mingit`. Per `cargo check` verso Windows da Linux ne basta una vuota con
un file dentro (è ignorata da git).

## Icone

Generate con `python3 scripts/make-icons.py` (Pillow): razzo in ottone su legno di ciliegio, colori dei token del
tema. In `icons/`: `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, `tray.png`.

## Limiti noti

* Mai eseguito su Windows e mai avviata la finestra in questo ambiente: l'avvio della GUI, il tray, il plugin
  updater, autostart, notifiche, dialogo di scelta cartella, Credential Manager e il rilevamento di OpenRocket
  (registro) compilano (`cargo check` verso Windows) ma non sono stati provati dal vivo.
* L'accesso reale (Supabase + GitHub App) non è stato provato con account veri: il flusso PKCE è verificato contro
  server HTTP finti (verifier ↔ challenge, redirect su loopback, scambio, rinnovo, errori).
* `fetchIntervalSeconds` vale al prossimo avvio dell'app (il motore legge l'intervallo all'avvio).
* All'uscita dal tray («Esci») l'app non chiede di pubblicare le modifiche ancora aperte: il contratto IPC non ha un
  evento per questo.
