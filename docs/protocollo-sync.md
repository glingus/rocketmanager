# Protocollo di sincronizzazione

> Specifica vincolante per `crates/rs-git`, `crates/rs-store` e `crates/rs-core`.
> Riferimento generale: [`piano-v1.md`](piano-v1.md) §4. In caso di dubbio vince la regola
> più conservativa: **non perdere mai dati di nessuno**.

## 1. Termini

| Termine | Significato |
|---|---|
| Progetto | Una cartella locale collegata a un repo GitHub privato (un repo per progetto) |
| Cartella di lavoro | La cartella dove l'utente salva i file con OpenRocket (working tree) |
| Versione pubblicata | Un commit raggiungibile da `origin/main` con numero `N` e tag `vN` |
| Versione in attesa | Un commit in `origin/main..main` (creato localmente, non ancora inviato) |
| Modifiche non pubblicate | Differenze tra cartella di lavoro e `HEAD` (file modificati, aggiunti, rimossi) |
| Copia di sicurezza | Snapshot completo della cartella di lavoro in un ref nascosto locale |

**Regola fondamentale:** pubblicato = raggiungibile da `origin/main`. I numeri scritti dentro le
versioni in attesa sono provvisori e vengono **sempre ricalcolati** subito prima dell'invio.

## 2. Ref e convenzioni Git

| Ref | Dove | Uso |
|---|---|---|
| `refs/heads/main` | locale e remoto | Unico branch pubblicato. Mai force-push. |
| `refs/tags/vN` | locale e remoto | Un tag leggero per ogni versione pubblicata (`N ≥ 1`) |
| `refs/heads/conflitti/<id>` | remoto (e locale) | Versione locale messa al sicuro durante un conflitto |
| `refs/rocketsync/safety/<unix-ms>-<op>` | solo locale | Copie di sicurezza |

- Il commit iniziale del repo (creato dal server alla creazione del progetto) ha
  `Rocket-Sync-Kind: init` e `Rocket-Sync-Version: 0`, senza tag.
- `.gitattributes` del progetto: `*.ork binary` (Git non fonde mai i `.ork`), `* -text`
  (nessuna conversione di fine riga).
- `.gitignore` del progetto (scritto alla creazione):
  ```
  .rocketsync/local/
  *.tmp
  ~$*
  *.swp
  *.bak
  Thumbs.db
  desktop.ini
  .DS_Store
  ```
- `.rocketsync/project.json` (versionato): `{ "projectId": "<uuid>", "schema": 1 }`.
- `.rocketsync/local/` (ignorato): copie di file in conflitto, esportazioni temporanee.

## 3. Formato dei commit

```
v13 — Aggiornate pinne e paracadute

<descrizione facoltativa scritta dall'utente>

Razzo.ork
• Pinne trapezoidali: numero 3 → 4; corda alla radice 80 → 95 mm
• Aggiunto: Paracadute principale (Ø 900 mm)

Rocket-Sync-Version: 13
Rocket-Sync-Kind: publish
Rocket-Sync-Client: 0.1.0
```

- **Oggetto:** `v<N> — <titolo>`; per le versioni in attesa `v? — <titolo>`. Il separatore è
  ` — ` (trattino lungo U+2014 con spazi).
- **Titolo:** quello scritto dall'utente; se assente, generato (es. "Modificato Razzo.ork",
  "Modificati 3 file").
- **Corpo:** descrizione utente (se c'è), poi changelog raggruppato per file (righe che
  iniziano con `• `). File senza interpretazione semantica: `• Modificato (contenuto non interpretato)`.
- **Trailer** (ultimo paragrafo, formato `git interpret-trailers`):

| Trailer | Valori |
|---|---|
| `Rocket-Sync-Version` | numero intero, oppure `pending` |
| `Rocket-Sync-Kind` | `init`, `publish`, `restore`, `conflict-resolution` |
| `Rocket-Sync-Client` | versione dell'app |
| `Rocket-Sync-Restored-From` | numero della versione ripristinata (solo `restore`) |
| `Rocket-Sync-Restored-Paths` | elenco separato da `;` se il ripristino è parziale |
| `Rocket-Sync-Conflict` | id del conflitto (solo `conflict-resolution`) |
| `Rocket-Sync-Resolution` | `percorso=mine\|theirs\|both\|manual;…` (solo `conflict-resolution`) |

