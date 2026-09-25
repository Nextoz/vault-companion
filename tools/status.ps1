# Live view of what the Vault Companion workers are doing. Run in its own pane:
#   pwsh -NoProfile -File tools/status.ps1          (refreshes every 30 s; Ctrl+C to stop)
param([int]$Every = 30, [string]$Scratch = "$env:LOCALAPPDATA\Temp\claude\C--Dev-vault-companion\005c759d-a07c-46b8-86c8-f2b116cee581\scratchpad")
$repo = Split-Path -Parent $PSScriptRoot
while ($true) {
  Clear-Host
  "=== Vault Companion status  $(Get-Date -Format 'HH:mm:ss') ==="
  ""
  "--- Herdr agents (local Claude workers/reviewers)"
  try { (herdr agent list | ConvertFrom-Json).result.agents | ForEach-Object { "  {0,-16} {1,-7} {2}" -f ($_.name ?? '(lead)'), $_.agent_status, $_.cwd } } catch { "  (herdr not available)" }
  ""
  "--- Codex (Astra) runs: last lines of each active log"
  Get-ChildItem $Scratch -Filter '*-run.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-3) } | Sort-Object LastWriteTime -Descending | ForEach-Object {
    $done = Select-String -Path $_.FullName -Pattern '^(\w+ DONE|\w+ BLOCKED|VERDICT:|ERROR:)' -CaseSensitive -ErrorAction SilentlyContinue | Select-Object -Last 1
    $age = [int]((Get-Date) - $_.LastWriteTime).TotalMinutes
    "  [{0}] updated {1} min ago {2}" -f $_.BaseName, $age, ($(if ($done) { "=> $($done.Line)" } else { '(running)' }))
    Get-Content $_.FullName -Tail 3 -ErrorAction SilentlyContinue | ForEach-Object { "      " + ($_ -replace '\s+', ' ').Substring(0, [Math]::Min(110, ($_ -replace '\s+', ' ').Length)) }
  }
  ""
  "--- Cloud sessions (open in browser)  — from docs/plan.md"
  Select-String -Path "$repo\docs\plan.md" -Pattern 'session_[A-Za-z0-9]+' -AllMatches | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique | ForEach-Object { "  https://claude.ai/code/$_" }
  ""
  "--- Worker branches on GitHub"
  git -C $repo fetch -q origin 2>$null
  git -C $repo branch -r --list 'origin/agent/*' | ForEach-Object { "  " + $_.Trim() }
  ""
  "--- Open pull requests (CodeRabbit reviews these)"
  try { gh pr list --repo Nextoz/vault-companion --json number,title,headRefName,reviewDecision --jq '.[] | "  #\(.number) \(.headRefName)  \(.title)"' } catch { "  (gh not available)" }
  ""
  "Next refresh in $Every s.  Plan: docs/plan.md   Checkpoint: docs/checkpoint.md"
  Start-Sleep -Seconds $Every
}
