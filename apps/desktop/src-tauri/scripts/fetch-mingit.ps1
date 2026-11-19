<#
.SYNOPSIS
  Scarica MinGit (Git for Windows, edizione minima) e lo estrae in resources\mingit.

.DESCRIPTION
  La versione e l'SHA-256 sono fissati qui sotto: se il file scaricato non corrisponde, lo script
  si ferma e non estrae nulla. La cartella resources\mingit NON è nel repository (è ignorata da
  git): si popola in CI prima di "tauri build", oppure a mano con questo script.

  Per aggiornare MinGit: cambiare $Version/$Tag, scaricare il file, calcolare lo SHA-256
  (Get-FileHash) e confrontarlo con quello pubblicato nelle note della release su
  https://github.com/git-for-windows/git/releases, poi aggiornare $Sha256.

  Rocket Sync richiede git >= 2.40 (git merge-tree --write-tree --merge-base).

.EXAMPLE
  pwsh -File scripts/fetch-mingit.ps1
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\resources\mingit')
)

$ErrorActionPreference = 'Stop'

$Version = '2.47.1'
$Tag     = 'v2.47.1.windows.1'
$File    = "MinGit-$Version-64-bit.zip"
$Sha256  = '50b04b55425b5c465d076cdb184f63a0cd0f86f6ec8bb4d5860114a713d2c29a'
$Url     = "https://github.com/git-for-windows/git/releases/download/$Tag/$File"

$Destination = [System.IO.Path]::GetFullPath($Destination)
$GitExe = Join-Path $Destination 'cmd\git.exe'

if (Test-Path $GitExe) {
    $current = & $GitExe --version 2>$null
    if ($current -like "git version $Version.*") {
        Write-Host "MinGit $Version già presente in $Destination"
        exit 0
    }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mingit-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp $File
    Write-Host "Scarico $Url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing

    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        throw "SHA-256 non corrispondente per $File`n  atteso:   $Sha256`n  trovato:  $actual"
    }
    Write-Host "SHA-256 verificato."

    if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    Expand-Archive -Path $zip -DestinationPath $Destination -Force

    if (-not (Test-Path $GitExe)) {
        throw "Estrazione incompleta: manca $GitExe"
    }
    $v = & $GitExe --version
    Write-Host "Installato: $v in $Destination"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
