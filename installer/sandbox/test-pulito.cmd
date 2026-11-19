@echo off
rem Eseguito DENTRO Windows Sandbox al primo accesso (vedi test-pulito.wsb).
rem Imposta qui il repository che pubblica le release di Rocket Sync:
set "ROCKETSYNC_OWNER="
set "ROCKETSYNC_REPO="
rem Non avviare l'app durante l'installazione: prima il test automatico.
set "ROCKETSYNC_NO_LAUNCH=1"

set "APP=%LOCALAPPDATA%\Rocket Sync\Rocket Sync.exe"
set "SELFTEST=%USERPROFILE%\Desktop\selftest.json"

echo.
echo === 1/3  Installazione ===
if "%ROCKETSYNC_OWNER%"=="" (
  echo ATTENZIONE: ROCKETSYNC_OWNER/ROCKETSYNC_REPO non sono impostati in test-pulito.cmd.
  echo Modifica il file e riavvia la sandbox.
  goto :fine
)
call C:\RocketSyncInstaller\install.cmd local
set "INSTALL_CODE=%ERRORLEVEL%"
echo Codice di uscita dell'installazione: %INSTALL_CODE%
copy /y "%TEMP%\RocketSync-install.log" "%USERPROFILE%\Desktop\RocketSync-install.log" >nul

if not "%INSTALL_CODE%"=="0" (
  echo L'installazione non e' riuscita: il log e' sul Desktop.
  goto :fine
)

echo.
echo === 2/3  Autodiagnosi (--self-test) ===
start "" /wait "%APP%" --self-test "%SELFTEST%"
set "SELFTEST_CODE=%ERRORLEVEL%"
echo Codice di uscita dell'autodiagnosi: %SELFTEST_CODE%
if exist "%SELFTEST%" (type "%SELFTEST%") else (echo ATTENZIONE: selftest.json non e' stato creato.)

echo.
echo === 3/3  Avvio per la prova a mano ===
start "" "%APP%"
echo.
echo Segui ora installer\sandbox\CHECKLIST.md.
echo Sul Desktop trovi RocketSync-install.log e selftest.json: copiali fuori dalla sandbox
echo (incolla nella finestra del PC host) prima di chiuderla, perche' alla chiusura si perde tutto.

:fine
