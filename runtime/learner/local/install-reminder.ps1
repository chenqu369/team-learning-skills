param([Parameter(Mandatory=$true)][string]$ProjectRoot,[string]$At='12:00',[string]$TaskName='Datawhale-LearnerSync-ManualReminder')
$ErrorActionPreference='Stop'
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw '当前电脑时区不是Asia/Shanghai；未创建提醒，也未修改系统时区。' }
if ($At -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') { throw '时间必须为HH:mm。' }
$projectDirectory=(Resolve-Path -LiteralPath $ProjectRoot).Path
$reminderScript=Join-Path $PSScriptRoot 'remind.ps1'
$powershellPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $powershellPath -NoProfile -ExecutionPolicy Bypass -File $reminderScript -ProjectRoot $projectDirectory -Check | Out-Null
if ($LASTEXITCODE -ne 0) { throw '提醒程序路径或环境检查未通过。' }
$arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$reminderScript+'" -ProjectRoot "'+$projectDirectory+'"'
$existing=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions[0].Arguments -ne $arguments) { throw '已有同名任务指向不同位置；保留原任务，请指定独立任务名。' }
$action=New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectDirectory
$trigger=New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
$userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal=New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '工作日手动同步结营名单提醒；只弹窗，不执行CMD、Node或飞书写入。' -Force | Out-Null
$back=Get-ScheduledTask -TaskName $TaskName
$taskInfo=Get-ScheduledTaskInfo -TaskName $TaskName
$taskXml=[xml](Export-ScheduledTask -TaskName $TaskName)
$calendar=$taskXml.Task.Triggers.CalendarTrigger
if ($back.Actions[0].Arguments -ne $arguments -or $back.Principal.LogonType -ne 'Interactive' -or -not $back.Settings.Enabled) { throw '任务回读与提醒配置不符。' }
$readDays=@($calendar.ScheduleByWeek.DaysOfWeek.ChildNodes | ForEach-Object { $_.LocalName } | Sort-Object)
if (($readDays -join ',') -ne 'Friday,Monday,Thursday,Tuesday,Wednesday' -or ([datetime]$calendar.StartBoundary).ToString('HH:mm') -ne $At -or $back.Settings.StartWhenAvailable) { throw '提醒日期、时间或补发设置回读不符。' }
$receipt=[pscustomobject]@{ task_name=$TaskName; enabled=$back.Settings.Enabled; reminder_only=$true; auto_sync=$false; timezone='Asia/Shanghai'; weekdays=@('Monday','Tuesday','Wednesday','Thursday','Friday'); at=$At; start_boundary=$calendar.StartBoundary; schedule_xml=$calendar.ScheduleByWeek.OuterXml; action_execute=$back.Actions[0].Execute; action_arguments=$back.Actions[0].Arguments; logon_type=[string]$back.Principal.LogonType; next_run=$taskInfo.NextRunTime.ToString('o'); popup_actual_delivery_tested=$false; missed_reminders_replayed=$false }
$receiptPath=Join-Path $projectDirectory 'workflow\local\reminder.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
$receipt | ConvertTo-Json -Depth 6
