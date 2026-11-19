<#
.SYNOPSIS
  Prova di installazione su Windows (CI e PC reali): installa in silenzio per l'utente con install.cmd,
  verifica file e collegamenti, riesegue l'installazione (riparazione), lancia --self-test e
  disinstalla. Esce con codice diverso da 0 al primo controllo fallito.

.PARAMETER Installer
  Percorso dell'installer NSIS (qualsiasi nome: viene copiato come RocketSync-setup.exe).
.PARAMETER OutDir
  Cartella dove salvare selftest.json e i log (default: %TEMP%\RocketSync-smoke).
#>
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [string]$OutDir = (Join-Path $env:TEMP 'RocketSync-smoke')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installCmd = Join-Path (Split-Path -Parent $here) 'install.cmd'
$appName = 'Rocket Sync'
$results = New-Object System.Collections.ArrayList

function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    [void]$results.Add([pscustomobject]@{ Controllo = $Name; Esito = $(if ($Ok) { 'OK' } else { 'FALLITO' }); Dettaglio = $Detail })
    if ($Ok) { Write-Host "  [OK]       $Name $Detail" }
    else { Write-Host "  [FALLITO]  $Name $Detail" -ForegroundColor Red }
    if (-not $Ok) {
        Write-Host "::error::Smoke test fallito: $Name $Detail"
        $results | Format-Table -AutoSize | Out-String | Write-Host
        exit 1
    }
}

# Valori scritti dal modello NSIS di Tauri 2 (installMode currentUser, verificato su installer.nsi di
# tauri-cli v2.12.6): chiave HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<productName> con
# DisplayName, DisplayIcon ("<cartella>\<exe>"), InstallLocation ("<cartella>"), UninstallString
# ("<cartella>\uninstall.exe"), MainBinaryName; cartella predefinita %LOCALAPPDATA%\<productName>.
function Get-UninstallEntry {
    foreach ($root in 'HKCU:', 'HKLM:') {
        $key = "$root\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appName"
        if (Test-Path -LiteralPath $key) {
            $p = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            if ($p -and $p.DisplayName -eq $appName) { return $p }
        }
    }
    return $null
}

function Get-InstalledExe {
    $default = "$env:LOCALAPPDATA\$appName\$appName.exe"
    if (Test-Path -LiteralPath $default) { return $default }
    $e = Get-UninstallEntry
    if ($e -and $e.DisplayIcon) {
        $icon = ([string]$e.DisplayIcon).Trim('"')
        if (Test-Path -LiteralPath $icon) { return $icon }
    }
    return $null
}

