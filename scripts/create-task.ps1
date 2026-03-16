Unregister-ScheduledTask -TaskName "WeeekCRMSync" -Confirm:$false -ErrorAction SilentlyContinue

$pythonPath = (Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python*\pythonw.exe" | Select-Object -First 1).FullName
$scriptPath = "$env:USERPROFILE\claude-session-manager\scripts\weeek-sync.py"
$workDir = "$env:USERPROFILE\claude-session-manager\scripts"

$action = New-ScheduledTaskAction -Execute $pythonPath -Argument "`"$scriptPath`"" -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName "WeeekCRMSync" -Action $action -Trigger $trigger -Settings $settings -Description "Sync deals Воронка продаж -> Воронка найма every 5 min" -Force
Write-Host "Python: $pythonPath"
Write-Host "Script: $scriptPath"
Write-Host "Task created!"
