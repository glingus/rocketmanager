# Contratto IPC (interfaccia ↔ core)

> Specifica vincolante per l'interfaccia (`apps/desktop/src`) e per la shell Tauri
> (`apps/desktop/src-tauri`). I comandi si invocano con `invoke(nome, args)`; gli eventi si
> ascoltano con `listen(nome)`. JSON in **camelCase**. Le date sono stringhe ISO 8601 UTC.
>
> L'interfaccia parla **direttamente** con Supabase (via `supabase-js`, vedi
> [`modello-dati.md`](modello-dati.md)) per progetti, membri, note, log e notifiche.
> Con la shell parla solo per ciò che riguarda file, Git, credenziali e sistema operativo.
> Il token GitHub **non arriva mai** all'interfaccia.

## 1. Tipi comuni

```ts
type AppError = {
  code: ErrorCode;
  message: string;      // in italiano, mostrabile all'utente
  detail?: string;      // tecnico, per la diagnostica
  retryable: boolean;
};

type ErrorCode =
  | 'network' | 'authRequired' | 'authFailed' | 'notLinked' | 'folderNotEmpty' | 'folderInSyncedDrive'
  | 'fileNotStable' | 'fileInvalid' | 'fileTooLarge' | 'blockedByEditor' | 'conflictOpen'
  | 'localChangesPresent' | 'staleSavePending' | 'nonFastForward' | 'lockHeld' | 'notFound' | 'invalidPath'
  | 'gitMissing' | 'internal';

type SyncState =
  | 'synced' | 'localChanges' | 'publishing' | 'updateAvailable' | 'updating'
  | 'conflict' | 'offline' | 'error' | 'notLinked';

type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';
```

## 2. Stato di un progetto

```ts
type ProjectStatus = {
  projectId: string;
  state: SyncState;
  folder: string | null;
  headVersion: number | null;        // ultima versione pubblicata presente localmente
  remoteVersion: number | null;      // ultima versione pubblicata sul server (dopo l'ultimo fetch)
  behindBy: number;                  // versioni in arrivo
  changedFiles: ChangedFile[];       // modifiche non pubblicate
  pendingVersions: PendingVersion[]; // versioni create localmente e non ancora inviate
  blockedByEditor: string[];         // file da aggiornare aperti in OpenRocket
  openConflictIds: string[];
  staleSaveSuspected: string[];      // file salvati forse da una copia non aggiornata
  lastFetchAt: string | null;
  lastPublishAt: string | null;
  autoPublishAt: string | null;      // quando scatterà la pubblicazione automatica
  repoSizeBytes: number | null;
  error: AppError | null;
};

type ChangedFile = {
  path: string;                      // relativo alla cartella del progetto, separatore '/'
  change: FileChangeKind;
  oldPath?: string;
  stable: boolean;
  valid: boolean | null;             // null = non ancora validato
  invalidReason?: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
};

type PendingVersion = {
  sha: string;
  title: string;
  createdAt: string;
  waitingReason: 'offline' | 'blockedByEditor' | 'conflict' | 'retrying' | null;
};

type PublishPolicy =
  | { mode: 'assisted'; idleMinutes: number }      // default: 10
  | { mode: 'manual' }
  | { mode: 'onSave'; minIntervalMinutes: number };
```

## 3. Versioni, confronto, diff semantico

