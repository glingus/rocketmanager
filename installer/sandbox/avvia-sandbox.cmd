@echo off
rem Avvia Windows Sandbox con test-pulito.wsb, sistemando il percorso assoluto della cartella installer/.
setlocal
for %%I in ("%~dp0..") do set "HOSTDIR=%%~fI"
set "WSB=%TEMP%\rocketsync-test-pulito.wsb"
powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw -Encoding UTF8 '%~dp0test-pulito.wsb').Replace('C:\RocketSync\installer', $env:HOSTDIR) | Set-Content -Encoding UTF8 $env:WSB"
if errorlevel 1 (echo Impossibile preparare il file .wsb & exit /b 1)
where WindowsSandbox.exe >nul 2>nul
if errorlevel 1 (
  echo Windows Sandbox non e' attivo su questo PC.
  echo Attivalo da "Attiva o disattiva funzionalita' di Windows" ^(serve Windows 10/11 Pro o superiore^), poi riavvia.
  exit /b 2
)
start "" "%WSB%"
