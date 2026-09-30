# Prepare the isolated worker Codex home and print the visible-agent launch command.
# The API key is never read or printed here: the launch command uses AGENT_USER_ENV, which agent-pane.sh
# looks up from the Windows User scope at run time and writes into the runner (the value never appears).
# Usage: pwsh -NoProfile -File tools/start-worker.ps1 -Clone <dir> -Envelope <file> [options]
param(
  [Parameter(Mandatory=$true)][string]$Clone,
  [Parameter(Mandatory=$true)][string]$Envelope,
  [string]$Provider = 'deepseek',
  [string]$Model,
  [string]$Effort = 'high',
  [string]$CodexHome = 'C:/Dev/tools/vault-companion-codex-home',
  [string]$Sandbox = 'workspace-write'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$profile = Get-Content (Join-Path $repo 'tools/profiles/worker.profile.json') -Raw | ConvertFrom-Json

$models = @($profile.models.PSObject.Properties | ForEach-Object { [string]$_.Value })
if ([string]::IsNullOrWhiteSpace($Model)) { $Model = $profile.defaultModel }

# Pinned worker-profile guards.
if ($profile.memories -ne $false) { throw 'worker profile must disable memories' }
if ($profile.mcp -ne $false) { throw 'worker profile must disable MCP' }
if ($profile.sandbox -ne 'workspace-write') { throw 'worker sandbox must default to workspace-write' }

if ($Provider -ne 'deepseek') { throw "unsupported provider: $Provider" }
if ($Model -notin $models) { throw "unknown DeepSeek model: $Model" }

# Ensure the minimal isolated Codex home exists. Only the pinned config is copied; auth/credentials are never touched.
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$dest = Join-Path $CodexHome 'config.toml'
if (-not (Test-Path $dest)) { Copy-Item -LiteralPath (Join-Path $repo 'tools/profiles/worker.codex.toml') -Destination $dest }
$existing = Get-Content $dest -Raw
if ($existing -match '(?im)^\s*\[mcp_servers\]' -or $existing -match '(?im)^\s*mcp_servers\s*=') { throw 'worker Codex home must not define MCP servers' }
if ($existing -notmatch '(?im)^\s*memories\s*=\s*false') { throw 'worker Codex home must disable memories' }
if ($existing -notmatch '(?im)^\s*generate_memories\s*=\s*false') { throw 'worker Codex home must disable memory generation' }
if ($existing -notmatch '(?im)^\s*use_memories\s*=\s*false') { throw 'worker Codex home must disable memory use' }

$schema = Join-Path $repo 'tools/profiles/handoff.schema.json'
$label = "$Provider-$Model-$Effort · worker"
$envPrefix = if ($Provider -eq 'deepseek') { 'AGENT_USER_ENV=DEEPSEEK_API_KEY ' } else { '' }
$agentPane = (($repo -replace '\\', '/') + '/tools/agent-pane.sh')
$launcher = (($repo -replace '\\', '/') + '/tools/worker-launch.mjs')
$launch = "${envPrefix}bash `"$agentPane`" `"$label`" `"$Clone`" `"$Clone/.agent/run.log`" node `"$launcher`" --clone `"$Clone`" --envelope `"$Envelope`" --provider $Provider --model $Model --effort $Effort --sandbox $Sandbox --codex-home `"$CodexHome`" --coordinator `"$repo`""

Write-Output "Worker Codex home: $CodexHome"
Write-Output "Handoff schema:    $schema"
Write-Output "Launch (run from inside Herdr; DEEPSEEK_API_KEY is looked up at run time, never shown):"
Write-Output $launch
