<#
.SYNOPSIS
  Offline self-check for tools/intent-review.ps1 (no network, no Scaleway call).

.DESCRIPTION
  Builds a synthetic git clone, then runs intent-review.ps1 twice with self-check-only inputs:
  a canned model response file (proves the JSONL event shape and cut/state -> major severity), and
  -FailNetwork (proves a model/network failure degrades to an advisory error event and never crashes).
  Exit 1 on any failure.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'intent-review.ps1'
$pass = 0; $fail = 0

function Assert-True([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host ("  PASS {0}" -f $Name)
    } else {
        $script:fail++
        Write-Host ("  FAIL {0}{1}" -f $Name, $(if ($Detail) { ": $Detail" } else { '' })) -ForegroundColor Red
    }
}

function New-FakeClone([string]$work) {
    $clone = Join-Path $work 'clone'
    New-Item -ItemType Directory -Force $clone | Out-Null
    git -C $clone init -q | Out-Null
    git -C $clone config user.email 'selfcheck@local'
    git -C $clone config user.name 'selfcheck'
    $ui = Join-Path $clone 'apps/web/src/ui'
    New-Item -ItemType Directory -Force $ui | Out-Null
    Set-Content -LiteralPath (Join-Path $ui 'App.tsx') -Value 'export const App = () => null;' -Encoding utf8
    git -C $clone add -A | Out-Null
    git -C $clone commit -q -m 'base' | Out-Null
    $base = (git -C $clone rev-parse HEAD).Trim()
    Set-Content -LiteralPath (Join-Path $ui 'App.tsx') -Value "export const App = () => null;`n// candidate" -Encoding utf8
    $agent = Join-Path $clone '.agent'
    New-Item -ItemType Directory -Force $agent | Out-Null
    Set-Content -LiteralPath (Join-Path $agent 'brief.md') -Value @('# fake brief', '', '## Outcome', 'Render a card.', '', '## Acceptance', '- card renders') -Encoding utf8
    git -C $clone add -A -- . ':(exclude).agent' | Out-Null
    git -C $clone commit -q -m 'candidate' | Out-Null
    return [pscustomobject]@{ clone = $clone; base = $base }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('vc-intent-review-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    $repo = New-FakeClone $work
    $out = Join-Path $work 'intent.jsonl'
    $resp = Join-Path $work 'canned.json'
    $canned = '[{"severity":"minor","file":"apps/web/src/ui/App.tsx","line":42,"kind":"cut","issue":"hard-coded source stub","fix":"wire the real reader"},{"severity":"minor","file":"apps/web/src/ui/App.tsx","line":44,"kind":"state","issue":"unhandled empty state","fix":"render empty card"}]'
    Set-Content -LiteralPath $resp -Value $canned -Encoding utf8

    Write-Host 'Canned response -> JSONL shape:'
    $output1 = & pwsh -NoProfile -File $script -Clone $repo.clone -Base $repo.base -Task intenttest -Out $out -ResponseFile $resp 2>&1 | Out-String
    $code1 = $LASTEXITCODE
    $events1 = @(Get-Content -LiteralPath $out | Where-Object { $_.Trim().StartsWith('{') } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } })
    $findings1 = @($events1 | Where-Object type -eq 'finding')
    $complete1 = $events1 | Where-Object type -eq 'complete' | Select-Object -Last 1
    Assert-True 'exit-0' ($code1 -eq 0) "got $code1"
    Assert-True 'complete-event' ($null -ne $complete1 -and $complete1.outcome -eq 'completed')
    Assert-True 'two-findings' ($findings1.Count -eq 2) "got $($findings1.Count)"
    Assert-True 'cut-forced-major' ($findings1[0].severity -eq 'major')
    Assert-True 'state-forced-major' ($findings1[1].severity -eq 'major')
    Assert-True 'finding-line' ($findings1[0].codegenInstructions -match 'at line 42')
    Assert-True 'no-secret-output' ($output1 -notmatch 'Bearer\s+\S+')

    Write-Host 'Model/network failure -> advisory:'
    $out2 = Join-Path $work 'intent-fail.jsonl'
    $output2 = & pwsh -NoProfile -File $script -Clone $repo.clone -Base $repo.base -Task intenttest -Out $out2 -FailNetwork 2>&1 | Out-String
    $code2 = $LASTEXITCODE
    $events2 = @(Get-Content -LiteralPath $out2 | Where-Object { $_.Trim().StartsWith('{') } | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } })
    $err2 = $events2 | Where-Object type -eq 'error' | Select-Object -Last 1
    Assert-True 'graceful-exit-1' ($code2 -eq 1) "got $code2"
    Assert-True 'advisory-error-event' ($null -ne $err2 -and $err2.message -match 'simulated model/network failure')
    Assert-True 'no-complete-event' (-not ($events2 | Where-Object type -eq 'complete'))
    Assert-True 'no-findings-on-failure' (-not ($events2 | Where-Object type -eq 'finding'))
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ("intent-review self-check: {0} passed, {1} failed" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
