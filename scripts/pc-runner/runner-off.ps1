# PocketRocket PC runner: turn OFF. Stops runner.mjs and everything it started (the ssh tunnel, a running
# claude job, an open confirm dialog). Also finds a runner whose pid file went missing.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$pidFile = Join-Path $dir 'runner.pid'
Add-Type -AssemblyName System.Windows.Forms

$ids = @()
if (Test-Path -LiteralPath $pidFile) {
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($raw -match '^\d+$') {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$raw) -ErrorAction SilentlyContinue
    # Only kill it if that pid is still our runner (pids get reused).
    if ($p -and $p.CommandLine -like '*runner.mjs*') { $ids += [int]$raw }
  }
}
# Any other runner started from this folder.
$runner = Join-Path $dir 'runner.mjs'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) } |
  ForEach-Object { if ($ids -notcontains [int]$_.ProcessId) { $ids += [int]$_.ProcessId } }

foreach ($id in $ids) {
  # /T takes the whole tree: ssh, claude and its shells, the dialog. taskkill gets the pid as an argument, not code.
  & taskkill.exe /PID $id /T /F | Out-Null
}
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }

$msg = if ($ids.Count -gt 0) { 'PocketRocket Runner is OFF.' } else { 'PocketRocket Runner was not running.' }
[void][System.Windows.Forms.MessageBox]::Show($msg, 'PocketRocket Runner', 'OK', 'Information')
