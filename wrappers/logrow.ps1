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
$header = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes,run_id,prompt_sha256,cache_read_tokens,review_verdict,fix_round,tags'
$stream = $null
try {
    for ($attempt = 1; $attempt -le 50; $attempt++) {
        try {
            $stream = [IO.File]::Open($LogPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            break
        } catch [System.IO.IOException] {
            if ($attempt -ge 50) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    if ($stream.Length -eq 0) {
        $bytes = $utf8.GetBytes($header + "`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
    } else {
        [void]$stream.Seek([int64]-1, [IO.SeekOrigin]::End)
        $last = $stream.ReadByte()
        if ($last -ne 0x0A) {
            $nl = $utf8.GetBytes("`r`n")
            [void]$stream.Seek(0, [IO.SeekOrigin]::End)
            $stream.Write($nl, 0, $nl.Length)
        }
    }
    [void]$stream.Seek(0, [IO.SeekOrigin]::End)
    $bytes = $utf8.GetBytes($row + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
$row
