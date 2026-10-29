[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [Parameter(Mandatory = $true)][ValidateSet('design','code','review','fix')][string]$Phase,
    [string]$TaskId,
    [ValidateRange(1,2147483647)][int]$Attempt = 1,
    [string]$Model,
    [string]$Effort,
    [string]$WorkDir = (Get-Location).Path,
    [ValidateRange(0.001,35790)][double]$TimeoutMin = 60,
    [string]$RunsRoot = $env:LIVE_MONITOR_RUNS,
    [string]$SessionsRoot = $env:LIVE_MONITOR_SESSIONS,
    [string]$Executable = 'codex'
)
. (Join-Path $PSScriptRoot 'run-common.ps1')
# run-common uses exec ... - and RedirectStandardInput; prompt never enters argv.
Invoke-AgentRun -Agent codex -PromptFile $PromptFile -Phase $Phase -TaskId $TaskId -Attempt $Attempt -Model $Model -Effort $Effort -WorkDir $WorkDir -TimeoutMin $TimeoutMin -RunsRoot $RunsRoot -SessionsRoot $SessionsRoot -Executable $Executable
