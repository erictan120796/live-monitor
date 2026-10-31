param(
    [string]$Repo,
    [string]$TaskType,
    [string]$Tool,
    [string]$Model,
    [string]$Effort,
    $InputTokens = '',
    $OutputTokens = '',
    $DurationS = '',
    [string]$SessionId = '',
    [string]$Result = '',
    [string]$Notes = '',
    [string]$RunId = '',
    [string]$PromptSha256 = '',
    $CacheReadTokens = '',
    [AllowEmptyString()][ValidateSet('', 'approve', 'blockers', 'n-a')][string]$ReviewVerdict = '',
    [AllowEmptyString()][ValidateSet('', '0', '1')][string]$FixRound = '',
    [string]$Tags = '',
    [string]$LogPath = "$HOME\.orchestrator\task-log.csv",
    [string]$RunsRoot = "$HOME\.orchestrator\runs"
)
$ErrorActionPreference = 'Stop'
if (-not [string]::IsNullOrEmpty($RunId)) {
    if ($RunId -cnotmatch '\A[0-9]{8}T[0-9]{9}Z-[0-9a-f]{32}\z') {
        throw "Invalid RunId format: $RunId"
    }
    $manifestPath = Join-Path (Join-Path $RunsRoot $RunId) 'manifest.json'
    if ([IO.File]::Exists($manifestPath)) {
        $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ([string]::IsNullOrEmpty($PromptSha256)) { $PromptSha256 = [string]$manifest.prompt_sha256 }
        if ([string]::IsNullOrEmpty($Tags)) { $Tags = [string]$manifest.tags }
    }
}
$q={param($v) $s="$v"; if($s -match '[,"\r\n]'){ '"'+$s.Replace('"','""')+'"' } else { $s }}
$row = ((Get-Date -Format 'yyyy-MM-dd HH:mm'), $Repo, $TaskType, $Tool, $Model, $Effort, $InputTokens, $OutputTokens, $DurationS, $SessionId, $Result, $Notes, $RunId, $PromptSha256, $CacheReadTokens, $ReviewVerdict, $FixRound, $Tags | ForEach-Object { & $q $_ }) -join ','
$utf8 = New-Object Text.UTF8Encoding $false
if (-not [IO.File]::Exists($LogPath)) {
    $header = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes,run_id,prompt_sha256,cache_read_tokens,review_verdict,fix_round,tags'
    [IO.File]::WriteAllText($LogPath, ($header + "`r`n"), $utf8)
}
[IO.File]::AppendAllText($LogPath, ($row + "`r`n"), $utf8)
$row
