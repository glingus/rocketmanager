# Installazione di Rocket Sync

Due parti: la prima è per chi **usa** Rocket Sync (sezioni 1-7), la seconda per chi **mantiene** il
progetto e pubblica le versioni (sezioni 8-10). Il piano generale è in
[`piano-v1.md`](piano-v1.md) §6.

> **Stato della verifica.** Gli script sono stati provati con Pester su PowerShell 7 (Linux) e la
> pipeline è controllata con `actionlint`. L'installazione vera su Windows (compreso Windows
> PowerShell 5.1 e Windows Sandbox) la esegue la CI su `windows-latest` e, per il test su un Windows
> pulito, un membro del team con la checklist di
> [`installer/sandbox/CHECKLIST.md`](../installer/sandbox/CHECKLIST.md). Finché quel test non passa,
> l'installer **non** va considerato completo.

---

## 1. Installare (o aggiornare, o riparare)

Requisiti: **Windows 10 21H2 o più recente, oppure Windows 11, a 64 bit**; 500 MB liberi; accesso a
internet. Non servono i diritti di amministratore, né Git, né Node, né Java.

Apri il **Prompt dei comandi** (Start → digita `cmd` → Invio) e incolla questa riga, **una sola**:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/<proprietario>/<repository-release>/releases/latest/download/install.ps1 | iex"
```

L'indirizzo esatto (con il nome giusto al posto di `<proprietario>/<repository-release>`) te lo dà chi
mantiene il progetto. Lo stesso comando serve per **aggiornare** o **riparare** un'installazione
esistente: si può rilanciare quando vuoi.

Alternativa: scarica `install.cmd` e `install.ps1` dalla pagina delle release, mettili nella stessa
cartella e fai doppio clic su `install.cmd`, oppure da un Prompt dei comandi
`install.cmd local` (esegue lo script che ha accanto).

## 2. Cosa fa, passo per passo

Ogni passo scrive un messaggio in italiano e una riga nel log `%TEMP%\RocketSync-install.log`
(per aprirlo: Win+R, incolla `%TEMP%\RocketSync-install.log`).

1. **Controllo del computer.** Windows 10 21H2+ o 11 a 64 bit (build 19044 o successiva), spazio
   libero ≥ 500 MB, TLS 1.2 abilitato (necessario per scaricare in modo sicuro), proxy di sistema
   rilevato e usato per i download.
2. **WebView2.** Se il runtime di Microsoft che disegna la finestra non c'è (si cerca la chiave
   `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` in HKLM e HKCU), scarica il programma
   di installazione ufficiale (Evergreen, `go.microsoft.com/fwlink/p/?LinkId=2124703`) e lo esegue
   in silenzio. Su Windows 11 e sui Windows 10 aggiornati c'è già.
3. **Download dell'installer** dalla pagina delle release (`RocketSync-setup.exe` e il file
   `RocketSync-setup.exe.sha256`) e **verifica dell'impronta SHA-256**: se non coincide il file viene
   scartato e non si installa nulla.
4. **Installazione per l'utente corrente**, in silenzio (`/S`), senza amministratore. Se Rocket Sync è
   in esecuzione lo chiude prima (con garbo, poi con la forza dopo 10 secondi); i dati e le
   impostazioni restano.
5. **Collegamenti** sul desktop e nel menu Start: se mancano li crea, se puntano altrove li corregge.
6. **Avvio** di Rocket Sync, che apre la configurazione guidata.

L'app si installa in `%LOCALAPPDATA%\Rocket Sync\` (eseguibile `Rocket Sync.exe`, disinstallatore
`uninstall.exe`). Questo è ciò che fa il modello NSIS di Tauri 2 in modalità *per utente*
(`installMode: currentUser`, verificato su `installer.nsi` di tauri-cli 2.12.6): cartella
`$LOCALAPPDATA\${PRODUCTNAME}`, e nel registro `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Rocket Sync`
i valori `DisplayName`, `DisplayVersion`, `DisplayIcon`, `InstallLocation` e `UninstallString` (tutti i
percorsi tra virgolette) e `MainBinaryName`. Lo script cerca l'app prima lì e poi nel percorso
predefinito. Il nome dell'eseguibile viene da `mainBinaryName` in `tauri.conf.json`: senza, Tauri
userebbe il nome del crate (`rocket-sync.exe`).

### Codici di uscita

Chi lancia lo script da un'automazione (o chi ti assiste) può leggere il codice di uscita; ogni errore
ha il suo e un messaggio in italiano.

| Codice | Significato |
|---:|---|
| 0 | Installazione completata |
| 10 | Windows non supportato (serve Windows 10 21H2+ / 11, a 64 bit) |
| 11 | Spazio libero insufficiente (< 500 MB) |
| 12 | TLS 1.2 non abilitabile / rete non raggiungibile |
| 13 | Indirizzo delle release non configurato (`-Owner`/`-Repo`) |
| 20 / 21 | Download / installazione di WebView2 non riusciti |
| 30 | Download dell'installer non riuscito |
| 31 | Impronta SHA-256 diversa da quella pubblicata (file scartato) |
| 40 | Impossibile chiudere Rocket Sync in esecuzione |
| 41 | L'installer di Rocket Sync ha restituito un errore |
| 42 | Installazione terminata ma l'app non si trova |
| 50 | Collegamenti non creati (l'app è comunque installata) |
| 60 | Avvio non riuscito (l'app è comunque installata) |
| 99 | Errore imprevisto (vedi il log) |

Opzioni dello script (parametri, oppure variabili d'ambiente se si usa `irm | iex`):
`-Owner`/`ROCKETSYNC_OWNER`, `-Repo`/`ROCKETSYNC_REPO`, `-LocalInstaller`/`ROCKETSYNC_LOCAL_INSTALLER`
(un `RocketSync-setup.exe` già scaricato; l'hash si controlla se accanto c'è il `.sha256`),
`-NoLaunch`/`ROCKETSYNC_NO_LAUNCH=1`, `-SkipWebView2`.

## 3. L'avviso blu di Windows (SmartScreen)

La V1 **non è firmata con un certificato a pagamento**, quindi alla prima apertura dell'installer o
dell'app Windows può mostrare *"Windows ha protetto il PC"*. Non è un errore né un virus: significa
solo che il programma non ha ancora una "reputazione" per Microsoft.

1. Clicca **Ulteriori informazioni**.
2. Clicca **Esegui comunque**.

Se usi il comando unico di questa guida l'avviso in genere non compare per l'installer (viene
scaricato da PowerShell, non dal browser), ma può comparire all'apertura dell'app. In quel caso la
risposta è la stessa. Per sicurezza lo script verifica comunque l'impronta SHA-256 del file prima di
eseguirlo. Un certificato di firma del codice elimina l'avviso (vedi §8.5).

## 4. Primo avvio

Si apre la configurazione guidata (dettagli in `piano-v1.md` §6.3):

1. controllo dell'ambiente (Git è incluso; se OpenRocket manca compare il link per scaricarlo);
2. **Accedi con GitHub** (si apre il browser; serve l'invito all'organizzazione del team);
3. profilo;
4. scelta dei progetti da tenere su questo PC, oppure creazione/importazione di un progetto;
5. cartella locale — **evita OneDrive, Dropbox e Google Drive** (vedi §7);
6. prima sincronizzazione: se la cartella contiene già dei file, nessuno viene sovrascritto;
7. preferenze (avvio con Windows, notifiche, politica di versione).

Da lì in poi l'app si apre dal collegamento sul desktop.

## 5. Aggiornamenti

- L'app controlla gli aggiornamenti all'avvio e ogni 6 ore. Gli aggiornamenti sono **firmati**:
  Rocket Sync li installa solo se la firma coincide con la chiave pubblica incorporata.
- Compare "Installa e riavvia"; non scatta mai durante una sincronizzazione.
- In alternativa si può rilanciare il comando unico (§1), che installa l'ultima versione sopra la
  precedente.

## 6. Disinstallare

*Impostazioni → App → App installate → Rocket Sync → Disinstalla* (o il comando
`"%LOCALAPPDATA%\Rocket Sync\uninstall.exe"`). La disinstallazione **non cancella i tuoi
progetti** (le cartelle con i file `.ork`) né i repository su GitHub.

## 7. Problemi comuni

| Problema | Cosa fare |
|---|---|
| **Proxy aziendale**: il download fallisce (codice 12/30/31) | Lo script usa il proxy di sistema con le credenziali di Windows. Controlla che il PC raggiunga `github.com` e `go.microsoft.com`; se il proxy richiede un'autenticazione diversa, scarica `RocketSync-setup.exe` da un altro PC e usa `install.cmd local` con `ROCKETSYNC_LOCAL_INSTALLER=<percorso>`. |
| **Antivirus** blocca o mette in quarantena l'installer | È un falso positivo tipico dei programmi non firmati. Verifica l'impronta SHA-256 pubblicata nella release (`RocketSync-setup.exe.sha256`), poi ripristina il file dalla quarantena o aggiungi un'eccezione per `%LOCALAPPDATA%\Rocket Sync`. |
| **OneDrive / Dropbox / Google Drive**: errori strani, file "in uso", sincronizzazioni doppie | Non tenere la cartella dei progetti dentro una cartella sincronizzata: i file `.ork` vengono riscritti a ogni salvataggio e il servizio li blocca o li duplica. L'app avvisa se la cartella scelta è in un disco sincronizzato; scegline una fuori (es. `C:\Users\<tu>\RocketSync`). |
| Rocket Sync è aperto e non si chiude (codice 40) | Clic destro sull'icona nell'area di notifica → **Esci**, poi rilancia il comando. |
| `npx @tauri-apps/cli signer generate` fallisce con *"Un criterio di controllo dell'applicazione ha bloccato il file"* (riferito a `cli.win32-x64-msvc.node`) | È il **Controllo intelligente delle app** di Windows 11 (Smart App Control), che blocca il modulo nativo della CLI di Tauri perché non firmato. Non serve disattivarlo (non si può riattivare senza reinstallare Windows): genera le chiavi con lo script in JavaScript puro, che non usa moduli nativi: `node scripts/updater-keys/genera-chiavi.mjs -w %USERPROFILE%\.tauri\rocketsync.key` (§8.2). Per la **build** dell'installer usa la CI su GitHub (`release.yml`), non il PC con il blocco. |
| WebView2 non si installa (codice 21) | Installalo a mano da <https://developer.microsoft.com/microsoft-edge/webview2/> ("Evergreen Standalone Installer", x64), poi rilancia. |
| Codice 13 | Il comando non conosce il repository delle release: usa quello fornito da chi mantiene il progetto, oppure `-Owner`/`-Repo`. |
| Finestra bianca all'avvio | Di solito WebView2 mancante o corrotto: rilancia il comando di installazione (lo ripara). |
| Qualsiasi altro errore | Manda il file `%TEMP%\RocketSync-install.log`; per un'analisi più completa esegui `"%LOCALAPPDATA%\Rocket Sync\Rocket Sync.exe" --self-test %USERPROFILE%\Desktop\selftest.json` e manda anche `selftest.json`. |

### Autodiagnosi (`--self-test`)

`Rocket Sync.exe --self-test <file.json>` non apre la finestra: scrive un file JSON ed esce con
codice 0 se tutto è a posto.

```json
{
  "ok": true,
  "appVersion": "0.1.0",
  "gitPath": "C:\\Users\\…\\Rocket Sync\\resources\\mingit\\cmd\\git.exe",
  "gitVersion": "2.47.1",
  "webview2Version": "130.0.2849.80",
  "configOk": true,
  "dataDirWritable": true,
  "credentialStoreOk": true,
  "errors": []
}
```

È implementata dalla shell dell'app; la CI e la sandbox verificano che il file abbia tutte queste
chiavi e `ok = true`.

---

## 8. Per chi mantiene: pubblicare una release

La pipeline è in `.github/workflows/`: `ci.yml` (a ogni push e pull request) e `release.yml` (a ogni
tag `v*`).

### 8.1 Dove pubblicare

Le release (installer, `latest.json`, script) vanno su un **repository configurabile**, che *può*
essere questo ma non deve. Per il comando unico serve che il download sia possibile **senza
credenziali**: il repository delle release deve quindi essere **pubblico** (il codice sorgente può
restare privato, in un repo diverso). Un repository privato non permette il download con una sola riga
(vedi `piano-v1.md`, decisione 7).

### 8.2 Una tantum

1. **Chiavi dell'updater** (su un PC fidato):

   Serve solo **Node 20 o più recente** (nient'altro: nessuna installazione, nessun modulo nativo). Dalla
   cartella del repository, in un Prompt dei comandi:

   ```
   node scripts/updater-keys/genera-chiavi.mjs -w %USERPROFILE%\.tauri\rocketsync.key
   ```

   Chiede la password due volte (mentre digiti non compare nulla) e crea la chiave **privata**
   (`rocketsync.key`) e la **pubblica** (`rocketsync.key.pub`), nello **stesso formato** di
   `tauri signer generate`: la CLI di Tauri accetta la chiave (`tauri signer sign`, `tauri build`) e
   l'updater di Tauri verifica le firme. Non sovrascrive file esistenti senza `--force`. Opzioni:
   `--password-env NOME` (password da variabile d'ambiente, utile in automazione), `--check <percorso>`
   (verifica più tardi che la chiave si decifri con la password e corrisponda alla pubblica).
   Dettagli sul formato e sulle prove di compatibilità: `scripts/updater-keys/README.md`.

   Perché non `tauri signer generate`? Su Windows 11 la CLI di Tauri carica un modulo nativo
   (`cli.win32-x64-msvc.node`) che il *Controllo intelligente delle app* può bloccare (vedi §7); lo
   script di questa sezione è JavaScript puro e non è soggetto al blocco.

   **Conserva la chiave privata e la password in un posto sicuro (gestore di password): se le perdi non
   potrai più pubblicare aggiornamenti accettati dalle app già installate.**
2. **Repository delle release**: crealo (pubblico), per esempio `<organizzazione>/rocketsync-releases`.
3. **Token** per scriverci: *Settings → Developer settings → Fine-grained tokens* con accesso al solo
   repository delle release e permesso **Contents: Read and write** (e *Metadata: read*).
4. Nel repository del **codice** (*Settings → Secrets and variables → Actions*):

   | Tipo | Nome | Valore |
   |---|---|---|
   | Variabile | `RELEASES_REPO` | `proprietario/nome` del repository delle release |
   | Variabile | `UPDATER_PUBKEY` | contenuto del file `.key.pub` (la chiave **pubblica**, su una riga) |
   | Variabile | `SUPABASE_URL` | indirizzo del progetto Supabase, `https://<ref>.supabase.co`, senza `/` finale (Supabase → *Project Settings → API* → *Project URL*) |
   | Variabile | `SUPABASE_ANON_KEY` | chiave pubblica `anon` (Supabase → *Project Settings → API* → *Project API keys*). È pubblica **per design**: la sicurezza sta nelle policy RLS; la chiave `service_role` **non** va mai messa qui |
   | Variabile | `PROJECTS_ORG` | nome dell'organizzazione GitHub che ospita i repository dei progetti (quella dove è installata la GitHub App) |
   | Segreto | `TAURI_SIGNING_PRIVATE_KEY` | contenuto del file `.key` (la chiave **privata**) |
   | Segreto | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | la password della chiave |
   | Segreto | `RELEASES_TOKEN` | il token del passo 3 |

   Nessun segreto sta nei file del repository; il workflow si ferma subito, con un messaggio chiaro,
   se una di queste voci manca.

   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PROJECTS_ORG`, l'endpoint dell'updater (ricavato da
   `RELEASES_REPO`) e `UPDATER_PUBKEY` vengono **incorporati nell'app in fase di compilazione** come
   `ROCKETSYNC_SUPABASE_URL`, `ROCKETSYNC_SUPABASE_ANON_KEY`, `ROCKETSYNC_GITHUB_ORG`,
   `ROCKETSYNC_UPDATER_ENDPOINT` e `ROCKETSYNC_UPDATER_PUBKEY` (la shell le legge con `option_env!`;
   l'updater usa queste, non `plugins.updater` di `tauri.conf.json`). Senza, l'app pubblicata non
   potrebbe fare il login né trovare aggiornamenti: per questo lo smoke test della release richiede
   che `--self-test` riporti `configOk: true`.

### 8.3 Pubblicare

1. Aggiorna la versione (stessa in `Cargo.toml` → `[workspace.package]`, `apps/desktop/package.json`
   e `apps/desktop/src-tauri/tauri.conf.json`).
2. Crea e invia il tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `release.yml` (su `windows-latest`): controlla che il tag coincida con le versioni nei file;
   esegue i test dei crate; scarica MinGit; costruisce l'installer NSIS **per utente** e lo firma per
   l'updater; ne fa uno **smoke test** (installazione silenziosa, collegamenti, `--self-test`,
   disinstallazione); poi su Linux calcola l'impronta SHA-256, genera `latest.json` e pubblica la
   release su `RELEASES_REPO` con questi file:

   | File | A cosa serve |
   |---|---|
   | `RocketSync-setup.exe` | l'installer |
   | `RocketSync-setup.exe.sha256` | impronta verificata da `install.ps1` |
   | `RocketSync-setup.exe.sig` | firma dell'updater |
   | `latest.json` | manifest dell'updater di Tauri 2 (versione, note, URL e firma per `windows-x86_64`) |
   | `install.ps1`, `install.cmd` | script di installazione con `RELEASES_REPO` **già impostato** (i segnaposto `@@OWNER@@`/`@@REPO@@` vengono sostituiti) |

   I tag con un trattino (`v0.2.0-beta.1`) diventano pre-release e **non** sono "l'ultima release"
   (quindi non raggiungono chi usa il comando unico né l'updater).
4. L'endpoint dell'updater incorporato nell'app è
   `https://github.com/<RELEASES_REPO>/releases/latest/download/latest.json`.

