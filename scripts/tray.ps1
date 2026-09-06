# RxMD system-tray controller.
#
# Runs the RxMD Node server as a hidden child process and puts an "Rx" icon in the
# Windows system tray with a menu to start/stop/restart it, open it, copy its LAN
# and Tailscale addresses, update, and view logs. Uses only built-in Windows
# PowerShell + WinForms — no extra dependencies. Launched hidden via
# scripts\launch-tray.vbs (from install.bat, update.bat, or the Startup shortcut).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Single instance: if a tray is already running, just exit.
$createdNew = $false
$script:Mutex = New-Object System.Threading.Mutex($true, 'Global\RxMD_Tray', [ref]$createdNew)
if (-not $createdNew) { return }

$script:Root        = Split-Path -Parent $PSScriptRoot
Set-Location $script:Root
$script:DataDir     = Join-Path $script:Root 'data'
New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
$script:LogOut      = Join-Path $script:DataDir 'server.out.log'
$script:LogErr      = Join-Path $script:DataDir 'server.err.log'
$script:PidFile     = Join-Path $script:DataDir 'server.pid'
$script:Control     = Join-Path $script:DataDir 'tray.control'
$script:Server      = Join-Path $script:Root 'server\index.js'
$script:ServerProc  = $null

# Ignore any stale control command left over from a previous update.
Remove-Item $script:Control -ErrorAction SilentlyContinue

function Get-Port {
  $cfg = Join-Path $script:Root 'config.json'
  if (Test-Path $cfg) {
    try { return [int]((Get-Content $cfg -Raw | ConvertFrom-Json).port) } catch { }
  }
  return 8787
}

function Test-ServerRunning {
  return ($null -ne $script:ServerProc -and -not $script:ServerProc.HasExited)
}

function Start-Server {
  if (Test-ServerRunning) { return }
  try {
    $script:ServerProc = Start-Process -FilePath 'node' -ArgumentList @("`"$($script:Server)`"") `
      -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $script:LogOut -RedirectStandardError $script:LogErr
    Set-Content -Path $script:PidFile -Value $script:ServerProc.Id
    $script:Notify.ShowBalloonTip(2500, 'RxMD', "Server started on port $(Get-Port).", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Could not start the RxMD server:`n$($_.Exception.Message)", 'RxMD') | Out-Null
  }
}

function Stop-Server {
  if (Test-ServerRunning) {
    try { $script:ServerProc.Kill($true) } catch { try { $script:ServerProc.Kill() } catch { } }
  }
  $script:ServerProc = $null
  Remove-Item $script:PidFile -ErrorAction SilentlyContinue
}

function Restart-Server { Stop-Server; Start-Sleep -Milliseconds 700; Start-Server }

function Get-LanIP {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\.' -and $_.IPAddress -notmatch '^169\.254' } |
      Select-Object -First 1
    if ($ip) { return $ip.IPAddress }
  } catch { }
  return $null
}

function Get-TailscaleIP {
  $cli = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cli) {
    try { $ip = (& tailscale ip -4 2>$null | Select-Object -First 1); if ($ip) { return $ip.Trim() } } catch { }
  }
  # Tailscale uses the 100.64.0.0/10 CGNAT range.
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' } |
      Select-Object -First 1
    if ($ip) { return $ip.IPAddress }
  } catch { }
  return $null
}

function Copy-Text($text) {
  try { [System.Windows.Forms.Clipboard]::SetText($text) } catch { }
  $script:Notify.ShowBalloonTip(1500, 'RxMD', "Copied: $text", [System.Windows.Forms.ToolTipIcon]::Info)
}

function New-TrayIcon {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0b6ab0'))
  $g.FillRectangle($brush, 0, 0, 32, 32)
  $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
  $g.DrawString('Rx', $font, [System.Drawing.Brushes]::White, -1, 5)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return $icon
}

function Exit-Tray {
  $script:Timer.Stop()
  Stop-Server
  $script:Notify.Visible = $false
  $script:Notify.Dispose()
  try { $script:Mutex.ReleaseMutex() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

# ---- tray icon + menu ----
$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Icon = New-TrayIcon
$script:Notify.Text = 'RxMD'
$script:Notify.Visible = $true
$script:Notify.add_DoubleClick({ Start-Process ("http://localhost:$(Get-Port)/") })

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:Notify.ContextMenuStrip = $menu

function New-MenuItem($text, $handler, $enabled = $true) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Text = $text
  $it.Enabled = $enabled
  if ($handler) { $it.add_Click($handler) }
  return $it
}
function Add-Sep { $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null }

# Rebuild the menu each time it opens so status + IPs are current.
$menu.add_Opening({
  $menu.Items.Clear()
  $port = Get-Port
  $running = Test-ServerRunning

  $menu.Items.Add((New-MenuItem ("RxMD server: " + $(if ($running) { 'Running' } else { 'Stopped' }) + "  (port $port)") $null $false)) | Out-Null
  Add-Sep
  $menu.Items.Add((New-MenuItem 'Open in browser' { Start-Process ("http://localhost:$(Get-Port)/") })) | Out-Null
  Add-Sep

  $lan = Get-LanIP
  if ($lan) { $menu.Items.Add((New-MenuItem "LAN:  http://$lan`:$port   (click to copy)" { Copy-Text ("http://$(Get-LanIP):$(Get-Port)") })) | Out-Null }
  else { $menu.Items.Add((New-MenuItem 'LAN:  (no network detected)' $null $false)) | Out-Null }

  $ts = Get-TailscaleIP
  if ($ts) { $menu.Items.Add((New-MenuItem "Tailscale:  http://$ts`:$port   (click to copy)" { Copy-Text ("http://$(Get-TailscaleIP):$(Get-Port)") })) | Out-Null }
  else { $menu.Items.Add((New-MenuItem 'Tailscale:  not detected' $null $false)) | Out-Null }
  Add-Sep

  $menu.Items.Add((New-MenuItem 'Start server' { Start-Server } (-not $running))) | Out-Null
  $menu.Items.Add((New-MenuItem 'Stop server' { Stop-Server } $running)) | Out-Null
  $menu.Items.Add((New-MenuItem 'Restart server' { Restart-Server })) | Out-Null
  Add-Sep
  $menu.Items.Add((New-MenuItem 'Update RxMD (git pull + rebuild)' { Start-Process -FilePath (Join-Path $script:Root 'update.bat') })) | Out-Null
  $menu.Items.Add((New-MenuItem 'View server log' { if (Test-Path $script:LogOut) { Start-Process notepad $script:LogOut } })) | Out-Null
  Add-Sep
  $menu.Items.Add((New-MenuItem 'Exit (stops server)' { Exit-Tray })) | Out-Null
})

# Poll for commands written by update.bat (restart / stop / start / exit).
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 2000
$script:Timer.add_Tick({
  if (Test-Path $script:Control) {
    $cmd = ''
    try { $cmd = (Get-Content $script:Control -Raw).Trim().ToLower() } catch { }
    Remove-Item $script:Control -ErrorAction SilentlyContinue
    switch ($cmd) {
      'restart' { Restart-Server }
      'stop'    { Stop-Server }
      'start'   { Start-Server }
      'exit'    { Exit-Tray }
    }
  }
})
$script:Timer.Start()

Start-Server
[System.Windows.Forms.Application]::Run()
