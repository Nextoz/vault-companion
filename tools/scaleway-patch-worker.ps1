<#
.SYNOPSIS
  Tooling spike: ask a Scaleway model (default qwen3.5-397b-a17b) for a unified diff that patches
  the listed repo files, then apply it in a git clone with `git apply --check`/`git apply`.

.DESCRIPTION
  No app code. Reads a brief plus up to 12 repo-relative files (max 200 KB total) from -Clone,
  sends one chat completion that must return ONLY a unified diff (git format), writes it to
  <clone>/.agent/patch-<Task>.diff and applies it. On a failed `git apply --check` it retries once
  with the git error text; if that still fails the tree is left untouched. One JSON line is
  appended to <clone>/.agent/scaleway-patch.log (never the key, never file text).

  Exit codes: 0 applied, 2 patch would not apply, 3 request/parse failure, 4 bad arguments.

  Key: [Environment]::GetEnvironmentVariable('SCW_SECRET_KEY','User').
  Usage:
    pwsh -NoProfile -File tools/scaleway-patch-worker.ps1 -Clone <abs clone> -Brief <abs brief.md> `
         -Files a,b,c [-Model qwen3.5-397b-a17b] [-Task name]
#>
[CmdletBinding()]
param(
    [string]$Clone,
    [string]$Brief,
    [string[]]$Files = @(),
    [string]$Model = 'qwen3.5-397b-a17b',
    [string]$Task = '',
    [Alias('h', '?')][switch]$Help
)
$ErrorActionPreference = 'Stop'

$script:MaxFiles = 12
$script:MaxBytes = 204800
$script:Endpoint = 'https://api.scaleway.ai/v1/chat/completions'
$script:SystemPrompt = 'return ONLY one unified diff (git format, a/ b/ paths, enough context lines), no prose'

function Get-PatchText {
    param([string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return '' }
    $text = ($Content -replace "`r`n", "`n") -replace "`r", "`n"
    $lines = $text -split "`n"
    $fences = @()
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^```') { $fences += $i } }
    if ($fences.Count -ge 2 -and ($fences[1] - $fences[0]) -ge 2) {
        $body = ($lines[($fences[0] + 1)..($fences[1] - 1)] -join "`n")
    } else {
        $kept = New-Object System.Collections.Generic.List[string]
        foreach ($line in $lines) { if ($line -notmatch '^```') { $kept.Add($line) } }
        $body = ($kept -join "`n")
    }
    $m = [regex]::Match($body, '(?m)^diff --git ')
    if (-not $m.Success) { $m = [regex]::Match($body, '(?m)^--- ') }
    if (-not $m.Success) { return '' }
    if ($m.Index -gt 0) { $body = $body.Substring($m.Index) }
    return $body.Trim("`n")
}

function Test-SafeRepoPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path -match '^[A-Za-z]:') { return $false }
    if ([IO.Path]::IsPathRooted($Path)) { return $false }
    $norm = ($Path -replace '\\', '/').Trim()
    if ($norm.StartsWith('/')) { return $false }
    foreach ($seg in $norm.Split('/')) { if ($seg -eq '..') { return $false } }
    return $true
}

function Test-PathInsideRoot {
    param([string]$Root, [string]$Path)
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Path)) { return $false }
    $sep = [IO.Path]::DirectorySeparatorChar
    $r = [IO.Path]::GetFullPath($Root).TrimEnd($sep, [IO.Path]::AltDirectorySeparatorChar)
    $p = [IO.Path]::GetFullPath($Path)
    $cmp = [StringComparison]::OrdinalIgnoreCase
    return $p.Equals($r, $cmp) -or $p.StartsWith($r + $sep, $cmp)
}

function Test-PayloadSize {
    param([string[]]$Texts, [int]$MaxBytes = 204800)
    $total = 0
    foreach ($t in @($Texts)) {
        if ($null -eq $t) { continue }
        $total += [Text.Encoding]::UTF8.GetByteCount([string]$t)
        if ($total -gt $MaxBytes) { return $false }
    }
    return $true
}

function Get-SafeTaskName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    return ($Name -replace '[^A-Za-z0-9._-]', '_')
}

