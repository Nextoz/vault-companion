<#
.SYNOPSIS
  Pester-free self-check for tools/rework-report.ps1.

.DESCRIPTION
  Replays worker registry records captured from real overnight runs (tools/fixtures/rework-report/*.json; stuck1 is
  synthetic because no real record was stuck) and checks each outcome, the open/stuck handling, the -Days window and
  the -Reopen overlay. Fails (exit 1) on any mismatch.
#>
$ErrorActionPreference = 'Stop'
$report = Join-Path $PSScriptRoot 'rework-report.ps1'
$fixtures = Join-Path $PSScriptRoot 'fixtures/rework-report'
$now = [datetime]'2026-10-11T13:00:00+02:00'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "rework-selfcheck-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
$reopened = Join-Path $tmp 'reopened.jsonl'
$pass = 0; $fail = 0

function Check([string]$name, $got, $want) {
    if ("$got" -eq "$want") { $script:pass++; Write-Host "  PASS $name = $got" }
    else { $script:fail++; Write-Host "  FAIL $name`: got '$got', want '$want'" -ForegroundColor Red }
}
function Run([int]$days = 7) {
    & $report -Json -Days $days -WorkersDir $fixtures -ReopenedFile $reopened -Now $now | ConvertFrom-Json
}

try {
    Write-Host 'Outcomes (captured records):'
    $r = Run
    $by = @{}; foreach ($s in $r.slices) { $by[$s.task] = $s }
    Check 'mb3b1 brief not reviewable (exit 50)' $by.mb3b1.outcome 'brief'
    Check 'mb3b2 passed after the fix round' $by.mb3b2.outcome 'fixed'
    Check 'gam1a2 still failing after the fix round' $by.gam1a2.outcome 'failing'
    Check 'wl4a fix round never started, handed over failing' $by.wl4a.outcome 'failing'
    Check 'wl4b clean first pass' $by.wl4b.outcome 'first-pass'
    Check 'read1b2 running is open' $by.read1b2.outcome 'open'
    Check 'stuck1 stuck' $by.stuck1.outcome 'stuck'
    Check 'kind defaults to unknown' $by.wl4b.kind 'unknown'
    $flash = $r.byTier | Where-Object tier -eq 'flash'
    Check 'flash finished slices exclude open' $flash.slices 5
    Check 'flash held' $flash.held 1
    Check 'flash held rate' $flash.heldRate 20

    Write-Host 'Window:'
    Check 'records older than -Days are left out' (@((Run 0).slices).Count) 0

    Write-Host 'Reopen overlay:'
    & $report -Reopen wl4b -Reason 'screen did not match the mockup' -ReopenedFile $reopened -Now $now | Out-Null
    $r = Run
    $flash = $r.byTier | Where-Object tier -eq 'flash'
    Check 'a reopened first pass no longer counts as held' $flash.held 0
    Check 'reopened count' $flash.reopened 1
    Check 'reason kept' (($r.slices | Where-Object task -eq 'wl4b').reopened) 'screen did not match the mockup'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

Write-Host "rework-report self-check: $pass passed, $fail failed"
if ($fail) { exit 1 }
