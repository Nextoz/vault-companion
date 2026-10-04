<#
.SYNOPSIS
  Deterministic-first test tier selector for a change (path list in, one tier out).

.DESCRIPTION
  Prints JSON { tier, reason, source }. Tiers: none, unit-only, package-tests, full-e2e.

  A deterministic floor decides first (source "floor"):
    - any apps/worker/** path, packages/contracts/**, packages/vault-markdown/**, an auth
      file, package.json or pnpm-lock.yaml => full-e2e
    - docs-only (docs/**, any *.md, .agent/**) => none
    - -HighRisk => full-e2e
  Only when the floor leaves the tier open is ONE Jev -Choose asked (state = path list only,
  never code), bounded to 25 s. unresolved / Jev error / timeout / unparsable => full-e2e
  (source "fallback"). With -NoJev the floor itself answers (open floor => unit-only). The
  result is never below the floor.

.EXAMPLE
  pwsh -NoProfile -File tools/select-tests.ps1 -Paths apps/web/src/ui/App.tsx -NoJev
  pwsh -NoProfile -File tools/select-tests.ps1 -Paths (git diff --name-only main HEAD)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][AllowEmptyCollection()][string[]]$Paths,
    [switch]$HighRisk,
    [switch]$NoJev
)
$ErrorActionPreference = 'Stop'

function Normalize-Paths([string[]]$raw) {
    $out = [Collections.Generic.List[string]]::new()
    foreach ($p in $raw) {
        foreach ($piece in ($p -split "[\r\n,]+")) {
            $t = $piece.Trim()
            if (-not $t) { continue }
            $out.Add(($t -replace '\\', '/' -replace '^\./', ''))
        }
    }
    return , $out.ToArray()
}

function Get-FloorCategory([string[]]$paths) {
    foreach ($p in $paths) {
        if ($p -match '^apps/worker/') { return 'worker write path' }
        if ($p -match '^packages/contracts/') { return 'contracts' }
        if ($p -match '^packages/vault-markdown/') { return 'vault-markdown' }
        if ($p -match '(?i)(^|/)auth[^/]*\.(ts|tsx|js|mjs)$') { return 'auth file' }
        if ($p -match '(?i)(^|/)package\.json$') { return 'dependency manifest' }
        if ($p -match '(?i)(^|/)pnpm-lock\.yaml$') { return 'lockfile' }
    }
    return $null
}

function Test-AllDocs([string[]]$paths) {
    if ($paths.Count -eq 0) { return $false }
    foreach ($p in $paths) {
        if ($p -notmatch '^docs/' -and $p -notmatch '\.md$' -and $p -notmatch '^\.agent/') { return $false }
    }
    return $true
}

function Invoke-JevBounded([string]$JevPath, [string[]]$JevArgs, [int]$TimeoutMs) {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $exe = (Get-Process -Id $PID).Path
    if (-not $exe) { $exe = 'pwsh' }
    $psi.FileName = $exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.ArgumentList.Add('-NoProfile')
    $psi.ArgumentList.Add('-File')
    $psi.ArgumentList.Add($JevPath)
    foreach ($a in $JevArgs) { $psi.ArgumentList.Add($a) }
    $p = [Diagnostics.Process]::new()
    $p.StartInfo = $psi
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    [void]$p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill($true) } catch { }
        return [pscustomobject]@{ timedOut = $true; out = '' }
    }
    return [pscustomobject]@{ timedOut = $false; out = ($outTask.GetAwaiter().GetResult()) }
}

function ConvertFrom-JevJson([string]$text) {
    if (-not $text) { return $null }
    $s = $text.IndexOf('{'); $e = $text.LastIndexOf('}')
    if ($s -lt 0 -or $e -le $s) { return $null }
    try { return ($text.Substring($s, $e - $s + 1) | ConvertFrom-Json) } catch { return $null }
}

function Finish([string]$tier, [string]$reason, [string]$source) {
    [pscustomobject]@{ tier = $tier; reason = $reason; source = $source } | ConvertTo-Json -Compress
    return
}

$paths = Normalize-Paths $Paths
$category = Get-FloorCategory $paths

if ($HighRisk) { Finish 'full-e2e' 'floor: -HighRisk' 'floor' }
elseif ($category) { Finish 'full-e2e' "floor: $category" 'floor' }
elseif (Test-AllDocs $paths) { Finish 'none' 'floor: docs-only' 'floor' }
else {
    $jev = Join-Path $env:USERPROFILE 'Obsidian Vault/Second Brain/Tools/jev.ps1'
    if ($NoJev) { Finish 'unit-only' 'floor: open tier, Jev disabled (-NoJev)' 'floor' }
    elseif (-not (Test-Path -LiteralPath $jev)) { Finish 'full-e2e' 'fallback: Jev not found' 'fallback' }
    else {
        $state = 'Test-tier selection for a change. Changed file paths only (no code): ' + (($paths | ForEach-Object { "'$_'" }) -join ', ')
        $jevArgs = @(
            '-State', $state,
            '-Choose', 'unit-only,package-tests,full-e2e,unresolved',
            '-Instructions', 'Pick the cheapest test tier that still covers this change: full-e2e if it can touch worker routes, contracts, vault-markdown writes, auth or dependencies; package-tests if several files in one package share risk but nothing cross-cutting; unit-only if only local pure code and its tests; unresolved if the path list is insufficient.',
            '-Json'
        )
        $r = Invoke-JevBounded -JevPath $jev -JevArgs $jevArgs -TimeoutMs 25000
        if ($r.timedOut) { Finish 'full-e2e' 'fallback: Jev timeout (25s)' 'fallback' }
        else {
            $obj = ConvertFrom-JevJson $r.out
            $choice = $null
            if ($obj) { $choice = [string]$obj.answers.answer.choice }
            if ($choice -in 'unit-only', 'package-tests', 'full-e2e') { Finish $choice "jev: $choice" 'jev' }
            elseif ($choice -eq 'unresolved') { Finish 'full-e2e' 'fallback: Jev unresolved' 'fallback' }
            else { Finish 'full-e2e' 'fallback: Jev unparsable' 'fallback' }
        }
    }
}
