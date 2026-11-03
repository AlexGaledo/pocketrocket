# Opens PocketRocket on the VPS from this PC, with no token to paste: starts the SSH tunnel if it is not up,
# reads the hub token over SSH, and opens the app with the token in the URL fragment. Fragments are never sent
# to a server, and the page strips it on load (packages/web/src/lib/auth.ts). The token is never written to disk.
# -NoBrowser checks everything except opening the page, without printing the token.
param(
  [string]$HostAlias = 'crm-agency',
  [int]$Port = 7790,
  [string]$InstallDir = '/home/pocketrocket-crew/pocketrocket-crew',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

function Stop-WithMessage([string]$text) {
  if ($NoBrowser) { Write-Error $text }
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show($text, 'PocketRocket')
  exit 1
}

function Test-Hub {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health"
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (-not (Test-Hub)) {
  Start-Process ssh -WindowStyle Hidden -ArgumentList @(
    '-N', '-L', "${Port}:127.0.0.1:$Port",
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    $HostAlias
  )
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Hub)) {
    if ((Get-Date) -gt $deadline) { Stop-WithMessage "Could not reach PocketRocket through SSH on $HostAlias. Check the server is up and that 'ssh $HostAlias' works in a terminal." }
    Start-Sleep -Milliseconds 500
  }
}

$token = (& ssh -o BatchMode=yes $HostAlias "cat $InstallDir/data/hub-token" | Out-String).Trim()
if (-not $token) { Stop-WithMessage "Could not read the hub token from $HostAlias." }

if ($NoBrowser) {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Headers @{ Authorization = "Bearer $token" } "http://127.0.0.1:$Port/api/bots"
  Write-Output "Tunnel up, token accepted: HTTP $($r.StatusCode)"
  exit 0
}

Start-Process ("http://127.0.0.1:$Port/#token=" + [uri]::EscapeDataString($token))
