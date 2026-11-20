# Fixture del formato delle chiavi dell'updater

**Chiavi di sola prova, senza alcun valore: non proteggono nulla.** Le password sono scritte nei test.

| File | Origine | Password |
|---|---|---|
| `official.key`, `official.key.pub` | generati dalla **CLI ufficiale** `@tauri-apps/cli 2.12.6` (`tauri signer generate -w official.key -p …`) | `rocketsync-test-password` |
| `sample.txt.official.sig` | `tauri signer sign -f official.key -p … sample.txt` (CLI ufficiale) | — |
| `script.key`, `script.key.pub` | generati da `genera-chiavi.mjs` | `rocketsync-test-password-2` |
| `sample.txt.script.sig` | firma prodotta dalla **CLI ufficiale** con `script.key` (`tauri signer sign -k "$(cat script.key)" -p … sample.txt`) | — |
| `sample.txt` | file firmato | — |

I test (`../genera-chiavi.test.mjs`) decifrano le chiavi ufficiali con il nostro codice e verificano
con il nostro codice le firme fatte dalla CLI ufficiale con la nostra chiave. Le firme contengono un
timestamp: non vanno rigenerate se non serve.
