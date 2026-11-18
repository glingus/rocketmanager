# Formato dei file `.ork` (OpenRocket) e cosa ne interpreta Rocket Sync

> Documento di lavoro di `crates/rs-ork`. Tutto ciò che è scritto qui come "osservato" è stato
> verificato su file reali (`tests/fixtures/ork/`, vedi il `README.md` di quella cartella) o sul
> sorgente di OpenRocket (`openrocket/openrocket` su GitHub, letto da `raw.githubusercontent.com`:
> `GeneralRocketLoader`, `GeneralRocketSaver`, `OpenRocketSaver`, i `*Saver.java` dei componenti,
> `DocumentConfig`). Dove non ho potuto verificare lo dico esplicitamente.

## 1. Contenitori

Il loader di OpenRocket (`GeneralRocketLoader.loadStep1`) decide dai **primi byte**:

| Primi byte | Contenitore | Note |
|---|---|---|
| `1f 8b` | **GZIP** di un XML | Accettato dal loader. Non ho trovato un esempio GZIP reale scaricabile: la fixture `three-stage-rocket-13.04-gzip.ork` è derivata (XML reale compresso da noi). Non so quale versione di OpenRocket lo producesse; il saver attuale non lo fa. |
| `PK` | **ZIP** | La prima voce che finisce per `.ork` (o `.rkt`, `.cdx1`) è il razzo; le altre voci sono le immagini delle decalcomanie (`decals/…`). |
| altro (di norma `<?xml`) | **XML semplice** | Osservato nei file di OpenRocket 12.03 (formato 1.4). |

Quello che **scrive OpenRocket oggi** (`GeneralRocketSaver.saveAllPartsZipFile`): sempre uno
**ZIP** con la voce `rocket.ork` (XML UTF-8, compressione livello 9) più le decal usate, anche se non ce
ne sono. Osservato in tutti i file dal formato 1.6 (OpenRocket 13.04) al 1.10 (24.12).

