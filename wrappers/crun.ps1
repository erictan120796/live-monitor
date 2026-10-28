[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [Parameter(Mandatory = $true)][ValidateSet('design','code','review','fix')][string]$Phase,
    [string]$TaskId,
    [ValidateRange(1,2147483647)][int]$Attempt = 1,
    [string]$Model = 'grok-4.7-medium',
    [string]$WorkDir = (Get-Location).Path,
    [string]$OutFile,
    [ValidateRange(0.001,35790)][double]$TimeoutMin = 60,
    [string]$RunsRoot = $env:LIVE_MONITOR_RUNS,
    [string]$Executable = 'cursor-agent'
)
. (Join-Path $PSScriptRoot 'run-common.ps1')
# run-common bypasses forwarding shims via versions/<version>/{node.exe,index.js}.
# Resolution failure uses powershell -File and records the fallback in manifest.
Invoke-AgentRun -Agent cursor -PromptFile $PromptFile -Phase $Phase -TaskId $TaskId -Attempt $Attempt -Model $Model -WorkDir $WorkDir -OutFile $OutFile -TimeoutMin $TimeoutMin -RunsRoot $RunsRoot -Executable $Executable
