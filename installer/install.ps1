<#
.SYNOPSIS
  Installa (o aggiorna, o ripara) Rocket Sync per l'utente corrente. Non servono diritti di amministratore.

.DESCRIPTION
  1. controlla Windows 10 21H2+/11 a 64 bit, spazio libero, TLS 1.2 e proxy di sistema;
  2. installa il runtime WebView2 se manca;
  3. scarica l'ultimo installer dalla pagina delle release e ne verifica l'SHA-256;
  4. chiude Rocket Sync se e' in esecuzione e installa in silenzio, per l'utente corrente;
  5. verifica/crea i collegamenti sul desktop e nel menu Start;
  6. avvia Rocket Sync.

  Rieseguibile in qualsiasi momento (aggiornamento o riparazione). Log: %TEMP%\RocketSync-install.log

  Codici di uscita:
    0   installazione completata
    10  Windows non supportato (serve Windows 10 21H2 o piu' recente, o Windows 11, a 64 bit)
    11  spazio libero insufficiente (servono almeno 500 MB)
    12  impossibile abilitare TLS 1.2 / rete non raggiungibile
    13  indirizzo delle release non configurato (-Owner / -Repo)
    20  download di WebView2 non riuscito
    21  installazione di WebView2 non riuscita
    30  download dell'installer non riuscito
    31  verifica SHA-256 non riuscita (file corrotto o alterato)
    40  impossibile chiudere Rocket Sync in esecuzione
    41  l'installer di Rocket Sync ha fallito
    42  Rocket Sync non trovato dopo l'installazione
    50  collegamenti non creati (l'app e' comunque installata)
    60  avvio di Rocket Sync non riuscito (l'app e' comunque installata)
    99  errore imprevisto

.PARAMETER Owner
  Proprietario (utente/organizzazione) del repository GitHub che pubblica le release.
.PARAMETER Repo
  Nome del repository delle release.
.PARAMETER LocalInstaller
  Percorso di un RocketSync-setup.exe gia' scaricato (salta il download; l'hash si controlla se
  accanto c'e' il file .sha256 oppure se si passa -Sha256).
.PARAMETER Sha256
  Hash atteso dell'installer locale.
.PARAMETER NoLaunch
  Non avviare Rocket Sync alla fine.
.PARAMETER SkipWebView2
  Non controllare/installare WebView2 (solo per prove).

  Le stesse opzioni si possono dare con le variabili d'ambiente ROCKETSYNC_OWNER, ROCKETSYNC_REPO,
  ROCKETSYNC_LOCAL_INSTALLER, ROCKETSYNC_NO_LAUNCH=1 (utile con "irm ... | iex").
#>
param(
    [string]$Owner = $env:ROCKETSYNC_OWNER,
    [string]$Repo = $env:ROCKETSYNC_REPO,
    [string]$LocalInstaller = $env:ROCKETSYNC_LOCAL_INSTALLER,
    [string]$Sha256 = '',
    [switch]$NoLaunch,
    [switch]$SkipWebView2
)

# --- Configurazione (le due righe seguenti vengono impostate dalla pipeline di release) ----------
$DefaultOwner = '@@OWNER@@'
$DefaultRepo = '@@REPO@@'
# ------------------------------------------------------------------------------------------------

$script:AppName = 'Rocket Sync'
$script:InstallerAsset = 'RocketSync-setup.exe'
$script:MinFreeBytes = 500MB
$script:MinWindowsBuild = 19044          # Windows 10 21H2
$script:WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$script:WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
$script:LogPath = Join-Path $env:TEMP 'RocketSync-install.log'
$script:DownloadRetries = 3

# Codici di uscita
$script:Exit = @{
    Ok = 0; UnsupportedOs = 10; NoSpace = 11; Network = 12; NotConfigured = 13
    WebView2Download = 20; WebView2Install = 21; Download = 30; Hash = 31
    CloseApp = 40; InstallerFailed = 41; AppNotFound = 42; Shortcuts = 50; Launch = 60; Unexpected = 99
}