function Test-PatchScope {
    param([string]$ClonePath, [string]$PatchPath, [string[]]$Allowed)
    $ns = [string](& git -C $ClonePath apply --numstat -z $PatchPath 2>&1)
    if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Reason = 'git apply --numstat could not read the patch' } }
    $allowedSet = @{}
    foreach ($a in @($Allowed)) { $allowedSet[($a -replace '\\', '/').Trim()] = $true }
    foreach ($rec in ($ns -split [string][char]0)) {
        if ([string]::IsNullOrWhiteSpace($rec)) { continue }
        $parts = $rec -split "`t"
        $path = ($parts[$parts.Count - 1] -replace '\\', '/').Trim()
        if (-not $allowedSet.ContainsKey($path)) {
            return @{ Ok = $false; Reason = "patch touches '$path', which is not one of the listed files" }
        }
    }
    $sum = @(& git -C $ClonePath apply --summary $PatchPath 2>&1)
    if ($LASTEXITCODE -ne 0) { return @{ Ok = $false; Reason = 'git apply --summary could not read the patch' } }
    foreach ($line in $sum) {
        if ([string]$line -match '^\s*(create mode|delete mode|mode change|rename|copy)\b') {
            return @{ Ok = $false; Reason = "patch performs a '$($Matches[1])' change, which is not allowed" }
        }
    }
    return @{ Ok = $true; Reason = '' }
}
function Invoke-ScalewayChat {
    param(
        [object[]]$Messages,
        [string]$ModelName,
        [int]$MaxTokens = 16000,
        [double]$Temperature = 0.2,
        [int]$TimeoutSec = 300
    )
    $key = [Environment]::GetEnvironmentVariable('SCW_SECRET_KEY', 'User')
    if (-not $key) { $key = $env:SCW_SECRET_KEY }
    if (-not $key) { throw 'SCW_SECRET_KEY is not set' }
    $body = @{ model = $ModelName; max_tokens = $MaxTokens; temperature = $Temperature; messages = $Messages }
    if ($ModelName -like 'glm*') { $body.reasoning_effort = 'low' }
    $r = Invoke-RestMethod -Uri $script:Endpoint -Method Post -Headers @{ Authorization = "Bearer $key" } `
        -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec $TimeoutSec
    $used = [int]$r.usage.prompt_tokens + [int]$r.usage.completion_tokens
    Remove-Variable key -ErrorAction SilentlyContinue
    return [pscustomobject]@{ content = [string]$r.choices[0].message.content; tokens = $used }
}

function Fail {
    param([int]$Code, [string]$Message)
    [Console]::Error.WriteLine("scaleway-patch-worker: $Message")
    return $Code
}

function Write-Log {
    param([string]$ClonePath, [string]$TaskName, [string]$ModelName, [int]$Attempts, [int]$Tokens, [bool]$Applied)
    $logPath = Join-Path $ClonePath '.agent/scaleway-patch.log'
    $line = @{ tokens = $Tokens; model = $ModelName; task = $TaskName; attempts = $Attempts; applied = $Applied; time = (Get-Date -Format s) } |
        ConvertTo-Json -Compress
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Write-Help {
    $lines = @(
        'scaleway-patch-worker.ps1 -Clone <abs dir> -Brief <abs brief.md> -Files <a,b,c> [-Model <id>] [-Task <name>]',
        'Asks a Scaleway model for one unified diff over the listed repo-relative files and applies it in the clone.',
        'Exit: 0 applied, 2 patch would not apply, 3 request/parse failure, 4 bad arguments.'
    )
    foreach ($l in $lines) { Write-Host $l }
}

function Invoke-Main {
    if ($Help) { Write-Help; return 0 }
    $expanded = New-Object System.Collections.Generic.List[string]
    foreach ($entry in @($Files)) {
        foreach ($part in ([string]$entry -split ',')) {
            $p = $part.Trim()
            if ($p) { $expanded.Add($p) }
        }
    }
    $Files = $expanded.ToArray()


    if ([string]::IsNullOrWhiteSpace($Clone) -or [string]::IsNullOrWhiteSpace($Brief) -or $Files.Count -eq 0) {
        return (Fail 4 'usage: -Clone <abs dir> -Brief <abs brief.md> -Files <a,b,c> [-Model <id>] [-Task <name>]')
    }
    if (-not [IO.Path]::IsPathRooted($Brief) -or -not (Test-Path -LiteralPath $Brief -PathType Leaf)) {
        return (Fail 4 "-Brief must be an existing absolute file: $Brief")
    }
    if (-not (Test-Path -LiteralPath $Clone -PathType Container)) {
        return (Fail 4 "-Clone must be an existing directory: $Clone")
    }
    if ($Files.Count -gt $script:MaxFiles) {
        return (Fail 4 "too many files (max $($script:MaxFiles), got $($Files.Count))")
    }

    $cloneFull = (Resolve-Path -LiteralPath $Clone).Path
    $blocks = New-Object System.Collections.Generic.List[string]
    $texts = New-Object System.Collections.Generic.List[string]
    $normalized = New-Object System.Collections.Generic.List[string]
    foreach ($f in $Files) {
        if (-not (Test-SafeRepoPath $f)) { return (Fail 4 "unsafe repo-relative path: $f") }
        $rel = ($f -replace '\\', '/').Trim()
        $full = [IO.Path]::GetFullPath((Join-Path $cloneFull $rel))
        if (-not (Test-PathInsideRoot $cloneFull $full)) { return (Fail 4 "path escapes the clone: $f") }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return (Fail 4 "file not found in clone: $f") }
        $text = Get-Content -LiteralPath $full -Raw
        $normalized.Add($rel)
        $texts.Add($text)
        $blocks.Add("=== $rel ===")
        $blocks.Add([string]$text)
    }
    if (-not (Test-PayloadSize $texts.ToArray() $script:MaxBytes)) {
        return (Fail 4 "payload exceeds $($script:MaxBytes) bytes")
    }

    if ([string]::IsNullOrWhiteSpace($Task)) { $Task = Get-SafeTaskName ([IO.Path]::GetFileNameWithoutExtension($Brief)) }
    $Task = Get-SafeTaskName $Task
    if ([string]::IsNullOrWhiteSpace($Task)) { $Task = 'patch' }

    $briefText = (Get-Content -LiteralPath $Brief -Raw).TrimEnd()
    $userContent = "$briefText`n`n" + ($blocks -join "`n")
    $messages = @(
        @{ role = 'system'; content = $script:SystemPrompt },
        @{ role = 'user'; content = $userContent }
    )

    $agentDir = Join-Path $cloneFull '.agent'
    New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
    $patchPath = Join-Path $agentDir "patch-$Task.diff"

    $tokens = 0
    $attempts = 0
    $applied = $false

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $attempts = $attempt
        try {
            $resp = Invoke-ScalewayChat -Messages $messages -ModelName $Model
        } catch {
            Write-Log $cloneFull $Task $Model $attempts $tokens $false
            return (Fail 3 "request failed: $($_.Exception.Message)")
        }
        $tokens += $resp.tokens
        $patch = Get-PatchText $resp.content
        if ([string]::IsNullOrWhiteSpace($patch)) {
            Write-Log $cloneFull $Task $Model $attempts $tokens $false
            return (Fail 3 'response contained no unified diff')
        }
        if (-not $patch.EndsWith("`n")) { $patch += "`n" }
        [IO.File]::WriteAllText($patchPath, $patch, (New-Object System.Text.UTF8Encoding($false)))

        $reject = ''
        $scope = Test-PatchScope -ClonePath $cloneFull -PatchPath $patchPath -Allowed $normalized.ToArray()
        if (-not $scope.Ok) {
            $reject = "scope check rejected the patch: $($scope.Reason)"
        } else {
            $check = & git -C $cloneFull apply --check --whitespace=nowarn $patchPath 2>&1
            if ($LASTEXITCODE -ne 0) {
                $reject = (($check | Out-String).Trim())
                if (-not $reject) { $reject = 'git apply --check failed' }
            }
        }

        if (-not $reject) {
            & git -C $cloneFull apply --whitespace=nowarn $patchPath 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Log $cloneFull $Task $Model $attempts $tokens $false
                return (Fail 2 'git apply failed after a passing --check')
            }
            $applied = $true
            break
        }

        $gitErr = $reject
        if ($attempt -eq 1) {
            $messages = @(
                @{ role = 'system'; content = $script:SystemPrompt },
                @{ role = 'user'; content = $userContent },
                @{ role = 'assistant'; content = $patch },
                @{ role = 'user'; content = "That patch was rejected:`n$gitErr`nReturn a corrected unified diff only, in git format." }
            )
        }

    }

    Write-Log $cloneFull $Task $Model $attempts $tokens $applied
    if (-not $applied) {
        Write-Host ("scaleway-patch-worker: task={0} applied=false attempts={1} tokens={2} -> {3}" -f $Task, $attempts, $tokens, $patchPath)
        return 2
    }
    Write-Host ("scaleway-patch-worker: task={0} applied=true attempts={1} tokens={2} files={3} -> {4}" -f $Task, $attempts, $tokens, $normalized.Count, $patchPath)
    return 0
}

if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-Main) }
