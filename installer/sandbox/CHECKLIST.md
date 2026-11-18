# Prova di installazione su Windows pulito (Windows Sandbox)

Serve per verificare che Rocket Sync si installi e funzioni su un Windows "vergine", senza nulla di
quello che c'è già sul tuo PC (Git, WebView2, OpenRocket, account GitHub già collegati…). Dura circa
45 minuti. Alla fine mandami i due file indicati al punto 6.

## 0. Prerequisiti (una volta sola)

- Un PC con **Windows 10 o 11 Pro / Enterprise / Education**, a 64 bit, con virtualizzazione attiva
  nel BIOS. Windows Home **non** ha Windows Sandbox: in quel caso usa un altro PC del team.
- Attiva la funzione: *Start → "Attiva o disattiva funzionalità di Windows" → Windows Sandbox*, OK,
  riavvia il PC.
- Almeno 8 GB di RAM e 5 GB liberi.
- Un **account GitHub** già invitato nell'organizzazione del team, e un **secondo PC** (o un collega)
  con Rocket Sync già installato per la prova di ricezione (punto 5).
- La cartella `installer/` del repository di Rocket Sync su questo PC (scaricata come zip o clonata).
- Apri **`installer\sandbox\test-pulito.cmd`** con il Blocco note e scrivi, tra le virgolette, il
  proprietario e il nome del repository che pubblica le release:

  ```bat
  set "ROCKETSYNC_OWNER=nome-organizzazione"
  set "ROCKETSYNC_REPO=nome-repository-release"
  ```

## 1. Avvia la sandbox

1. Doppio clic su **`installer\sandbox\avvia-sandbox.cmd`**. Si apre una finestra con un Windows
   nuovo (con il tuo stesso aspetto, ma completamente separato).
2. Si apre da sola una finestra nera ("Prompt dei comandi") che esegue l'installazione: attendi che
   scriva *"=== 3/3 Avvio per la prova a mano ==="* (1-3 minuti; il download è di qualche decina di MB).
3. Sul **Desktop della sandbox** devono comparire, oltre al collegamento, `RocketSync-install.log` e
   `selftest.json`.

## 2. Cosa guardare a occhio subito dopo l'installazione

Spunta ogni voce e scrivi accanto cosa vedi se qualcosa non va.

- [ ] Nella finestra nera l'installazione si è chiusa con *"Codice di uscita dell'installazione: 0"*.
- [ ] Sul Desktop c'è il collegamento **Rocket Sync** con l'icona del razzo (non l'icona bianca generica).
- [ ] Nel menu Start (digita "Rocket") compare **Rocket Sync**.
- [ ] *Nessun avviso rosso* di SmartScreen che impedisca di avviare l'app. Un avviso blu "Windows ha
      protetto il PC" è atteso: *Ulteriori informazioni → Esegui comunque* (vedi `docs/installazione.md`).
- [ ] Nella finestra nera, "Autodiagnosi" mostra il contenuto di `selftest.json` con `"ok": true`.
- [ ] L'app si è aperta da sola (altrimenti aprila dal collegamento sul Desktop) e la finestra è
      leggibile: testi nitidi, nessuna finestra bianca vuota, nessun errore.

## 3. Primo avvio e accesso

- [ ] La **configurazione guidata** parte da sola e il controllo dell'ambiente non segnala errori
      bloccanti. (Che OpenRocket manchi è normale: deve apparire il link per scaricarlo.)
- [ ] **Accedi con GitHub**: si apre il browser, accetti, e torni nell'app già collegato col tuo nome
      e la tua foto.
- [ ] Il profilo e le preferenze si salvano; con *Avvio con Windows* attivo non compaiono errori.

## 4. Un progetto di prova

1. [ ] Crea un progetto nuovo chiamato **"Prova installazione"** (oppure collega quello di prova che
       ti ho indicato). Il repository deve comparire nell'organizzazione GitHub.
2. [ ] Accetta la cartella locale proposta (sotto `Documenti` o simile, **non** dentro OneDrive).
3. [ ] Copia dentro la cartella un file `.ork` qualsiasi (nella sandbox non c'è OpenRocket: usa un
       file d'esempio che ti ho dato, oppure trascinalo dal PC host incollando nella finestra).
4. [ ] L'app lo rileva e mostra **"Modifiche non pubblicate"** dopo pochi secondi.
5. [ ] Premi **Pubblica**: compare la versione 1 nella cronologia, senza errori.

## 5. Ricezione su un secondo PC

- [ ] Sul secondo PC (o dal collega) con Rocket Sync già installato: entro un minuto compare
      "Aggiornamento disponibile" per *Prova installazione*; **Aggiorna** scarica il file `.ork`.
- [ ] Sul secondo PC modifica/aggiungi un file e pubblica; nella sandbox compare l'aggiornamento
      e, aggiornando, il file arriva.
- [ ] (Facoltativo) Le notifiche di Windows e quelle in-app compaiono.

## 6. Cosa mandarmi

Prima di chiudere la sandbox (**alla chiusura si perde tutto**), copia dal Desktop della sandbox
e incolla sul tuo PC:

1. `RocketSync-install.log` — il registro dell'installazione;
2. `selftest.json` — il risultato dell'autodiagnosi;
3. (se qualcosa non ha funzionato) uno screenshot della finestra con l'errore e la lista delle voci
   non spuntate con una riga di spiegazione ciascuna.

Se il log è assente perché il comando non è partito, mandami uno screenshot della finestra nera.

## Se qualcosa va storto

| Sintomo | Cosa fare |
|---|---|
| `avvia-sandbox.cmd` dice che Windows Sandbox non è attivo | Attiva la funzione (punto 0) e riavvia il PC. |
| La finestra nera dice che owner/repo non sono impostati | Compila `test-pulito.cmd` (punto 0) e riavvia la sandbox. |
| Codice di uscita ≠ 0 | Il messaggio sopra lo spiega in italiano; il significato dei codici è in `docs/installazione.md`. Mandami il log. |
| Download lento o bloccato | Riprova; se sei dietro un proxy aziendale, il log riporta il proxy usato. |
| `selftest.json` ha `"ok": false` | Non è un problema tuo: mandamelo, contiene gli errori in `errors`. |
