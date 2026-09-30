# Windows: start Motes at logon and restart it if it stops.
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
# Remove with:  Unregister-ScheduledTask -TaskName Motes -Confirm:$false
# Motes only works while the PC is awake: Settings > System > Power > Sleep = Never (when plugged in).

$motes = (Get-Command motes -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $motes -Argument "up --no-browser"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Motes" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Motes - always-on personal agents" -Force | Out-Null
Start-ScheduledTask -TaskName "Motes"
Write-Host "Motes is running. Dashboard: http://localhost:7777"
