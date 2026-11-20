# Configurazione iniziale del backend

Guida passo per passo per **chi mette in piedi Rocket Sync la prima volta** (il titolare
dell'organizzazione). Si fa una volta sola, in circa 20 minuti. Alla fine il backend è pronto:
la GitHub App esiste ed è installata, l'accesso con GitHub funziona, il database è creato e le
sette Edge Functions sono pubblicate. **Non devi copiare a mano nessun segreto.**

Le persone del team non fanno nulla di tutto questo: useranno solo l'app
([guida utente](guida-utente.md)).

> Stato della verifica: il configuratore è provato in automatico contro server finti di GitHub e
> di Supabase (38 test). Non è mai stato eseguito contro i servizi veri: la prima esecuzione
> reale è questa. Se qualcosa non torna, vedi [Se qualcosa va storto](#9-se-qualcosa-va-storto)
> e la [procedura manuale](#10-procedura-manuale-in-alternativa).

## Cosa fa il configuratore

Un solo comando, `node scripts/setup/setup-backend.mjs`, che ti guida in otto passi:

1. controlla il progetto Supabase con il tuo access token;
2. registra la **GitHub App** nell'organizzazione (tu premi un solo pulsante su GitHub);
3. legge le chiavi API del progetto;
4. attiva l'**accesso con GitHub** su Supabase (provider, indirizzo di ritorno, le dieci porte
   `127.0.0.1:53682–53691`);
5. salva i **segreti** delle Edge Functions su Supabase (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_ORG`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`);
6. applica le **migrazioni** del database, in ordine, saltando quelle già applicate, e salva in
   Vault `project_url` e `service_role_key` (servono alla coda Discord);
7. pubblica le **7 Edge Functions**;
8. stampa i tre valori **pubblici** da mettere nelle variabili di GitHub Actions.

**I segreti restano in memoria**: il client secret, il webhook secret e la chiave privata della
app passano dal browser a Supabase senza essere stampati né scritti su disco. Il configuratore
salva solo uno stato non segreto (nome e numero dell'app, passi già completati) in
`%APPDATA%\RocketSync\setup-backend.json` su Windows, `~/Library/Application Support/RocketSync/`
su macOS, `~/.config/RocketSync/` su Linux. Si può rilanciare quante volte serve: riparte da dove
si era fermato e non rifà ciò che è già fatto.

## 1. Creare l'organizzazione GitHub

1. Accedi a GitHub con il **tuo** account e vai su <https://github.com/organizations/plan>.
2. Scegli il piano **Free**, dai un nome all'organizzazione (per esempio `rocket-team`), indica
   come proprietario il tuo account.
3. Salta l'invito dei colleghi: **non serve ora**. Basta il tuo account; i colleghi vengono
   invitati più tardi dall'app, dalla schermata Membri.

Il nome dell'organizzazione ti servirà nel passo 4 (è la parte dopo `github.com/` nell'indirizzo).

## 2. Creare il progetto Supabase e l'access token

1. Vai su <https://supabase.com/dashboard> e accedi (anche con GitHub).
2. **New project**. Nome a piacere (per esempio `Rocket Sync`), una password del database
   (salvala nel gestore di password: il configuratore non la usa), **Region: Central EU
   (Frankfurt)**, piano **Free**.
3. Aspetta che il progetto sia pronto (un paio di minuti).
4. Annota il **project ref**: sono 20 lettere minuscole, si vedono nell'indirizzo del pannello
   (`supabase.com/dashboard/project/<ref>`). Puoi anche incollare l'intero indirizzo: il
   configuratore lo riconosce.
5. Crea l'**access token**: in alto a destra il tuo avatar → **Account preferences** →
   **Access Tokens** → **Generate new token**. Dagli un nome (`rocket-sync-setup`) e copialo:
   inizia con `sbp_` e si vede una volta sola. Dopo la configurazione puoi revocarlo dalla stessa
   pagina.

## 3. Installare Node e scaricare il codice

1. Installa **Node.js 20 o più recente** (scarica la versione LTS da <https://nodejs.org>). Per
   controllare: apri un terminale (su Windows PowerShell) e scrivi `node --version`: deve
   rispondere `v20` o superiore.
2. Installa **Git** (<https://git-scm.com/downloads>) e scarica il codice:

   ```bash
   git clone https://github.com/<proprietario>/<repository>.git rocketsync
   cd rocketsync
   ```

Il configuratore non richiede `pnpm install` né altre dipendenze: usa solo Node. Per pubblicare le
Edge Functions scarica da solo, con `npx`, la CLI di Supabase alla versione fissata (2.122.1):
serve quindi la connessione a internet.

## 4. Lanciare il configuratore

```bash
node scripts/setup/setup-backend.mjs
```

Ti chiede, in italiano:

- il **nome dell'organizzazione** GitHub del passo 1;
- il **project ref** del passo 2;
- l'**access token** di Supabase: mentre lo scrivi (o lo incolli) non compare nulla a video, è
  normale.

Per non digitare nulla puoi passare i dati da riga di comando e usare la variabile d'ambiente per
il token:

```bash
# macOS / Linux
SUPABASE_ACCESS_TOKEN=sbp_... node scripts/setup/setup-backend.mjs --org rocket-team --ref abcdefghijklmnopqrst
# Windows PowerShell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."; node scripts/setup/setup-backend.mjs --org rocket-team --ref abcdefghijklmnopqrst
```

`node scripts/setup/setup-backend.mjs --aiuto` mostra tutte le opzioni.

## 5. Cosa cliccare su GitHub

Quando arriva al passo 2 il configuratore apre il browser su una pagina locale
(`http://127.0.0.1:<porta>/`) che rimanda subito a GitHub.

1. Se GitHub chiede l'accesso, accedi **con l'account proprietario dell'organizzazione**.
2. Compare la pagina *Register new GitHub App* con tutti i campi già compilati (nome
   `Rocket Sync <organizzazione>`, permessi, indirizzo del webhook, indirizzo di ritorno). **Non
   cambiare nulla** e premi il pulsante verde **Create GitHub App for <organizzazione>**.
3. GitHub ti riporta a una pagina che dice che l'app è stata creata: puoi chiudere la scheda e
   tornare al terminale. Il configuratore ha ricevuto le credenziali e prosegue da solo.

Se il nome `Rocket Sync <organizzazione>` fosse già usato, GitHub lo segnala nella stessa pagina:
cambia il nome in quel campo e prosegui.

Se il browser non si apre da solo, il terminale stampa l'indirizzo da incollare. Hai 15 minuti.

## 6. Le due cose da fare a mano su GitHub

Alla fine del passo 2 il configuratore apre due pagine e **aspetta che tu le abbia completate**
(poi premi Invio nel terminale). GitHub non permette di farle in automatico.

**a) Togliere la spunta «Expire user authorization tokens».**
Pagina: *impostazioni dell'app* (`https://github.com/organizations/<org>/settings/apps/<nome-app>`).
Cerca la casella **Expire user authorization tokens** (nelle sezioni *Optional features* o
*Identifying and authorizing users*, a seconda della versione dell'interfaccia di GitHub),
**toglila** e premi **Save changes**. Senza scadenza dei token Git continua a funzionare anche se
Supabase fosse irraggiungibile (motivazione in [sicurezza.md](sicurezza.md) §7).

**b) Installare l'app sull'organizzazione.**
Pagina: `https://github.com/apps/<nome-app>/installations/new`. Scegli la tua organizzazione,
poi **All repositories** (l'app deve poter agire sui repository che crea) e **Install**. Se GitHub
chiede di autorizzare l'app mentre la installi, conferma.

> Dopo l'installazione il browser può finire su una pagina d'errore tipo
> `localhost:3000/?error=invalid_request&error_code=bad_oauth_callback&error_description=OAuth+state+parameter+missing`.
> È **innocua**: l'app è installata comunque e puoi chiudere la scheda. L'accesso con GitHub
> avviene dall'app, non durante l'installazione (per questo la richiesta di autorizzazione
> all'installazione è disattivata).

## 7. Le variabili di GitHub Actions

A fine esecuzione il configuratore stampa tre valori **pubblici**:

```
SUPABASE_URL      = https://<ref>.supabase.co
SUPABASE_ANON_KEY = eyJ...
PROJECTS_ORG      = <organizzazione>
```

(La chiave `anon` è pubblica per progetto: la sicurezza sta nelle policy del database. La chiave
`service_role` non viene mai mostrata.)

Vanno inseriti come **variabili** (non segreti) nel repository del codice: *Settings → Secrets
and variables → Actions → Variables → New repository variable*. Servono alla build dell'app
([installazione.md](installazione.md) §8.2).

Se sul tuo PC è installata la GitHub CLI (`gh`) e hai fatto `gh auth login`, il configuratore
ti propone di impostarle lui con `gh variable set`: lo fa **solo dopo la tua conferma**, e solo
queste tre. In caso contrario inseriscile a mano.

Restano da impostare, perché non dipendono dal backend, `RELEASES_REPO`, `UPDATER_PUBKEY` e i
segreti di firma: vedi [installazione.md](installazione.md) §8.2.

## 8. Rilanciare, rifare, controllare

- **Rilanciare** il comando è sicuro. L'app non viene ricreata se i segreti `GITHUB_APP_*` esistono
  già su Supabase; le migrazioni già applicate vengono saltate (sono annotate nella tabella
  `supabase_migrations.schema_migrations`, la stessa della CLI di Supabase, quindi anche
  `supabase db push` le riconosce); Vault e segreti vengono aggiornati con gli stessi valori.
- **Rifare l'app da zero** (per esempio hai cancellato l'app su GitHub o hai perso il client
  secret): `node scripts/setup/setup-backend.mjs --nuova-app`. Prima elimina la vecchia app da
  *Settings → Developer settings → GitHub Apps* dell'organizzazione, altrimenti il nome è occupato.
- **Altre opzioni**: `--senza-deploy` (non pubblica le funzioni), `--senza-browser` (stampa gli
  indirizzi invece di aprirli), `--si` (risponde sì alle conferme, per l'uso non interattivo).
- **Controllo finale**: nel pannello Supabase, *Edge Functions* deve elencarne 7
  (`accept-invitations`, `create-project`, `discord-dispatch`, `discord-settings`,
  `github-token-refresh`, `github-webhook`, `manage-members`); *Table Editor* deve mostrare le
  tabelle (`projects`, `versions`, …); *Authentication → Providers* deve avere GitHub attivo.

## 9. Se qualcosa va storto

Il configuratore traduce gli errori in frasi chiare e dice come proseguire. I casi più comuni:

| Messaggio | Cosa fare |
|---|---|
| «L'access token di Supabase non è valido o è scaduto» | Genera un nuovo token (§2, punto 5) e rilancia. |
| «Supabase non ha trovato la risorsa richiesta … Controlla il ref del progetto» | Controlla le 20 lettere, o incolla l'indirizzo del pannello; il token deve appartenere all'account che possiede il progetto. |
| «Il progetto Supabase non è utilizzabile (stato …)» | Il progetto è in pausa o in creazione: ripristinalo dal pannello e rilancia. |
| «Supabase ha limitato le richieste (troppe in poco tempo)» | Aspetta un minuto e rilancia: il configuratore riprova da solo qualche volta prima di arrendersi. |
| «GitHub ha annullato la creazione dell'app» o «Tempo scaduto» | Rilancia e premi *Create GitHub App* entro 15 minuti. |
| «GitHub non riconosce il codice di creazione dell'app: è scaduto … o è già stato usato» | Rilancia con `--nuova-app` (se l'app è stata creata a metà, eliminala prima da GitHub). |
| «La migrazione … non è riuscita» | Ogni migrazione è una transazione: nulla di mezzo è rimasto. Leggi il dettaglio SQL stampato, correggi e rilancia: riparte da quella. |
| «La pubblicazione delle Edge Functions non è riuscita» | Controlla la connessione e che `npx` funzioni (`npx --version`); rilancia: i passi già fatti vengono saltati. |
| «Non trovo le chiavi API "anon" e "service_role"» | Il progetto usa solo le nuove chiavi: attiva le *Legacy API keys* da *Project Settings → API Keys* e rilancia. |

Per i problemi dopo la configurazione (webhook, Discord, accesso dall'app) vedi
[runbook-recupero.md](runbook-recupero.md) e [`supabase/README.md`](../supabase/README.md).

## 10. Procedura manuale (in alternativa)

Se non puoi o non vuoi usare il configuratore, ogni passo si può fare a mano seguendo
[`supabase/README.md`](../supabase/README.md): §1 (progetto e accesso con GitHub), §2 (migrazioni
con `supabase db push` e Vault), §3 (registrazione manuale della GitHub App e segreti), §4
(pubblicazione delle funzioni). Il risultato è lo stesso. Le variabili di Actions sono nel §7 di
questa guida.
