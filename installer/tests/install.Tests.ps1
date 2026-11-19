# Test Pester 5 di install.ps1: funzioni pure, flusso principale con mock, compatibilita' con PowerShell 5.1.
# Esecuzione:  pwsh -NoProfile -Command "Invoke-Pester installer/tests -Output Detailed"

BeforeAll {
    $env:ROCKETSYNC_INSTALL_NOMAIN = '1'
    if ([string]::IsNullOrEmpty($env:TEMP)) { $env:TEMP = [System.IO.Path]::GetTempPath().TrimEnd('/', '\') }
    if ([string]::IsNullOrEmpty($env:LOCALAPPDATA)) { $env:LOCALAPPDATA = Join-Path $env:TEMP 'localappdata' }
    $script:ScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1'
    $script:HostExe = (Get-Process -Id $PID).Path   # stesso interprete (pwsh o powershell.exe) per i processi figli
    . $script:ScriptPath
}

AfterAll {
    Remove-Item Env:ROCKETSYNC_INSTALL_NOMAIN -ErrorAction SilentlyContinue
}

Describe 'Test-SupportedPlatform' {
    It 'accetta Windows 10 21H2 e successivi a 64 bit' {
        Test-SupportedPlatform -Major 10 -Build 19044 -Architecture 'AMD64' -Is64BitOs $true | Should -BeNullOrEmpty
        Test-SupportedPlatform -Major 10 -Build 19045 -Architecture 'AMD64' -Is64BitOs $true | Should -BeNullOrEmpty
        Test-SupportedPlatform -Major 10 -Build 22631 -Architecture 'AMD64' -Is64BitOs $true | Should -BeNullOrEmpty
    }
    It 'rifiuta Windows 10 precedente alla 21H2 con un messaggio in italiano' {
        $r = Test-SupportedPlatform -Major 10 -Build 19043 -Architecture 'AMD64' -Is64BitOs $true
        $r | Should -Match '21H2'
        $r | Should -Match 'Windows 10 \(build 19043\)'
    }
    It 'rifiuta Windows 8.1 e il 32 bit' {
        Test-SupportedPlatform -Major 6 -Build 9600 -Architecture 'AMD64' -Is64BitOs $true | Should -Not -BeNullOrEmpty
        Test-SupportedPlatform -Major 10 -Build 22000 -Architecture 'x86' -Is64BitOs $false | Should -Match '64 bit'
        Test-SupportedPlatform -Major 10 -Build 22000 -Architecture 'x86' -Is64BitOs $true | Should -Match 'Architettura'
    }
    It 'accetta ARM64 solo da Windows 11 (emulazione x64)' {
        Test-SupportedPlatform -Major 10 -Build 22621 -Architecture 'ARM64' -Is64BitOs $true | Should -BeNullOrEmpty
        Test-SupportedPlatform -Major 10 -Build 19045 -Architecture 'ARM64' -Is64BitOs $true | Should -Not -BeNullOrEmpty
    }
    It 'dice se e'' Windows 10 o 11' {
        Get-WindowsFriendlyName -Build 22631 | Should -BeLike 'Windows 11*'
        Get-WindowsFriendlyName -Build 19045 | Should -BeLike 'Windows 10*'
    }
}

Describe 'Spazio libero' {
    It 'richiede almeno 500 MB' {
        Test-FreeSpace -FreeBytes (500MB - 1) | Should -BeFalse
        Test-FreeSpace -FreeBytes 500MB | Should -BeTrue
        Test-FreeSpace -FreeBytes 40GB | Should -BeTrue
        Test-FreeSpace -FreeBytes 0 | Should -BeFalse
    }
    It 'formatta i megabyte' {
        Format-Megabytes -Bytes (512MB) | Should -Match '^512 MB$'
    }
}

Describe 'Hash SHA-256' {
    $hash = 'A' * 64
    It 'estrae l''hash da tutti i formati usuali' {
        $h = ('0123456789abcdef' * 4)
        Get-ExpectedHash -Text $h | Should -Be $h
        Get-ExpectedHash -Text "$h  RocketSync-setup.exe`n" | Should -Be $h
        Get-ExpectedHash -Text "$h *RocketSync-setup.exe`r`n" | Should -Be $h
        Get-ExpectedHash -Text "SHA256 (RocketSync-setup.exe) = $($h.ToUpper())" | Should -Be $h
        Get-ExpectedHash -Text "  $h" | Should -Be $h
    }
    It 'rifiuta testo che non e'' un hash' {
        Get-ExpectedHash -Text '' | Should -BeNullOrEmpty
        Get-ExpectedHash -Text $null | Should -BeNullOrEmpty
        Get-ExpectedHash -Text 'non un hash' | Should -BeNullOrEmpty
        Get-ExpectedHash -Text ('a' * 63) | Should -BeNullOrEmpty
        Get-ExpectedHash -Text ('a' * 65) | Should -BeNullOrEmpty
        Get-ExpectedHash -Text ('z' * 64) | Should -BeNullOrEmpty
    }
    It 'confronta senza badare a maiuscole e spazi, e non accetta vuoti' {
        Test-HashMatch -Expected 'abc' -Actual 'ABC ' | Should -BeTrue
        Test-HashMatch -Expected 'abc' -Actual 'abd' | Should -BeFalse
        Test-HashMatch -Expected '' -Actual '' | Should -BeFalse
        Test-HashMatch -Expected $null -Actual 'abc' | Should -BeFalse
    }
    It 'calcola lo stesso SHA-256 di un valore noto (Get-FileHash)' {
        $f = Join-Path $env:TEMP 'rs-hash-test.txt'
        [System.IO.File]::WriteAllText($f, 'abc')
        try {
            (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() |
                Should -Be 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        } finally { Remove-Item $f -Force }
    }
}

Describe 'Indirizzi delle release' {
    It 'costruisce gli indirizzi dell''ultima release' {
        $u = Get-ReleaseUrls -Owner 'team-razzi' -Repo 'rocketsync-releases'
        $u.Installer | Should -Be 'https://github.com/team-razzi/rocketsync-releases/releases/latest/download/RocketSync-setup.exe'
        $u.Hash | Should -Be 'https://github.com/team-razzi/rocketsync-releases/releases/latest/download/RocketSync-setup.exe.sha256'
    }
    It 'rifiuta valori mancanti, segnaposto o con caratteri pericolosi' {
        Get-ReleaseUrls -Owner '' -Repo 'x' | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner 'x' -Repo $null | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner '@@OWNER@@' -Repo '@@REPO@@' | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner 'a/b' -Repo 'c' | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner 'a' -Repo 'c;calc' | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner 'a b' -Repo 'c' | Should -BeNullOrEmpty
        Get-ReleaseUrls -Owner 'a' -Repo 'c?x=1' | Should -BeNullOrEmpty
    }
    It 'sceglie parametro, poi valore predefinito' {
        $r = Resolve-ReleaseSource -Owner 'o1' -Repo 'r1' -DefaultOwner 'o2' -DefaultRepo 'r2'
        $r.Owner | Should -Be 'o1'
        $r = Resolve-ReleaseSource -Owner '' -Repo '' -DefaultOwner 'o2' -DefaultRepo 'r2'
        $r.Urls.Installer | Should -BeLike 'https://github.com/o2/r2/*'
        $r = Resolve-ReleaseSource -Owner 'o1' -Repo '' -DefaultOwner 'o2' -DefaultRepo 'r2'
        $r.Repo | Should -Be 'r2'
        Resolve-ReleaseSource -Owner '' -Repo '' -DefaultOwner '@@OWNER@@' -DefaultRepo '@@REPO@@' | Should -BeNullOrEmpty
    }
    It 'nello script consegnato i valori predefiniti sono ancora da configurare' {
        $DefaultOwner | Should -Be '@@OWNER@@'
        $DefaultRepo | Should -Be '@@REPO@@'
    }
}

Describe 'WebView2' {
    It 'usa la chiave EdgeUpdate con l''identificativo del runtime Evergreen' {
        $seen = New-Object System.Collections.ArrayList
        $null = Get-WebView2VersionFromRegistry -Reader { param($p) [void]$seen.Add($p); $null }
        $seen.Count | Should -Be 3
        $seen | ForEach-Object { $_ | Should -BeLike '*EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' }
        $seen[0] | Should -BeLike 'HKLM:*WOW6432Node*'
        $seen[2] | Should -BeLike 'HKCU:*'
    }
    It 'ritorna la prima versione valida e ignora 0.0.0.0' {
        Get-WebView2VersionFromRegistry -Reader { param($p) if ($p -like 'HKLM:*WOW6432Node*') { '120.0.2210.91' } else { '99.0.0.0' } } | Should -Be '120.0.2210.91'
        Get-WebView2VersionFromRegistry -Reader { param($p) if ($p -like 'HKCU:*') { '121.0.1.1' } elseif ($p -like 'HKLM:*') { '0.0.0.0' } } | Should -Be '121.0.1.1'
        Get-WebView2VersionFromRegistry -Reader { param($p) '0.0.0.0' } | Should -BeNullOrEmpty
        Get-WebView2VersionFromRegistry -Reader { param($p) $null } | Should -BeNullOrEmpty
    }
}

Describe 'Ricerca dell''app installata' {
    It 'elenca prima la cartella dichiarata dall''installer e poi i percorsi predefiniti per utente' {
        $c = Get-AppCandidatePaths -LocalAppData 'C:\Users\x\AppData\Local' -InstallLocations @('D:\Custom', '', $null)
        $c[0] | Should -Be 'D:\Custom\Rocket Sync.exe'
        $c.Count | Should -Be 3
        $c[1] | Should -Be 'C:\Users\x\AppData\Local\Programs\Rocket Sync\Rocket Sync.exe'
        $c[2] | Should -Be 'C:\Users\x\AppData\Local\Rocket Sync\Rocket Sync.exe'
    }
    It 'ritorna il primo percorso esistente' {
        Find-FirstExisting -Paths @('a', 'b', 'c') -Exists { param($p) $p -eq 'b' -or $p -eq 'c' } | Should -Be 'b'
        Find-FirstExisting -Paths @('a') -Exists { param($p) $false } | Should -BeNullOrEmpty
    }
}

Describe 'Codici di uscita' {
    It 'sono tutti distinti' {
        $vals = $script:Exit.Values
        ($vals | Select-Object -Unique).Count | Should -Be $vals.Count
    }
    It 'un errore porta il suo codice' {
        $e = New-InstallError -Code 31 -Message 'x'
        try { throw $e } catch { Get-InstallErrorCode $_ | Should -Be 31 }
        try { throw 'altro' } catch { Get-InstallErrorCode $_ | Should -BeNullOrEmpty }
    }
}

Describe 'Get-InstallerFile con un installer locale' {
    BeforeEach {
        $script:fake = Join-Path $env:TEMP 'fake-RocketSync-setup.exe'
        [System.IO.File]::WriteAllBytes($script:fake, [byte[]](1..200))
        $script:good = (Get-FileHash -LiteralPath $script:fake -Algorithm SHA256).Hash.ToLower()
    }
    AfterEach {
        Remove-Item "$($script:fake)*" -Force -ErrorAction SilentlyContinue
    }
    It 'accetta l''hash corretto' {
        $f = Get-InstallerFile -Source $null -LocalInstaller $script:fake -Sha256 $script:good
        Test-Path $f | Should -BeTrue
    }
    It 'legge l''hash dal file .sha256 accanto all''installer' {
        Set-Content "$($script:fake).sha256" "$($script:good.ToUpper())  RocketSync-setup.exe"
        { Get-InstallerFile -Source $null -LocalInstaller $script:fake -Sha256 '' } | Should -Not -Throw
    }
    It 'scarta il file e fallisce con il codice 31 se l''hash non coincide' {
        $err = $null
        try { Get-InstallerFile -Source $null -LocalInstaller $script:fake -Sha256 ('0' * 64) } catch { $err = $_ }
        Get-InstallErrorCode $err | Should -Be 31
        $err.Exception.Message | Should -Match 'SHA-256'
        Test-Path (Join-Path (Join-Path $env:TEMP 'RocketSync-install') 'RocketSync-setup.exe') | Should -BeFalse
    }
    It 'fallisce con il codice 30 se il file non esiste' {
        $err = $null
        try { Get-InstallerFile -Source $null -LocalInstaller (Join-Path $env:TEMP 'non-esiste.exe') -Sha256 '' } catch { $err = $_ }
        Get-InstallErrorCode $err | Should -Be 30
    }
}

Describe 'Get-InstallerFile con download da un server locale' {
    BeforeAll {
        $script:payload = [byte[]](1..250)
        $script:payloadHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($script:payload)).Replace('-', '').ToLower()
        $port = Get-Random -Minimum 20000 -Maximum 40000
        $script:base = "http://127.0.0.1:$port"
        $script:listener = New-Object System.Net.HttpListener
        $script:listener.Prefixes.Add("$script:base/")
        $script:listener.Start()
        $script:worker = [powershell]::Create()
        $null = $script:worker.AddScript({
                param($l, $payload, $hash, $wrongHash)
                while ($l.IsListening) {
                    try { $ctx = $l.GetContext() } catch { break }
                    $path = $ctx.Request.Url.AbsolutePath
                    $body = $null
                    if ($path -eq '/ok/RocketSync-setup.exe') { $body = $payload }
                    elseif ($path -eq '/ok/RocketSync-setup.exe.sha256') { $body = [System.Text.Encoding]::ASCII.GetBytes("$hash  RocketSync-setup.exe`n") }
                    elseif ($path -eq '/bad/RocketSync-setup.exe') { $body = $payload }
                    elseif ($path -eq '/bad/RocketSync-setup.exe.sha256') { $body = [System.Text.Encoding]::ASCII.GetBytes("$wrongHash  RocketSync-setup.exe`n") }
                    if ($null -eq $body) { $ctx.Response.StatusCode = 404; $ctx.Response.Close() }
                    else { $ctx.Response.OutputStream.Write($body, 0, $body.Length); $ctx.Response.Close() }
                }
            }).AddArgument($script:listener).AddArgument($script:payload).AddArgument($script:payloadHash).AddArgument('f' * 64)
        $script:job = $script:worker.BeginInvoke()
        $script:DownloadRetries = 1
        $script:src = { param($dir) [pscustomobject]@{ Urls = [pscustomobject]@{ Installer = "$($script:base)/$dir/RocketSync-setup.exe"; Hash = "$($script:base)/$dir/RocketSync-setup.exe.sha256" } } }
    }
    AfterAll {
        $script:listener.Stop(); $script:listener.Close(); $script:worker.Dispose()
    }
    It 'scarica l''installer e verifica l''hash pubblicato' {
        $f = Get-InstallerFile -Source (& $script:src 'ok') -LocalInstaller '' -Sha256 ''
        (Get-Item $f).Length | Should -Be 250
        (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() | Should -Be $script:payloadHash
    }
    It 'scarta il file e da 31 se l''hash pubblicato non coincide' {
        $err = $null
        try { Get-InstallerFile -Source (& $script:src 'bad') -LocalInstaller '' -Sha256 '' } catch { $err = $_ }
        Get-InstallErrorCode $err | Should -Be 31
    }
    It 'da 30 se il download non riesce (404)' {
        $err = $null
        try { Get-InstallerFile -Source (& $script:src 'assente') -LocalInstaller '' -Sha256 '' } catch { $err = $_ }
        Get-InstallErrorCode $err | Should -Be 30
    }
}

Describe 'Invoke-RocketSyncInstall (flusso con i passi simulati)' {
    BeforeEach {
        Mock Assert-Environment {}
        Mock Install-WebView2IfMissing {}
        Mock Get-InstallerFile { Join-Path $env:TEMP 'x.exe' }
        Mock Stop-RocketSync {}
        Mock Invoke-NsisInstaller {}
        Mock Find-InstalledApp { 'C:\Apps\Rocket Sync\Rocket Sync.exe' }
        Mock Confirm-Shortcuts {}
        Mock Start-RocketSync {}
        Mock Write-Host {}
    }
    It 'senza owner/repo configurati esce con 13 senza fare nulla' {
        $code = Invoke-RocketSyncInstall -Owner '' -Repo '' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false
        $code | Should -Be 13
        Should -Not -Invoke Assert-Environment
        Should -Not -Invoke Get-InstallerFile
    }
    It 'esegue i passi nell''ordine e ritorna 0' {
        $code = Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false
        $code | Should -Be 0
        Should -Invoke Assert-Environment -Times 1 -Exactly
        Should -Invoke Install-WebView2IfMissing -Times 1 -Exactly
        Should -Invoke Stop-RocketSync -Times 1 -Exactly
        Should -Invoke Invoke-NsisInstaller -Times 1 -Exactly
        Should -Invoke Confirm-Shortcuts -Times 1 -Exactly
        Should -Invoke Start-RocketSync -Times 1 -Exactly
    }
    It '-NoLaunch non avvia l''app; -SkipWebView2 salta WebView2' {
        $code = Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $true -SkipWebView2 $true
        $code | Should -Be 0
        Should -Not -Invoke Start-RocketSync
        Should -Not -Invoke Install-WebView2IfMissing
    }
    It 'propaga il codice dell''errore e si ferma' {
        Mock Get-InstallerFile { throw (New-InstallError -Code 31 -Message 'hash') }
        $code = Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false
        $code | Should -Be 31
        Should -Not -Invoke Invoke-NsisInstaller
        Should -Not -Invoke Start-RocketSync
    }
    It 'un errore imprevisto da' {
        Mock Stop-RocketSync { throw 'boom' }
        (Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false) | Should -Be 99
    }
    It 'codice 42 se l''app non si trova dopo l''installazione' {
        Mock Find-InstalledApp { $null }
        (Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false) | Should -Be 42
    }
    It 'collegamenti non creati: codice 50 ma l''app viene comunque avviata' {
        Mock Confirm-Shortcuts { throw (New-InstallError -Code 50 -Message 'lnk') }
        (Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false) | Should -Be 50
        Should -Invoke Start-RocketSync -Times 1 -Exactly
    }
    It 'avvio non riuscito: codice 60' {
        Mock Start-RocketSync { throw (New-InstallError -Code 60 -Message 'avvio') }
        (Invoke-RocketSyncInstall -Owner 'o' -Repo 'r' -LocalInstaller '' -Sha256 '' -NoLaunch $false -SkipWebView2 $false) | Should -Be 60
    }
    It 'con un installer locale non serve owner/repo' {
        (Invoke-RocketSyncInstall -Owner '' -Repo '' -LocalInstaller 'C:\x.exe' -Sha256 '' -NoLaunch $true -SkipWebView2 $true) | Should -Be 0
    }
}

Describe 'Compatibilita'' con Windows PowerShell 5.1 e con "irm | iex"' {
    BeforeAll {
        $tokens = $null; $errors = $null
        $script:Ast = [System.Management.Automation.Language.Parser]::ParseFile($script:ScriptPath, [ref]$tokens, [ref]$errors)
        $script:ParseErrors = $errors
        $script:Raw = [System.IO.File]::ReadAllText($script:ScriptPath)
    }
    It 'si analizza senza errori' {
        $script:ParseErrors.Count | Should -Be 0
    }
    It 'non usa costrutti introdotti dopo la 5.1' {
        # Si confrontano i NOMI dei tipi AST: su Windows PowerShell 5.1 le classi TernaryExpressionAst e
        # PipelineChainAst non esistono, quindi un letterale [..] farebbe fallire il test stesso.
        $newer = @('TernaryExpressionAst', 'PipelineChainAst')
        $bad = $script:Ast.FindAll({
                param($n)
                ($newer -contains $n.GetType().Name) -or
                ($n.GetType().Name -eq 'MemberExpressionAst' -and $n.PSObject.Properties['NullConditional'] -and $n.NullConditional)
            }, $true)
        $bad.Count | Should -Be 0
        $script:Raw | Should -Not -Match '\?\?'
        $script:Raw | Should -Not -Match '-AsHashtable|Join-String|ForEach-Object\s+-Parallel|\$IsWindows|\$IsLinux'
    }
    It 'non usa classi PowerShell (rischio con iex)' {
        $classes = $script:Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TypeDefinitionAst] }, $true)
        $classes.Count | Should -Be 0
    }
    It 'usa solo ASCII per virgolette e trattini (nessun carattere che 5.1 leggerebbe male senza BOM)' {
        $nonAscii = [regex]::Matches($script:Raw, '[\u2010-\u201F\u2026\u00A0\uFEFF]')
        $nonAscii.Count | Should -Be 0
    }
    It 'si carica anche con Get-Content | Invoke-Expression (parametri compresi)' {
        $code = '$env:ROCKETSYNC_INSTALL_NOMAIN=''1''; $env:TEMP=[IO.Path]::GetTempPath(); Get-Content -Raw ''' + $script:ScriptPath + ''' | Invoke-Expression; if ((Test-SupportedPlatform -Major 10 -Build 22000 -Architecture AMD64 -Is64BitOs $true) -eq $null) { ''ok'' }'
        $out = & $script:HostExe -NoProfile -Command $code
        ($out | Select-Object -Last 1) | Should -Be 'ok'
    }
    It 'senza ROCKETSYNC_INSTALL_NOMAIN termina con il codice 13 quando non e'' configurato' {
        $out = & $script:HostExe -NoProfile -Command ('$env:TEMP=[IO.Path]::GetTempPath(); Remove-Item Env:ROCKETSYNC_INSTALL_NOMAIN -ErrorAction SilentlyContinue; & ''' + $script:ScriptPath + '''; exit $LASTEXITCODE') 6>&1
        $LASTEXITCODE | Should -Be 13
        ($out -join "`n") | Should -Match 'non configurato'
    }
}
