# Read-only ranking. Writes nothing except -OutCsv when that path is set.
param(
    [string]$LogPath = "$HOME\.orchestrator\task-log.csv",
    [string]$RunsRoot = "$HOME\.orchestrator\runs",
    [string]$PromptStore = "$HOME\.orchestrator\prompts",
    [ValidateSet('model', 'scope_style', 'template', 'flow_step')]
    [string]$GroupBy = 'model',
    [int]$Top = 5,
    [string]$OutCsv,
    [double]$CacheWeight = 0.1
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($Top -lt 0) { $Top = 0 }
$Weight = [decimal]::Round([decimal]$CacheWeight, 10, [MidpointRounding]::AwayFromZero)

function Get-Field {
    param($Row, [string]$Name)
    if ($null -eq $Row) { return '' }
    $prop = $Row.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return '' }
    return ([string]$prop.Value).Trim()
}

function ConvertTo-DecimalValue {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return [decimal]0 }
    try {
        return [decimal]::Parse($Text, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture)
    } catch {
        return [decimal]0
    }
}

function Format-Num {
    param([decimal]$Value)
    return $Value.ToString('0.######', [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertFrom-TagString {
    param([string]$Text)
    $map = @{}
    if ([string]::IsNullOrWhiteSpace($Text)) { return ,$map }
    foreach ($part in $Text.Split(';')) {
        $piece = $part.Trim()
        $idx = $piece.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $piece.Substring(0, $idx).Trim()
        $value = $piece.Substring($idx + 1).Trim()
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $map[$name] = $value
    }
    return ,$map
}

function Get-ManifestTags {
    param([string]$RunId)
    if ([string]::IsNullOrWhiteSpace($RunId)) { return '' }
    try {
        $manifestPath = Join-Path (Join-Path $RunsRoot $RunId) 'manifest.json'
        if (-not [IO.File]::Exists($manifestPath)) { return '' }
        $json = [IO.File]::ReadAllText($manifestPath, (New-Object Text.UTF8Encoding $false))
        $obj = $json | ConvertFrom-Json
        if ($null -eq $obj) { return '' }
        $prop = $obj.PSObject.Properties['tags']
        if ($null -eq $prop -or $null -eq $prop.Value) { return '' }
        return [string]$prop.Value
    } catch {
        return ''
    }
}

function Get-Median {
    param($Values)
    $nums = @($Values | ForEach-Object { [decimal]$_ })
    $n = $nums.Count
    if ($n -eq 0) { return [decimal]0 }
    $sorted = @($nums | Sort-Object)
    if (($n % 2) -eq 1) {
        return [decimal]$sorted[[int](($n - 1) / 2)]
    }
    $upper = [int]($n / 2)
    $lower = $upper - 1
    return [decimal]::Divide([decimal]::Add([decimal]$sorted[$lower], [decimal]$sorted[$upper]), [decimal]2)
}

function Test-RowSuccess {
    param($Row)
    $result = (Get-Field $Row 'result').ToLowerInvariant()
    $verdict = (Get-Field $Row 'review_verdict').ToLowerInvariant()
    $fix = Get-Field $Row 'fix_round'
    $okResult = @('ok', 'approved', 'completed') -contains $result
    $okVerdict = @('approve', 'n-a', '') -contains $verdict
    $okFix = @('', '0', '1') -contains $fix
    return ($okResult -and $okVerdict -and $okFix)
}

if (-not [IO.File]::Exists($LogPath)) {
    Write-Warning "Log not found: $LogPath"
    exit 0
}

$all = @(Import-Csv -LiteralPath $LogPath)
$bucket = @{}
foreach ($row in $all) {
    if ($null -eq $row) { continue }
    $runId = Get-Field $row 'run_id'
    if ([string]::IsNullOrWhiteSpace($runId)) { continue }

    $tagsText = Get-Field $row 'tags'
    if ([string]::IsNullOrWhiteSpace($tagsText)) {
        $tagsText = Get-ManifestTags $runId
    }
    $tags = ConvertFrom-TagString $tagsText
    if ($tags -isnot [System.Collections.IDictionary]) { throw 'Tag parse returned no map.' }

    if ($GroupBy -eq 'model') {
        $key = (Get-Field $row 'model') + '/' + (Get-Field $row 'effort')
    } elseif ($tags.ContainsKey($GroupBy) -and -not [string]::IsNullOrWhiteSpace([string]$tags[$GroupBy])) {
        $key = [string]$tags[$GroupBy]
    } else {
        $key = '(none)'
    }

    $inputTokens = ConvertTo-DecimalValue (Get-Field $row 'input_tokens')
    $outputTokens = ConvertTo-DecimalValue (Get-Field $row 'output_tokens')
    $cacheTokens = ConvertTo-DecimalValue (Get-Field $row 'cache_read_tokens')
    $weighted = [decimal]::Add(
        [decimal]::Add($inputTokens, $outputTokens),
        [decimal]::Multiply($Weight, $cacheTokens)
    )
    $weighted = [decimal]::Round($weighted, 6, [MidpointRounding]::AwayFromZero)

    $item = [pscustomobject]@{
        Duration = ConvertTo-DecimalValue (Get-Field $row 'duration_s')
        Input    = $inputTokens
        Output   = $outputTokens
        Cache    = $cacheTokens
        Weighted = $weighted
        Success  = [bool](Test-RowSuccess $row)
        Sha      = Get-Field $row 'prompt_sha256'
        Group    = $key
    }
    if (-not $bucket.ContainsKey($key)) { $bucket[$key] = @() }
    $bucket[$key] = @($bucket[$key]) + @($item)
}

$records = New-Object 'System.Collections.Generic.List[object]'
$best = @{}
foreach ($key in @($bucket.Keys)) {
    $items = @($bucket[$key])
    $runs = $items.Count
    $successes = @($items | Where-Object { $_.Success }).Count
    $rate = [decimal]::Round([decimal]::Divide([decimal]$successes, [decimal]$runs), 2, [MidpointRounding]::AwayFromZero)
    $sum = [decimal]0
    foreach ($item in $items) {
        $sum = [decimal]::Add($sum, [decimal]$item.Weighted)
        if ($item.Success -and -not [string]::IsNullOrWhiteSpace($item.Sha)) {
            $sha = $item.Sha
            if ((-not $best.ContainsKey($sha)) -or ([decimal]$item.Weighted -lt [decimal]$best[$sha].Weighted)) {
                $best[$sha] = $item
            }
        }
    }
    $costText = ''
    $sortBlank = 1
    $sortCost = [decimal]0
    if ($successes -gt 0) {
        $cost = [decimal]::Round([decimal]::Divide($sum, [decimal]$successes), 6, [MidpointRounding]::AwayFromZero)
        $costText = Format-Num $cost
        $sortBlank = 0
        $sortCost = $cost
    }
    $records.Add([pscustomobject]@{
        group                     = [string]$key
        runs                      = [string]$runs
        successes                 = [string]$successes
        success_rate              = $rate.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
        median_duration_s         = Format-Num (Get-Median ($items | ForEach-Object { $_.Duration }))
        median_input_tokens       = Format-Num (Get-Median ($items | ForEach-Object { $_.Input }))
        median_output_tokens      = Format-Num (Get-Median ($items | ForEach-Object { $_.Output }))
        median_cache_read_tokens  = Format-Num (Get-Median ($items | ForEach-Object { $_.Cache }))
        cost_per_success          = $costText
        SortBlank                 = $sortBlank
        SortCost                  = $sortCost
    })
}

$props = @(
    'group', 'runs', 'successes', 'success_rate',
    'median_duration_s', 'median_input_tokens', 'median_output_tokens',
    'median_cache_read_tokens', 'cost_per_success'
)
$out = @($records.ToArray() | Sort-Object -Property SortBlank, SortCost, group | Select-Object -Property $props)

if (-not [string]::IsNullOrWhiteSpace($OutCsv)) {
    $out | Export-Csv -LiteralPath $OutCsv -NoTypeInformation -Delimiter ','
}
if ($out.Count -gt 0) {
    $out | Format-Table -Property $props -AutoSize | Out-String -Width 4096 | Write-Output
}

Write-Output ''
Write-Output 'Top prompts'
$promptRanked = @($best.Values | Sort-Object -Property Weighted, Sha | Select-Object -First $Top)
foreach ($item in $promptRanked) {
    if ($null -eq $item) { continue }
    $sha = [string]$item.Sha
    $short = $sha
    if ($sha.Length -gt 12) { $short = $sha.Substring(0, 12) }
    $shown = ''
    $full = Join-Path $PromptStore ($sha + '.md')
    if ([IO.File]::Exists($full)) { $shown = $full }
    $line = $short + ' ' + [string]$item.Group + ' ' + (Format-Num ([decimal]$item.Weighted))
    if (-not [string]::IsNullOrEmpty($shown)) { $line = $line + ' ' + $shown }
    Write-Output $line
}