`rs-ork::detect_container` replica la stessa logica (con tolleranza per BOM UTF-8 e spazi iniziali
nell'XML). Un file RockSim (`<RockSimDoc`) viene riconosciuto e **rifiutato** come non supportato.

### Come OpenRocket salva (importante per il watcher)

Dal sorgente di `GeneralRocketSaver.save`:

1. crea un file temporaneo **nella stessa cartella** della destinazione:
   `File.createTempFile("ORSave", ".tmp", cartella)` → `ORSave<numero>.tmp`;
2. ci scrive tutto lo ZIP;
3. se il file di destinazione esiste lo **rinomina in `<nome>.ork-bak`**;
4. rinomina il temporaneo sul nome di destinazione, imposta la data di modifica a "adesso";
5. cancella `<nome>.ork-bak`. Se il rename fallisce rimette a posto il backup.

Conseguenze:
- per un istante il `.ork` **non esiste** (o esiste solo `.ork-bak`): il watcher deve usare il
  debounce e non interpretare la sparizione come cancellazione;
- compaiono e scompaiono `ORSave*.tmp` (già coperti da `*.tmp` nel `.gitignore` del progetto) e
  **`*.ork-bak`, che il `.gitignore` del protocollo (`*.bak`) NON copre**: va aggiunto
  `*.ork-bak` (lo fa l'Edge Function `create-project`, vedi `supabase/`);
- il salvataggio **non è deterministico a livello di byte**: salvare due volte lo stesso documento
  senza modifiche può dare ZIP diversi (date delle voci). Il confronto va fatto sul contenuto, non
  sull'hash del file: `rs-ork::diff` su due salvataggi senza modifiche non riporta nulla
  (`OrkDiff::is_empty()`); l'app può usarlo per non creare versioni vuote.

## 2. Struttura dell'XML

```xml
<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>                       <!-- il razzo = radice dei componenti -->
    <name/> <id/> <designer/> <designtype/> <revision/> <referencetype/> …
    <motorconfiguration configid="…" default="true"> <stage number="0" active="true"/> </motorconfiguration> …
    <subcomponents>
      <stage>                    <!-- stadio (o <parallelstage> per un booster) -->
        <name/> <id/> <separationevent/> <separationaltitude/> <separationdelay/>
        <separationconfiguration configid="…"> … </separationconfiguration>
        <subcomponents>
          <nosecone/> <bodytube> … <subcomponents> <trapezoidfinset/> <innertube> <motormount>…</motormount> </innertube> … </subcomponents> </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
  <datatypes/>                   <!-- espressioni personalizzate, se ci sono -->
  <simulations> <simulation status="uptodate"> … </simulation> … </simulations>
  <photostudio/> <docprefs/>
</openrocket>
```

- Ogni componente è un elemento dentro `<subcomponents>`; il **nome dell'elemento è il tipo**:
  `stage`, `parallelstage`, `podset`, `nosecone`, `bodytube`, `transition`, `trapezoidfinset`,
  `ellipticalfinset`, `freeformfinset`, `tubefinset`, `innertube`, `tubecoupler`, `centeringring`,
  `bulkhead`, `engineblock`, `launchlug`, `railbutton`, `parachute`, `streamer`, `shockcord`,
  `masscomponent`.
- I parametri sono elementi figli con testo scalare; alcuni hanno attributi (`<axialoffset method=…>`,
  `<material type= density= group=>`).
- I motori sono dentro `<motormount>` del tubo che li ospita, uno `<motor configid="…">` per
  configurazione di volo, più `<ignitionconfiguration configid="…">` se l'accensione differisce dal
  predefinito. Le configurazioni sono dichiarate in `<rocket>` come `<motorconfiguration>`
  (negli esempi senza nome: il nome mostrato da OpenRocket è la lista dei motori).
- I paracadute (`parachute`, `streamer`) hanno `<deployevent>/<deployaltitude>/<deploydelay>` predefiniti
  e `<deploymentconfiguration configid>` per configurazione. Gli stadi hanno l'equivalente
  `<separation…>`.
- **Duplicati per compatibilità.** I file recenti scrivono più volte lo stesso dato in forma moderna e
  legacy: `axialoffset`+`position`, `instancecount`+`fincount`, `angleoffset`+`rotation`/`radialdirection`,
  `tabposition` (due varianti `relativeto`), `windaverage`/`winddirection`+`<wind model="average">`.
  Il parser legge la forma moderna e, se manca, quella legacy; l'altra è considerata ridondante
  (non conta come "non interpretata").
- Le versioni del formato osservate: **1.4** (OpenRocket 12.03), **1.6** (13.04), **1.8**
  (22.02/23.xx), **1.10** (24.12). Il loader attuale elenca come supportate 1.0–1.10.

## 3. ID dei componenti (decisivo per il merge futuro)

**Esito della verifica:**

| Formato | `<id>` sui componenti? |
|---|---|
| 1.4, 1.6 (OpenRocket 12.03, 13.04) | **no** |
| 1.8 (22.02.beta.05, "23.xx", esempi del JAR 23.09) | **no** (verificato su 4 file) |
| 1.10 (OpenRocket 24.12) | **sì**, un UUID su `rocket`, su ogni stadio e su ogni componente |

Quindi **gli ID non possono essere dati per scontati**: dipendono dalla versione di OpenRocket con
cui il file è stato salvato. Per i progetti del team conviene che **tutti usino la stessa versione,
≥ 24.12**.

**Stabilità degli ID tra salvataggi** (dal sorgente, `RocketComponent` e `DocumentConfig`):
- l'ID è un `UUID.randomUUID()` assegnato alla creazione del componente;
- il loader lo rilegge (`setters.put("RocketComponent:id", … "setID" …)`) e il saver lo riscrive
  (`<id>` in `RocketComponentSaver.addParams`): **caricare e salvare conserva gli ID**;
- `RocketComponent.copy()` (copia/incolla di un componente) assegna **nuovi ID** a tutta la copia;
- un file senza `<id>` (formato ≤ 1.8) riceve ID casuali **a ogni caricamento**; diventano stabili
  solo dopo il primo salvataggio con OpenRocket ≥ 24.12.

Prove a supporto sui file reali: tutte le fixture 1.10 hanno ID unici e ben formati; gli avvisi
delle simulazioni (`<warning><source>`) citano ID di componenti, e **tutti** corrispondono a
componenti presenti nello stesso file (`dual-parachute`: 6/6, `clustered-motors`: 1/1), cioè gli ID
sono sopravvissuti a un ciclo salva → carica → simula → salva.

**Limite della verifica.** Non ho potuto eseguire OpenRocket per salvare due volte lo stesso file e
confrontare gli ID (il JAR l'ho scaricato ma il suo avvio è stato bloccato dalle regole
dell'ambiente), quindi la stabilità tra salvataggi è dimostrata dal sorgente e dalle prove
indirette sopra, **non** da un esperimento end-to-end. Da rifare con OpenRocket 24.12 sul PC del team
prima di basare un merge automatico sugli ID.

**Come ne tiene conto `rs-ork`** (abbinamento dei componenti tra due versioni):
1. per ID, se presente in entrambe le versioni, unico nel file e dello stesso tipo (anche se il
   componente è stato spostato: diventa `moved`);
2. altrimenti, dentro il padre già abbinato: stesso tipo + stesso nome (se ci sono più candidati
   con lo stesso nome vince il più simile per sottoalbero e parametri, non l'ordine);
3. altrimenti, **rinomina**: se per quel tipo resta esattamente un componente non abbinato per
   parte e non hanno entrambi ID diversi;
4. il resto è `added` / `removed` (non si inventano abbinamenti ambigui). Due componenti con ID
   entrambi presenti ma diversi non si abbinano mai.

Senza ID, quindi, uno **spostamento** tra padri diversi appare come rimozione + aggiunta.

## 4. Simulazioni e dati di volo

```xml
<simulation status="uptodate">          <!-- uptodate | outdated | loaded | external | notsimulated -->
  <name/> <simulator>RK4Simulator</simulator> <calculator>BarrowmanCalculator</calculator>
  <conditions>
    <configid/> <launchrodlength/> <launchintowind/> <launchrodangle/> <launchroddirection/>
    <windaverage/> <windturbulence/> <winddirection/>
    <wind model="average"> <speed/> <direction/> <standarddeviation/> </wind>
    <wind model="multilevel" altituderef="msl"> <windlevel altitude speed direction standarddeviation/> </wind>
    <windmodeltype/> <launchaltitude/> <launchlatitude/> <launchlongitude/> <geodeticmethod/>
    <atmosphere model="isa|extendedisa"> <basetemperature/> <basepressure/> </atmosphere>
    <timestep/> <maxtime/>
  </conditions>
  <extension extensionid="…"> <entry key type>…</entry> </extension>   <!-- estensioni di simulazione -->
  <flightdata maxaltitude maxvelocity maxacceleration maxmach timetoapogee flighttime
              groundhitvelocity launchrodvelocity deploymentvelocity optimumdelay>
    <warning type="…"> <id/> <description/> <priority/> <source>ID-componente</source> … </warning>
    <databranch name="Sustainer" types="Time,Altitude,…" …>
      <event time="0" type="launch"/> …
      <datapoint>0.0,0.0,…</datapoint> × centinaia-migliaia
    </databranch>
  </flightdata>
</simulation>
```

- **I risultati principali stanno negli attributi di `<flightdata>`** (apogeo, velocità massima…):
  piccoli e confrontabili. Le **serie** (`<databranch>`, migliaia di `<datapoint>`) sono ciò che fa
  crescere il file (negli esempi reali da ~150 KB a 1,3 MB di XML).
- Il salvataggio dei dati di volo è un'opzione di OpenRocket: un file può contenere solo gli
  attributi riassuntivi (come i file 13.04 delle fixture, 16–25 KB) o nulla.
- `rs-ork` **non confronta le serie punto per punto**: ne calcola un'impronta (FNV-1a sul
  contenuto) e segnala `dataUpdated: true` se cambia. L'impronta non viene confusa con
  condizioni/risultati: se cambia solo il numero di un dato di volo si vede solo `dataUpdated`.
- I vecchi file (≤ 1.6) hanno `<warning>` come testo semplice; quelli recenti hanno elementi
  strutturati. Il parser confronta la `description` o il testo.

## 5. Unità

I valori nel file sono **sempre SI**, a doppia precisione Java (`0.052000000000000005`,
`5.55E-17`). Il parser converte solo per la visualizzazione e confronta i **valori visualizzati**:
una differenza sotto la precisione mostrata (0,01 mm, 0,01 g…) non è una modifica.

| Grandezza | Nel file | Mostrata |
|---|---|---|
| lunghezze (spessori, corde, lunghezze) | m | mm |
| raggi (`radius`, `outerradius`, `aftradius`, `packedradius`…) | m (raggio) | **diametro** in mm (come nell'interfaccia di OpenRocket); `auto 0.0125` = "automatico (25 mm)" |
| `railbutton` (`outerdiameter`…) | m (diametro) | mm |
| masse | kg | g |
| angoli: `launchrodangle`, `launchroddirection`, `cant`, `angleoffset`, `radialdirection`, `clusterrotation`, latitudine/longitudine | gradi | ° |
| angoli: direzione del vento (`winddirection`, `<wind><direction>`) | **radianti** | ° |
| velocità / accelerazioni | m/s, m/s² | invariati |
| quote (apogeo, quota di apertura, quota di lancio) | m | m |
| tempi | s | s |
| temperatura / pressione (atmosfera personalizzata) | K / Pa | °C / hPa |
| turbolenza del vento | frazione (0,1) | % |
| materiali | densità kg/m³ (`bulk`), kg/m² (`surface`), kg/m (`line`) | come nel file |

I decimali mostrati usano la virgola italiana.

## 6. Cosa interpreta `rs-ork` e cosa no

**Interpretato** (etichette italiane, unità, confronto):
- tutti i tipi di componente elencati al §2 con i loro parametri geometrici;
- parametri comuni: nome, materiale, finitura, posizione assiale (metodo + valore), angolo,
  distanza radiale, numero di copie e separazione, massa/baricentro/Cd forzati, commento,
  componente da catalogo (`preset`), aspetto (colore, lucentezza, decal con tutti i suoi
  parametri), aspetto interno;
- profilo delle pinne libere (`finpoints`), posizione della linguetta;
- evento/quota/ritardo di apertura dei paracadute e di separazione degli stadi, anche per singola
  configurazione di volo;
- configurazioni di volo: nome, motore (costruttore, designazione, ritardo, definizione) per ogni
  alloggiamento, accensione, stadi disattivati; la configurazione scelta nell'editor (`default="true"`)
  è **volutamente ignorata** (è solo uno stato dell'interfaccia);
- simulazioni: nome, stato, metodi, condizioni (lanciatoia, angolo, direzione, vento medio e
  direzione, turbolenza, quota/latitudine/longitudine, atmosfera, passo, durata massima),
  risultati principali e avvisi, `dataUpdated`;
- riepilogo: contenitore, versione e creatore, nome del razzo, numero di stadi (inclusi i booster),
  componenti (radice esclusa), simulazioni.

**Non interpretato** — finisce in `uninterpreted` con sezione, conteggio e un esempio, **mai**
descritto come capito:
- elementi sconosciuti dentro un componente (sezione "Componenti"), una simulazione
  ("Simulazioni": per esempio le `<extension>`), una configurazione ("Configurazioni di volo");
- `<datatypes>` (espressioni personalizzate), `<photostudio>`, `<docprefs>` (preferenze del
  documento, materiali del documento) e qualsiasi elemento di primo livello sconosciuto;
- le **immagini** dentro lo ZIP (decal, texture): se cambiano, sezione "Immagini allegate al file";
- le serie dei dati di volo (solo `dataUpdated`).

**Valori predefiniti.** Un parametro presente solo da un lato e uguale al valore assunto da
OpenRocket quando l'elemento manca (`instancecount` 1, `instanceseparation`/`filletradius` 0,
`isflipped` false, `designtype` original, `launchintowind` true, `maxtime` 1200…) non è una
modifica: serve a non riempire di rumore il confronto tra due versioni del formato.

**Cambio di versione di OpenRocket.** Il confronto di due file salvati da versioni diverse
(per esempio 13.04 → 24.12) mostra comunque differenze reali dell'esempio e alcuni elementi nuovi
del formato; per questo si consiglia a tutto il team la stessa versione di OpenRocket.

## 7. Tipi di diff e regole

- `diff(path, before, after)`:
  - file aggiunto/rimosso: solo il riepilogo del lato esistente (`before`/`after` = `null` per l'altro),
    elenchi vuoti;
  - una parte illeggibile: `parseError` spiega quale ("la versione successiva non è leggibile (…)")
    e gli elenchi restano vuoti — non si finge un confronto;
  - componenti: `added` e `removed` si riportano **solo per la radice del sottoalbero** (con un
    parametro `subcomponents` "N componenti"); `modified` solo se un parametro cambia; `moved`
    se cambia il padre (parametro `parent`) o l'ordine tra fratelli (parametro `order`).
- `three_way(path, base, mine, theirs)`: calcola `base→mine` e `base→theirs` e segnala come
  `overlapping` solo ciò che entrambe le parti hanno toccato **con esiti diversi**:
  stesso parametro con valori diversi, componente (o simulazione, configurazione) rimosso da una
  parte e modificato dall'altra, componente aggiunto da entrambe, aggiunta dentro un componente
  rimosso dall'altra parte, modifiche non interpretate nella stessa sezione da entrambe
  (non si può dimostrare l'indipendenza). `independent` è `true` solo se tutto è leggibile e
  non ci sono sovrapposizioni. Due parti che fanno la stessa identica modifica non si sovrappongono.
- `changelog_lines`: una riga per componente/configurazione/simulazione modificati, per esempio
  `Pinne trapezoidali «Pinne»: numero di pinne 3 → 4; corda alla radice 80 → 95 mm`,
  `Aggiunto: Paracadute «Paracadute principale» (Ø 900 mm)`,
  `Simulazione «Simulation 1»: velocità media del vento 2 → 4 m/s; dati di volo ricalcolati`.
  Se non si rileva nulla: "Salvato di nuovo senza modifiche rilevabili al progetto".
- `normalized_xml(bytes, strip_flight_data)`: XML con indentazione fissa (2 spazi), attributi
  nell'ordine del file, nessun contenitore; con `strip_flight_data` toglie i `<databranch>` e
  conserva gli attributi riassuntivi di `<flightdata>`.

## 8. Validazione ("OpenRocket ha finito di scrivere")

`validate(bytes)` rifiuta:
- ZIP senza directory centrale (troncato) o con una voce dal CRC errato (si leggono **tutte** le voci);
- GZIP interrotto o con checksum errato;
- XML con tag non chiusi, tag non corrispondenti, entità sconosciute, UTF-8 non valido;
- XML senza `<openrocket>`/`<rocket>`, file RockSim/RASAero, contenuto di altro tipo;
- contenuto decompresso oltre 1 GiB (protezione da zip bomb).

Messaggi in italiano, adatti a `FileInspector::validate`. Un file ancora in scrittura ma già
completo e coerente passa: la stabilità (2 s senza eventi, dimensione e data costanti) resta
compito del watcher.

## 9. CLI di debug

```
ork-cli summary <file> [--json]        # riepilogo + componenti con ID, configurazioni, simulazioni
ork-cli diff <a> <b> [--json]          # changelog italiano, oppure l'OrkDiff completo
ork-cli normalize <file> [--keep-flight-data]   # XML normalizzato su stdout
```
