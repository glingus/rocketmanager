# Rocket Sync — Piano V1

> **Stato:** bozza da approvare · **Data:** 18 novembre 2026
> Documento di pianificazione (Fase 1). Nessun codice è stato ancora scritto.

## Indice

1. [Ambiente di partenza](#0-ambiente-di-partenza)
2. [Architettura](#1-architettura)
3. [Struttura del repository](#2-struttura-del-repository)
4. [Sfide tecniche principali](#3-sfide-tecniche-principali)
5. [Sincronizzazione e conflitti](#4-sincronizzazione-e-conflitti)
6. [Dati condivisi (Supabase)](#5-dati-condivisi-supabase)
7. [Installazione](#6-installazione)
8. [Fasi di sviluppo](#7-fasi-di-sviluppo)
9. [Direzione visiva](#8-direzione-visiva)
10. [Predisposizione per la V2 (IA)](#9-predisposizione-per-la-v2-ia)
11. [Decisioni da approvare](#10-decisioni-da-approvare)
12. [Informazioni necessarie](#11-informazioni-necessarie)

---

## 0. Ambiente di partenza

Ho controllato l'ambiente prima di scrivere il piano:

- Il repository `glingus/rocketmanager` è vuoto, senza nessun commit.
- Il container di sviluppo è Linux e ha Node 22, pnpm, Rust 1.97, Docker e Java.

**Cosa ne consegue:**

- Qui posso sviluppare e testare il core, il backend Supabase (in locale con Docker) e i test multi-utente.
- Le build Windows vanno fatte su GitHub Actions, con runner Windows.
- Il test di installazione su un Windows pulito richiede un PC reale del team.

---

## 1. Architettura

```
┌──────────────────────── PC Windows (×4) ─────────────────────────┐
│  Rocket Sync (Tauri 2)                                           │
│  ┌── WebView2: React + TypeScript (UI in italiano) ──┐           │
│  │   supabase-js (chiave pubblica + sessione utente) │◄─Realtime/REST─► Supabase
│  └────────────── IPC tipizzato ──────────────────────┘           │     Auth · Postgres+RLS · Realtime
│  Core Rust: watcher · motore sync · git · parser .ork · journal  │     Storage · Edge Functions ──► Discord
│        │  Git incluso nell'app (MinGit)                          │            ▲ webhook "push"
│  Cartella progetto (.ork) + .git   ◄──── HTTPS git ────►  GitHub: org privata, 1 repo per progetto
│  SQLite locale (stato, journal, cache) · Credential Manager      │     (GitHub App "Rocket Sync")
└──────────────────────────────────────────────────────────────────┘
```

### Tre posti, ognuno con un compito

| Dove | Cosa contiene | È la fonte di verità per |
|---|---|---|
| PC (cartella e clone Git) | File `.ork`, allegati, storico completo | Il lavoro in corso, anche offline |
| GitHub (1 repo privato per progetto) | Storico delle versioni | Le versioni, in modo permanente |
| Supabase | Profili, progetti, membri, note e task, log, notifiche, indice delle versioni | La collaborazione |

Git deve funzionare anche se Supabase è irraggiungibile. Senza Supabase restano consultabili solo le note in cache, in sola lettura.

### Scelte tecniche

**Interfaccia: Tauri 2 + React + TypeScript + Vite**

- TanStack Query per i dati del server, Zustand per lo stato dell'interfaccia.
- I tipi delle chiamate tra interfaccia e core vengono generati dal codice Rust, così le due parti non possono andare fuori sincrono.
- Lo stile usa CSS moderno con variabili e CSS Modules, non Tailwind. Il tema Cherry Wood è fatto di texture, gradienti metallici e ombre, che si gestiscono meglio con token dedicati.

**Core in Rust**

- È diviso in moduli testabili anche senza interfaccia: Git, sincronizzazione, watcher, parser `.ork`, archivio locale.

**Git incluso nell'app (MinGit, la versione portatile ufficiale di Git for Windows)**

- Nessun prerequisito da installare.
- Configurazione isolata: le impostazioni Git che l'utente ha già sul PC non interferiscono.
- Ho scartato libgit2 e gitoxide: sono meno collaudati su Windows, e il push di gitoxide è ancora immaturo.

**Login unico "Accedi con GitHub" tramite Supabase Auth**

- Il token GitHub resta solo nel core Rust e in Windows Credential Manager. L'interfaccia non lo vede mai.

**GitHub App installata su un'organizzazione GitHub del team**

- I permessi sono limitati ai repo di Rocket Sync.
- Le notifiche push dei repo arrivano a una Edge Function, così le "versioni pubblicate" vengono registrate lato server e non si possono falsificare.
- Creazione dei repo e gestione degli accessi avvengono lato server.

**Comportamento dell'app**

- Resta nella system tray.
- Avvio automatico con Windows (opzionale).
- Una sola istanza alla volta.

**Scartati**

- Electron: più pesante.
- Git LFS: quota di 1 GB e complessità inutile per file piccoli.
- Storico delle versioni dentro Supabase: vietato dal brief.

---

## 2. Struttura del repository

```
rocketmanager/
├── apps/desktop/
│   ├── src/                     React + TS
│   │   ├── app/                 avvio, router, layout
│   │   ├── features/            onboarding, dashboard, project, history, compare,
│   │   │                        conflicts, cards, members, activity, notifications, settings
│   │   ├── ui/                  componenti base (pulsanti, pannelli, spie di stato…)
│   │   ├── theme/               token, texture, font inclusi (funzionano offline)
│   │   ├── i18n/it.ts           tutti i testi italiani in un unico posto
│   │   └── lib/                 client Supabase, chiamate al core generate da Rust
│   └── src-tauri/               shell Tauri: comandi, tray, updater, permessi
├── crates/
│   ├── rs-core/                 motore di sync, watcher, journal, recovery
│   ├── rs-git/                  wrapper sul Git incluso, gestione credenziali
│   ├── rs-ork/                  parser .ork, modello semantico, diff, changelog (+ CLI di debug)
│   └── rs-store/                SQLite locale e migrazioni
├── supabase/
│   ├── migrations/              schema + policy RLS
│   ├── functions/               create-project, manage-members, github-webhook,
│   │                            discord-dispatch, github-token-refresh
│   └── tests/                   test delle policy (isolamento progetti, notifiche private)
├── installer/                   install.cmd / install.ps1, configurazione Windows Sandbox
├── tests/fixtures/ork/          file .ork reali di più versioni di OpenRocket
├── tests/scenarios/             scenari multi-utente A/B, conflitti, ripristino, multi-progetto
├── docs/                        architettura, protocollo sync, formato .ork, sicurezza,
│                                installazione, runbook di recupero, roadmap-v2
└── .github/workflows/           CI (Linux + Windows), release firmata + manifest aggiornamenti
```

### Struttura di ogni cartella progetto

La cartella predefinita è `C:\Users\<utente>\RocketSync\<Progetto>` e non sta sotto OneDrive. Su Windows 11 la cartella Documenti è spesso sincronizzata da OneDrive, e OneDrive insieme a Git rischia di corrompere il repository.

```
Experimental Rocket\
├── .git\                     (nascosta)
├── .gitattributes            *.ork binario: Git non tenta mai di fonderli da solo
├── .gitignore                file temporanei, Thumbs.db, desktop.ini…
├── .rocketsync\project.json  id progetto, versione dello schema
└── Experimental Rocket.ork   + qualsiasi altro file del progetto
```

### Uso di Git in ogni repo progetto

- Un solo branch, `main`.
- Un tag `vN` per ogni versione.
- Branch temporanei `conflitti/<id>` per mettere al sicuro le versioni in conflitto.
- Ref nascosti, solo locali, per le copie di sicurezza.

### Formato del messaggio di commit (in italiano)

```
v13 — Aggiornate pinne e paracadute

Razzo.ork
• Pinne trapezoidali: numero 3 → 4; corda alla radice 80 → 95 mm
• Aggiunto: Paracadute principale (Ø 900 mm)
• Simulazione "Volo nominale": apogeo 812 → 845 m

Rocket-Sync-Version: 13
Rocket-Sync-Kind: publish | restore | conflict-resolution
```

Il changelog vive dentro Git per sempre. Supabase ne tiene solo un indice, che si può ricostruire in qualsiasi momento.

---

## 3. Sfide tecniche principali

| Rischio | Mitigazione |
|---|---|
| **I `.ork` sono compressi.** Secondo la versione possono essere ZIP, GZIP o XML semplice, quindi i diff testuali e il merge di Git sono inutili. | Il parser riconosce il formato dai primi byte del file. Diff semantico sul contenuto XML. Va verificato su file reali del team. |
| **OpenRocket non blocca i file e non li ricarica se cambiano.** Se un collega ti aggiorna il file mentre lo hai aperto e poi salvi, cancelli il suo lavoro senza accorgertene. | Nessun aggiornamento automatico dei file aperti in OpenRocket. In più una "guardia editor non aggiornato" (vedi §4.4). |
| **Capire quando OpenRocket ha finito di scrivere.** | Attesa di 2 secondi senza nuovi eventi, poi dimensione e data stabili, poi apertura esclusiva riuscita, poi file valido (archivio leggibile e XML corretto). Un file parziale non viene mai incluso in una versione. |
| **Due persone pubblicano nello stesso momento.** | Push ottimistico con nuovo tentativo. Il push del branch e del tag è atomico, quindi due versioni non possono avere lo stesso numero. |
| **Stranezze di Windows:** antivirus che blocca i file, OneDrive, percorsi lunghi, maiuscole e minuscole, CRLF. | Nuovi tentativi automatici, supporto ai percorsi lunghi, conversione CRLF disattivata, avviso se la cartella è dentro OneDrive, Dropbox o Google Drive. |
| **Team con versioni diverse di OpenRocket.** Diff rumorosi e problemi di compatibilità. | Mostro la versione di OpenRocket che ha salvato ogni file e avviso se nel team ce ne sono più di una. |
| **GitHub Free non permette di proteggere i branch dei repo privati.** | L'app non fa mai force-push: è un vincolo nel codice coperto da un test. Ogni clone contiene comunque tutto lo storico. |
| **Dimensione dei repo.** Ogni versione di un `.ork` viene salvata per intero; GitHub rifiuta file oltre 100 MB. | Avviso sopra i 50 MB, blocco sopra i 100 MB, dimensione del repo visibile nelle Impostazioni. Consiglio di salvare in OpenRocket solo i dati principali delle simulazioni. |
| **Il login unico deve servire sia per Supabase sia per Git.** | È il primo spike della Fase 1. Se non funziona, il ripiego è un'app OAuth classica di GitHub. |
| **Supabase Free si sospende dopo 7 giorni senza attività.** | L'app gestisce il backend irraggiungibile senza bloccarsi, e Git continua a funzionare. |
| **Build e test su Windows partendo da un ambiente Linux.** | GitHub Actions con runner Windows. Il test pulito si fa su Windows Sandbox con un PC del team. |

---

## 4. Sincronizzazione e conflitti

### 4.1 Stati di un progetto

| Stato | Significato |
|---|---|
| Sincronizzato | Cartella locale identica all'ultima versione pubblicata |
| Modifiche non pubblicate | Ci sono salvataggi locali non ancora diventati versione |
| Pubblicazione in corso | Commit e invio a GitHub in corso |
| Aggiornamento disponibile | Un collega ha pubblicato una versione nuova |
| Conflitto | Due persone hanno modificato lo stesso file |
| Offline (N versioni in attesa) | Le versioni create offline aspettano la connessione |
| Errore | Problema da risolvere, con l'azione suggerita |

Ogni stato ha un'icona e un testo, non solo un colore. Per ogni progetto le operazioni Git girano una alla volta, in coda.

### 4.2 Quando nasce una versione

Rocket Sync **non crea una versione a ogni salvataggio**. I salvataggi si accumulano come "modifiche non pubblicate" e la versione nasce al momento della pubblicazione.

La politica si sceglie per progetto:

- **Assistita (consigliata):** un banner con il pulsante "Pubblica" e una descrizione facoltativa. Pubblicazione automatica dopo 10 minuti senza nuovi salvataggi.
- **Solo manuale.**
- **A ogni salvataggio**, con un intervallo minimo tra una versione e l'altra.

All'uscita dall'app viene chiesto se pubblicare le modifiche ancora aperte.

### 4.3 Pubblicazione

1. Tutti i file modificati devono essere stabili e validi.
2. Copia di sicurezza completa, nuovi file compresi, in un ref nascosto. I file dell'utente non vengono toccati.
3. Scarico le novità dal server (fetch).
4. Poi, a seconda di cosa è cambiato sul server:
   - **Nessuna novità sul server:** creo il commit (autore reale, changelog generato) e lo invio insieme al tag `vN` in un'unica operazione.
   - **Il server ha novità su file diversi dai miei:** costruisco il mio commit, che non è ancora mai stato pubblicato, sopra l'ultima versione, ricalcolo il numero e lo invio.
   - **Il server ha novità sullo stesso file:** è un conflitto (§4.5).
5. Se l'invio viene rifiutato perché un collega ha pubblicato nel frattempo, ricomincio dal punto 3, al massimo 3 volte.
6. **Offline:** creo una versione locale "in attesa di invio". Il numero definitivo le viene assegnato alla riconnessione.

Il webhook di GitHub registra la versione in Supabase e fa partire la notifica, per esempio:

> *15:22 — Simone ha pubblicato la versione 5 di Experimental Rocket*

### 4.4 Ricezione degli aggiornamenti

- **Cosa fa partire il controllo:** l'evento in tempo reale "nuova versione", un controllo ogni 60 secondi e l'avvio dell'app.
- **Aggiornamento automatico** (con un avviso "Aggiornato alla v13 (Luca)") solo se l'utente non ha modifiche su quei file e i file non sono aperti in OpenRocket. Per capirlo leggo i titoli delle finestre di OpenRocket; come compaiono i nomi dei file nei titoli va verificato.
- **Se il file è aperto in OpenRocket:** "Aggiornamento disponibile: chiudi Razzo.ork in OpenRocket e premi Aggiorna".
- **Guardia "editor non aggiornato":** se un file viene aggiornato mentre OpenRocket è aperto e poi l'utente salva, confronto il file salvato con la versione vecchia e con quella nuova. Se il salvataggio parte dalla versione vecchia, lo tratto come conflitto e non come una modifica normale. Così il lavoro di Luca non viene annullato in silenzio.
- **Se l'utente ha modifiche sullo stesso file arrivato dal server:** segnalo subito il conflitto a entrambi, prima che si accumuli altro lavoro.

### 4.5 Conflitti

1. **Metto al sicuro:** faccio un commit con le modifiche locali e lo invio subito sul branch `conflitti/<id>` su GitHub. Le due versioni sono al sicuro anche se il PC si rompe.
2. Il file dell'utente resta intatto nella cartella. La versione del collega si può aprire come copia.
3. Registro il conflitto in Supabase e mando una notifica critica a tutti, anche su Discord.
4. **Schermata di risoluzione:** confronto semantico a tre colonne (versione di partenza / la mia / la sua). Distingue le modifiche che si sovrappongono (stesso componente o parametro) da quelle indipendenti. Le scelte sono:
   - **Tieni la mia**
   - **Tieni la sua**
   - **Tieni entrambe**, come due file separati
   - **Unisci a mano in OpenRocket:** apro la copia, l'utente lavora e salva, poi preme "Ho finito".
5. **Risultato:** un merge commit con due genitori. Entrambe le storie restano nel repo per sempre. Nasce una nuova versione di tipo "Risoluzione conflitto" e parte la notifica "conflitto risolto".
6. I file di testo vengono fusi automaticamente da Git quando la fusione è pulita.

### 4.6 Merge automatico dei `.ork`: per ora no

In teoria si possono fondere da sole modifiche fatte su componenti diversi. In V1 non lo propongo, per quattro motivi:

- Non so ancora se gli ID dei componenti restano stabili tra versioni di OpenRocket; va verificato.
- Le simulazioni salvate nel file diventerebbero incoerenti con il razzo fuso.
- L'ordine dei componenti ha un significato.
- Un file che OpenRocket non riesce a riaprire è peggio di un conflitto.

In V1 l'app si limita a dire "le modifiche non si sovrappongono, unione semplice". Per una V1.x si può valutare un merge sperimentale, controllato aprendo il risultato con il motore di OpenRocket in Java senza interfaccia.

### 4.7 Ripristino, download e confronto

**Ripristina vN** (tutto il progetto o un solo file)

1. Prima una copia di sicurezza.
2. Poi l'albero dei file torna com'era in vN e viene creato un **nuovo** commit "Ripristinata la versione N".
3. Lo storico resta intatto.

**Scarica vN**

- Esporta i file in una cartella a scelta, oppure li apre in OpenRocket come copia temporanea.
- La cartella di lavoro non viene toccata.

**Confronta due versioni qualsiasi**

- File aggiunti, rimossi, modificati e rinominati.
- Per i `.ork`, un diff semantico.
- Per i file di testo, un diff riga per riga.
- Per gli altri file binari, solo la variazione di dimensione.

### 4.8 Diff semantico e changelog

**Come riconosco i componenti tra due versioni:** per ID se presente, altrimenti per posizione nell'albero, tipo e nome.

**Cosa confronto:**

- Componenti del razzo (stadi, ogive, tubi, pinne, paracadute, masse…) con i loro parametri, convertiti in mm, g e gradi.
- Configurazioni dei motori.
- Condizioni e risultati principali delle simulazioni.

**Cosa non riesco a interpretare:** il blocco "N modifiche non interpretate nella sezione X", con il diff dell'XML grezzo. Non dichiaro mai di aver capito una modifica che il parser non riconosce con certezza.

**Il changelog:** si genera con regole deterministiche, senza IA. La descrizione scritta dall'utente viene messa in cima.

### 4.9 Prenotazioni (lock leggero)

- **Automatiche:** quando un utente ha modifiche non pubblicate, gli altri vedono per esempio "Marco sta modificando Razzo.ork (non pubblicato, dalle 14:05)".
- **Manuali:** "Prenota file", con una nota e una scadenza.
- Se apri un file prenotato da altri ricevi un avviso, ma **non sei mai bloccato**.

### 4.10 Resistenza ai crash

**Journal:** ogni operazione registra in SQLite a che passo è arrivata.

**All'avvio:**

- Pulizia dei lock di Git rimasti.
- Ripresa o annullamento delle operazioni interrotte.
- Invio delle versioni rimaste in attesa.
- Ripristino dei conflitti aperti.

**Regole fisse:**

- Copie di sicurezza conservate per 30 giorni.
- **Mai** un force-push e mai un reset dei file senza copia di sicurezza.
- Pulsante **"Esporta diagnostica"**, con log da cui i token sono rimossi.

---

## 5. Dati condivisi (Supabase)

### 5.1 Tabelle

| Tabella | Contenuto |
|---|---|
| `profiles` | Utente, id e login GitHub, nome, avatar |
| `projects` | Nome, descrizione, repo, impostazioni (politica versioni, retention), `archived_at`, `ai_admin_id` (preparato per V2) |
| `project_members` / `project_invitations` | Ruolo admin o member. Gli inviti sono per username GitHub. |
| `versions` | Indice derivato da Git tramite webhook: numero, sha, autore, data, file, changelog. Si può ricostruire da Git. |
| `conflicts` | File, utenti coinvolti, branch di salvataggio, stato, esito |
| `file_claims` | Chi sta modificando cosa, prenotazioni, segnale di presenza (in tempo reale) |
| `cards` | Titolo (l'unico campo obbligatorio), descrizione, colore, priorità, categoria, stato, autore, assegnatario, scadenza, posizione, versione collegata |
| `card_categories` | Modificabili per progetto; 6 predefinite |
| `card_comments` / `card_attachments` | Commenti; allegati su Storage privato |
| `activity_log` | Evento, autore, importanza, dettagli. Un trigger tiene gli ultimi 100 eventi per progetto. **Non tocca mai Git.** |
| `notifications` | Una riga per destinatario, letta o non letta. Le notifiche private hanno destinatari espliciti. |
| `notification_preferences` | Per utente e tipo di evento: in-app e desktop |
| `discord_targets` | Webhook per progetto, conservato nel Vault e mai leggibile dal client, più i tipi di evento abilitati |

### 5.2 Permessi

- RLS su tutte le tabelle, con tutto negato salvo regole esplicite.
- Il client usa solo la chiave pubblica e la sessione dell'utente.
- Le operazioni privilegiate passano da Edge Functions, che controllano il ruolo lato server: creare un repo, gestire i membri, ricevere il webhook GitHub, inviare su Discord.
- Non si può rimuovere l'ultimo admin di un progetto.

### 5.3 Ruoli

| Ruolo | Può fare |
|---|---|
| **Administrator** | Tutto quello che fa un Member, più: gestione del progetto, membri e ruoli, configurazione del repo, Discord, politica di versione, archiviazione |
| **Member** | Modificare i file, sincronizzare, creare e ripristinare versioni, creare e gestire note e task |

### 5.4 Notifiche: chi le riceve

| Evento | Importanza | Chi lo riceve | Su Discord (predefinito) |
|---|---|---|---|
| Versione pubblicata / ripristinata | Importante | Tutti | Sì |
| Conflitto rilevato / risolto | Critico / Importante | Tutti | Sì |
| Membro aggiunto o rimosso | Importante | Tutti | Sì |
| Card con priorità Alta o Critica, o categoria Problema | Importante | Tutti | Sì |
| Card assegnata | Info | Solo l'assegnatario | No |
| Card completata, nota modificata | Info | In-app e log | No |
| Inizio modifica di un file (uno per sessione) | Info | Solo log | No |
| Errore di sync sul mio PC | Importante | Solo io | No |
| (V2) Eventi dell'IA | — | Solo l'AI admin | No |

**Discord**

- I messaggi sono in italiano, con l'ora di Roma.
- Una raffica di eventi in 2 minuti diventa un solo messaggio.
- In caso di errore il messaggio viene reinviato più volte.

**Interfaccia delle notifiche**

- Una striscia "Novità" che scorre in orizzontale sulla dashboard.
- Una campanella con il numero di notifiche non lette.
- Lo storico delle notifiche, con filtri.

### 5.5 Notes & Tasks

- Aggiunta rapida: scrivi il titolo, premi Invio, e la card è creata.
- Il pulsante "Trasforma in attività" fa comparire assegnatario, scadenza e priorità.
- Colore e priorità sono indipendenti.
- Due viste: bacheca libera e colonne per stato.
- Filtri a chip.
- Offline le note sono in sola lettura.

---

## 6. Installazione

### 6.1 Un solo comando CMD

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<host-release>/install.ps1 | iex"
```

Lo script fa questi passi:

1. Controlla Windows 10/11 a 64 bit, lo spazio su disco e la connessione (proxy e TLS compresi).
2. Installa il runtime WebView2 se manca.
3. Scarica l'installer e ne verifica l'hash SHA-256.
4. Installa l'app **per l'utente corrente**, senza diritti di amministratore.
5. Crea i collegamenti sul desktop e nel menu Start.
6. Avvia la configurazione guidata.
7. Scrive un log in `%TEMP%`, con messaggi di errore in italiano.

### 6.2 Prerequisiti

- Git è incluso nell'app.
- Il runtime C++ è incorporato nell'eseguibile, quindi non va installato a parte.
- Node e Java non servono.
- OpenRocket viene solo rilevato; se manca, l'app mostra il link per scaricarlo.

### 6.3 Primo avvio

1. Controllo dell'ambiente.
2. Accesso con GitHub.
3. Profilo.
4. Scelta dei progetti da tenere su questo PC, creazione di un progetto nuovo o importazione di una cartella esistente.
5. Cartella locale.
6. Prima sincronizzazione con barra di avanzamento. Se la cartella contiene già dei file, non ne sovrascrivo nessuno.
7. Preferenze: avvio con Windows, notifiche, politica di versione.

Da lì in poi l'app si apre dal collegamento sul desktop, senza CMD.

### 6.4 Aggiornamenti

- L'app controlla all'avvio e ogni 6 ore.
- Gli aggiornamenti sono firmati e si installano con "Installa e riavvia", mai durante una sincronizzazione.
- La pipeline di release parte da un tag su GitHub Actions.

### 6.5 Test su Windows pulito

- Preparo una configurazione di Windows Sandbox e una checklist.
- Un membro del team la esegue su un PC con Windows Pro e mi manda il log.
- In CI aggiungo un test automatico di installazione e un comando di autodiagnosi (`--self-test`).
- Dall'ambiente cloud di sviluppo non posso far girare Windows. Per questo non dichiarerò l'installer completo finché il test reale non passa.

---

## 7. Fasi di sviluppo

| Fase | Cosa si fa | Quando è finita |
|---|---|---|
| **1. Architettura e spike** | Documenti in `docs/` (architettura, protocollo di sync, schema dati, sicurezza, roadmap V2) e quattro prove brevi (vedi sotto). | Decisioni confermate, rischi chiusi o mitigati |
| **2. Core funzionante** | Monorepo e CI; moduli Rust (Git, sync, watcher, parser e diff, journal); schema base su Supabase, creazione progetto, webhook GitHub; schermate di configurazione, dashboard, progetto, Version History, confronto, ripristino, download, conflitti. | Scenari di sync, conflitto, ripristino e multi-progetto verdi in CI (Linux + Windows), con due utenti simulati su un remoto locale, più un test reale su GitHub |
| **3. Collaborazione** | Membri e ruoli, Notes & Tasks completo, pipeline di notifiche, Novità, notifiche desktop, Discord, Activity Log con retention, prenotazioni. | Test sulle policy di Supabase, test delle notifiche private, test Discord con webhook simulato e reale |
| **4. Rifinitura visiva** | Tema Cherry Wood Workshop (§8), stati vuoti, messaggi di errore, accessibilità, revisione dei testi italiani. | La tua approvazione su screenshot dell'app vera |
| **5. Test e rilascio** | Tutti i test richiesti (§7.2), installazione pulita, una settimana di prova con i 4 utenti su un progetto di test, rilascio 1.0. | Tutti i test passano, con gli output registrati |

### 7.1 Spike della Fase 1

1. **Login unico:** accesso GitHub/Supabase con un token valido anche per Git.
2. **Formato `.ork` su file reali:** ID dei componenti, modo in cui salva OpenRocket, titoli delle finestre.
3. **Git incluso e credenziali** su un runner Windows.
4. **Installer** per utente, aggiornamenti e WebView2.

### 7.2 Test richiesti e come li eseguo

| Area | Scenari | Come |
|---|---|---|
| Sincronizzazione | A crea una versione → B la riceve → B modifica → A riceve | Automatico in CI: due cloni e un remoto locale, più un test reale su GitHub |
| Conflitti | Due utenti modificano lo stesso file; entrambe le versioni recuperabili; conflitto rilevato; nulla scartato | Automatico in CI |
| Ripristino | Ripristino di una versione vecchia; nuovo commit creato; storico intatto | Automatico in CI (conteggio commit e raggiungibilità delle versioni precedenti) |
| Multi-progetto | Più progetti; repo indipendenti; note e log non trapelano tra progetti | Automatico in CI + test pgTAP sulle policy RLS |
| Notifiche | Notifiche condivise, preferenze private, Discord | Test su Supabase locale, webhook Discord simulato + webhook reale di prova |
| Installazione | Windows pulito, prerequisiti, collegamento sul desktop, login GitHub, sync dopo l'installazione | Windows Sandbox su un PC del team con checklist + smoke test in CI |

---

## 8. Direzione visiva

**Dove va il legno e dove no**

- Legno di ciliegio solo su barra laterale, intestazioni, fascia delle card progetto e cornice dei pannelli selezionati. Noce scuro per gli accenti.
- Le aree con molti dati (tabelle, diff, log, form) hanno superfici pulite color "carta tecnica" calda, ad alto contrasto.

**Metallo e spie di stato**

- Metallo spazzolato per pulsanti, interruttori e separatori.
- Ottone per lo stato attivo.
- Spie di stato come quelle di un banco da officina: verde sincronizzato, ambra modifiche, rosso conflitto, grigio-blu offline.

**Caratteri**

- Titoli in un font condensato industriale (Barlow o Saira).
- Testo in IBM Plex Sans, dati tecnici in IBM Plex Mono.
- Tutti inclusi nell'app, così funzionano offline.

**Texture e animazioni**

- 2 o 3 texture leggere, al massimo 150 KB l'una.
- Transizioni di 150–250 ms, che rispettano l'impostazione "riduci animazioni" di Windows.

**Regola generale:** dove la decorazione disturba la lettura, vince la leggibilità.

**Lingua:** tutta l'interfaccia è in italiano. Restano in inglese i termini convenzionali (Version History, Activity Log, Notes & Tasks).

---

## 9. Predisposizione per la V2 (IA)

Nella V1 non scrivo codice di IA: preparo solo i punti di aggancio.

- Eventi di dominio tipizzati, gli stessi del log, a cui l'agente potrà iscriversi.
- Un'interfaccia di sola lettura sul contesto del progetto (modello semantico dei `.ork`, storico, note), che riusa il parser della V1.
- Uno schema documentato "proposta, poi approvazione" per i suggerimenti dell'IA: l'IA analizza, spiega e suggerisce, ma non modifica nulla senza approvazione.
- Fornitore di IA selezionabile tra:
  - **OmniRoute:** cloud, con chiave API e modello configurabile.
  - **Qwen 27B in locale:** endpoint locale configurabile, nessuna dipendenza dal cloud.
- Le chiavi dell'IA stanno solo sul PC dell'AI admin.
- Il campo `ai_admin_id` e le notifiche private esistono già nella V1.
- Ogni risultato dell'IA sarà etichettato come verificato, ipotesi o incerto.

La roadmap dettagliata andrà in `docs/roadmap-v2.md`.

---

## 10. Decisioni da approvare

1. **Organizzazione GitHub dedicata e GitHub App "Rocket Sync"** (consigliato). Servono account GitHub per tutti e quattro. L'organizzazione è gratuita, e la GitHub App si crea con un click partendo da un file di configurazione che preparo io.
2. **Accesso solo con GitHub** (consigliato): un unico login per tutto, senza password separate.
3. **Git incluso nell'app (MinGit) invece di libgit2** (consigliato).
4. **Politica di versione predefinita: assistita, con pubblicazione automatica dopo 10 minuti di inattività.** Va bene come valore iniziale?
5. **Nessun merge automatico dei `.ork` in V1**, solo risoluzione assistita (consigliato).
6. **Prenotazioni solo consultive, mai bloccanti** (consigliato).
7. **Dove pubblicare installer e aggiornamenti.** Da un repo privato non si scarica con un solo comando senza credenziali. In più, su un repo privato ogni minuto dei runner Windows di Actions vale il doppio, sui 2000 minuti gratuiti al mese. Ci sono due opzioni:
   - Rendere pubblico `rocketmanager`. Il codice non conterrà segreti.
   - Creare un repo pubblico separato solo per le release.
8. **Firma del codice.** V1 senza firma, con possibili avvisi di SmartScreen o dell'antivirus, oppure un certificato a pagamento. Consiglio di partire senza.
9. **Piano Supabase.** Free va bene per partire: si sospende dopo 7 giorni senza uso, ma Git continua a funzionare. Pro costa 25 $ al mese.
10. **Discord con webhook** (uno per progetto, oppure un unico canale del team). Nessun bot nella V1.

---

## 11. Informazioni necessarie

- Username GitHub dei 4 membri, e conferma di chi è admin e AI admin.
- Versione di OpenRocket usata (meglio se la stessa per tutti) e 3–5 file `.ork` reali, idealmente due versioni dello stesso razzo.
- Versioni di Windows sui 4 PC (10 o 11, Home o Pro), e se qualcuno ha OneDrive con il backup di Documenti attivo.
- Chi crea l'organizzazione GitHub, il progetto Supabase e il webhook Discord. Sono passaggi da fare con i propri account; verrà fornita una guida passo passo.
