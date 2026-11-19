<#
.SYNOPSIS
  Controlla con il parser di PowerShell che i file indicati non abbiano errori di sintassi.
  Esce con 1 al primo file con errori (li elenca tutti, con riga e colonna).

.PARAMETER Path
  File .ps1 o cartelle (cercate ricorsivamente).
#>
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Path)

$files = @()
foreach ($p in $Path) {
    if (Test-Path -LiteralPath $p -PathType Container) {
        $files += Get-ChildItem -LiteralPath $p -Recurse -Filter '*.ps1' -File |
            Where-Object { $_.FullName -notmatch '[\\/](node_modules|target|\.git)[\\/]' } |
            ForEach-Object { $_.FullName }
    } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
        $files += (Resolve-Path -LiteralPath $p).Path
    } else {
        Write-Host "Percorso inesistente: $p" -ForegroundColor Red
        exit 2
    }
}

$bad = 0
foreach ($f in $files) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $bad++
        foreach ($e in $errors) {
            Write-Host ("{0}:{1}:{2}: errore di sintassi: {3}" -f $f, $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message) -ForegroundColor Red
            Write-Host "::error file=$f,line=$($e.Extent.StartLineNumber)::$($e.Message)"
        }
    }
}
Write-Host ("Controllati {0} file PowerShell, {1} con errori." -f $files.Count, $bad)
if ($bad -gt 0) { exit 1 }
exit 0
