# Calendar write check (ADR-0048): does the calendar-writer refresh token work with exactly `calendar.events`, can it
# create and delete one test event, and does it avoid the 7-day Testing expiry? Run by the owner in their own PowerShell;
# prompts for the three values (not echoed) and prints only status codes, scopes and lifetime fields, never a secret.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Read-Secret([string]$name) {
  $secure = Read-Host -AsSecureString $name
  [Net.NetworkCredential]::new('', $secure).Password
}

$clientId = Read-Secret 'GOOGLE_CAL_WRITE_CLIENT_ID'
$clientSecret = Read-Secret 'GOOGLE_CAL_WRITE_CLIENT_SECRET'
$refreshToken = Read-Secret 'GOOGLE_CAL_WRITE_REFRESH_TOKEN'

$expected = @('https://www.googleapis.com/auth/calendar.events')
$ok = $true

try {
  $token = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body @{
    client_id = $clientId; client_secret = $clientSecret; refresh_token = $refreshToken; grant_type = 'refresh_token'
  }
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  $reason = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { 'unknown' }
  "refresh: FAILED http=$code error=$reason"
  exit 1
}

$scopes = @($token.scope -split ' ' | Sort-Object)
"refresh: ok · access token lifetime $($token.expires_in) s"
"scopes:  $($scopes -join ' ')"
if (Compare-Object $scopes $expected) { 'scopes:  MISMATCH (expected exactly calendar.events)'; $ok = $false }
if ($null -ne $token.refresh_token_expires_in) {
  "refresh token expires in $($token.refresh_token_expires_in) s: the client is probably still in Testing"; $ok = $false
} else { 'refresh token: no expiry reported (In production)' }

$headers = @{ Authorization = "Bearer $($token.access_token)" }
$base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
$day = (Get-Date).AddYears(1).ToString('yyyy-MM-dd')
$body = @{
  summary = 'VC write check (safe to delete)'; colorId = '8'
  start = @{ date = $day }; end = @{ date = (Get-Date $day).AddDays(1).ToString('yyyy-MM-dd') }
} | ConvertTo-Json -Depth 4
$id = $null
try {
  $created = Invoke-RestMethod -Method Post -Uri "${base}?fields=id" -Headers $headers -ContentType 'application/json' -Body $body
  $id = $created.id
  'create:   ok'
} catch { "create:   FAILED http=$($_.Exception.Response.StatusCode.value__)"; $ok = $false }

if ($id) {
  try { Invoke-RestMethod -Method Delete -Uri "$base/$id" -Headers $headers | Out-Null; 'delete:   ok' }
  catch { "delete:   FAILED http=$($_.Exception.Response.StatusCode.value__) (remove the 'VC write check' event by hand, $day)"; $ok = $false }
  try {
    $g = Invoke-RestMethod -Uri "$base/${id}?fields=status" -Headers $headers
    if ($g.status -eq 'cancelled') { 'gone:     ok (cancelled)' } else { "gone:     NO (status $($g.status))"; $ok = $false }
  } catch { 'gone:     ok (404/410)' }
}

"stamp:    $(Get-Date -Format 'yyyy-MM-dd HH:mm') · $(if ($ok) { 'WRITE SPIKE PASS' } else { 'WRITE SPIKE FAIL' })"