- **Autore e committer:** nome visualizzato dell'utente + email noreply GitHub
  (`<id>+<login>@users.noreply.github.com`). Mai l'email reale.
- **Numero della prossima versione:** `max(Rocket-Sync-Version)` lungo la catena first-parent
  di `origin/main` + 1 (si legge il primo commit con trailer numerico risalendo la catena).

## 4. Esecuzione di Git (`rs-git`)

- Percorso del binario `git` configurabile (in produzione: MinGit incluso nell'app; nei test:
  il `git` di sistema). Versione minima richiesta: **2.40** (serve `git merge-tree --write-tree --merge-base`).
- Ogni invocazione usa un ambiente isolato:
  - `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<file di config dell'app>`
  - `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=<programma askpass>` (se configurato), `LC_ALL=C`
  - opzioni `-c core.autocrlf=false -c core.longpaths=true -c core.quotepath=false
    -c core.hooksPath=<cartella vuota> -c credential.helper= -c advice.detachedHead=false`
- Output sempre in formati stabili: `status --porcelain=v2 -z`, `diff --name-status -z -M`,
  `log -z --format=…`, `for-each-ref --format=…`.
- Timeout per comando (default 120 s, fetch/push/clone 600 s) e cancellazione.
- Nuovi tentativi automatici (3, con attesa crescente) per errori transitori: `index.lock`
  presente, file bloccato da antivirus ("Permission denied" / sharing violation), errori di rete.
