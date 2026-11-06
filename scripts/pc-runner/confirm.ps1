# PocketRocket PC runner: the local Run / Refuse dialog for one job.
# Started by runner.mjs as: powershell -File confirm.ps1 -JobFile <temp json>
# The job (bot, room, folder, prompt) is read from that JSON file as data. Nothing from the job is ever placed
# into script text, so a prompt cannot inject PowerShell. Exit code 0 = Run, anything else = Refuse.
# Closing the window, pressing Esc, or no answer before the timeout all refuse.
param([Parameter(Mandatory = $true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
try {
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$timeoutSec = [int]$job.timeoutSec
if ($timeoutSec -le 0) { $timeoutSec = 600 }
$script:left = $timeoutSec
$script:answer = 1

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PocketRocket: run a job on this PC?'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(760, 620)
$form.MinimumSize = New-Object System.Drawing.Size(520, 420)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.ShowInTaskbar = $true

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'
$layout.Padding = New-Object System.Windows.Forms.Padding(12)
$layout.ColumnCount = 1
$layout.RowCount = 4
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
[void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$form.Controls.Add($layout)

$info = New-Object System.Windows.Forms.Label
$info.AutoSize = $true
$info.MaximumSize = New-Object System.Drawing.Size(720, 0)
$tools = ($job.tools -join ', ')
# Plain string concatenation of data into a label's Text: displayed, never executed.
$info.Text = 'Bot: @' + [string]$job.handle + "`r`n" +
  'Room: ' + [string]$job.room + "`r`n" +
  'Folder: ' + [string]$job.folderName + '  (' + [string]$job.folderPath + ')' + "`r`n" +
  'Claude may use: ' + $tools
$layout.Controls.Add($info)

if ($job.mcpServers -and @($job.mcpServers).Count -gt 0) {
  $info.Text = $info.Text + "`r`n" + 'MCP servers: ' + (@($job.mcpServers) -join ', ')
}

# The hint row is a small stack: an optional red warning, then the prompt label.
$hintPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$hintPanel.FlowDirection = 'TopDown'
$hintPanel.AutoSize = $true
$hintPanel.WrapContents = $false
if ($job.runsCode -eq $true) {
  $warn = New-Object System.Windows.Forms.Label
  $warn.AutoSize = $true
  $warn.MaximumSize = New-Object System.Drawing.Size(720, 0)
  $warn.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
  $warn.ForeColor = [System.Drawing.Color]::FromArgb(200, 0, 0)
  $warn.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $warn.Text = 'This job can run code in this folder.'
  $hintPanel.Controls.Add($warn)
}
$hint = New-Object System.Windows.Forms.Label
$hint.AutoSize = $true
$hint.MaximumSize = New-Object System.Drawing.Size(720, 0)
$hint.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 4)
$hint.Text = 'Full prompt. Read it all: Run lets Claude act in this folder with the tools above.'
$hintPanel.Controls.Add($hint)
$layout.Controls.Add($hintPanel)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.ScrollBars = 'Both'
$box.WordWrap = $true
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 10)
$box.Text = ([string]$job.prompt) -replace "`r?`n", "`r`n"
$layout.Controls.Add($box)

$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.FlowDirection = 'RightToLeft'
$bar.Dock = 'Fill'
$bar.AutoSize = $true
$bar.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)

$refuse = New-Object System.Windows.Forms.Button
$refuse.Text = 'Refuse'
$refuse.AutoSize = $true
$refuse.Add_Click({ $script:answer = 1; $form.Close() })

$runBtn = New-Object System.Windows.Forms.Button
$runBtn.Text = 'Run'
$runBtn.AutoSize = $true
$runBtn.Add_Click({ $script:answer = 0; $form.Close() })

$countdown = New-Object System.Windows.Forms.Label
$countdown.AutoSize = $true
$countdown.Padding = New-Object System.Windows.Forms.Padding(0, 6, 12, 0)

$bar.Controls.Add($refuse)
$bar.Controls.Add($runBtn)
$bar.Controls.Add($countdown)
$layout.Controls.Add($bar)

# Esc refuses; Enter does nothing by default, so a stray keypress never approves.
$form.CancelButton = $refuse
$form.Add_Shown({ $refuse.Focus(); $form.Activate() })

function Update-Countdown {
  $m = [math]::Floor($script:left / 60)
  $s = $script:left % 60
  $countdown.Text = ('Refuses automatically in {0}:{1:00}' -f $m, $s)
}
Update-Countdown
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:left--
  if ($script:left -le 0) { $script:answer = 1; $timer.Stop(); $form.Close() } else { Update-Countdown }
})
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()
$form.Dispose()
exit $script:answer