### 8.4 Verifiche locali

```
# script di release (generazione di latest.json, coerenza di versione)
node --test "scripts/*.test.mjs"
node scripts/check-release-version.mjs v0.1.0

# generatore delle chiavi dell'updater (formato identico alla CLI di Tauri; le prove "dal vivo"
# con la CLI ufficiale girano se è installata: pnpm install)
node --test "scripts/updater-keys/*.test.mjs"

# script di installazione (Pester 5, PowerShell 7)
pwsh -NoProfile -Command "Invoke-Pester installer/tests -Output Detailed"

# workflow
actionlint

# sintassi di tutto il PowerShell (script e passi dei workflow)
python3 scripts/check-powershell-syntax.py
```

### 8.5 Firma del codice (facoltativa)

Senza certificato resta l'avviso SmartScreen della §3 (il piano consiglia di partire così). Con un
certificato si aggiunge la firma all'installer in `release.yml` (variabili `certificateThumbprint` /
`signCommand` di Tauri, `bundle.windows`); la firma dell'**updater** di cui sopra è un'altra cosa e
serve comunque.

## 9. Come funziona la CI

- **`linux`**: `cargo fmt --check`, `clippy -D warnings`, `cargo test --workspace` (con le librerie
  di sistema di Tauri), test del database (`supabase/scripts/test-db.sh`: PostgreSQL 16 + pgTAP),
  test delle Edge Functions (`npm ci && npm test && npm run typecheck`), test degli script di release,
  poi `pnpm install --frozen-lockfile`, typecheck, lint, test, build ed e2e (Playwright/Chromium)
  dell'interfaccia.
- **`windows`**: Pester su Windows PowerShell 5.1, `cargo test -p rs-git -p rs-store -p rs-core -p
  rs-ork`, MinGit, build dell'installer NSIS, smoke test (`installer/tests/smoke-windows.ps1`).
- **`installer-scripts`** (Pester su Linux) e **`workflows`** (`actionlint` + `scripts/check-powershell-syntax.py`, che analizza con il parser di PowerShell tutti i `.ps1` e i passi `pwsh`/`powershell` dei workflow, compresi quelli dei job Windows senza `shell`).
- Permessi `contents: read` ovunque; cache di cargo, pnpm e npm; nessun segreto.

## 10. Test su un Windows pulito

Windows Sandbox è la prova più vicina a "un PC nuovo". La procedura per un membro del team è in
[`installer/sandbox/CHECKLIST.md`](../installer/sandbox/CHECKLIST.md): doppio clic su
`installer\sandbox\avvia-sandbox.cmd`, seguire la lista (collegamento sul desktop, primo avvio,
login GitHub, collegamento di un progetto di prova, pubblicazione, ricezione su un secondo PC) e
mandare `RocketSync-install.log` e `selftest.json`.