# Errore con codice di uscita (niente classi PowerShell: massima compatibilita' con "irm | iex" su 5.1).
function New-InstallError {
    param([int]$Code, [string]$Message)
    $e = New-Object System.Exception($Message)
    $e.Data['InstallCode'] = $Code
    return $e
}

function Get-InstallErrorCode {
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    if ($ex -and $ex.Data -and $ex.Data.Contains('InstallCode')) { return [int]$ex.Data['InstallCode'] }
    return $null
}

# ================================================================================================
# Log
# ================================================================================================
function Write-Log {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERRORE')][string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $script:LogPath -Value $line -Encoding UTF8 } catch { }
    switch ($Level) {
        'WARN' { Write-Host "  ! $Message" -ForegroundColor Yellow }
        'ERRORE' { Write-Host "  X $Message" -ForegroundColor Red }
        default { Write-Host "  $Message" }
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host $Message -ForegroundColor Cyan
    try { Add-Content -Path $script:LogPath -Value ("`r`n== $Message") -Encoding UTF8 } catch { }
}

# ================================================================================================
# Funzioni pure (testate con Pester, installer/tests/install.Tests.ps1)
# ================================================================================================

# Versione "21H2"/"11" a partire dal numero di build di Windows.
function Get-WindowsFriendlyName {
    param([int]$Build)
    if ($Build -ge 22000) { return "Windows 11 (build $Build)" }
    if ($Build -ge 10240) { return "Windows 10 (build $Build)" }
    return "Windows (build $Build)"
}

# Ritorna $null se la piattaforma e' supportata, altrimenti il motivo (in italiano).
function Test-SupportedPlatform {
    param([int]$Major, [int]$Build, [string]$Architecture, [bool]$Is64BitOs)
    if ($Major -lt 10 -or $Build -lt $script:MinWindowsBuild) {
        return "Serve Windows 10 21H2 (build 19044) o piu' recente, oppure Windows 11. Questo PC ha $(Get-WindowsFriendlyName -Build $Build)."
    }
    if (-not $Is64BitOs) {
        return 'Serve una versione di Windows a 64 bit.'
    }
    $arch = $Architecture.ToUpperInvariant()
    if ($arch -eq 'AMD64' -or $arch -eq 'X64') { return $null }
    if ($arch -eq 'ARM64' -and $Build -ge 22000) { return $null }   # Windows 11 ARM esegue app x64
    return "Architettura del processore non supportata ($Architecture)."
}

function Test-FreeSpace {
    param([long]$FreeBytes, [long]$RequiredBytes = $script:MinFreeBytes)
    return ($FreeBytes -ge $RequiredBytes)
}

function Format-Megabytes {
    param([long]$Bytes)
    return ('{0:N0} MB' -f ($Bytes / 1MB))
}

# "<hash>  nome.exe", "<hash> *nome.exe", "SHA256 (nome) = <hash>" oppure solo "<hash>".
function Get-ExpectedHash {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $m = [regex]::Match($Text, '(?<![0-9A-Fa-f])([0-9A-Fa-f]{64})(?![0-9A-Fa-f])')
    if ($m.Success) { return $m.Groups[1].Value.ToLowerInvariant() }
    return $null
}

function Test-HashMatch {
    param([string]$Expected, [string]$Actual)
    if ([string]::IsNullOrEmpty($Expected) -or [string]::IsNullOrEmpty($Actual)) { return $false }
    return ($Expected.Trim().ToLowerInvariant() -eq $Actual.Trim().ToLowerInvariant())
}

# Indirizzi di download dall'ultima release (https://github.com/<owner>/<repo>/releases/latest/download/...).
function Get-ReleaseUrls {
    param([string]$Owner, [string]$Repo, [string]$Asset = $script:InstallerAsset)
    $bad = '[^A-Za-z0-9._-]'
    if ([string]::IsNullOrWhiteSpace($Owner) -or [string]::IsNullOrWhiteSpace($Repo) `
            -or $Owner.StartsWith('@@') -or $Repo.StartsWith('@@') `
            -or $Owner -match $bad -or $Repo -match $bad) {
        return $null
    }
    $base = "https://github.com/$Owner/$Repo/releases/latest/download"
    return [pscustomobject]@{
        Installer = "$base/$Asset"
        Hash      = "$base/$Asset.sha256"
    }
}

# Sceglie owner/repo: parametro, poi valore predefinito nello script. $null se non configurati.
function Resolve-ReleaseSource {
    param([string]$Owner, [string]$Repo, [string]$DefaultOwner, [string]$DefaultRepo)
    $o = if ([string]::IsNullOrWhiteSpace($Owner)) { $DefaultOwner } else { $Owner }
    $r = if ([string]::IsNullOrWhiteSpace($Repo)) { $DefaultRepo } else { $Repo }
    $urls = Get-ReleaseUrls -Owner $o -Repo $r
    if ($null -eq $urls) { return $null }
    return [pscustomobject]@{ Owner = $o; Repo = $r; Urls = $urls }
}

# Versione di WebView2 dai valori `pv` delle chiavi EdgeUpdate. $Reader riceve un percorso di registro
# e ritorna il valore (o $null). La versione "0.0.0.0" significa "non installato".
function Get-WebView2VersionFromRegistry {
    param([scriptblock]$Reader)
    $id = $script:WebView2ClientId
    $paths = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id"
    )
    foreach ($p in $paths) {
        $v = & $Reader $p
        if (-not [string]::IsNullOrWhiteSpace($v) -and $v -ne '0.0.0.0') { return [string]$v }
    }
    return $null
}