```ts
type VersionKind = 'init' | 'publish' | 'restore' | 'conflictResolution';

type VersionInfo = {
  number: number | null;             // null = in attesa
  sha: string;
  kind: VersionKind;
  title: string;
  description: string | null;
  changelog: ChangelogGroup[];
  author: { name: string; email: string; githubLogin: string | null };
  date: string;
  files: FileChange[];
  restoredFrom: number | null;
  conflictId: string | null;
  published: boolean;
};

type ChangelogGroup = { path: string; lines: string[]; interpreted: boolean };

type FileChange = {
  path: string;
  change: FileChangeKind;
  oldPath?: string;
  binary: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
};

type VersionRef = { number: number | null; sha: string };

type Comparison = { from: VersionRef; to: VersionRef; files: FileComparison[] };

type FileComparison = FileChange & {
  ork: OrkDiff | null;               // solo per i .ork
  textDiff: string | null;           // diff unificato, solo per file di testo
  note: string | null;               // es. "File binario: cambiata solo la dimensione"
};

// ---- Diff semantico dei .ork (prodotto da crates/rs-ork) ----

type OrkSummary = {
  container: 'zip' | 'gzip' | 'xml';
  creator: string | null;            // es. "OpenRocket 23.09"
  formatVersion: string | null;      // attributo version di <openrocket>
  rocketName: string | null;
  stageCount: number;
  componentCount: number;
  simulationCount: number;
};

type OrkDiff = {
  path: string;
  before: OrkSummary | null;         // null = file aggiunto
  after: OrkSummary | null;          // null = file rimosso
  components: ComponentChange[];
  motorConfigurations: ConfigChange[];
  simulations: SimulationChange[];
  uninterpreted: UninterpretedChange[];
  parseError: string | null;         // una delle due parti non è leggibile
};

type ComponentChange = {
  kind: 'added' | 'removed' | 'modified' | 'moved';
  componentType: string;             // nome dell'elemento XML, es. "trapezoidfinset"
  typeLabel: string;                 // es. "Pinne trapezoidali"
  name: string;
  path: string[];                    // nomi dei componenti antenati, dallo stadio in giù
  params: ParamChange[];
};

type ParamChange = {
  key: string;                       // es. "fincount"
  label: string;                     // es. "Numero di pinne"
  before: DisplayValue | null;
  after: DisplayValue | null;
};

type DisplayValue = { raw: string; display: string; unit: string | null }; // display: "95 mm"

type ConfigChange = {
  kind: 'added' | 'removed' | 'modified';
  name: string;
  params: ParamChange[];
};

type SimulationChange = {
  kind: 'added' | 'removed' | 'modified';
  name: string;
  conditions: ParamChange[];
  results: ParamChange[];            // apogeo, velocità massima, ecc.
  dataUpdated: boolean;              // dati di volo ricalcolati
};

type UninterpretedChange = { section: string; count: number; sample: string | null };

type OrkThreeWay = {
  path: string;
  mine: OrkDiff;                     // base → mia
  theirs: OrkDiff;                   // base → loro
  overlapping: OverlapItem[];        // stesso componente/parametro cambiato da entrambi
  independent: boolean;              // true se nessuna sovrapposizione
};

type OverlapItem = {
  componentPath: string[];
  componentName: string;
  key: string | null;                // null = il componente intero (aggiunto/rimosso da una parte)
  label: string;
  mine: DisplayValue | null;
  theirs: DisplayValue | null;
};
```

## 4. Conflitti e copie di sicurezza

```ts
type Conflict = {
  id: string;
  projectId: string;
  status: 'open' | 'resolved';
  createdAt: string;
  baseSha: string;
  oursSha: string;
  theirsSha: string;
  theirsVersion: number | null;
  theirsAuthor: string | null;
  remoteBranchPushed: boolean;
  files: ConflictFile[];
};

type ConflictFile = {
  path: string;
  kind: 'bothModified' | 'bothAdded' | 'modifiedDeleted' | 'deletedModified';
  threeWay: OrkThreeWay | null;      // solo per i .ork leggibili
};

type ResolutionChoice = 'mine' | 'theirs' | 'both' | 'manual';
type FileResolution = { path: string; choice: ResolutionChoice };

type Snapshot = { id: string; createdAt: string; operation: string; fileCount: number };
```

## 5. Comandi

### Sessione e credenziali

| Comando | Argomenti | Risultato |
|---|---|---|
| `auth_status` | — | `AuthStatus` |
| `auth_sign_in` | — | `AuthStatus` (apre il browser, attende il ritorno) |
| `auth_sign_out` | — | `void` |
| `secure_store_get` | `{ key }` | `string \| null` |
| `secure_store_set` | `{ key, value }` | `void` |
| `secure_store_delete` | `{ key }` | `void` |

```ts
type AuthStatus = {
  signedIn: boolean;
  user: { githubLogin: string; name: string; avatarUrl: string | null } | null;
  supabaseSession: { accessToken: string; refreshToken: string; expiresAt: number } | null;
};
```

`secure_store_*` serve come storage di `supabase-js` (sessione salvata in Credential Manager e
non in `localStorage`).

### Progetti locali

| Comando | Argomenti | Risultato |
|---|---|---|
| `list_local_projects` | — | `LocalProject[]` |
| `suggest_project_folder` | `{ projectName }` | `string` (es. `C:\Users\…\RocketSync\Nome`) |
| `check_folder` | `{ path }` | `FolderCheck` |
| `pick_folder` | `{ defaultPath? }` | `string \| null` (finestra di sistema) |
| `link_project` | `{ projectId, repoFullName, folder }` | `ProjectStatus` (clone, con eventi di avanzamento) |
| `unlink_project` | `{ projectId }` | `void` (la cartella resta sul disco) |
| `get_project_status` | `{ projectId }` | `ProjectStatus` |

