# Chiavi dell'updater senza la CLI di Tauri

`genera-chiavi.mjs` produce la coppia di chiavi con cui si firmano gli aggiornamenti di Rocket Sync,
con lo **stesso formato di `tauri signer generate`**, in JavaScript puro (Node 20+, nessuna
dipendenza, nessun modulo nativo). Serve dove la CLI di Tauri non parte, per esempio su Windows 11 con
il *Controllo intelligente delle app* attivo (blocca `cli.win32-x64-msvc.node`).

```
node scripts/updater-keys/genera-chiavi.mjs -w %USERPROFILE%\.tauri\rocketsync.key
node scripts/updater-keys/genera-chiavi.mjs --check %USERPROFILE%\.tauri\rocketsync.key
```

Uso completo: `--help`. Dove si mettono le chiavi: `docs/installazione.md` §8.2.

## Il formato (verificato sul sorgente reale)

Fonti: `tauri-cli` v2.12.6 (`crates/tauri-cli/src/helpers/updater_signature.rs`) e crate `minisign` 0.10.

- File della chiave privata e della pubblica = **base64 del testo di una "box" minisign**.
- Pubblica: `untrusted comment: minisign public key: <KEYNUM>\n<base64 di "Ed" | keynum(8) | pk(32)>\n`,
  con `<KEYNUM>` = il keynum letto come u64 little-endian, 16 cifre esadecimali maiuscole.
- Privata: `untrusted comment: rsign encrypted secret key\n<base64 di 158 byte>\n` con
  `"Ed" | "Sc" | "B2" | salt(32) | opslimit u64 LE | memlimit u64 LE | keynum(8) | sk(64) | chk(32)`:
  - `sk` = seme Ed25519 (32) || chiave pubblica (32);
  - `chk` = BLAKE2b-256(`"Ed"` || keynum || sk) (Node non lo ha: implementato in `minisign.mjs`, verificato
    contro il `blake2b512` di OpenSSL e i vettori noti);
  - `keynum || sk || chk` (104 byte) sono cifrati con XOR contro `scrypt(password, salt, 104 byte)`;
  - opslimit = 1 048 576, memlimit = 33 554 432, che il crate traduce (`raw_scrypt_params`, cioè il
    `pickparams` di libsodium) in **N = 2^15, r = 8, p = 1**; anche questo è replicato e testato.
- Firma (`.sig` di `tauri signer sign`): base64 di un `.minisig` "prehashed" (`ED`): Ed25519 su
  BLAKE2b-512 dei dati, più firma globale sul commento fidato.

## Prove di compatibilità

`node --test "scripts/updater-keys/*.test.mjs"` (18 test, in CI):

1. **Vettori della CLI ufficiale** in `fixtures/` (chiave generata da `tauri signer generate` e firma di
   `tauri signer sign`): il nostro codice li decifra e li verifica.
2. **Chiave del nostro script firmata dalla CLI ufficiale**: la firma si verifica con la nostra chiave
   pubblica, sia con vettore salvato sia "dal vivo" se la CLI ufficiale è installata (in CI lo è).
3. **Chiave della CLI ufficiale decifrata dal nostro codice**, e chiave del nostro script accettata dalla CLI
   ufficiale (`signer sign -k` e `-f`; con password sbagliata la CLI rifiuta).
4. Formato byte per byte (lunghezze 348/152 caratteri, commenti, parametri KDF), BLAKE2b, scrypt, rifiuto
   di password errate, file alterati, sovrascrittura senza `--force`, permessi 0600, password nascosta.

Verifica una tantum con il verificatore **vero** dell'updater (`minisign-verify` 0.3.0, lo stesso di
`tauri-plugin-updater`): una firma prodotta dalla CLI ufficiale con una chiave generata da questo script
risulta valida, e non valida se i dati cambiano.
