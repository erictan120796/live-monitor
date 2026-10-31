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

function Read-TokenField($obj, [string]$Name) {
    if ($null -eq $obj) { return $null }
    $prop = $obj.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $null }
    return $prop.Value
}

function Format-LogToken($value) {
    if ($null -eq $value) { return '' }
    if ($value -is [string]) { return $value }
    return [Convert]::ToString($value, [Globalization.CultureInfo]::InvariantCulture)
}

function Resolve-LogToken($obj, [string[]]$Names) {
    foreach ($name in $Names) {
        $value = Read-TokenField $obj $name
        if ($null -ne $value) { return (Format-LogToken $value) }
    }
    return ''
}

$ErrorActionPreference = 'Stop'
if (-not [string]::IsNullOrEmpty($RunId)) {
    if ($RunId -cnotmatch '\A[0-9]{8}T[0-9]{9}Z-[0-9a-f]{32}\z') {
        throw "Invalid RunId format: $RunId"
    }
    $manifestPath = Join-Path (Join-Path $RunsRoot $RunId) 'manifest.json'
    if (-not [IO.File]::Exists($manifestPath)) {
        throw "Run manifest not found for RunId $RunId"
    }
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $sessionProp = $manifest.PSObject.Properties['session_id']
    $manifestSession = ''
    if ($null -ne $sessionProp -and $null -ne $sessionProp.Value) {
        $manifestSession = [string]$sessionProp.Value
    }
    if ([string]::IsNullOrEmpty($manifestSession)) {
        $threadProp = $manifest.PSObject.Properties['thread_id']
        if ($null -ne $threadProp -and $null -ne $threadProp.Value) {
            $manifestSession = [string]$threadProp.Value
        }
    }
    if ([string]::IsNullOrEmpty($manifestSession)) {
        throw "Run manifest session_id is empty for RunId $RunId"
    }
    $passedSession = ''
    if ($PSBoundParameters.ContainsKey('SessionId')) { $passedSession = [string]$SessionId }
    if (-not $PSBoundParameters.ContainsKey('SessionId') -or -not [string]::Equals($passedSession, $manifestSession, [StringComparison]::Ordinal)) {
        throw 'session_id mismatch'
    }
    foreach ($tokenParam in @('InputTokens', 'OutputTokens', 'CacheReadTokens')) {
        if ($PSBoundParameters.ContainsKey($tokenParam)) {
            throw 'token values must come from the run record when -RunId is given'
        }
    }
    if ([string]::IsNullOrEmpty($PromptSha256)) { $PromptSha256 = [string]$manifest.prompt_sha256 }
    if ([string]::IsNullOrEmpty($Tags)) { $Tags = [string]$manifest.tags }
    $endedProp = $manifest.PSObject.Properties['ended_at']
    $endedAt = $null
    if ($null -ne $endedProp) { $endedAt = $endedProp.Value }
    if ($null -ne $endedAt) {
        $tokenObj = $null
        $tokenProp = $manifest.PSObject.Properties['tokens']
        if ($null -ne $tokenProp -and $null -ne $tokenProp.Value) { $tokenObj = $tokenProp.Value }
        $InputTokens = Resolve-LogToken $tokenObj @('input_tokens', 'inputTokens')
        $OutputTokens = Resolve-LogToken $tokenObj @('output_tokens', 'outputTokens')
        $CacheReadTokens = Resolve-LogToken $tokenObj @('cached_input_tokens', 'cache_read_input_tokens', 'cacheReadTokens')
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
