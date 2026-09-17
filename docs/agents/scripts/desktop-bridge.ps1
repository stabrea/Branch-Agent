# Runs a command on the owner's real desktop, from an SSH session that has none.
#
# An SSH login on Windows lands in a non-interactive session with no desktop attached, so anything
# that draws a window cannot run there — not because it lacks permission, but because there is no
# screen for it to draw on. This is the bridge across that gap: a scheduled task registered against
# the owner's own interactive logon, which the SSH session triggers. Whatever it runs appears on the
# real screen, with the owner's full rights, and nothing is prompted.
#
# Set it up once (from anywhere, including over SSH):
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File docs/agents/scripts/desktop-bridge.ps1 -Install
#
# Then, from the Mac over SSH:
#
#     powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Run 'notepad.exe'
#     powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Run 'npm run package:desktop' -Wait
#
# The command's own output is written beside the queue file and printed when -Wait is given, so a
# build or a test run on the desktop reports back the way a local one would.
param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$Run,
  [switch]$Wait,
  [int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
$taskName = 'BranchAgentDesktopBridge'
$home_    = [Environment]::GetFolderPath('UserProfile')
$dir      = Join-Path $home_ '.branch-desktop-bridge'
$queue    = Join-Path $dir 'command.ps1'
$output   = Join-Path $dir 'output.txt'
$done     = Join-Path $dir 'done.txt'

function Ensure-Dir { if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } }

if ($Install) {
  Ensure-Dir
  # -WindowStyle Hidden on the host shell only: what the queued command opens is its own business,
  # and it opens on the real desktop.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $queue + '"')
  # "Run only when the user is logged on" is the whole point: it is what puts the command on the
  # desktop instead of in another session-0 shell no better than SSH itself.
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::FromHours(6)) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Write-Output "installed: $taskName"
  exit 0
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "removed: $taskName"
  exit 0
}

if (-not $Run) { Write-Output "nothing to run. Use -Install, -Uninstall, or -Run '<command>'."; exit 2 }

Ensure-Dir
Remove-Item $output, $done -ErrorAction SilentlyContinue
# The command is written to a file rather than passed as an argument: a scheduled task's argument
# list is mangled by quoting rules, and a build command has quotes in it.
@"
`$ErrorActionPreference = 'Continue'
Set-Location '$((Get-Location).Path)'
try { & { $Run } *>&1 | Tee-Object -FilePath '$output' } catch { `$_ | Out-String | Tee-Object -FilePath '$output' }
Set-Content -Path '$done' -Value `$LASTEXITCODE
"@ | Set-Content -Path $queue -Encoding UTF8

Start-ScheduledTask -TaskName $taskName
Write-Output "started on the desktop: $Run"

if ($Wait) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
  if (Test-Path $output) { Get-Content $output }
  if (Test-Path $done) { Write-Output ("exit code: " + (Get-Content $done)) }
  else { Write-Output "still running after $TimeoutSeconds seconds; output is in $output" }
}
