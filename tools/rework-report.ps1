<#
.SYNOPSIS
  Rework report: per worker tier and slice kind, how often the first pass held (owner 2026-10-11).
  pwsh -NoProfile -File tools/rework-report.ps1 [-Days 7] [-Json]
  pwsh -NoProfile -File tools/rework-report.ps1 -Reopen <task> -Reason "<why the owner sent it back>"

.DESCRIPTION
  Reads the worker registry (.agent/workers/*.json, written by launch-worker.ps1 and worker-after.ps1); no new
  receipts. Each finished slice gets one outcome:
    first-pass   handoff-check exit 0 without a correction round
    fixed        exit 0 after the one correction round
    failing      handed to the Lead with exit 10/20/30/40 (Lead fixed it or re-sliced)
    brief        exit 50: the Lead's brief was not reviewable (no acceptance bullets)
    stuck        the watcher reported it stuck
  Running, checking and fixing records are listed as open and left out of the rates. A merged slice that the owner
  sends back after review (e.g. a screen built from text that did not match the mockup) is recorded with -Reopen
  in .agent/reopened.jsonl and counts as rework even if its first pass held.
#>
param(
    [int]$Days = 7,
    [switch]$Json,
    [string]$Reopen,
    [string]$Reason,
    # Tests point these at fixtures.
    [string]$WorkersDir = (Join-Path $PSScriptRoot '../.agent/workers'),
    [string]$ReopenedFile = (Join-Path $PSScriptRoot '../.agent/reopened.jsonl'),
    [datetime]$Now = (Get-Date)
)
$ErrorActionPreference = 'Stop'

if ($Reopen) {
    if (-not $Reason) { throw '-Reopen needs -Reason (one line: what the owner found).' }
    New-Item -ItemType Directory -Force (Split-Path $ReopenedFile) | Out-Null
    [ordered]@{ task = $Reopen; at = $Now.ToString('o'); reason = $Reason } | ConvertTo-Json -Compress |
        Add-Content -LiteralPath $ReopenedFile -Encoding utf8
    Write-Output "Recorded rework: $Reopen"
    exit 0
}

function Get-Outcome($r) {
    if ($r.stuckNotified -and $r.state -ne 'ready') { return 'stuck' }
    if ($r.state -ne 'ready') { return 'open' }
    if ([int]$r.exit -eq 50) { return 'brief' }
    $secondRound = $r.round -eq 'fix'
    if ([int]$r.exit -eq 0) { return $(if ($secondRound) { 'fixed' } else { 'first-pass' }) }
    return 'failing'
}

$since = $Now.AddDays(-$Days)
$reopened = @{}
if (Test-Path -LiteralPath $ReopenedFile) {
    Get-Content -LiteralPath $ReopenedFile | Where-Object { $_.Trim() } | ForEach-Object {
        $line = $_ | ConvertFrom-Json
        $reopened[$line.task] = $line.reason
    }
}
$rows = @(Get-ChildItem -LiteralPath $WorkersDir -Filter *.json -ErrorAction SilentlyContinue | ForEach-Object {
    $r = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    $started = [datetime]$r.started
    if ($started -lt $since) { return }
    [pscustomobject]@{
        task = $r.task; tier = $r.tier; kind = $(if ($r.kind) { $r.kind } else { 'unknown' })
        outcome = Get-Outcome $r; reopened = $reopened[$r.task]; started = $started.ToString('yyyy-MM-dd HH:mm')
    }
} | Sort-Object started)

$done = @($rows | Where-Object outcome -ne 'open')
function Summarise([string]$by) {
    $done | Group-Object $by | Sort-Object Name | ForEach-Object {
        $g = @($_.Group)
        $held = @($g | Where-Object { $_.outcome -eq 'first-pass' -and -not $_.reopened }).Count
        [pscustomobject]@{
            $by = $_.Name; slices = $g.Count; held = $held
            fixed = @($g | Where-Object outcome -eq 'fixed').Count; failing = @($g | Where-Object outcome -eq 'failing').Count
            brief = @($g | Where-Object outcome -eq 'brief').Count; stuck = @($g | Where-Object outcome -eq 'stuck').Count
            reopened = @($g | Where-Object reopened).Count
            heldRate = [int][math]::Round(100 * $held / $g.Count)
        }
    }
}
$report = [ordered]@{ days = $Days; slices = $rows; byTier = @(Summarise 'tier'); byKind = @(Summarise 'kind') }
if ($Json) { $report | ConvertTo-Json -Depth 4; exit 0 }

$heldAll = @($done | Where-Object { $_.outcome -eq 'first-pass' -and -not $_.reopened }).Count
Write-Output ("Rework, last {0} days: first pass held on {1} of {2} finished slices ({3} open)." -f $Days, $heldAll, $done.Count, ($rows.Count - $done.Count))
Write-Output ''
Write-Output 'By tier:'; $report.byTier | Format-Table -AutoSize | Out-String -Stream | Where-Object { $_.Trim() }
Write-Output 'By kind:'; $report.byKind | Format-Table -AutoSize | Out-String -Stream | Where-Object { $_.Trim() }
Write-Output 'Slices:'; $rows | Format-Table task, tier, kind, outcome, reopened, started -AutoSize | Out-String -Stream | Where-Object { $_.Trim() }
