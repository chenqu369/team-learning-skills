param(
  [ValidateSet('Health','RecruitSource','UsageReport','RecruitPreview','RecruitProgress','RecruitPublish','RosterPreview','RosterRead','RosterSync','EvaluationPreview','EvaluationAwards','Help')]
  [string]$Action='Help',
  [string]$Config,
  [string]$Out,
  [switch]$Apply,
  [string]$PythonPath
)
$ErrorActionPreference='Stop'
$actions=@{Health='health';RecruitSource='recruit-source';UsageReport='usage-report';RecruitPreview='recruit-preview';RecruitProgress='recruit-progress';RecruitPublish='recruit-publish';RosterPreview='roster-preview';RosterRead='roster-read';RosterSync='roster-sync';EvaluationPreview='evaluation-preview';EvaluationAwards='evaluation-awards';Help='help'}
$arguments=@((Join-Path $PSScriptRoot '助教评价入口.mjs'),$actions[$Action])
if($Config){$arguments+=@('--config',$Config)}
if($Out){$arguments+=@('--out',$Out)}
if($Apply){$arguments+='--apply'}
$previousPython=$env:ASSISTANT_PYTHON
try{
  if($PythonPath){$env:ASSISTANT_PYTHON=$PythonPath}
  & node @arguments
  if($LASTEXITCODE -ne 0){throw "助教评价执行失败，退出码 $LASTEXITCODE"}
}finally{$env:ASSISTANT_PYTHON=$previousPython}
