# Rocket Sync V2 — "Rocket Sync AI Assistant"

> **Stato:** roadmap, **non da implementare ora**. La V1 non contiene codice di IA: contiene solo i
> punti di aggancio descritti nel §4. Riferimenti: [`piano-v1.md`](piano-v1.md) §9,
> [`modello-dati.md`](modello-dati.md), [`contratto-ipc.md`](contratto-ipc.md),
> [`protocollo-sync.md`](protocollo-sync.md).

## 1. Obiettivo

Un assistente che **legge** il lavoro del team (versioni, file `.ork`, note, documentazione) e aiuta a
tenerlo in ordine: trova incongruenze, riassume, propone azioni. Parla italiano.

Principi, validi per tutta la V2:

1. **L'IA analizza, spiega e suggerisce. Non modifica niente da sola.** Ogni azione passa da una
   proposta che una persona approva (§5).
2. **Ogni risultato dice quanto è sicuro**: *verificato*, *ipotesi* o *incerto*, con le prove (§5.3).
3. **Mai inventare.** Se i dati non bastano, l'IA lo dice. Il fact-checking usa solo le fonti che il
   team ha fornito.
4. **Il team decide dove gira.** Fornitore cloud o modello locale, scelto da chi amministra (§3).
5. **Git e la Version History restano la fonte di verità.** L'IA non scrive mai sullo storico.

## 2. Capacità previste