```ts
type LocalProject = { projectId: string; folder: string; repoFullName: string; linkedAt: string };
type FolderCheck = {
  exists: boolean; empty: boolean; writable: boolean;
  inSyncedDrive: 'onedrive' | 'dropbox' | 'googleDrive' | null;
  fileCount: number;
};
```

### Sincronizzazione

| Comando | Argomenti | Risultato |
|---|---|---|
| `publish` | `{ projectId, title?, description?, paths? }` | `ProjectStatus` |
| `sync_now` | `{ projectId }` | `ProjectStatus` (fetch + aggiornamento + invio in attesa) |
| `update_now` | `{ projectId, force? }` | `ProjectStatus` |
| `discard_changes` | `{ projectId, paths }` | `ProjectStatus` |
| `answer_stale_save` | `{ projectId, path, reopened: boolean }` | `ProjectStatus` |
| `notify_remote_changed` | `{ projectId }` | `void` (l'interfaccia ha ricevuto in tempo reale una nuova versione: fetch immediato) |
| `get_publish_policy` | `{ projectId }` | `PublishPolicy` |
| `set_publish_policy` | `{ projectId, policy }` | `void` |

### Storico

| Comando | Argomenti | Risultato |
|---|---|---|
| `list_versions` | `{ projectId, limit?, beforeSha? }` | `VersionInfo[]` (più recenti prima) |
| `get_version` | `{ projectId, sha }` | `VersionInfo` |
| `compare_versions` | `{ projectId, fromSha, toSha }` | `Comparison` |
| `export_version` | `{ projectId, sha, paths?, destDir }` | `string[]` (file scritti) |
| `open_version_copy` | `{ projectId, sha, path }` | `void` (copia temporanea aperta in OpenRocket) |
| `restore_version` | `{ projectId, sha, paths? }` | `ProjectStatus` |

### Conflitti e copie di sicurezza

| Comando | Argomenti | Risultato |
|---|---|---|
| `list_conflicts` | `{ projectId, includeResolved? }` | `Conflict[]` |
| `get_conflict` | `{ projectId, conflictId }` | `Conflict` |
| `open_conflict_copy` | `{ projectId, conflictId, path, side: 'base' \| 'theirs' }` | `void` |
| `resolve_conflict` | `{ projectId, conflictId, resolutions: FileResolution[] }` | `ProjectStatus` |
| `list_snapshots` | `{ projectId }` | `Snapshot[]` |
| `export_snapshot` | `{ projectId, snapshotId, destDir }` | `string[]` |

### Sistema

| Comando | Argomenti | Risultato |
|---|---|---|
| `get_app_info` | — | `{ version, gitVersion, openRocket: { found, path, version } }` |
| `open_in_openrocket` | `{ projectId, path }` | `void` |
| `open_folder` | `{ path }` | `void` |
| `get_app_settings` / `set_app_settings` | — / `{ settings }` | `AppSettings` / `void` |
| `export_diagnostics` | — | `string` (percorso dello zip creato) |
| `check_for_update` | — | `{ available, version?, notes? }` |
| `install_update` | — | `void` (riavvia l'app) |
| `notify_desktop` | `{ title, body }` | `void` (notifica di Windows) |

```ts
type AppSettings = {
  autostart: boolean;
  desktopNotifications: boolean;
  minimizeToTray: boolean;
  fetchIntervalSeconds: number;      // default 60
};
```

## 6. Eventi (shell → interfaccia)

| Evento | Payload |
|---|---|
| `project-status` | `ProjectStatus` |
| `operation-progress` | `{ projectId, op: string, step: string, percent: number \| null, message: string }` |
| `version-published` | `{ projectId, number, sha, title }` |
| `update-applied` | `{ projectId, fromVersion, toVersion, files: string[] }` |
| `conflict-detected` | `{ projectId, conflictId, files: string[] }` |
| `conflict-resolved` | `{ projectId, conflictId, number }` |
| `stale-save-suspected` | `{ projectId, path }` |
| `recovery-performed` | `{ projectId, summary: string }` |
| `sync-error` | `{ projectId, error: AppError }` |

L'interfaccia, quando riceve `version-published`, `conflict-detected`, `conflict-resolved` o un
ripristino, registra l'evento condiviso su Supabase (`emit_event`, vedi `modello-dati.md`)
solo per i tipi consentiti al client. La pubblicazione delle versioni viene registrata dal
server tramite il webhook GitHub, quindi il client **non** la registra.

## 7. Modalità di sviluppo

L'interfaccia deve funzionare anche fuori da Tauri, con un backend simulato
(`VITE_BACKEND=mock`) che implementa tutti i comandi ed eventi di questo contratto con dati
realistici. Serve per sviluppo, test automatici e screenshot.