- Credenziali: il token non compare mai sulla riga di comando, nell'URL del remote o in
  `.git/config`. In produzione l'askpass risponde `x-access-token` come utente e il token come
  password, leggendolo da Windows Credential Manager. `rs-git` espone solo il punto di aggancio
  (percorso askpass + variabili d'ambiente extra); nei test si usano remote `file://`.
- Errori tipizzati: `NotARepository`, `Network`, `AuthFailed`, `NonFastForward`,
  `LockHeld`, `Conflict`, `Timeout`, `Other{stderr}`. Nei log i token sono sempre oscurati.

## 5. Rilevamento delle modifiche (watcher)

1. Il watcher osserva ricorsivamente la cartella di lavoro, esclusi `.git/`,
   `.rocketsync/local/` e i pattern di `.gitignore`.
2. Un file è **stabile** quando:
   - non ci sono stati eventi su di lui per **2 s** (debounce);
   - dimensione e data di modifica sono identiche in **due letture a 500 ms** di distanza;
   - (solo Windows) l'apertura in modalità esclusiva riesce.
3. Un file stabile viene **validato** tramite `FileInspector::validate` (per i `.ork` lo fornisce
   `rs-ork`: archivio leggibile + XML corretto). Un file non valido viene ricontrollato a
   intervalli; dopo 30 s resta segnato "illeggibile" e non può entrare in una versione.
4. Limiti di dimensione: avviso oltre **50 MB**, blocco oltre **100 MB** (limite GitHub).
5. Gli eventi generati da Rocket Sync stesso (aggiornamenti, ripristini) vengono ignorati.

## 6. Stati di un progetto

| Stato (`SyncState`) | Condizione (in ordine di priorità) |
|---|---|
| `error` | ultima operazione fallita in modo non transitorio |
| `conflict` | esiste almeno un conflitto aperto |
| `publishing` / `updating` | operazione in corso |
| `offline` | ultimo fetch fallito per rete e ci sono versioni in attesa |
| `updateAvailable` | `origin/main` è avanti rispetto a `main` |
| `localChanges` | modifiche non pubblicate o versioni in attesa |
| `synced` | nessuna delle precedenti |

Lo stato completo (`ProjectStatus`, vedi [`contratto-ipc.md`](contratto-ipc.md)) include file
modificati, versioni in attesa, file bloccati dall'editor, conflitti aperti, salvataggi sospetti.

## 7. Operazioni

Ogni operazione:
- è eseguita da un **unico worker per progetto**, in coda (mai due operazioni Git in parallelo
  sullo stesso repo);
- è registrata nel **journal** (`rs-store`) con il passo raggiunto;
- crea una **copia di sicurezza** prima di toccare la cartella di lavoro.

### 7.1 Collegamento (clone)

- Cartella vuota: `git clone`.
- Cartella non vuota: clone in una cartella temporanea, poi spostamento di `.git`; per ogni file
  locale che esiste anche nel remoto con contenuto diverso, il file locale viene rinominato in
  `<nome> (copia locale <AAAA-MM-GG>).<ext>` prima di scrivere quello remoto. I file presenti solo
  in locale restano e risultano "modifiche non pubblicate". **Nessun file locale viene perso.**

### 7.2 Controllo novità (fetch)

- Ogni 60 s, all'avvio, su richiesta e quando arriva una notifica in tempo reale.
- Dopo il fetch si calcolano: commit in `main..origin/main` (in arrivo), file cambiati in arrivo,
  sovrapposizione con le modifiche locali (non pubblicate + versioni in attesa).
- Sovrapposizione non vuota → **conflitto** (§7.5), anche se l'utente non sta pubblicando.

### 7.3 Aggiornamento

Precondizioni: nessun conflitto aperto, nessuna sovrapposizione.

1. Si interroga `EditorDetector`. Se qualcuno dei file da scrivere è aperto in OpenRocket (o
   OpenRocket è in esecuzione e non si sa quali file ha aperti) → stato `updateAvailable` con
   `blockedByEditor` valorizzato; **nessun file viene toccato**. L'utente può forzare
   (`force: true`): in quel caso si arma la guardia del §7.8.
2. Copia di sicurezza (se ci sono modifiche locali).
3. Si porta `main` su `origin/main` **materializzando** solo i file cambiati tra i due alberi
   (vedi §7.9). Le modifiche locali su altri file restano intatte.

### 7.4 Pubblicazione

1. Tutti i file da includere devono essere stabili e validi; altrimenti errore esplicito.
2. Copia di sicurezza.
3. Commit locale delle modifiche (tutte, oppure solo i percorsi indicati) con
   `Rocket-Sync-Version: pending` e oggetto `v? — <titolo>` → diventa una **versione in attesa**.
4. **Invio** (anche ripetuto più tardi, es. al ritorno online):
   1. fetch;
   2. se `origin/main` è antenato di `main`: si riscrivono le versioni in attesa (stessi alberi,
      messaggi con il numero definitivo) a partire da `origin/main`;
   3. se `origin/main` è avanti: per ogni versione in attesa, in ordine, si calcola l'albero unito
      con `git merge-tree --write-tree` sopra la nuova base. Se c'è conflitto → §7.5. Altrimenti
      serve aggiornare la cartella di lavoro per i file arrivati dal remoto: si applica la stessa
      guardia editor del §7.3 (se bloccato, la versione resta in attesa con il motivo);
   4. si materializzano i file cambiati (§7.9) e si sposta `main` sulla catena riscritta;
   5. `git push --atomic origin main:refs/heads/main vN:refs/tags/vN …` (tutti i tag nuovi);
   6. push rifiutato (non fast-forward) → si ricomincia da 4.1, al massimo 3 volte;
   7. errore di rete → la versione resta in attesa, stato `offline`.
5. Esito: evento `VersionPublished { number, sha }` per ogni versione inviata.
6. **Vietato:** `--force`, `reset --hard` senza copia di sicurezza, riscrittura di commit già
   raggiungibili da `origin/main`.

### 7.5 Conflitto

Si verifica quando lo stesso percorso è cambiato sia in arrivo sia in locale (modificato da
entrambi, aggiunto da entrambi con contenuto diverso, modificato da una parte e cancellato
dall'altra). Due versioni identiche dello stesso file **non** sono un conflitto. I file di testo
che `merge-tree` fonde senza conflitti non sono un conflitto.

1. Le modifiche non pubblicate vengono incluse in una versione in attesa
   (titolo "Modifiche locali in conflitto").
2. Si genera un id (`<AAAAMMGG>-<6 caratteri casuali>`) e si invia `main` locale su
   `refs/heads/conflitti/<id>` (push normale). Se offline, si ritenta appena possibile
   (`remoteBranchPushed: false` finché non riesce).
3. Si registra il conflitto in `rs-store`: base (merge-base), `ours` (main locale),
   `theirs` (origin/main), elenco file con tipo, data, stato `open`.
4. La cartella di lavoro **non viene toccata**. Le versioni `base` e `theirs` di ogni file si
   possono esportare in `.rocketsync/local/conflitti/<id>/` per aprirle in OpenRocket.
5. Finché il conflitto è aperto la pubblicazione è bloccata per tutto il progetto; i fetch
   continuano.
6. **Risoluzione** (per ogni file una scelta):
   - `mine`: contenuto da `ours`;
   - `theirs`: contenuto da `theirs`;
   - `both`: `theirs` resta al suo percorso, `ours` viene salvato come
     `<nome> - versione <utente> <AAAA-MM-GG>.<ext>`;
   - `manual`: il contenuto attuale del file nella cartella di lavoro (l'utente ha unito a mano
     in OpenRocket); deve essere stabile e valido.

   Si costruisce l'albero finale (risultato di `merge-tree` per i file non in conflitto + scelte),
   si crea un **merge commit con due genitori** `[theirs, ours]`
   (`Rocket-Sync-Kind: conflict-resolution`), si materializza (§7.9, con guardia editor),
   si invia come al §7.4.4 (con nuovo tentativo se `origin/main` è avanzato ancora: in quel caso
   si ricalcola, e se compare un nuovo conflitto si apre un nuovo conflitto).
   Dopo l'invio riuscito si cancella il branch remoto `conflitti/<id>` (il merge commit lo rende
   comunque raggiungibile) e il conflitto passa a `resolved`.

### 7.6 Ripristino

- Precondizioni: nessun conflitto aperto, progetto aggiornato (se `origin/main` è avanti prima si
  aggiorna), nessuna modifica non pubblicata sui file interessati (altrimenti errore che chiede di
  pubblicare o scartare).
- Albero: quello della versione `vN` (ripristino completo) oppure l'albero attuale con i soli
  percorsi indicati presi da `vN` (rimossi se in `vN` non esistevano).
- Nuovo commit (`Rocket-Sync-Kind: restore`, `Rocket-Sync-Restored-From: N`), materializzazione
  con guardia editor, invio come al §7.4.4. **Lo storico non viene mai riscritto.**

### 7.7 Lettura dello storico, confronto, esportazione

- **Storico:** `git log --first-parent origin/main` + versioni in attesa; per ogni commit: trailer,
  autore, data, file cambiati rispetto al primo genitore (`--name-status -M`).
- **Confronto** tra due versioni qualsiasi: elenco file aggiunti/rimossi/modificati/rinominati e,
  per ciascuno, i byte delle due parti (per il diff semantico di `rs-ork` o il diff testuale).
- **Esportazione:** scrive i file di una versione in una cartella indicata, senza toccare la
  cartella di lavoro; i percorsi vengono validati (nessun `..`, nessun percorso assoluto).
- **Scarto delle modifiche locali:** sempre preceduto da una copia di sicurezza.

### 7.8 Guardia "editor non aggiornato"

- Quando Rocket Sync scrive un file mentre `EditorDetector` dice che OpenRocket è in esecuzione
  (con quel file aperto, o con file sconosciuti), registra una sorveglianza
  `{ path, oldBlob, newBlob, version, writtenAt }`.
- La sorveglianza si chiude da sola se OpenRocket viene chiuso dopo la scrittura.
- Se arriva un salvataggio stabile di quel file mentre la sorveglianza è attiva, il file passa in
  `staleSaveSuspected` e non può essere pubblicato finché l'utente non risponde:
  - "Ho riaperto il file prima di modificarlo" → sorveglianza chiusa, modifica normale;
  - "No / non so" → si apre un conflitto con base = versione precedente all'aggiornamento,
    `ours` = file salvato, `theirs` = versione scritta da Rocket Sync.

### 7.9 Materializzazione

Funzione unica usata da aggiornamento, invio, ripristino e risoluzione:

- input: albero di partenza, albero di arrivo, insieme dei percorsi per cui è ammesso che il file
  su disco sia diverso dall'albero di partenza (solo il caso `manual`);
- per ogni percorso diverso tra i due alberi: verifica che il file su disco coincida con l'albero
  di partenza (altrimenti **si ferma senza scrivere nulla**); poi scrive (o cancella) il file;
- aggiorna indice e ref in modo che `git status` risulti pulito per quei percorsi;
- registra i percorsi scritti, per ignorare i relativi eventi del watcher e per la guardia §7.8.

## 8. Copie di sicurezza

- Si creano con un indice temporaneo (`GIT_INDEX_FILE`): `add -A` (inclusi file nuovi non
  ignorati) → `write-tree` → `commit-tree -p HEAD` → `update-ref refs/rocketsync/safety/…`.
  Non toccano la cartella di lavoro né l'indice reale.
- Conservazione: 30 giorni, massimo 50 per progetto (le più vecchie si eliminano).
- Si possono elencare ed esportare in una cartella.

## 9. Journal e recupero dopo crash

Tabella `journal` in `rs-store`: `op_id`, `project_id`, `kind`, `step`, `payload` (JSON),
`started_at`, `updated_at`, `finished_at`, `outcome`.

All'avvio, per ogni progetto:
1. `.git/index.lock` più vecchio di 60 s e nessun processo Git nostro attivo → rimosso.
2. Stati Git a metà (`MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`) →
   annullati (Rocket Sync non li usa mai: sono residui).
3. Operazioni nel journal non concluse:
   - invio interrotto → le versioni in attesa verranno inviate al prossimo giro;
   - materializzazione interrotta → si confronta la cartella con l'albero di arrivo e si
     completa, oppure si ripristina dalla copia di sicurezza;
   - conflitto senza branch remoto → si ritenta il push del branch.
4. Ogni recupero viene registrato nel journal (`outcome = recovered`) e mostrato all'utente.

## 10. Punti di aggancio (trait) di `rs-core`

`rs-core` non dipende da `rs-ork` né da Tauri. Riceve dall'esterno:

```rust
/// Validazione e changelog per tipo di file (rs-ork fornisce l'implementazione per i .ork).
pub trait FileInspector: Send + Sync {
    /// Ok se il file è completo e leggibile; Err(motivo in italiano) se parziale o corrotto.
    fn validate(&self, path: &str, bytes: &[u8]) -> Result<(), String>;
    /// Righe di changelog in italiano (senza il prefisso "• ").
    fn changelog(&self, path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> Vec<String>;
}

/// Rilevamento dei file aperti in OpenRocket (implementazione Windows reale, mock nei test).
pub trait EditorDetector: Send + Sync {
    fn state(&self, project_root: &std::path::Path) -> EditorState;
}

pub enum EditorState {
    NotRunning,
    /// `open_files` = None se OpenRocket è in esecuzione ma non si sa quali file ha aperti.
    Running { open_files: Option<Vec<std::path::PathBuf>> },
}
```

Un `FileInspector` di default (senza `rs-ork`) valida tutto e genera righe generiche
("Modificato", "Aggiunto", "Rimosso").

## 11. Eventi emessi

`StatusChanged`, `OperationProgress { op, step, percent? }`, `VersionPublished { number, sha }`,
`UpdateApplied { fromVersion, toVersion, files }`, `ConflictDetected { id, files }`,
`ConflictResolved { id, number }`, `StaleSaveSuspected { path }`, `RecoveryPerformed { opId, summary }`,
`SyncError { error }`. La forma JSON è definita in [`contratto-ipc.md`](contratto-ipc.md).

## 12. Test obbligatori (in `crates/rs-core/tests/`)

Ogni scenario usa un remoto bare locale (`file://`) e due o più cloni in cartelle temporanee
(utente A e utente B), con un `EditorDetector` simulato:

1. A pubblica → B riceve; B modifica e pubblica → A riceve.
2. A e B modificano lo stesso `.ork` → conflitto rilevato per entrambi i percorsi possibili
   (al fetch e al push); entrambe le versioni recuperabili (branch `conflitti/<id>` sul remoto);
   nessun file cambiato su disco; risoluzione `mine`, `theirs`, `both`, `manual` → merge commit
   con due genitori, storico intatto.
3. A e B modificano file diversi nello stesso momento → nessun conflitto, entrambi pubblicati,
   numeri di versione consecutivi e unici.
4. Ripristino di una versione vecchia → nuovo commit, numero nuovo, commit precedenti ancora
   raggiungibili, contenuto identico alla versione ripristinata.
5. Aggiornamento bloccato da file aperto in OpenRocket; forzatura + salvataggio sospetto →
   conflitto invece di sovrascrittura.
6. Offline: pubblicazione locale, remoto irraggiungibile, poi raggiungibile → invio con numero
   ricalcolato.
7. Crash simulato a metà materializzazione e a metà invio → recupero all'avvio senza perdita.
8. Due progetti indipendenti → nessuna interferenza tra repo, journal e stati.
9. File parziale (ZIP troncato) → non entra in nessuna versione.
10. Nessun comando eseguito contiene `--force` (verifica sul log dei comandi).