| # | Capacità | Cosa fa | Dati che legge |
|---|---|---|---|
| 1 | **Etichette per le card** | Propone categoria, priorità e parole chiave per una nota. | Titolo e descrizione della card, categorie del progetto. |
| 2 | **Organizzazione della documentazione** | Propone come raggruppare, rinominare e collegare note e documenti; segnala duplicati. | Card, commenti, allegati di testo, elenco dei file. |
| 3 | **Analisi dello storico** | Racconta come si è evoluto il progetto: quali parametri sono cambiati più spesso, quando, da chi. | Version History, changelog, diff semantico. |
| 4 | **Contraddizioni tra versioni** | Trova decisioni annullate senza spiegazione (per esempio pinne cambiate e poi ripristinate) o valori che tornano indietro. | Versioni e diff dei `.ork`, titoli e descrizioni. |
| 5 | **Confronto documentazione / file** | Verifica che ciò che è scritto nelle note coincida con il file (massa dichiarata, diametro, motore). | Note e documenti, modello semantico del `.ork`. |
| 6 | **Fact-checking su fonti fornite** | Controlla un'affermazione sulle sole fonti caricate dal team (schede tecniche, manuali) e cita il passaggio. | Fonti indicate dall'utente, nessuna ricerca aperta sul web. |
| 7 | **Incoerenze** | Segnala dati incompatibili tra loro (simulazione con un motore che non è nella configurazione, paracadute che si apre sopra l'apogeo). | Modello semantico del `.ork`, risultati delle simulazioni. |
| 8 | **Riassunti** | Riassume una versione, un intervallo di versioni, un conflitto o una discussione di commenti. | Changelog, commenti, conflitti. |
| 9 | **Azioni suggerite** | Dal risultato di un'analisi propone cosa fare: creare un'attività, assegnarla, aprire un confronto, ripristinare un file. | Gli output delle altre capacità. |
| 10 | **Report** | Prepara un report periodico (settimana, lancio) in testo, con versioni, problemi aperti, decisioni e dubbi. | Tutto quanto sopra. |

Le capacità 1, 8 e 10 sono le più semplici e le prime da rilasciare. Le 4, 5 e 7 dipendono dalla
qualità del modello semantico di `rs-ork` (§4).

## 3. Architettura proposta

### 3.1 Dove gira

L'IA **gira sul PC dell'"AI admin"** (la persona indicata in `projects.ai_admin_id`), dentro il core
Rust, non su un server nostro:

```
PC dell'AI admin
┌───────────────────────────────────────────────────────────────┐
│ Interfaccia (React)  ──IPC──►  Core Rust                      │
│  - pannello "Assistente"        - rs-ai (nuovo crate)         │
│  - lista proposte               - rs-ork (modello semantico)  │
│                                 - rs-core (eventi, storico)   │
│                                 - Credential Manager (chiavi) │
└──────────────┬────────────────────────────┬───────────────────┘
               │ Supabase (proposte, log)   │ fornitore di IA
               ▼                            ▼
   ai_suggestions, notifiche        OmniRoute (cloud)  oppure
   private, activity_log            Qwen 27B locale (OpenAI-compatibile)
```

Perché sul client e non in una Edge Function:

- Il core ha già accesso ai file, alla cartella di lavoro e a `rs-ork`. Sul server non c'è niente di tutto questo.
- Le **chiavi dell'IA restano solo su quel PC**: non passano da Supabase né dall'interfaccia degli altri.
- Un modello locale non ha bisogno di rete. È una scelta coerente con "Git funziona anche senza Supabase".

Gli altri membri **non eseguono l'IA**: vedono le proposte e le approvano o rifiutano dall'interfaccia, in
tempo reale, come ora vedono le card.

### 3.2 Fornitore selezionabile

Un'interfaccia unica nel nuovo crate `rs-ai`, con due implementazioni:

```rust
pub trait AiProvider: Send + Sync {
    /// Una richiesta strutturata: sistema, contesto, schema JSON atteso. Risposta già validata.
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError>;
    fn describe(&self) -> ProviderInfo; // nome, modello, locale/cloud (mostrato all'utente)
}
```

| Fornitore | Configurazione | Note |
|---|---|---|
| **OmniRoute** (cloud) | URL, **chiave API**, **modello** configurabili. | Cloud: vale la regola privacy del §6. |
| **Qwen 27B locale** | **Endpoint compatibile OpenAI** (per esempio `http://127.0.0.1:…/v1`) e nome del modello. | Nessun dato esce dal PC. Serve una macchina adeguata. |

Dettagli comuni:

- Entrambi parlano lo stesso protocollo (chat completions compatibile OpenAI), quindi la differenza è
  solo l'URL, il modello e la presenza della chiave.
- Le risposte sono **JSON con schema fisso** (§5): se il modello non lo rispetta, la richiesta si
  ripete una volta, poi fallisce con un errore chiaro. Mai testo libero che diventa un'azione.
- **Chiavi in Windows Credential Manager**, con lo stesso `SecretStore` che oggi custodisce la sessione
  (`apps/desktop/src-tauri/src/secrets.rs`, servizio `it.rocketsync.app`). Non finiscono in
  `localStorage`, nei log, nella diagnostica né in Supabase.
- Impostazioni del fornitore **per PC**, non per progetto. Il progetto sa solo *chi* è l'AI admin.
- Un limite configurabile di richieste e di contesto per ogni analisi, e un pulsante **Annulla**.

### 3.3 Cosa gira dove

| Parte | Dove | Perché |
|---|---|---|
| Raccolta del contesto (versioni, diff, note) | Core Rust dell'AI admin | Ha i file e `rs-ork`. |
| Chiamata al modello | Core Rust dell'AI admin | Le chiavi non escono dal PC. |
| Proposte, stato, approvazioni | Supabase (`ai_suggestions`) | Tutti i membri le vedono e le votano. |
| Esecuzione di una proposta approvata | Il PC di chi approva, con i comandi di sempre | Pubblicare, ripristinare, creare una card sono già comandi del core o scritture su Supabase con RLS. |

## 4. Punti di aggancio già presenti nella V1

La V1 non contiene IA, ma questi elementi esistono già e la V2 li riusa senza cambiare il modello.

| Aggancio | Dove | Cosa ci farà la V2 |
|---|---|---|
| **`projects.ai_admin_id`** | `supabase/migrations/…_tables.sql` (colonna `uuid` verso `profiles`, "riservato alla V2"). Modificabile solo dagli admin: è nel grant di update su `projects`. | Indica quale PC esegue l'IA. Nessuna migrazione per questo. |
| **Eventi `ai.*` riservati** | `public.event_types`: la tabella ha già il commento "I tipi ai.* (AI admin) sono riservati alla V2"; `modello-dati.md` §3 elenca `ai.*` come audience `private`, solo AI admin, nessun Discord. | La V2 aggiunge righe a `event_types` (per esempio `ai.suggestion_created`, `ai.analysis_failed`) senza toccare il resto. |
| **Notifiche private** | `private.emit_event_core` e `emit_event_server`: gli eventi con `audience = 'private'` arrivano solo ai destinatari indicati. | Avvisano l'AI admin ("analisi pronta", "errore del fornitore") senza disturbare il team. |
| **`emit_event` dal client** | RPC `public.emit_event(p_project_id, p_type, p_payload, p_recipients)`: solo tipi con `client_allowed`. | Il core dell'AI admin registra gli eventi `ai.*` con questa RPC (autore = AI admin). |
| **`rs-ork`: modello semantico** | `crates/rs-ork/src/lib.rs`: `parse(bytes) -> OrkDocument`, `diff(path, before, after) -> OrkDiff`, `three_way(path, base, mine, theirs) -> OrkThreeWay`, `normalized_xml`; `model.rs` per componenti, parametri con unità, configurazioni, simulazioni e parti "non interpretate". | Fornisce all'IA fatti strutturati ("diametro 98 mm, massa 85 g") invece di XML grezzo. L'IA non deve mai interpretare lo ZIP. |
| **Eventi del core** | `crates/rs-core/src/events.rs`, `EngineEvent` (`VersionPublished`, `UpdateApplied`, `ConflictDetected`, `ConflictResolved`…) e, lato interfaccia, gli eventi di `contratto-ipc.md` §6. | L'agente si iscrive a questi eventi per reagire ("nuova versione → controlla le incoerenze") senza polling. |
| **Estensioni del core** | `crates/rs-core/src/hooks.rs`: `FileInspector` e `EditorDetector` come trait iniettabili. | `rs-ai` si aggancia allo stesso modo, senza che `rs-core` dipenda dall'IA. |
| **Storico di sola lettura** | Comandi `list_versions`, `get_version`, `compare_versions` del contratto IPC. | Contesto di sola lettura dell'IA: nessun comando di scrittura le viene concesso. |
| **`DataService`** | `apps/desktop/src/lib/data/types.ts`: interfaccia unica per Supabase, con `supabaseData` e `mockData`. | Si aggiungono `listSuggestions`, `decideSuggestion`, ecc. e la loro versione mock, per sviluppare e testare l'interfaccia senza modello. |
| **Mock completo** | `apps/desktop/src/lib/mock/` e `e2e/`. | La V2 si sviluppa e si prova con proposte finte, senza chiavi né modelli. |
| **Realtime** | Pubblicazione `supabase_realtime` su `cards`, `activity_log`, `notifications`… | Aggiungendo `ai_suggestions` le proposte compaiono subito a tutti. |

Dove la V1 non basta e la V2 dovrà **aggiungere**: il crate `rs-ai`, la tabella `ai_suggestions`, le
righe `ai.*` in `event_types`, i comandi `ai_*` del contratto IPC, e un pannello "Assistente" nell'interfaccia.

## 5. Modello "proposta → approvazione"

### 5.1 Flusso

```
evento o richiesta ──► l'IA raccoglie il contesto (sola lettura)
                         │
                         ▼
                 chiama il fornitore, riceve JSON validato
                         │
                         ▼
        ai_suggestions: stato = proposed, con evidenze e fonti
                         │  notifica privata all'AI admin / avviso nel pannello
                         ▼
        una persona approva, modifica o rifiuta
                         │
          approved ──► si esegue l'azione con i comandi normali ──► applied / failed
          rejected ──► si chiude, resta nel log
```

### 5.2 Regole non negoziabili

1. **Nessuna modifica a file importanti senza approvazione esplicita.** Sono "importanti": qualunque
   file del progetto (in particolare i `.ork`), le versioni, i ruoli e i membri, le impostazioni del
   progetto e di Discord, l'eliminazione di card. L'IA non ha comandi che li scrivano.
2. **Le azioni a basso rischio** (creare una card, mettere un'etichetta, scrivere un commento) possono
   essere pre-approvate per tipo, **solo da un amministratore**, e restano sempre annullabili e registrate.
3. Chi approva è sempre una persona. L'IA non può approvare le proprie proposte (vincolo nel database).
4. Ripristinare, pubblicare o unire file passa dai comandi del core, con le copie di sicurezza di sempre
   (`protocollo-sync.md` §8). L'IA non può chiamarli direttamente.
5. Ogni proposta, approvazione, rifiuto ed esecuzione finisce nell'**Activity Log**.
6. Un'analisi non verificabile non diventa mai un'azione: resta "ipotesi" o "incerto" e non si può
   applicare con un clic.

### 5.3 Classificazione dei risultati

| Classe | Significato | Cosa serve |
|---|---|---|
| **Verificato** | Il dato è nei file o nelle fonti e si può ricontrollare. | Almeno una evidenza con riferimento preciso (versione, file, parametro, passaggio di una fonte). Spesso è un confronto deterministico di `rs-ork`, non un'opinione del modello. |
| **Ipotesi** | Spiegazione plausibile, ma non provata. | Le evidenze a favore e ciò che mancherebbe per verificarla. |
| **Incerto** | Il modello non ha abbastanza elementi. | Lo dichiara e indica cosa servirebbe. Non si può trasformare in azione. |

La classe la **assegna il codice**, non il modello: un risultato è "verificato" solo se le evidenze
citate vengono ritrovate davvero nei dati (versione e parametro esistono e hanno quel valore, il
passaggio citato è nella fonte). Altrimenti scende a "ipotesi" o "incerto".

### 5.4 Schema dati proposto

Tabella `public.ai_suggestions` (nuova migrazione, RLS attiva come tutte le altre):

```sql
create type public.ai_suggestion_status
  as enum ('proposed', 'approved', 'rejected', 'applied', 'failed', 'expired');
create type public.ai_confidence as enum ('verified', 'hypothesis', 'uncertain');
create type public.ai_capability as enum (
  'card_labels', 'doc_organization', 'history_analysis', 'version_contradictions',
  'doc_vs_file', 'fact_check', 'inconsistencies', 'summary', 'suggested_actions', 'report');

create table public.ai_suggestions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  capability      public.ai_capability not null,
  title           text not null check (char_length(title) between 1 and 200),
  summary         text not null,                      -- spiegazione in italiano
  confidence      public.ai_confidence not null,      -- assegnata dal codice, non dal modello
  status          public.ai_suggestion_status not null default 'proposed',
  action          jsonb,                              -- azione proposta, vedi sotto (null = solo informativa)
  evidence        jsonb not null default '[]',        -- prove ritrovabili
  sources         jsonb not null default '[]',        -- fonti fornite dal team
  context_ref     jsonb not null default '{}',        -- cosa è stato letto (versioni, card, file): riproducibilità
  provider        text not null,                      -- es. "omniroute:<modello>" / "local:qwen-27b"
  created_by      uuid not null references public.profiles (id),  -- l'AI admin che ha eseguito l'analisi
  created_at      timestamptz not null default now(),
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  applied_at      timestamptz,
  result          jsonb,                              -- esito dell'esecuzione o motivo del fallimento
  expires_at      timestamptz,                        -- proposte che perdono senso (nuova versione, file cambiato)
  check (decided_by is null or decided_by <> created_by or capability in ('summary', 'report')),
  check (confidence = 'verified' or action is null or (action ->> 'risk') = 'info')
);
create index ai_suggestions_project_idx on public.ai_suggestions (project_id, status, created_at desc);
```

Forma dei campi JSON (validata sia dal core sia da un trigger):

```jsonc
// evidence: una voce per prova, sempre ritrovabile
{ "kind": "ork_param",  "version": 7, "path": "Razzo.ork",
  "component": "Pinne trapezoidali", "key": "rootchord", "value": "95 mm" }
{ "kind": "card",       "cardId": "…" }
{ "kind": "commit",     "number": 9, "sha": "…" }
{ "kind": "source_quote", "sourceId": "…", "page": 3, "text": "Massa a vuoto 1,2 kg" }

// sources: documenti forniti dal team (mai ricerche aperte)
{ "id": "…", "title": "Scheda motore J350W", "attachmentId": "…", "sha256": "…" }

// action: cosa succede se approvata
{ "type": "create_card",   "risk": "low",  "params": { "title": "…", "categoryId": "…", "priority": "high" } }
{ "type": "label_card",    "risk": "low",  "params": { "cardId": "…", "categoryId": "…", "priority": "medium" } }
{ "type": "add_comment",   "risk": "low",  "params": { "cardId": "…", "body": "…" } }
{ "type": "open_compare",  "risk": "info", "params": { "fromVersion": 5, "toVersion": 9 } }
{ "type": "restore_file",  "risk": "high", "params": { "version": 5, "path": "Razzo.ork" } }  // sempre con approvazione esplicita
```

Policy RLS in breve:

| Operazione | Chi |
|---|---|
| `select` | Membri del progetto. |
| `insert` | Solo l'AI admin del progetto (`projects.ai_admin_id = auth.uid()`), sempre con `status = 'proposed'`. |
| `update` (stato, nota) | Membri, ma solo `proposed → approved/rejected` e solo i campi `status`, `decided_*`, `decision_note`. Mai su proposte con `risk = 'high'` se non sono admin del progetto. |
| `update` (esito) | Solo chi ha approvato, con `approved → applied/failed`. |
| `delete` | Nessuno (le proposte restano nel log). |

Le righe di `event_types` da aggiungere: `ai.suggestion_created` (private, AI admin), `ai.suggestion_decided`
(project, info), `ai.analysis_failed` (private, AI admin), tutte `discord_default = false`.

## 6. Privacy

Con un **modello locale** nulla esce dal PC dell'AI admin.

Con un **fornitore cloud** (OmniRoute) il fornitore riceve il **contesto della singola richiesta**:

| Cosa viene inviato | Cosa **non** viene mai inviato |
|---|---|
| Testo delle card e dei commenti coinvolti nell'analisi. | Chiavi, token GitHub, sessione Supabase, webhook Discord. |
| Il **modello semantico** estratto dal `.ork` (componenti, parametri, risultati delle simulazioni), non il file. | Il file `.ork` in sé, gli allegati binari, i file fuori dall'analisi. |
| Il changelog e i diff delle versioni richieste. | Indirizzi email (l'app usa l'indirizzo noreply di GitHub), percorsi assoluti del PC. |
| Estratti delle fonti indicate dal team, solo per il fact-checking. | Il resto del progetto e gli altri progetti. |

Regole:

- **Opt-in per progetto**, deciso da un amministratore. Di default l'IA è spenta.
- Prima della prima richiesta verso un fornitore cloud l'app mostra **cosa verrà inviato**, in italiano,
  e chiede conferma. È sempre visibile nel pannello quale fornitore è attivo e se è locale o cloud.
- **Anteprima del contesto** per ogni analisi, con un limite di dimensione, e un registro locale di ciò che
  è stato inviato (data, fornitore, dimensione), senza il contenuto.
- Rimozione dei dati sensibili prima dell'invio: token, URL con segreti, percorsi locali.
- Il contesto inviato viene tagliato alle sole parti necessarie (per esempio i parametri cambiati, non
  tutto il modello).
- Nessun addestramento: si richiede o si sceglie un fornitore che non usi i dati per addestrare.
- `ai_suggestions.context_ref` conserva **riferimenti** (versione, card), non copie dei contenuti.
- La diagnostica esportata non contiene mai chiavi né contesti.

## 7. Fasi di rilascio

| Fase | Contenuto | Esito verificabile |
|---|---|---|
| **V2.0 — Fondamenta** | Crate `rs-ai` con `AiProvider` e i due fornitori; impostazioni e chiavi in Credential Manager; migrazione con `ai_suggestions`, enum e righe `ai.*`; comandi IPC `ai_*`; pannello "Assistente" (vuoto ma funzionante); `mockData` e mock del fornitore. | Si configura un fornitore, si fa una richiesta di prova e si salva una proposta finta, approvata e rifiutata, con tutti i test RLS. |
| **V2.1 — Sola lettura e testo** | Capacità **1 (etichette)**, **8 (riassunti)** e **10 (report)**. Solo azioni a basso rischio (`label_card`, `add_comment`, `create_card`). | Le proposte hanno evidenze e classificazione. Mai un'azione senza approvazione. |
| **V2.2 — Storico e file** | **3 (storico)**, **4 (contraddizioni)**, **7 (incoerenze)** su `rs-ork`, con controlli deterministici e il modello per spiegarli. | Una contraddizione risulta "verificata" solo se le evidenze sono ritrovate. |
| **V2.3 — Documentazione e fonti** | **2 (organizzazione)**, **5 (documentazione vs file)** e **6 (fact-checking)** con caricamento di fonti. | Ogni affermazione cita la fonte; senza fonte resta "incerto". |
| **V2.4 — Azioni** | **9 (azioni suggerite)**: `open_compare` e, con approvazione dell'amministratore, `restore_file`. Pre-approvazione per tipo per le azioni a basso rischio. | Nessuna azione ad alto rischio senza due occhi umani. |
| **V2.5 — Rifinitura** | Valutazione su casi reali del team, costi, tempi, ottimizzazione del contesto, modello locale come predefinito se la qualità basta. | Misure su casi reali, non impressioni. |

Prima di partire con la V2.0 vanno verificati:

1. La qualità del **modello semantico di `rs-ork`** sui file reali del team (la V2.2 ne dipende).
2. Le **prestazioni del Qwen 27B** sul PC dell'AI admin e quanto contesto regge.
3. Le **condizioni del fornitore cloud** (dove vengono trattati i dati, conservazione, addestramento).
4. Che gli amministratori accettino la regola "nessuna modifica senza approvazione", anche per le azioni a basso rischio.

## 8. Cosa **non** è nella V2

- Nessuna unione automatica dei file `.ork` (resta fuori, vedi `piano-v1.md` §4.6).
- Nessuna scrittura diretta dell'IA su file, versioni, membri o impostazioni.
- Nessuna ricerca libera sul web per il fact-checking: solo le fonti caricate dal team.
- Nessun server di IA gestito da noi: ogni team porta il proprio fornitore.
