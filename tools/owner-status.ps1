<#
.SYNOPSIS
  One-line resource status for owner updates: free RAM, DeepSeek balance, Scaleway GLM local usage estimate.
  pwsh -NoProfile -File tools/owner-status.ps1   (prints e.g. "RAM 6.2/15.4 GB free · DeepSeek $9.42 · GLM ~31k/900k")
  Exit 1 when free RAM is below -MinRamGB (the Lead then posts ACTION NEEDED before launching a worker or e2e).
  Keys are read from the Windows user environment at run time and never printed.
#>
param([double]$MinRamGB = 3)
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$free = $os.FreePhysicalMemory / 1MB
$parts = @(('RAM {0:N1}/{1:N1} GB free' -f $free, ($os.TotalVisibleMemorySize / 1MB)))
try {
    $key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
    $b = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    $usd = ($b.balance_infos | Where-Object currency -eq 'USD' | Select-Object -First 1).total_balance
    $parts += "DeepSeek `$$usd$(if (-not $b.is_available) { ' (UNAVAILABLE)' })"
} catch { $parts += 'DeepSeek balance unknown' } finally { Remove-Variable key -ErrorAction SilentlyContinue }
# Scaleway has no balance API here: the Lead appends {"tokens":N} per GLM run to this local, gitignored ledger.
$ledger = Join-Path $PSScriptRoot '..\.agent\budget\scaleway.jsonl'
$used = 24457  # conservative local accounting before 2026-10-01 (previous Lead)
if (Test-Path -LiteralPath $ledger) { Get-Content -LiteralPath $ledger | ForEach-Object { try { $used += [int]($_ | ConvertFrom-Json).tokens } catch { } } }
$parts += ('GLM ~{0:N0}k/900k (local estimate)' -f ($used / 1000))
$line = $parts -join ' · '
Write-Output $line
if ($free -lt $MinRamGB) { exit 1 }
