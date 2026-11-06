# PocketRocket PC runner: turn ON. Starts runner.mjs hidden and writes runner.pid next to it.
# Runs as the current user; no admin, no autostart. runner-off.ps1 stops it.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$pidFile = Join-Path $dir 'runner.pid'
Add-Type -AssemblyName System.Windows.Forms

function Say([string]$text, [string]$icon = 'Information') {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'PocketRocket Runner', 'OK', $icon)
}

if (Test-Path -LiteralPath $pidFile) {
  $old = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($old -match '^\d+$') {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$old) -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -like '*runner.mjs*') { Say 'PocketRocket Runner is already ON.'; exit 0 }
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Say 'Node.js was not found on PATH. Install Node 22 or newer first.' 'Error'; exit 1 }

# Validate before going hidden, so a broken config shows up here instead of failing silently.
$runner = Join-Path $dir 'runner.mjs'
# (Windows PowerShell 5.1 turns a native program's stderr into errors; 'Stop' would throw on them.)
$ErrorActionPreference = 'Continue'
$check = & $node.Source $runner check 2>&1 | Out-String
$checkExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($checkExit -ne 0) { Say ("The runner did not start:`r`n`r`n" + $check) 'Error'; exit 1 }
if ($check -match 'token: missing') { Say 'No runner token yet. Copy it from the hub, then run: node runner.mjs pair' 'Error'; exit 1 }

# The script path is passed as one quoted argument (paths can hold spaces); nothing here is evaluated as code.
$proc = Start-Process -FilePath $node.Source -ArgumentList @(('"' + $runner + '"'), 'run') -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ascii
Say ("PocketRocket Runner is ON.`r`n`r`nEvery job still asks you here before it runs. Logs: " + (Join-Path $dir 'logs'))
