# MB0 spike (ADR-0044): does the owner's Google refresh token work, with exactly the two read-only scopes, and
# without a 7-day expiry? Run by the owner in their own PowerShell; it prompts for the three values (not echoed)
# and prints only status codes, scopes, lifetime fields and counts, never a secret, token, mail or event text.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Read-Secret([string]$name) {
  $secure = Read-Host -AsSecureString $name
  [Net.NetworkCredential]::new('', $secure).Password
}

$clientId = Read-Secret 'GOOGLE_CLIENT_ID'
$clientSecret = Read-Secret 'GOOGLE_CLIENT_SECRET'
$refreshToken = Read-Secret 'GOOGLE_REFRESH_TOKEN'

$expected = @('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.metadata')
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
if (Compare-Object $scopes $expected) { 'scopes:  MISMATCH (expected exactly gmail.metadata + calendar.readonly)'; $ok = $false }
if ($null -ne $token.refresh_token_expires_in) {
  "refresh token expires in $($token.refresh_token_expires_in) s: the client is probably still in Testing"; $ok = $false
} else { 'refresh token: no expiry reported (In production)' }

$headers = @{ Authorization = "Bearer $($token.access_token)" }
try {
  $cal = Invoke-RestMethod -Uri 'https://www.googleapis.com/calendar/v3/users/me/calendarList?fields=items(id)' -Headers $headers
  "calendar: ok · $(@($cal.items).Count) calendars"
} catch { "calendar: FAILED http=$($_.Exception.Response.StatusCode.value__)"; $ok = $false }
try {
  $null = Invoke-RestMethod -Uri 'https://gmail.googleapis.com/gmail/v1/users/me/labels?fields=labels(id)' -Headers $headers
  'gmail:    ok'
} catch { "gmail:    FAILED http=$($_.Exception.Response.StatusCode.value__)"; $ok = $false }

"stamp:    $(Get-Date -Format 'yyyy-MM-dd HH:mm') · $(if ($ok) { 'SPIKE PASS' } else { 'SPIKE FAIL' })"
