<#
.SYNOPSIS
  Offline self-check for tools/handoff-check.ps1 brief-format guard and alternatives advisory.

.DESCRIPTION
  Builds a synthetic git clone and runs handoff-check.ps1 with -FindingsFile (no CodeRabbit/GLM/Jev,
  no network). One fake brief without Acceptance must exit 50; one with Outcome + Acceptance must pass
  and still report the advisory when .agent/handoffs/<task>.md is absent. Exit 1 on any failure.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'handoff-check.ps1'
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

function New-FakeClone([string]$work, [string]$name) {
    $clone = Join-Path $work $name
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
    return [pscustomobject]@{ clone = $clone; base = $base; agent = $agent }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('vc-handoff-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$saved = Join-Path $work 'saved-review.jsonl'
@{ type = 'complete'; outcome = 'completed'; findings = 0; reviewedFiles = @('apps/web/src/ui/App.tsx'); reviewer = 'saved' } |
    ConvertTo-Json -Compress -Depth 6 | Set-Content -LiteralPath $saved -Encoding utf8

try {
    Write-Host 'Brief without Acceptance:'
    $bad = New-FakeClone $work 'bad'
    Set-Content -LiteralPath (Join-Path $bad.agent 'brief.md') -Value @('# fake brief', '', '## Outcome', 'Render a card.') -Encoding utf8
    $out1 = & pwsh -NoProfile -File $script -Clone $bad.clone -Base $bad.base -Task fake -FindingsFile $saved -Intent on -NoJev 2>&1 | Out-String
    $code1 = $LASTEXITCODE
    Assert-True 'exit-50' ($code1 -eq 50) "got $code1"
    Assert-True 'clear-message' ($out1 -match 'BRIEF NOT REVIEWABLE' -and $out1 -match 'missing.*## Acceptance')

    Write-Host 'Brief with Acceptance + missing alternatives advisory:'
    $good = New-FakeClone $work 'good'
    Set-Content -LiteralPath (Join-Path $good.agent 'brief.md') -Value @('# fake brief', '', '## Outcome', 'Render a card.', '', '## Acceptance', '- card renders') -Encoding utf8
    $out2 = & pwsh -NoProfile -File $script -Clone $good.clone -Base $good.base -Task fake -FindingsFile $saved -Intent off -NoJev 2>&1 | Out-String
    $code2 = $LASTEXITCODE
    $summary2 = Get-Content -LiteralPath (Join-Path $good.agent 'check-fake.md') -Raw
    Assert-True 'exit-0' ($code2 -eq 0) "got $code2"
    Assert-True 'clean-verdict' ($out2 -match 'CLEAN \(exit 0\)')
    Assert-True 'alternatives-advisory' ($summary2 -match 'Handoff alternatives: advisory')
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ("handoff-check self-check: {0} passed, {1} failed" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
