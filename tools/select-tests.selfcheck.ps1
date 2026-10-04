<#
.SYNOPSIS
  Pester-free self-check for tools/select-tests.ps1.

.DESCRIPTION
  Replays the fixture path lists captured from real merged diffs (tools/fixtures/select-tests/*.json)
  plus explicit floor guards, all with -NoJev (deterministic). Fails (exit 1) on any mismatch, so it
  also fails if the deterministic floor is weakened or removed from select-tests.ps1.
#>
$ErrorActionPreference = 'Stop'
$sel = Join-Path $PSScriptRoot 'select-tests.ps1'
$fixturesDir = Join-Path $PSScriptRoot 'fixtures/select-tests'
$pass = 0; $fail = 0

function Assert-Tier([string]$name, [string[]]$paths, [string]$wantTier, [string]$wantSource, [switch]$HighRisk, [switch]$EnableJev) {
    $params = @{ Paths = $paths; NoJev = (-not $EnableJev) }
    if ($HighRisk) { $params.HighRisk = $true }
    $json = & $sel @params
    $got = $json | ConvertFrom-Json
    if ($got.tier -eq $wantTier -and $got.source -eq $wantSource) {
        $script:pass++
        Write-Host ("  PASS {0} -> {1}/{2}" -f $name, $got.tier, $got.source)
    } else {
        $script:fail++
        Write-Host ("  FAIL {0}: got {1}/{2}, want {3}/{4}" -f $name, $got.tier, $got.source, $wantTier, $wantSource) -ForegroundColor Red
    }
}

Write-Host "Replayed diffs (fixtures, -NoJev):"
$fixtures = @(Get-ChildItem -LiteralPath $fixturesDir -Filter *.json | Sort-Object Name)
if ($fixtures.Count -lt 10) { Write-Host ("  FAIL: only {0} fixtures (need >= 10 real merged diffs)" -f $fixtures.Count) -ForegroundColor Red; $fail++ }
foreach ($f in $fixtures) {
    $fx = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
    Assert-Tier $fx.name @($fx.paths) $fx.expected.tier $fx.expected.source
}

Write-Host "Floor guards (fail if the floor is removed):"
Assert-Tier 'floor-worker'    @('apps/worker/src/app.ts')                  'full-e2e' 'floor'
Assert-Tier 'floor-contracts' @('packages/contracts/src/index.ts')         'full-e2e' 'floor'
Assert-Tier 'floor-vaultmd'   @('packages/vault-markdown/src/api.ts')      'full-e2e' 'floor'
Assert-Tier 'floor-lockfile'  @('pnpm-lock.yaml')                          'full-e2e' 'floor'
Assert-Tier 'floor-pkgjson'   @('apps/web/package.json')                   'full-e2e' 'floor'
Assert-Tier 'floor-auth'      @('packages/domain/src/auth.ts')             'full-e2e' 'floor'
Assert-Tier 'floor-docs'      @('docs/checkpoint.md', 'README.md', '.agent/brief.md') 'none' 'floor'
Assert-Tier 'floor-open'      @('apps/web/src/ui/App.tsx')                 'unit-only' 'floor'
Assert-Tier 'floor-highrisk'  @('apps/web/src/ui/App.tsx')                 'full-e2e' 'floor' -HighRisk

Write-Host "Fallback guard (Jev unavailable, no -NoJev):"
$miss = Join-Path ([IO.Path]::GetTempPath()) ('vc-jev-miss-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $miss | Out-Null
$oldProfile = $env:USERPROFILE
try {
    $env:USERPROFILE = $miss
    Assert-Tier 'fallback-no-jev' @('apps/web/src/ui/App.tsx') 'full-e2e' 'fallback' -EnableJev
} finally {
    $env:USERPROFILE = $oldProfile
    Remove-Item -LiteralPath $miss -Force -ErrorAction SilentlyContinue
}

Write-Host ("select-tests self-check: {0} passed, {1} failed" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
