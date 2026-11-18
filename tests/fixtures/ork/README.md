# Fixture `.ork` reali

File di esempio di **OpenRocket** usati dai test di `crates/rs-ork`. OpenRocket è software libero
distribuito con licenza **GNU GPL v3** (<https://github.com/openrocket/openrocket>); gli esempi sono
distribuiti insieme al programma e qui sono usati solo come dati di test, senza modifiche
(tranne dove indicato). Vanno trattati come **binari** (non fonderli, non normalizzare i fine riga).

I file dei test che servono varianti (numero pinne, paracadute aggiunto, simulazione modificata,
file troncato…) le costruiscono a partire da questi, modificando l'XML in memoria: nessuna variante
è salvata su disco.

| File | Origine | Formato file | Contenitore | Note |
|---|---|---|---|---|
| `simple-model-rocket-12.03-plainxml.ork` | tag `release-12.09`, `core/resources/datafiles/examples/A simple model rocket.ork` (raw.githubusercontent.com) | 1.4, "OpenRocket 12.03" | **XML semplice** | Nessun ID dei componenti. Dati di volo salvati. |
| `simple-model-rocket-13.04.ork` | tag `release-13.05`, stessa cartella | 1.6, "OpenRocket 13.04beta1" | ZIP (`rocket.ork` + 2 decal) | Nessun ID. Nessun dato di volo (file piccolo). |
| `three-stage-rocket-13.04.ork` | tag `release-13.05`, `Three-stage rocket.ork` | 1.6 | ZIP | 3 stadi, pinne libere (`freeformfinset`), 2 stadi con nome uguale. |
| `three-stage-rocket-13.04-gzip.ork` | **derivato**: l'`rocket.ork` XML del file precedente compresso con `gzip -9` | 1.6 | **GZIP** | Non ho trovato un esempio GZIP reale scaricabile: il loader di OpenRocket (`GeneralRocketLoader`) accetta GZIP, quindi questo file riproduce quel caso con contenuto reale. Nessuna decal. |
| `simple-model-rocket-24.12.ork` | branch `master`, `core/src/main/resources/datafiles/examples/A simple model rocket.ork` | 1.10, "OpenRocket 24.12" | ZIP | **Con `<id>` dei componenti**, 5 simulazioni con dati di volo. |
| `clustered-motors-24.12.ork` | `master`, `Clustered motors.ork` | 1.10 | ZIP | Tubi interni a grappolo, ID. |
| `dual-parachute-24.12.ork` | `master`, `Dual parachute deployment.ork` | 1.10 | ZIP | Due paracadute, giunti, paratie, rail button, ID; gli avvisi delle simulazioni citano gli ID dei componenti. |
| `parallel-booster-staging-24.12.ork` | `master`, `Parallel booster staging.ork` | 1.10 | ZIP | `parallelstage` (booster), separazione, ID. Contiene voci ZIP con percorso assoluto (`/datafiles/textures/…`). |
| `tube-fin-rocket-22.02.ork` | `OpenRocket-23.09.jar`, `datafiles/examples/Tube fin rocket.ork` | 1.8, "OpenRocket 22.02.beta.05" | ZIP | `tubefinset`. Nessun ID. |
| `presets-22.02.ork` | stesso JAR, `Presets.ork` | 1.8 | ZIP | Componenti da catalogo (`<preset>`). |
| `pods-airframes-22.02.ork` | stesso JAR, `Pods--airframes and winglets.ork` | 1.8 | ZIP | `podset`. |
| `two-stage-rocket-22.02.ork` | stesso JAR, `Two-stage rocket.ork` | 1.8 | ZIP | Paracadute con `deploymentconfiguration` per configurazione, 2 stadi, nomi delle configurazioni. |

Il JAR `OpenRocket-23.09.jar` è quello pubblicato su
<https://sourceforge.net/projects/openrocket/files/openrocket/23.09/>; ne sono stati estratti solo i
file di esempio (copiati byte per byte), il JAR non è stato eseguito.

Dimensione totale: circa 1,5 MB.
