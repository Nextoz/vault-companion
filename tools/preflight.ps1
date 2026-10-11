<#
.SYNOPSIS
  Overnight preflight (owner 2026-10-11): prove each worker path answers while the owner is still awake.
  pwsh -NoProfile -File tools/preflight.ps1     (start-lead.ps1 -Overnight runs it first)

.DESCRIPTION
  One line per check (PASS, WARN or FAIL), every check bounded by its own deadline, so a hang shows up as a FAIL
  instead of a silent night. Exit 1 when any check FAILs. No model tokens are spent: the Codex sandbox check runs
  `codex sandbox` (no model), the provider checks hit free list/balance endpoints, and Jev answers one ~300-token
  question. Keys are read from the Windows user environment inside each check and never printed.

  Why these checks: 2026-10-10/11 nights lost hours to a Jev call that hung before the network (no deadline), the
  Codex elevated sandbox needing a UAC click after an upgrade (error 1223), and an expired Codex login.
#>
param([int]$MinRamGB = 3)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$jev = Join-Path $env:USERPROFILE 'Obsidian Vault/Second Brain/Tools/jev.ps1'
$scratch = 'C:\Dev\vault-companion-clones\_preflight'
$failed = 0

function Check([string]$Name, [int]$Seconds, [scriptblock]$Body, [object[]]$Arguments = @()) {
    $job = Start-Job -ScriptBlock $Body -ArgumentList $Arguments
    $result = if (Wait-Job $job -Timeout $Seconds) {
        try { @(Receive-Job $job -ErrorAction Stop)[-1] } catch { "FAIL|$($_.Exception.Message)" }
    } else { "FAIL|no answer within $Seconds s (hung)" }
    Remove-Job $job -Force
    $level, $detail = "$result" -split '\|', 2
    if ($level -notin 'PASS', 'WARN', 'FAIL') { $level, $detail = 'FAIL', "unexpected result: $result" }
    if ($level -eq 'FAIL') { $script:failed++ }
    Write-Output ('{0} {1}: {2}' -f $level, $Name, $detail)
}

Check 'ram' 30 {
    param($min)
    $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
    # WARN, not FAIL: the Lead already waits for RAM before each launch.
    if ($free -ge $min) { "PASS|{0:N1} GB free" -f $free } else { "WARN|{0:N1} GB free, workers wait until {1} GB" -f $free, $min }
} @($MinRamGB)

Check 'herdr' 10 {
    param($inHerdr)
    if ($inHerdr) { 'PASS|inside Herdr' } else { 'FAIL|not inside Herdr: workers cannot open panes (start Herdr, then the Lead)' }
} @([bool]$env:HERDR_ENV)

Check 'clis' 20 {
    $missing = @('git', 'pnpm', 'codex', 'opencode', 'coderabbit', 'herdr') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($missing) { "FAIL|missing on PATH: $($missing -join ', ')" } else { 'PASS|git, pnpm, codex, opencode, coderabbit, herdr' }
}

Check 'jev' 60 {
    param($jevPath)
    if (-not (Test-Path -LiteralPath $jevPath)) { return "FAIL|$jevPath not found" }
    $t = [Diagnostics.Stopwatch]::StartNew()
    $out = & pwsh -NoProfile -File $jevPath -State 'Preflight check of the overnight build pipeline.' -Ask 'Is this a preflight check?' -TimeoutSeconds 30 -Json 2>&1
    if ($LASTEXITCODE -ne 0) { return "FAIL|exit $LASTEXITCODE`: $(@($out)[-1])" }
    $answer = ($out -join "`n" | ConvertFrom-Json).answers.answer
    if (-not $answer) { return 'FAIL|no answer in the response' }
    'PASS|answered in {0:N0} s' -f $t.Elapsed.TotalSeconds
} @($jev)

Check 'codex-login' 45 {
    $env:CODEX_HOME = 'C:/Dev/tools/vault-companion-codex-home'
    $out = & codex login status 2>&1
    if ($LASTEXITCODE -eq 0) { "PASS|$(@($out)[-1])" } else { "FAIL|codex tier not logged in: run ``codex login`` with CODEX_HOME=$env:CODEX_HOME" }
}

# The elevated Windows sandbox every Codex-driven tier (flash, pro, codex) runs in: a command inside the scratch
# folder must run, and a write outside it must be refused. Error 1223 here means the setup needs a UAC click.
foreach ($home_ in 'C:/Dev/tools/vault-companion-deepseek-home', 'C:/Dev/tools/vault-companion-codex-home') {
    Check "codex-sandbox ($(Split-Path $home_ -Leaf))" 90 {
        param($codexHome, $dir)
        New-Item -ItemType Directory -Force $dir | Out-Null
        Set-Location -LiteralPath $dir
        $env:CODEX_HOME = $codexHome
        $sandbox = @('sandbox', '-c', 'windows.sandbox=elevated', '-c', 'sandbox_mode=workspace-write', '--')
        $inside = & codex @sandbox cmd /c echo preflight-ok 2>&1
        if ($LASTEXITCODE -ne 0 -or -not ($inside -match 'preflight-ok')) {
            $why = @($inside)[-1]
            $hint = if ("$inside" -match '1223') { ' (accept the UAC prompt: run one codex command at the PC)' } else { '' }
            return "FAIL|sandboxed command did not run: $why$hint"
        }
        $outside = 'C:\Dev\vault-companion-preflight-outside.txt'
        & codex @sandbox cmd /c "echo x> $outside" 2>&1 | Out-Null
        if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside; return 'FAIL|sandbox allowed a write outside the workspace' }
        'PASS|runs inside, refuses writes outside'
    } @($home_, $scratch)
}

Check 'deepseek' 30 {
    $key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
    if (-not $key) { return 'FAIL|DEEPSEEK_API_KEY is not set for the user' }
    $b = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 20
    $usd = [double](($b.balance_infos | Where-Object currency -eq 'USD' | Select-Object -First 1).total_balance)
    if (-not $b.is_available) { 'FAIL|account not available' }
    elseif ($usd -lt 2) { "WARN|`$$usd left (owner rule: tell below `$2)" }
    else { "PASS|`$$usd" }
}

Check 'scaleway' 30 {
    $key = [Environment]::GetEnvironmentVariable('SCW_SECRET_KEY', 'User')
    if (-not $key) { return 'FAIL|SCW_SECRET_KEY is not set for the user' }
    $models = (Invoke-RestMethod -Uri 'https://api.scaleway.ai/v1/models' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 20).data.id
    if ($models -contains 'qwen3.5-397b-a17b') { "PASS|$(@($models).Count) models, scw default present" }
    else { 'FAIL|scw default model qwen3.5-397b-a17b is not served' }
}

if ($failed) {
    Write-Output "PREFLIGHT FAILED: $failed check(s). Fix them now, or start with -SkipPreflight to run without those workers."
    exit 1
}
Write-Output 'PREFLIGHT OK'
