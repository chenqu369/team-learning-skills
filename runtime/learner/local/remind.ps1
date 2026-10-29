param([Parameter(Mandatory=$true)][string]$ProjectRoot,[switch]$Check)
$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path -LiteralPath $ProjectRoot).Path
$cmdFile = Join-Path $projectDirectory '一键同步结营名单.cmd'
if (-not (Test-Path -LiteralPath $cmdFile -PathType Leaf)) { throw '找不到项目的一键同步CMD，请先确认路径。' }
Add-Type -AssemblyName System.Windows.Forms
if ($Check) {
    [pscustomobject]@{ checked=$true; reminder_only=$true; command_executed=$false; project=$projectDirectory; manual_command=$cmdFile } | ConvertTo-Json
    exit 0
}
$stateDirectory = Join-Path $projectDirectory 'workflow\state\local-workflow'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$entry = @{ at=[DateTimeOffset]::Now.ToString('o'); kind='manual_sync_reminder'; synchronization_started=$false } | ConvertTo-Json -Compress
Add-Content -LiteralPath (Join-Path $stateDirectory 'reminders.ndjson') -Value $entry -Encoding UTF8
$message = "请手动双击《一键同步结营名单.cmd》，同步本期结营名单。`r`n`r`n项目：$projectDirectory`r`n`r`n本提醒不会自动执行同步。运行后查看 workflow\local\最近运行.md。"
[System.Windows.Forms.MessageBox]::Show($message,'组队学习：手动同步提醒',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