# Percorsi candidati dell'eseguibile installato (per utente).
function Get-AppCandidatePaths {
    param([string]$LocalAppData, [string[]]$InstallLocations = @())
    $exeName = "$($script:AppName).exe"
    $root = $LocalAppData.TrimEnd('\', '/')
    $list = @()
    foreach ($loc in $InstallLocations) {
        if (-not [string]::IsNullOrWhiteSpace($loc)) { $list += ($loc.Trim().Trim('"').TrimEnd('\', '/') + '\' + $exeName) }
    }
    $list += "$root\Programs\$($script:AppName)\$exeName"
    $list += "$root\$($script:AppName)\$exeName"
    return $list
}

function Find-FirstExisting {
    param([string[]]$Paths, [scriptblock]$Exists = { param($p) Test-Path -LiteralPath $p -PathType Leaf })
    foreach ($p in $Paths) { if (& $Exists $p) { return $p } }
    return $null
}

# ================================================================================================
# Sistema
# ================================================================================================
function Get-WindowsInfo {
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    $build = 0
    if ($p -and $p.CurrentBuildNumber) { $build = [int]$p.CurrentBuildNumber }
    elseif ($p -and $p.CurrentBuild) { $build = [int]$p.CurrentBuild }
    $major = 10
    if ($p -and $p.CurrentMajorVersionNumber) { $major = [int]$p.CurrentMajorVersionNumber }
    $arch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
    [pscustomobject]@{
        Major = $major
        Build = $build
        Architecture = $arch
        Is64BitOs = [Environment]::Is64BitOperatingSystem
    }
}

function Get-FreeBytes {
    param([string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path)
    return (New-Object System.IO.DriveInfo($root)).AvailableFreeSpace
}

function Enable-Tls12 {
    try {
        $current = [Net.ServicePointManager]::SecurityProtocol
        $tls12 = [Net.SecurityProtocolType]::Tls12
        [Net.ServicePointManager]::SecurityProtocol = $current -bor $tls12
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288 } catch { }  # TLS 1.3 se disponibile
        return $true
    } catch {
        return $false
    }
}

# Proxy di sistema per un indirizzo: $null se la connessione e' diretta.
function Get-SystemProxyFor {
    param([string]$Url)
    try {
        $uri = [Uri]$Url
        $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        if ($proxy.IsBypassed($uri)) { return $null }
        $p = $proxy.GetProxy($uri)
        if ($p -and $p.AbsoluteUri -ne $uri.AbsoluteUri) { return $p.AbsoluteUri }
    } catch { }
    return $null
}

function Invoke-Download {
    param([string]$Url, [string]$OutFile, [int]$Retries = $script:DownloadRetries)
    $ProgressPreference = 'SilentlyContinue'   # su PowerShell 5.1 la barra rallenta molto i download
    $proxy = Get-SystemProxyFor -Url $Url
    if ($proxy) { Write-Log "Uso il proxy di sistema: $proxy" }
    $last = $null
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            $iwr = @{ Uri = $Url; OutFile = $OutFile; UseBasicParsing = $true; ErrorAction = 'Stop' }
            if ($proxy) { $iwr['Proxy'] = $proxy; $iwr['ProxyUseDefaultCredentials'] = $true }
            Invoke-WebRequest @iwr
            return
        } catch {
            $last = $_.Exception.Message
            Write-Log "Tentativo $i di $Retries non riuscito: $last" 'WARN'
            if ($i -lt $Retries) { Start-Sleep -Seconds (2 * $i) }
        }
    }
    throw $last
}

function Read-RemoteText {
    param([string]$Url)
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-Download -Url $Url -OutFile $tmp
        return [System.IO.File]::ReadAllText($tmp)
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

# ================================================================================================
# Passi
# ================================================================================================
function Assert-Environment {
    Write-Step '1/6  Controllo del computer'
    $win = Get-WindowsInfo
    Write-Log ("Sistema: {0}, architettura {1}" -f (Get-WindowsFriendlyName -Build $win.Build), $win.Architecture)
    $why = Test-SupportedPlatform -Major $win.Major -Build $win.Build -Architecture $win.Architecture -Is64BitOs $win.Is64BitOs
    if ($why) { throw (New-InstallError -Code $script:Exit.UnsupportedOs -Message ($why)) }

    $free = Get-FreeBytes -Path $env:LOCALAPPDATA
    Write-Log ("Spazio libero su {0}: {1}" -f [System.IO.Path]::GetPathRoot($env:LOCALAPPDATA), (Format-Megabytes -Bytes $free))
    if (-not (Test-FreeSpace -FreeBytes $free)) {
        throw (New-InstallError -Code $script:Exit.NoSpace -Message (("Spazio insufficiente: servono almeno {0} liberi, ce ne sono {1}." -f (Format-Megabytes -Bytes $script:MinFreeBytes), (Format-Megabytes -Bytes $free))))
    }

    if (-not (Enable-Tls12)) {
        throw (New-InstallError -Code $script:Exit.Network -Message ('Non riesco ad abilitare TLS 1.2, necessario per scaricare i file in modo sicuro.'))
    }
    Write-Log 'TLS 1.2 abilitato.'

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        Write-Log "Il comando e' in esecuzione come amministratore: non serve, e l'app verrebbe installata nel profilo dell'amministratore." 'WARN'
    }
}

function Get-WebView2Version {
    return Get-WebView2VersionFromRegistry -Reader {
        param($p)
        $item = Get-ItemProperty -Path $p -Name 'pv' -ErrorAction SilentlyContinue
        if ($item) { return $item.pv }
        return $null
    }
}

function Install-WebView2IfMissing {
    Write-Step '2/6  Runtime WebView2'
    $v = Get-WebView2Version
    if ($v) {
        Write-Log "WebView2 gia' presente (versione $v)."
        return
    }
    Write-Log 'WebView2 non trovato: scarico il programma di installazione ufficiale di Microsoft (Evergreen).'
    $boot = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
    try {
        Invoke-Download -Url $script:WebView2BootstrapperUrl -OutFile $boot
    } catch {
        throw (New-InstallError -Code $script:Exit.WebView2Download -Message ("Download di WebView2 non riuscito: $($_.Exception.Message)"))
    }
    try {
        $p = Start-Process -FilePath $boot -ArgumentList '/silent', '/install' -PassThru -Wait
        Write-Log "Programma di installazione di WebView2 terminato con codice $($p.ExitCode)."
    } catch {
        throw (New-InstallError -Code $script:Exit.WebView2Install -Message ("Installazione di WebView2 non riuscita: $($_.Exception.Message)"))
    } finally {
        Remove-Item -LiteralPath $boot -Force -ErrorAction SilentlyContinue
    }
    $v = Get-WebView2Version
    if (-not $v) {
        throw (New-InstallError -Code $script:Exit.WebView2Install -Message ("WebView2 risulta ancora mancante dopo l'installazione. Installalo a mano da https://developer.microsoft.com/microsoft-edge/webview2/ e rilancia questo comando."))
    }
    Write-Log "WebView2 installato (versione $v)."
}

function Get-InstallerFile {
    param($Source, [string]$LocalInstaller, [string]$Sha256)
    Write-Step "3/6  Download di $($script:AppName)"
    $dir = Join-Path $env:TEMP 'RocketSync-install'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir $script:InstallerAsset
    $expected = $null

    if (-not [string]::IsNullOrWhiteSpace($LocalInstaller)) {
        if (-not (Test-Path -LiteralPath $LocalInstaller -PathType Leaf)) {
            throw (New-InstallError -Code $script:Exit.Download -Message ("File dell'installer non trovato: $LocalInstaller"))
        }
        Write-Log "Uso l'installer locale: $LocalInstaller"
        Copy-Item -LiteralPath $LocalInstaller -Destination $file -Force
        if (-not [string]::IsNullOrWhiteSpace($Sha256)) { $expected = Get-ExpectedHash -Text $Sha256 }
        elseif (Test-Path -LiteralPath "$LocalInstaller.sha256") { $expected = Get-ExpectedHash -Text ([System.IO.File]::ReadAllText("$LocalInstaller.sha256")) }
        if (-not $expected) { Write-Log 'Nessun hash fornito per l''installer locale: verifica SHA-256 saltata.' 'WARN' }
    } else {
        Write-Log "Scarico $($Source.Urls.Installer)"
        try {
            Invoke-Download -Url $Source.Urls.Installer -OutFile $file
        } catch {
            throw (New-InstallError -Code $script:Exit.Download -Message ("Download dell'installer non riuscito: $($_.Exception.Message). Controlla la connessione (e il proxy aziendale) e riprova."))
        }
        try {
            $expected = Get-ExpectedHash -Text (Read-RemoteText -Url $Source.Urls.Hash)
        } catch {
            throw (New-InstallError -Code $script:Exit.Hash -Message ("Non riesco a scaricare il file con l'impronta SHA-256: $($_.Exception.Message)"))
        }
        if (-not $expected) {
            throw (New-InstallError -Code $script:Exit.Hash -Message ("Il file .sha256 pubblicato con la release non e' valido."))
        }
    }

    $size = (Get-Item -LiteralPath $file).Length
    Write-Log ("Installer pronto: {0} ({1})" -f $file, (Format-Megabytes -Bytes $size))
    if ($expected) {
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if (-not (Test-HashMatch -Expected $expected -Actual $actual)) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            throw (New-InstallError -Code $script:Exit.Hash -Message ("Impronta SHA-256 diversa da quella pubblicata (attesa $expected, calcolata $($actual.ToLowerInvariant())). Il file e' stato scartato: non e' sicuro installarlo."))
        }
        Write-Log "SHA-256 verificato: $($actual.ToLowerInvariant())"
    }
    return $file
}

function Stop-RocketSync {
    Write-Step "4/6  Installazione"
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $script:AppName -or $_.ProcessName -eq 'rocket-sync' })
    if ($procs.Count -eq 0) { return }
    Write-Log "$($script:AppName) e' in esecuzione: lo chiudo prima di aggiornare."
    foreach ($p in $procs) { try { [void]$p.CloseMainWindow() } catch { } }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $script:AppName -or $_.ProcessName -eq 'rocket-sync' }).Count -gt 0) {
        Start-Sleep -Milliseconds 500
    }
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $script:AppName -or $_.ProcessName -eq 'rocket-sync' })) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Write-Log "Impossibile terminare il processo $($p.Id): $($_.Exception.Message)" 'WARN' }
    }
    Start-Sleep -Seconds 1
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $script:AppName -or $_.ProcessName -eq 'rocket-sync' })
    if ($left.Count -gt 0) {
        throw (New-InstallError -Code $script:Exit.CloseApp -Message ("Non riesco a chiudere $($script:AppName). Chiudilo dall'icona nell'area di notifica (Esci) e rilancia il comando."))
    }
}

