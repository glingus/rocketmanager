# Rocket Sync

App desktop per Windows che sincronizza i progetti **OpenRocket** di un piccolo team, con
versioni, confronti, conflitti gestiti in sicurezza, note e attività condivise e notifiche.
Git e GitHub lavorano in background: chi usa l'app non deve conoscerli.

> Stato: **V1 in sviluppo**. Il codice è completo e testato in automatico (Linux e runner
> Windows di GitHub Actions); mancano le prove su PC Windows reali e con account GitHub e
> Supabase veri. Vedi [Cosa resta da verificare](#cosa-resta-da-verificare).

## Documentazione

| Documento | Per chi |
|---|---|
| [Guida utente](docs/guida-utente.md) | Chi usa l'app ogni giorno |
| [Configurazione iniziale](docs/configurazione-iniziale.md) | Il titolare: GitHub, Supabase e backend pronti con un comando |
| [Installazione](docs/installazione.md) | Chi installa e chi pubblica le release |
| [Piano V1](docs/piano-v1.md) | Architettura, scelte, fasi |
| [Protocollo di sincronizzazione](docs/protocollo-sync.md) | Come funzionano pubblicazione, aggiornamenti, conflitti, ripristino, recupero |
| [Contratto IPC](docs/contratto-ipc.md) | Comandi ed eventi tra interfaccia e core |
| [Modello dati](docs/modello-dati.md) | Schema Supabase, policy, funzioni |
| [Formato .ork](docs/formato-ork.md) | Cosa sappiamo dei file OpenRocket e cosa interpretiamo |
| [Roadmap V2](docs/roadmap-v2.md) | Assistente IA (non implementato) |

## Struttura

```
apps/desktop/            interfaccia React + TypeScript (tema Cherry Wood Workshop)
apps/desktop/src-tauri/  shell Tauri 2: comandi IPC, accesso GitHub, tray, updater, self-test
crates/rs-git/           esecuzione isolata di Git (MinGit incluso nell'app)
crates/rs-store/         SQLite locale: journal, conflitti, impostazioni
crates/rs-core/          motore di sincronizzazione, watcher, conflitti, recupero
crates/rs-ork/           parser e diff semantico dei file .ork
supabase/                migrazioni, policy RLS, Edge Functions, test pgTAP
scripts/setup/           configuratore guidato del backend (Node, senza dipendenze)
installer/               installazione con un comando, test su Windows Sandbox
.github/workflows/       CI (Linux + Windows) e release firmata
tests/fixtures/ork/      file .ork reali usati nei test
```

## Sviluppo

Requisiti: Rust stabile, Node 22, pnpm 10, Git ≥ 2.40; su Linux le librerie di Tauri
(`libwebkit2gtk-4.1-dev` e simili, vedi `.github/workflows/ci.yml`).

```bash
pnpm install
pnpm dev                                   # interfaccia nel browser con backend simulato
cargo test --workspace                     # core, parser, shell
pnpm --filter @rocketsync/desktop test     # test dell'interfaccia
pnpm --filter @rocketsync/desktop e2e      # flussi end-to-end con screenshot
bash supabase/scripts/test-db.sh           # schema e policy (PostgreSQL 16 + pgTAP)
(cd supabase && npm ci && npm test)        # logica delle Edge Functions
node --test scripts/setup/*.test.mjs       # configuratore del backend (server finti)
```

Configurazione della shell (URL Supabase, organizzazione GitHub, updater):
[`apps/desktop/src-tauri/README.md`](apps/desktop/src-tauri/README.md).
Backend: [`supabase/README.md`](supabase/README.md); prima configurazione guidata:
`node scripts/setup/setup-backend.mjs` ([guida](docs/configurazione-iniziale.md)).

## Cosa resta da verificare

Queste prove richiedono account o macchine reali e vanno fatte prima di considerare la V1
pronta:

1. Installazione su un Windows pulito con Windows Sandbox
   ([`installer/sandbox/CHECKLIST.md`](installer/sandbox/CHECKLIST.md)).
2. Organizzazione GitHub, GitHub App e progetto Supabase reali (accesso, creazione progetto,
   inviti, webhook).
3. Sincronizzazione tra due PC del team con OpenRocket (titoli delle finestre per la guardia
   "editor non aggiornato", sequenza di salvataggio).
4. Discord con un webhook reale.
5. Stabilità degli ID dei componenti con OpenRocket 24.12 (salvare due volte lo stesso file).
