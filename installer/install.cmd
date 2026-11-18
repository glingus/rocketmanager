@echo off
rem ===========================================================================================
rem  Rocket Sync - installazione / aggiornamento / riparazione (senza diritti di amministratore)
rem
rem    install.cmd          scarica ed esegue l'ultimo install.ps1 dalle release (comando unico)
rem    install.cmd local    esegue l'install.ps1 che sta accanto a questo file
rem
rem  Comando unico, da incollare in un Prompt dei comandi:
rem    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/@@OWNER@@/@@REPO@@/releases/latest/download/install.ps1 | iex"
rem
rem  I segnaposto @@OWNER@@/@@REPO@@ vengono sostituiti dalla pipeline di release.
rem  Opzioni (variabili d'ambiente): ROCKETSYNC_OWNER, ROCKETSYNC_REPO, ROCKETSYNC_NO_LAUNCH=1,
rem  ROCKETSYNC_LOCAL_INSTALLER=<percorso di RocketSync-setup.exe>
rem  Il codice di uscita e' quello di install.ps1 (0 = ok, vedi docs/installazione.md).
rem ===========================================================================================
setlocal
if /i "%~1"=="local" goto local
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/@@OWNER@@/@@REPO@@/releases/latest/download/install.ps1 | iex"
exit /b %ERRORLEVEL%

:local
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Raw -Encoding UTF8 '%~dp0install.ps1' | Invoke-Expression"
exit /b %ERRORLEVEL%
