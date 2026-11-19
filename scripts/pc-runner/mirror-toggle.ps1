# PocketRocket Mirror pause-resume: toggles the mirror.paused file next to config.json.
# While that file exists, the runner sends no Claude Code session entries to the hub (checked every few seconds).
$ErrorActionPreference = 'Stop'
$flag = Join-Path $PSScriptRoot 'mirror.paused'
Add-Type -AssemblyName System.Windows.Forms

function Say([string]$text) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'PocketRocket Mirror', 'OK', 'Information')
}

if (Test-Path -LiteralPath $flag) {
  Remove-Item -LiteralPath $flag -Force
  Say "Mirror RESUMED.`r`n`r`nNew lines of your Claude Code sessions are sent to PocketRocket again (only while the Runner is ON)."
} else {
  Set-Content -LiteralPath $flag -Value 'paused' -Encoding ascii
  Say "Mirror PAUSED.`r`n`r`nNothing from your Claude Code sessions is sent until you press this shortcut again."
}