function Invoke-Install {
    param([string]$LocalInstaller)
    $env:ROCKETSYNC_LOCAL_INSTALLER = $LocalInstaller
    $env:ROCKETSYNC_NO_LAUNCH = '1'
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$installCmd`"", 'local' -Wait -PassThru -NoNewWindow
    return $p.ExitCode
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$work = Join-Path $OutDir 'work'
New-Item -ItemType Directory -Path $work -Force | Out-Null

Write-Host "== Smoke test di installazione ($Installer) =="
Check 'installer presente' (Test-Path -LiteralPath $Installer -PathType Leaf) $Installer
$setup = Join-Path $work 'RocketSync-setup.exe'
Copy-Item -LiteralPath $Installer -Destination $setup -Force
$hash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLower()
Set-Content -LiteralPath "$setup.sha256" -Value "$hash  RocketSync-setup.exe" -Encoding ASCII

# Parte da una situazione pulita.
$before = Get-UninstallEntry
Check 'non gia'' installato (prima dell''installazione)' ($null -eq $before) $(if ($before) { 'trovata una versione precedente' } else { '' })

# 1. Prima installazione
Write-Host "`n-- Installazione silenziosa per utente --"
$code = Invoke-Install -LocalInstaller $setup
Check 'install.cmd local termina con 0' ($code -eq 0) "codice $code"
$exe = Get-InstalledExe
Check 'eseguibile installato' ($null -ne $exe) $exe
Check 'installato nel profilo utente, in %LOCALAPPDATA%\Rocket Sync' ($exe -eq "$env:LOCALAPPDATA\$appName\$appName.exe") $exe
$installDir = Split-Path -Parent $exe
Check 'nella cartella c''e'' il disinstallatore' (Test-Path -LiteralPath (Join-Path $installDir 'uninstall.exe')) $installDir

$shell = New-Object -ComObject WScript.Shell
$links = @(
    @{ Nome = 'collegamento sul desktop'; Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk") },
    @{ Nome = 'collegamento nel menu Start'; Path = (Join-Path ([Environment]::GetFolderPath('Programs')) "$appName.lnk") }
)
foreach ($l in $links) {
    $exists = Test-Path -LiteralPath $l.Path
    Check $l.Nome $exists $l.Path
    if ($exists) {
        $target = $shell.CreateShortcut($l.Path).TargetPath
        Check "$($l.Nome) punta all'app" ($target -eq $exe) $target
    }
}

$logPath = Join-Path $env:TEMP 'RocketSync-install.log'
Check 'log di installazione scritto' (Test-Path -LiteralPath $logPath) $logPath
Copy-Item -LiteralPath $logPath -Destination (Join-Path $OutDir 'RocketSync-install.log') -Force

$entry = Get-UninstallEntry
Check 'voce in "App installate" (HKCU, chiave "Rocket Sync")' ($null -ne $entry) $(if ($entry) { "versione $($entry.DisplayVersion)" } else { '' })
if ($entry) {
    Check 'InstallLocation punta alla cartella dell''app' (([string]$entry.InstallLocation).Trim('"') -eq $installDir) ([string]$entry.InstallLocation)
    Check 'DisplayIcon punta all''eseguibile' (([string]$entry.DisplayIcon).Trim('"') -eq $exe) ([string]$entry.DisplayIcon)
}

# 2. Seconda esecuzione: aggiornamento/riparazione, idempotente
Write-Host "`n-- Riesecuzione (riparazione) --"
$code = Invoke-Install -LocalInstaller $setup
Check 'seconda esecuzione termina con 0' ($code -eq 0) "codice $code"
Check 'eseguibile ancora presente' ($null -ne (Get-InstalledExe))

# 3. Autodiagnosi
Write-Host "`n-- Autodiagnosi --"
$selftest = Join-Path $OutDir 'selftest.json'
Remove-Item -LiteralPath $selftest -Force -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList '--self-test', "`"$selftest`"" -Wait -PassThru
Check 'selftest.json creato' (Test-Path -LiteralPath $selftest) $selftest
$raw = Get-Content -LiteralPath $selftest -Raw
Write-Host $raw
$st = $raw | ConvertFrom-Json
foreach ($key in 'ok', 'appVersion', 'gitPath', 'gitVersion', 'webview2Version', 'configOk', 'dataDirWritable', 'credentialStoreOk', 'errors') {
    Check "selftest contiene '$key'" ($st.PSObject.Properties.Name -contains $key)
}
Check 'selftest: ok = true' ($st.ok -eq $true) ("errori: " + (@($st.errors) -join '; '))
Check '--self-test esce con 0' ($p.ExitCode -eq 0) "codice $($p.ExitCode)"
Check 'selftest: Git incluso trovato' (-not [string]::IsNullOrWhiteSpace([string]$st.gitPath)) ([string]$st.gitPath)
Check 'selftest: versione app' (-not [string]::IsNullOrWhiteSpace([string]$st.appVersion)) ([string]$st.appVersion)

# 4. Disinstallazione
Write-Host "`n-- Disinstallazione --"
$entry = Get-UninstallEntry
$uninst = $null
if ($entry -and $entry.UninstallString) {
    $m = [regex]::Match([string]$entry.UninstallString, '^\s*"([^"]+)"|^\s*(\S+)')
    $uninst = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
}
if (-not $uninst) { $uninst = Join-Path $installDir 'uninstall.exe' }
Check 'disinstallatore trovato' (Test-Path -LiteralPath $uninst) $uninst
# `_?=` fa attendere la fine al disinstallatore NSIS (altrimenti si copia in %TEMP% e ritorna subito).
$p = Start-Process -FilePath $uninst -ArgumentList '/S', "_?=$installDir" -Wait -PassThru
Check 'disinstallazione termina con 0' ($p.ExitCode -eq 0) "codice $($p.ExitCode)"
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $uninst -Force -ErrorAction SilentlyContinue
Check 'eseguibile rimosso' (-not (Test-Path -LiteralPath $exe)) $exe
Check 'voce rimossa da "App installate"' ($null -eq (Get-UninstallEntry))
foreach ($l in $links) {
    if (Test-Path -LiteralPath $l.Path) { Write-Host "  [avviso]   il disinstallatore ha lasciato: $($l.Path)" -ForegroundColor Yellow }
}

Write-Host "`n== Tutti i controlli superati =="
$results | Format-Table -AutoSize | Out-String | Write-Host
exit 0
