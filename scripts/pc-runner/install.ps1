# PocketRocket PC runner: install for the current user. No admin, no autostart, no scheduled task.
# Copies the runner to %LOCALAPPDATA%\PocketRocketRunner, creates config.json from the example if there is none,
# and puts "PocketRocket Runner ON" / "PocketRocket Runner OFF" shortcuts on the Desktop.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pc-runner\install.ps1
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'PocketRocketRunner'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'logs') | Out-Null

foreach ($f in @('runner.mjs', 'lib.mjs', 'confirm.ps1', 'runner-on.ps1', 'runner-off.ps1', 'config.example.json', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dest $f) -Force
}
$config = Join-Path $dest 'config.json'
$newConfig = -not (Test-Path -LiteralPath $config)
if ($newConfig) { Copy-Item -LiteralPath (Join-Path $dest 'config.example.json') -Destination $config }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
foreach ($s in @(@{ Name = 'PocketRocket Runner ON'; Script = 'runner-on.ps1'; Icon = 137 }, @{ Name = 'PocketRocket Runner OFF'; Script = 'runner-off.ps1'; Icon = 131 })) {
  $lnk = $shell.CreateShortcut((Join-Path $desktop ($s.Name + '.lnk')))
  $lnk.TargetPath = $ps
  # The script path is one quoted -File argument; a Windows path cannot contain a double quote.
  $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dest $s.Script) + '"'
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',' + $s.Icon
  $lnk.Description = $s.Name
  $lnk.Save()
}

Write-Host "Installed to $dest"
Write-Host "Desktop shortcuts: 'PocketRocket Runner ON' and 'PocketRocket Runner OFF'"
if ($newConfig) { Write-Host "Next: edit $config (folders you allow), then copy the runner token from the hub and run:" }
else { Write-Host "Kept your existing config.json. To (re)pair, copy the runner token from the hub and run:" }
Write-Host ('  node "' + (Join-Path $dest 'runner.mjs') + '" pair')
Write-Host ('Check the config any time with: node "' + (Join-Path $dest 'runner.mjs') + '" check')
