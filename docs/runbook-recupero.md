# Rocket Sync — runbook di recupero

> Per chi **aiuta un collega in difficoltà**. Prima la calma: in Rocket Sync quasi nulla si perde davvero. Ogni versione
> pubblicata è su GitHub, ogni operazione rischiosa crea una **copia di sicurezza** locale, e l'app non fa mai `--force`.
> Riferimenti: [`protocollo-sync.md`](protocollo-sync.md), [`sicurezza.md`](sicurezza.md), [`guida-utente.md`](guida-utente.md).
>
> Tutti i comandi di questo documento sono stati provati su un repository di prova con lo stesso schema di ref dell'app
> (nomi presi da `crates/rs-core/src/project/*.rs`). **Quelli indicati come "sola lettura" non modificano niente.**

## 1. Dove sta cosa sul PC

| Cosa | Dove (Windows) |
|---|---|
| Programma | `%LOCALAPPDATA%\Programs\Rocket Sync\` (installazione per utente) |
| Git incluso (MinGit) | `%LOCALAPPDATA%\Programs\Rocket Sync\resources\mingit\cmd\git.exe` |
| **Cartella dati dell'app** | `%APPDATA%\it.rocketsync.app\` |
| Database locale (progetti collegati, journal, conflitti, guardia) | `%APPDATA%\it.rocketsync.app\rocketsync.db` |
| Configurazione (URL Supabase, chiave pubblica, organizzazione, updater) | `%APPDATA%\it.rocketsync.app\config.json` (facoltativo, prevale sulla compilazione) |
| Configurazione Git dell'app | `%APPDATA%\it.rocketsync.app\gitconfig` |
| **Log** | `%APPDATA%\it.rocketsync.app\logs\rocketsync.log` (si ruota in `rocketsync.old.log` oltre 5 MB; i token sono oscurati) |
| **Diagnostiche esportate** | `%APPDATA%\it.rocketsync.app\diagnostics\rocketsync-diagnostica-AAAAMMGG-HHMMSS.zip` |
| Cartella del progetto (la sceglie l'utente; proposta: `C:\Users\<utente>\RocketSync\<Progetto>`) | contiene i file `.ork`, la cartella nascosta **`.git`**, `.rocketsync\project.json` |
| Copie dei file in conflitto | `<cartella progetto>\.rocketsync\local\conflitti\<id>\…` |
| Copie temporanee di una versione ("Apri copia") | `<cartella progetto>\.rocketsync\local\versioni\` |
| Copie di sicurezza | **dentro `.git`** della cartella progetto, ref `refs/rocketsync/safety/<unix-ms>-<operazione>` |
| Token GitHub e sessione | Windows **Credential Manager**, servizio `it.rocketsync.app` (non si recuperano a mano: si accede di nuovo) |

Per aprire la cartella dati: `Win+R` → `%APPDATA%\it.rocketsync.app`.

Nel terminale, per brevità negli esempi:

```bat
set GIT="%LOCALAPPDATA%\Programs\Rocket Sync\resources\mingit\cmd\git.exe"
cd /d "C:\Users\<utente>\RocketSync\<Progetto>"
```

Regola d'oro: usate da riga di comando **solo** `for-each-ref`, `log`, `show`, `ls-tree`, `ls-remote`, `archive`, `fetch`.
Mai `reset`, `checkout`, `clean`, `push`, `gc`, `prune` o `rm` sul repository: potrebbero togliere proprio quello che si vuole salvare.
Digitate i comandi direttamente nel **Prompt dei comandi** (non in un file `.bat`: i simboli `%` e `^` hanno un significato speciale; per questo `<sha>^2` sta tra virgolette).
Se compare un errore su `index.lock`, chiudete l'app e riprovate (l'app rimuove da sola i lock più vecchi di 60 secondi all'avvio).

## 2. Il primo passo: raccogliere le informazioni

1. In **Impostazioni → Aggiornamenti** annotate la versione di Rocket Sync, di Git e di OpenRocket.
2. Aprite il progetto: la **Panoramica** mostra la spia di stato e l'eventuale messaggio di errore. Fotografate lo schermo.
3. **Esportate la diagnostica** (§3) e conservatela.
4. Chiedete cosa stava facendo la persona e se OpenRocket era aperto.

## 3. Esportare la diagnostica

**Dall'app**: *Impostazioni → Diagnostica → Esporta diagnostica*. L'app mostra il percorso del file creato, di solito in
`%APPDATA%\it.rocketsync.app\diagnostics\`.

L'archivio contiene (tutto con i segreti oscurati da `redact`):

- `info.json`: versione app, sistema, versione di Git e di OpenRocket, configurazione (con la chiave pubblica `***`), impostazioni, eventuale errore del motore;
- `log/rocketsync.log`: gli ultimi 2 MB di log;
- `git-commands.txt`: gli ultimi 2000 comandi Git eseguiti, con codice di uscita, durata ed errore;
- per ogni progetto, in `projects/<id>/`: `project.json`, `status.json`, `journal.json` (ultime 200 operazioni), `versions.json` (ultime 50), `conflicts.json`, `snapshots.json`.

Se l'app **non parte**, da prompt:

```bat
"%LOCALAPPDATA%\Programs\Rocket Sync\Rocket Sync.exe" --self-test %USERPROFILE%\Desktop\selftest.json
```

crea un controllo dell'installazione. In questo caso mandate anche `%APPDATA%\it.rocketsync.app\logs\rocketsync.log`.

## 4. Recuperare un file

### 4.1 Dall'app (la strada normale)

| Voglio… | Come |
|---|---|
| Un file com'era in una **versione pubblicata** | *Version History* → scegli la versione → **Scarica** (in una cartella a scelta) oppure **Apri copia** (copia temporanea in `.rocketsync\local\versioni\`). La cartella di lavoro non viene toccata. |
| Tornare a una versione vecchia nel progetto | *Version History* → **Ripristina** (tutto o un solo file). Crea una nuova versione; non cancella niente. Prima pubblicate o scartate le modifiche non pubblicate sugli stessi file. |
| Quello che c'era **prima di un'operazione** (pubblicazione, aggiornamento, ripristino, scarto, risoluzione di un conflitto) | *Panoramica* → riquadro **Copie di sicurezza** → **Esporta** accanto alla copia giusta, scegliendo una cartella vuota. Contiene tutti i file di quel momento. |
| La **mia** versione o quella del collega in un conflitto | Nella schermata del conflitto: **Apri la loro copia in OpenRocket** (e "Apri la versione di partenza"). I file finiscono in `<progetto>\.rocketsync\local\conflitti\<id>\`, con nomi come `Razzo (versione dei colleghi).ork`, `Razzo (versione di partenza).ork`, `Razzo (la mia versione).ork`. |

Le copie di sicurezza si conservano **30 giorni, fino a 50 per progetto**: dopo, le più vecchie si cancellano da sole.

### 4.2 Da riga di comando (emergenza, anche con l'app chiusa)

Posizionatevi nella cartella del progetto (vedi §1). Tutti i comandi sotto sono in sola lettura sul repository e scrivono solo il file di destinazione.

**Elencare le copie di sicurezza** (la più recente per ultima):

```bat
%GIT% for-each-ref refs/rocketsync/safety/ --sort=creatordate --format="%(refname) %(creatordate:iso)"
```

Il nome è `refs/rocketsync/safety/<unix-ms>-<operazione>`; le operazioni sono `pubblicazione`, `aggiornamento`, `ripristino`, `scarto`, `risoluzione`,
`conflitto`, `recupero` e `salvataggio-sospetto`.

**Estrarre l'intera copia di sicurezza in uno zip** (senza toccare la cartella di lavoro):

```bat
%GIT% archive --format=zip -o "%USERPROFILE%\Desktop\copia-sicurezza.zip" refs/rocketsync/safety/<unix-ms>-<operazione>
```

Poi estraete lo zip in una cartella a parte e prendete i file che servono. Per un solo file: aggiungete il percorso in fondo, per esempio
`... refs/rocketsync/safety/<…> "Razzo.ork"`.

**Estrarre una versione pubblicata** (il tag `vN` esiste per ogni versione):

```bat
%GIT% archive --format=zip -o "%USERPROFILE%\Desktop\v5.zip" v5
```

**Vedere la storia** del progetto:

```bat
%GIT% log --first-parent --format="%h %ad %an  %s" --date=short main
```

**Versioni create sul PC ma non ancora inviate** ("in attesa"):

```bat
%GIT% log --format="%h %s" origin/main..main
```

Per estrarne una: `%GIT% archive --format=zip -o "%USERPROFILE%\Desktop\attesa.zip" <sha>`.

> Non usate `>` per scrivere un `.ork` da `git show`: nel prompt può rovinare i file binari. Usate sempre `git archive`.

### 4.3 Un conflitto: la "mia" versione e quella dei colleghi

Quando nasce un conflitto, il core mette la versione locale al sicuro sul server in `refs/heads/conflitti/<id>` (`<id>` è del tipo
`20261118-abc123`). Quando il conflitto si risolve, quel ramo remoto viene **cancellato**, ma le due storie restano nel **commit di risoluzione**
(tipo `conflictResolution`, trailer `Rocket-Sync-Conflict: <id>`), che ha due genitori: il primo è la versione dei colleghi, il secondo è la mia.

- **Conflitto ancora aperto**, prendere la mia versione dal server (serve l'accesso: vedi §4.4):

  ```bat
  %GIT% fetch origin refs/heads/conflitti/<id>:refs/rocketsync/recupero/<id>
  %GIT% archive --format=zip -o "%USERPROFILE%\Desktop\mia-<id>.zip" refs/rocketsync/recupero/<id>
  ```

- **Conflitto già risolto**: trovate il commit di risoluzione e usate i suoi genitori.

  ```bat
  %GIT% log --all --format="%h %s" --grep="Rocket-Sync-Conflict: <id>"
  %GIT% archive --format=zip -o "%USERPROFILE%\Desktop\mia.zip"      "<sha>^2"
  %GIT% archive --format=zip -o "%USERPROFILE%\Desktop\colleghi.zip" "<sha>^1"
  ```

### 4.4 Comandi che parlano con GitHub (`fetch`, `ls-remote`)

Servono le credenziali. L'app le dà a Git facendosi chiamare come **askpass**: nello **stesso prompt** impostate (solo per quella finestra):

```bat
set "GIT_ASKPASS=%LOCALAPPDATA%\Programs\Rocket Sync\Rocket Sync.exe"
set ROCKETSYNC_ASKPASS=1
set GIT_TERMINAL_PROMPT=0
```

L'eseguibile risponde `x-access-token` come utente e il token del Credential Manager come password, poi termina. Funziona solo se la persona
ha fatto l'accesso nell'app e il token non è scaduto (aprite l'app una volta per rinnovarlo). **Non avviate l'app da quel prompt** (si comporterebbe da
askpass) e chiudete la finestra a fine lavoro.

## 5. Il repository locale è danneggiato

Sintomi: la Panoramica mostra "Errore" con messaggi su Git, i comandi nella diagnostica (`git-commands.txt`) falliscono con `fatal:`/`corrupt`/`bad object`,
oppure `%GIT% fsck` segnala errori.

Prima: **non cancellate niente**. Procedura sicura:

1. **Esportate la diagnostica** (§3).
2. **Chiudete l'app** (anche dalla barra delle applicazioni) e **copiate l'intera cartella del progetto**, `.git` compresa, in un luogo sicuro (per esempio uno zip sul Desktop).
3. Provate a salvare comunque quanto serve con i comandi del §4.2 sulla copia: spesso `archive` funziona anche con un repository ferito.
4. Riaprite l'app → progetto → *Impostazioni del progetto* → **Scollega da questo PC**. I file nella cartella **restano**.
5. **Rinominate** la vecchia cartella (per esempio `Razzo-vecchia`).
6. Dalla Dashboard premete **Collega a una cartella** sul progetto e scegliete una **cartella nuova e vuota**: l'app scarica da GitHub tutto lo storico pubblicato.
7. Se nella vecchia cartella c'era lavoro **non pubblicato**, copiate i file `.ork` più recenti nella cartella nuova: compariranno come *Modifiche non pubblicate* e potrete pubblicarle. Le versioni "in attesa" (§4.2) si recuperano dallo zip del punto 3.

Se invece il problema è solo il **database locale** (`rocketsync.db` perso o corrotto) e la cartella del progetto è sana: ricollegate **la stessa cartella**. Se contiene già un
repository con lo stesso indirizzo del progetto, l'app lo **adotta** invece di rifiutarlo (`link.rs`: stesso `remote.origin.url`).
Se l'indirizzo è diverso l'app si rifiuta, per sicurezza: in quel caso procedete con la cartella nuova.

## 6. Un collega ha perso il PC

**Cosa è al sicuro e cosa no**

- Al sicuro, sul server: **tutte le versioni pubblicate** (repository GitHub, tag `vN`), note, card, commenti, allegati, log.
- A rischio: le **modifiche non pubblicate**, le **versioni "in attesa"** non ancora inviate e un conflitto aperto se il ramo `conflitti/<id>` non era stato inviato (nel conflitto compare "al sicuro anche su GitHub" solo se lo è).

**Se il PC è perso o rubato (accesso possibile da terzi)**

1. L'amministratore del progetto: **Membri → Rimuovi dal progetto**. Questo toglie subito i dati (RLS) e l'accesso al repository (`manage-members`). Poi, quando la persona ha un nuovo PC, la reinvita.
2. La persona (o l'amministratore dell'organizzazione): su github.com → *Settings → Applications → Authorized GitHub Apps* → **Revoca** l'autorizzazione di Rocket Sync. Così il token utente smette di funzionare.
3. Nel pannello Supabase → *Authentication → Users*: trovate l'utente e disattivate/eliminate le sue sessioni, secondo le opzioni offerte dal pannello.
4. Se il disco non era cifrato e c'erano chiavi o segreti in chiaro (non dovrebbero: l'app usa Credential Manager), ruotate ciò che serve (vedi `sicurezza.md` §8).

**Nuovo PC**: installate Rocket Sync, accedete con GitHub (come al primo avvio, [`guida-utente.md`](guida-utente.md) §2), scegliete i progetti e le cartelle. L'app scarica lo storico e i file all'ultima versione.
Il lavoro non pubblicato sul vecchio PC non si recupera da qui: se il disco è recuperabile, seguite il §4.2 sulla vecchia cartella.

## 7. Verificare che sul server ci sia tutto

**GitHub (fonte di verità)**. Dal PC di un collega con la cartella del progetto e l'accesso del §4.4:

```bat
%GIT% ls-remote --heads --tags origin
```

Si deve vedere `refs/heads/main` e un tag `refs/tags/vN` per **ogni** versione (numeri consecutivi). Eventuali `refs/heads/conflitti/<id>` sono conflitti ancora aperti.
Per confrontare con il PC: `%GIT% fetch origin` e `%GIT% log --first-parent --oneline origin/main`.

**Indice di Supabase** (`public.versions`, scritto dal webhook). Dal pannello SQL di Supabase:

```sql
select max(number) as ultima, count(*) as righe
from public.versions
where project_id = '<uuid del progetto>';
```

Il numero e il conteggio devono coincidere con i tag `vN` su GitHub. Se **mancano righe** (per esempio perché Supabase era sospeso quando è arrivato il webhook):

- su GitHub → *Settings → Developer settings → GitHub Apps → Rocket Sync → Advanced → Recent deliveries*, ripetete l'invio (**Redeliver**) degli eventi `push` mancanti: il webhook è **idempotente** sullo sha (`insertVersions` ignora i duplicati);
- GitHub conserva le consegne solo per un tempo limitato; oltre, l'indice non si ricostruisce con uno strumento automatico del progetto (oggi non esiste). La Version History dell'app legge comunque lo storico direttamente da Git: la mancanza di righe in `versions` non fa perdere versioni, nasconde solo gli avvisi e le viste che usano l'indice.

**Allegati e note**: stanno solo su Supabase (Postgres e Storage). Controllate le copie di sicurezza di Supabase del vostro piano (di norma i backup giornalieri sono previsti solo nei piani a pagamento: verificate cosa include il vostro).

## 8. Supabase è sospeso (piano Free)

Il piano Free **sospende il progetto dopo 7 giorni senza attività**. Cosa succede:

| Cosa | Effetto |
|---|---|
| Accesso con GitHub, note, card, membri, notifiche, Activity Log | **Non disponibili** finché il progetto non viene ripristinato. L'app lo gestisce senza bloccarsi. |
| File, cartelle, copie di sicurezza, Version History locale | **Funzionano**: sono sul PC. |
| Pubblicare e ricevere versioni (Git ↔ GitHub) | **Funzionano** finché il token GitHub è valido. Il token dura circa 8 ore e si rinnova tramite la Edge Function `github-token-refresh` di Supabase: se non si può rinnovare, dopo la scadenza i push e i fetch verso GitHub falliscono. |
| Versioni create mentre non si può inviare | Restano **in attesa** sul PC e partono da sole appena possibile; i numeri si ricalcolano all'invio. |
| Webhook di GitHub verso `github-webhook` | Non arriva: l'indice `versions` e le notifiche restano indietro (vedi §7 per recuperarle). |

**Cosa fare**

1. Nel pannello Supabase, **ripristinate (Restore/Resume) il progetto**: il pannello dice entro quanto tempo è possibile. Dopo il ripristino riaprite l'app e premete **Controlla novità**.
2. Se il token GitHub è scaduto, fate **Esci** e **Accedi con GitHub** di nuovo (Impostazioni → Account).
3. Controllate le consegne del webhook (§7) e, se servono, rinviatele.
4. Per evitare che succeda: un piano Pro (nessuna sospensione) oppure un'attività regolare sul progetto. Un promemoria nel calendario del team funziona meglio di niente.

> In emergenza, anche **senza Supabase** il lavoro non si ferma: si può continuare a salvare e pubblicare localmente. Quando Supabase (o il token) tornano, tutto si allinea.

## 9. Riepilogo rapido

| Problema | Prima cosa da fare |
|---|---|
| "Ho cancellato/sovrascritto un file" | *Panoramica → Copie di sicurezza → Esporta*, oppure *Version History → Scarica*. |
| "Ho scartato le modifiche per sbaglio" | Esporta la copia di sicurezza con operazione **scarto**. |
| "Il conflitto mi ha fatto perdere il mio" | `.rocketsync\local\conflitti\<id>\` o `conflitti/<id>` sul server (§4.3). |
| "L'app non parte" | `--self-test` (§3), log, reinstallazione (il programma non cancella i dati). |
| "Errore di Git / repository rovinato" | Backup della cartella, scollega, ricollega in una cartella nuova (§5). |
| "Ho perso il PC" | §6. |
| "Non riesco ad accedere" | Supabase sospeso? (§8) |