function Invoke-NsisInstaller {
    param([string]$Installer)
    Write-Log 'Installazione in silenzio per l''utente corrente (puo'' richiedere un minuto)...'
    try {
        $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
        if (-not $p.WaitForExit(300000)) {
            try { $p.Kill() } catch { }
            throw 'tempo scaduto (5 minuti)'
        }
        $code = $p.ExitCode
    } catch {
        throw (New-InstallError -Code $script:Exit.InstallerFailed -Message ("L'installer non e' partito o non e' terminato: $($_.Exception.Message)"))
    }
    Write-Log "Installer terminato con codice $code."
    if ($code -ne 0) {
        throw (New-InstallError -Code $script:Exit.InstallerFailed -Message ("L'installer ha restituito il codice $code. Dettagli in $script:LogPath."))
    }
}

function Find-InstalledApp {
    $locations = @()
    foreach ($root in 'HKCU:', 'HKLM:') {
        $uninstall = "$root\Software\Microsoft\Windows\CurrentVersion\Uninstall"
        if (Test-Path $uninstall) {
            foreach ($k in Get-ChildItem $uninstall -ErrorAction SilentlyContinue) {
                $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
                if ($p -and $p.DisplayName -eq $script:AppName -and $p.InstallLocation) { $locations += [string]$p.InstallLocation }
            }
        }
    }
    $candidates = Get-AppCandidatePaths -LocalAppData $env:LOCALAPPDATA -InstallLocations $locations
    return Find-FirstExisting -Paths $candidates
}

