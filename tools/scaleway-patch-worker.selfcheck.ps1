<#
.SYNOPSIS
  Offline self-check for tools/scaleway-patch-worker.ps1 (no network, no Scaleway call).

.DESCRIPTION
  Dot-sources the worker (its main body is guarded by an InvocationName check) and exercises the
  pure helpers: unified-diff extraction from fenced/unfenced text, repo-relative path validation,
  clone-containment, size cap and task-name sanitising. Exit 1 on any failure.
#>
$ErrorActionPreference = 'Stop'
$worker = Join-Path $PSScriptRoot 'scaleway-patch-worker.ps1'
. $worker
$pass = 0; $fail = 0

function Assert-Eq {
    param([string]$Name, $Got, $Want)
    if ([string]$Got -eq [string]$Want) {
        $script:pass++
        Write-Host ("  PASS {0}" -f $Name)
    } else {
        $script:fail++
        Write-Host ("  FAIL {0}: got [{1}] want [{2}]" -f $Name, $Got, $Want) -ForegroundColor Red
    }
}

$nl = "`n"
$fence = '```'
$diff = @(
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new'
) -join $nl

Write-Host 'Diff extraction:'
Assert-Eq 'unfenced' (Get-PatchText $diff) $diff
Assert-Eq 'fenced' (Get-PatchText ($fence + 'diff' + $nl + $diff + $nl + $fence)) $diff
Assert-Eq 'fenced-preamble' (Get-PatchText ('Here it is:' + $nl + $nl + $fence + 'diff' + $nl + $diff + $nl + $fence + $nl + 'done')) $diff
Assert-Eq 'no-fence-only-hunk' (Get-PatchText ('--- a/f.txt' + $nl + '+++ b/f.txt' + $nl + '@@ -1 +1 @@' + $nl + '-old' + $nl + '+new')) ('--- a/f.txt' + $nl + '+++ b/f.txt' + $nl + '@@ -1 +1 @@' + $nl + '-old' + $nl + '+new')
Assert-Eq 'empty' (Get-PatchText '') ''
Assert-Eq 'prose-only' (Get-PatchText 'I could not produce a patch.') ''

Write-Host 'Path validation:'
Assert-Eq 'safe-simple' (Test-SafeRepoPath 'src/app.ts') $true
Assert-Eq 'safe-backslash' (Test-SafeRepoPath 'packages\domain\src\x.ts') $true
Assert-Eq 'bad-parent' (Test-SafeRepoPath '..\x') $false
Assert-Eq 'bad-parent-mid' (Test-SafeRepoPath 'a/../b') $false
Assert-Eq 'bad-abs-win' (Test-SafeRepoPath 'C:\Dev\x') $false
Assert-Eq 'bad-abs-unix' (Test-SafeRepoPath '/etc/passwd') $false
Assert-Eq 'bad-unc' (Test-SafeRepoPath '\\srv\share\x') $false
Assert-Eq 'bad-drive-relative' (Test-SafeRepoPath 'C:x') $false
Assert-Eq 'bad-empty' (Test-SafeRepoPath '') $false

Write-Host 'Clone containment:'
Assert-Eq 'inside' (Test-PathInsideRoot 'C:\tmp\clone' 'C:\tmp\clone\a\b') $true
Assert-Eq 'inside-self' (Test-PathInsideRoot 'C:\tmp\clone' 'C:\tmp\clone') $true
Assert-Eq 'outside-sibling' (Test-PathInsideRoot 'C:\tmp\clone' 'C:\tmp\cloneX\b') $false
Assert-Eq 'outside-parent' (Test-PathInsideRoot 'C:\tmp\clone' 'C:\tmp\b') $false

Write-Host 'Size cap:'
Assert-Eq 'under' (Test-PayloadSize @('hello', 'world') 204800) $true
Assert-Eq 'exact' (Test-PayloadSize @('x' * 100) 100) $true
Assert-Eq 'one-over' (Test-PayloadSize @('x' * 101) 100) $false
Assert-Eq 'aggregate-over' (Test-PayloadSize @(('x' * 150000), ('y' * 150000)) 204800) $false

Write-Host 'Task name:'
Assert-Eq 'sanitize' (Get-SafeTaskName 'sc2a/b c') 'sc2a_b_c'
Assert-Eq 'keep-dots' (Get-SafeTaskName 'my-task.v2') 'my-task.v2'
Assert-Eq 'blank' (Get-SafeTaskName '   ') ''

Write-Host ("scaleway-patch-worker self-check: {0} passed, {1} failed" -f $pass, $fail)
if ($fail -gt 0) { exit 1 }
exit 0
