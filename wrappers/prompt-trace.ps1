# Prompt capture helpers. Windows PowerShell 5.1 / PowerShell 7. No external modules.

function Test-PromptSecret {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    $patterns = @(
        'postgres(ql)?://\S+:\S+@',
        'mysql://\S+:\S+@',
        '\bsk-[A-Za-z0-9_-]{20,}',
        '\bgh[pousr]_[A-Za-z0-9]{30,}',
        'github_pat_[A-Za-z0-9_]{20,}',
        '-----BEGIN [A-Z ]*PRIVATE KEY-----',
        '\bAKIA[0-9A-Z]{16}\b',
        'xox[baprs]-[A-Za-z0-9-]{10,}'
    )
    foreach ($pattern in $patterns) {
        if ([regex]::IsMatch($Text, $pattern)) { return $true }
    }
    return $false
}

function ConvertTo-TagString {
    param($Tags)
    if ($null -eq $Tags) { return '' }
    if ($Tags -is [string] -and [string]::IsNullOrEmpty($Tags)) { return '' }
    if ($Tags -isnot [System.Collections.IDictionary]) { throw 'Tags must be a hashtable.' }
    if ($Tags.Count -eq 0) { return '' }
    $allowed = @('task_type', 'flow_step', 'template', 'scope_style', 'issue_count')
    $rows = @()
    foreach ($key in @($Tags.Keys)) {
        $name = [string]$key
        $known = $false
        foreach ($candidate in $allowed) {
            if ($candidate -ceq $name) { $known = $true; break }
        }
        if (-not $known) { throw "Unknown tag key: $name" }
        $value = [string]$Tags[$key]
        if (-not [regex]::IsMatch($value, '^[A-Za-z0-9._/-]{1,64}$')) { throw "Invalid tag value for ${name}" }
        $rows += [pscustomobject]@{ Key = $name; Value = $value }
    }
    $parts = foreach ($row in ($rows | Sort-Object -Property Key)) { $row.Key + '=' + $row.Value }
    return ($parts -join ';')
}

function Save-PromptTrace {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Prompt,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$PromptPath,
        [Parameter(Mandatory = $true)][string]$RunDir,
        [Parameter(Mandatory = $true)][string]$StoreRoot
    )
    $utf8 = New-Object Text.UTF8Encoding $false
    $bytes = $utf8.GetBytes($Prompt)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $algorithm.ComputeHash($bytes) }
    finally { $algorithm.Dispose() }
    $sha = -join ($hash | ForEach-Object { $_.ToString('x2') })
    $redacted = [bool](Test-PromptSecret -Text $Prompt)
    if (-not $redacted) {
        [IO.File]::WriteAllText((Join-Path $RunDir 'prompt.md'), $Prompt, $utf8)
        $storePath = Join-Path $StoreRoot ($sha + '.md')
        # Content-addressed: write a missing hash once. Never overwrite or delete.
        if (-not [IO.File]::Exists($storePath)) {
            [void][IO.Directory]::CreateDirectory($StoreRoot)
            [IO.File]::WriteAllText($storePath, $Prompt, $utf8)
        }
    }
    # Comma keeps the dictionary intact; otherwise the pipeline unrolls it.
    return ,[ordered]@{
        prompt_sha256 = $sha
        prompt_chars = $Prompt.Length
        prompt_source = $PromptPath
        prompt_redacted = $redacted
    }
}