function Set-AppShortcut {
    param([string]$LinkPath, [string]$Target)
    $shell = New-Object -ComObject WScript.Shell
    try {
        $dir = Split-Path -Parent $LinkPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        if (Test-Path -LiteralPath $LinkPath) {
            $existing = $shell.CreateShortcut($LinkPath)
            if ($existing.TargetPath -eq $Target) {
                Write-Log "Collegamento gia' corretto: $LinkPath"
                return
            }
            Write-Log "Collegamento esistente punta altrove ($($existing.TargetPath)): lo aggiorno." 'WARN'
        }
        $lnk = $shell.CreateShortcut($LinkPath)
        $lnk.TargetPath = $Target
        $lnk.WorkingDirectory = Split-Path -Parent $Target
        $lnk.IconLocation = "$Target,0"
        $lnk.Description = 'Rocket Sync - sincronizzazione dei file OpenRocket'
        $lnk.Save()
        Write-Log "Collegamento creato: $LinkPath"
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

function Confirm-Shortcuts {
    param([string]$Exe)
    Write-Step '5/6  Collegamenti'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$($script:AppName).lnk"
    $failed = @()
    foreach ($link in @((Join-Path $desktop "$($script:AppName).lnk"), $startMenu)) {
        try { Set-AppShortcut -LinkPath $link -Target $Exe }
        catch { $failed += $link; Write-Log "Impossibile creare il collegamento $link : $($_.Exception.Message)" 'WARN' }
    }
    if ($failed.Count -gt 0) {
        throw (New-InstallError -Code $script:Exit.Shortcuts -Message ("Collegamenti non creati: $($failed -join ', '). L'app e' installata in $Exe"))
    }
}

function Start-RocketSync {
    param([string]$Exe)
    Write-Step "6/6  Avvio di $($script:AppName)"
    try {
        Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe)
        Write-Log "$($script:AppName) avviato."
    } catch {
        throw (New-InstallError -Code $script:Exit.Launch -Message ("Non riesco ad avviare $($script:AppName): $($_.Exception.Message). Aprilo dal collegamento sul desktop."))
    }
}

# ================================================================================================
# Programma principale
# ================================================================================================
function Invoke-RocketSyncInstall {
    param([string]$Owner, [string]$Repo, [string]$LocalInstaller, [string]$Sha256, [bool]$NoLaunch, [bool]$SkipWebView2)
    $result = $script:Exit.Ok
    $warning = $null
    try {
        Write-Host ''
        Write-Host "== Installazione di $($script:AppName) ==" -ForegroundColor Green
        Add-Content -Path $script:LogPath -Value ("`r`n==== Installazione avviata {0} (PowerShell {1}) ====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PSVersionTable.PSVersion) -Encoding UTF8 -ErrorAction SilentlyContinue

        $source = $null
        if ([string]::IsNullOrWhiteSpace($LocalInstaller)) {
            $source = Resolve-ReleaseSource -Owner $Owner -Repo $Repo -DefaultOwner $DefaultOwner -DefaultRepo $DefaultRepo
            if ($null -eq $source) {
                throw (New-InstallError -Code $script:Exit.NotConfigured -Message ("Indirizzo delle release non configurato. Rilancia con -Owner <proprietario> -Repo <repository> (oppure imposta ROCKETSYNC_OWNER e ROCKETSYNC_REPO)."))
            }
            Write-Log "Release: https://github.com/$($source.Owner)/$($source.Repo)"
        }

        Assert-Environment
        if ($SkipWebView2) { Write-Step '2/6  Runtime WebView2'; Write-Log 'Saltato su richiesta.' } else { Install-WebView2IfMissing }
        $installer = Get-InstallerFile -Source $source -LocalInstaller $LocalInstaller -Sha256 $Sha256
        Stop-RocketSync
        Invoke-NsisInstaller -Installer $installer
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue

        $exe = Find-InstalledApp
        if (-not $exe) {
            throw (New-InstallError -Code $script:Exit.AppNotFound -Message ("L'installer e' terminato ma non trovo $($script:AppName).exe. Guarda il log in $script:LogPath."))
        }
        Write-Log "Installato in: $exe"

        try { Confirm-Shortcuts -Exe $exe }
        catch { $warning = @{ Code = (Get-InstallErrorCode $_); Message = $_.Exception.Message } }
        if (-not $NoLaunch) {
            try { Start-RocketSync -Exe $exe }
            catch { if (-not $warning) { $warning = @{ Code = (Get-InstallErrorCode $_); Message = $_.Exception.Message } } }
        } else {
            Write-Log 'Avvio saltato su richiesta (-NoLaunch).'
        }

        if ($warning) {
            Write-Log $warning.Message 'WARN'
            $result = if ($warning.Code) { $warning.Code } else { $script:Exit.Unexpected }
        }
    } catch {
        $code = Get-InstallErrorCode $_
        if ($code) {
            Write-Log $_.Exception.Message 'ERRORE'
            $result = $code
        } else {
            Write-Log ("Errore imprevisto: {0}" -f $_.Exception.Message) 'ERRORE'
            Write-Log ($_.ScriptStackTrace) 'ERRORE'
            $result = $script:Exit.Unexpected
        }
    }
    Write-Host ''
    if ($result -eq $script:Exit.Ok) {
        Write-Host "Fatto. $($script:AppName) e' installato." -ForegroundColor Green
    } else {
        Write-Host "Installazione non completata (codice $result). Il log e' in: $script:LogPath" -ForegroundColor Red
    }
    Write-Log "Codice di uscita: $result"
    return $result
}

# Nei test (Pester) lo script viene "dot-sourced" con ROCKETSYNC_INSTALL_NOMAIN=1: si caricano solo le funzioni.
if (-not $env:ROCKETSYNC_INSTALL_NOMAIN) {
    $noLaunchFlag = $NoLaunch.IsPresent -or ($env:ROCKETSYNC_NO_LAUNCH -eq '1')
    $code = Invoke-RocketSyncInstall -Owner $Owner -Repo $Repo -LocalInstaller $LocalInstaller -Sha256 $Sha256 -NoLaunch $noLaunchFlag -SkipWebView2 $SkipWebView2.IsPresent
    exit $code
}
