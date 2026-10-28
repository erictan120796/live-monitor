# Optional manual retention helper. Wrappers never call this script.
# Deletes only expired terminal run folders strictly inside the resolved runs root.
# Invoke it; do not dot-source it.
[CmdletBinding()]
param(
    [string]$RunsRoot = $env:LIVE_MONITOR_RUNS,
    [ValidateRange(1, 36500)][int]$RetentionDays = 30,
    [string]$SessionsRoot = (Join-Path $HOME '.codex\sessions'),
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if ($MyInvocation.InvocationName -eq '.') { throw 'Invoke wrappers/prune-runs.ps1; do not dot-source it.' }
if (-not $RunsRoot) { $RunsRoot = Join-Path $HOME '.orchestrator\runs' }

function Get-NormalizedPath {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    # TrimEnd would turn "C:\" into drive-relative "C:", which then means the current directory.
    if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
    return $full.TrimEnd('\', '/')
}

function Test-StrictlyInside {
    param([string]$Parent, [string]$Child)
    $parent = Get-NormalizedPath $Parent
    $child = Get-NormalizedPath $Child
    if ($child.Equals($parent, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $child.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-InsideOrEqual {
    param([string]$Parent, [string]$Child)
    $parent = Get-NormalizedPath $Parent
    $child = Get-NormalizedPath $Child
    if ($child.Equals($parent, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $child.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-ReparsePoint {
    param([string]$LiteralPath)
    $attrs = [IO.File]::GetAttributes($LiteralPath)
    return [bool]($attrs -band [IO.FileAttributes]::ReparsePoint)
}

function Assert-NoReparseAncestors {
    param([string]$LiteralPath)
    # A plain directory below a junction still aliases another tree. Checking
    # only the final runs-root component does not establish deletion containment.
    $current = $LiteralPath
    while ($current) {
        if (Test-ReparsePoint $current) { throw "Refusing to prune a reparse-point runs root or ancestor: $current" }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function ConvertTo-UtcInstant {
    param($Value)
    if ($null -eq $Value -or [string]$Value -eq '') { return $null }
    if ($Value -is [DateTime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) { return [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc) }
        return $Value.ToUniversalTime()
    }
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    return [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, $styles)
}

function Read-JsonFile {
    param([string]$LiteralPath)
    $text = [IO.File]::ReadAllText($LiteralPath, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json
}

function Test-TerminalStatus {
    param([string]$LiteralPath)
    if (-not [IO.File]::Exists($LiteralPath)) { return $false }
    $text = [IO.File]::ReadAllText($LiteralPath, [Text.Encoding]::UTF8)
    $last = $null
    foreach ($line in ($text -split "`n")) {
        $line = $line.Trim().TrimStart([char]0xFEFF)
        if (-not $line) { continue }
        try { $last = $line | ConvertFrom-Json } catch { return $false }
    }
    if ($null -eq $last -or -not $last.status) { return $false }
    return $last.status -in @('completed', 'failed')
}

function Test-ContainsReparse {
    param([string]$Dir)
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Dir)
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            if (Test-ReparsePoint $entry) { return $true }
            $attrs = [IO.File]::GetAttributes($entry)
            if ($attrs -band [IO.FileAttributes]::Directory) { $stack.Push($entry) }
        }
    }
    return $false
}

function Remove-ContainedTree {
    param([string]$Dir, [string]$Root, [string]$Sessions)
    if (-not (Test-StrictlyInside $Root $Dir)) { throw "Refusing to delete outside runs root: $Dir" }
    if (Test-InsideOrEqual $Sessions $Dir) { throw "Refusing to delete inside Codex sessions root: $Dir" }
    if (Test-ReparsePoint $Dir) { throw "Refusing to follow reparse point: $Dir" }
    $files = New-Object 'System.Collections.Generic.List[string]'
    $dirs = New-Object 'System.Collections.Generic.List[string]'
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Dir)
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
            if (-not (Test-StrictlyInside $Root $entry)) { throw "Refusing to delete outside runs root: $entry" }
            if (Test-InsideOrEqual $Sessions $entry) { throw "Refusing to delete inside Codex sessions root: $entry" }
            if (Test-ReparsePoint $entry) { throw "Refusing to follow reparse point: $entry" }
            $attrs = [IO.File]::GetAttributes($entry)
            if ($attrs -band [IO.FileAttributes]::Directory) {
                $dirs.Add($entry)
                $stack.Push($entry)
            } else {
                $files.Add($entry)
            }
        }
    }
    foreach ($file in $files) { [IO.File]::Delete($file) }
    foreach ($sub in @($dirs | Sort-Object { $_.Length } -Descending)) { [IO.Directory]::Delete($sub) }
    [IO.Directory]::Delete($Dir)
}

$runsFull = Get-NormalizedPath $RunsRoot
$sessionsFull = Get-NormalizedPath $SessionsRoot
if ($runsFull.Equals($sessionsFull, [StringComparison]::OrdinalIgnoreCase) -or (Test-StrictlyInside $sessionsFull $runsFull)) {
    throw "Refusing to prune the Codex sessions root: $runsFull"
}
if (-not [IO.Directory]::Exists($runsFull)) { return }
Assert-NoReparseAncestors $runsFull
$pathRoot = [IO.Path]::GetPathRoot($runsFull)
if ($runsFull.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to prune a filesystem root: $runsFull" }
$rootItem = Get-Item -LiteralPath $runsFull -Force
if ($null -eq $rootItem.Parent) { throw "Refusing to prune a filesystem root: $runsFull" }

$cutoff = [DateTime]::UtcNow.AddDays(-1 * $RetentionDays)
foreach ($dir in @([IO.Directory]::EnumerateDirectories($runsFull))) {
    $name = [IO.Path]::GetFileName($dir.TrimEnd('\', '/'))
    if ($name -in @('.', '..') -or -not $name) { continue }
    if (-not (Test-StrictlyInside $runsFull $dir)) { continue }
    if (Test-InsideOrEqual $sessionsFull $dir) { Write-Output "skipped-sessions:$name"; continue }
    if (Test-ReparsePoint $dir) { Write-Output "skipped-reparse:$name"; continue }
    # Check before opening manifest/status too: neither may be an external link.
    try { if (Test-ContainsReparse $dir) { Write-Output "skipped-reparse:$name"; continue } } catch { continue }
    $manifestPath = Join-Path $dir 'manifest.json'
    if (-not [IO.File]::Exists($manifestPath)) { continue }
    try { $manifest = Read-JsonFile $manifestPath } catch { continue }
    if ([string]$manifest.schema_version -ne '1') { continue }
    if (-not [string]$manifest.run_id) { continue }
    if (-not ([string]$manifest.run_id).Equals($name, [StringComparison]::OrdinalIgnoreCase)) { continue }
    try { $ended = ConvertTo-UtcInstant $manifest.ended_at } catch { continue }
    if ($null -eq $ended -or $ended -ge $cutoff) { continue }
    $statusPath = Join-Path $dir 'status.jsonl'
    if ($manifest.files -and $manifest.files.status) { $statusPath = [string]$manifest.files.status }
    # Status evidence must live inside this run folder. Do not open paths outside the root.
    if (-not (Test-StrictlyInside $dir $statusPath)) { $statusPath = Join-Path $dir 'status.jsonl' }
    try { if (-not (Test-TerminalStatus $statusPath)) { continue } } catch { continue }
    try { if (Test-ContainsReparse $dir) { Write-Output "skipped-reparse:$name"; continue } } catch { continue }
    if ($WhatIf) { Write-Output "would-delete:$name"; continue }
    Remove-ContainedTree -Dir $dir -Root $runsFull -Sessions $sessionsFull
    Write-Output "deleted:$name"
}
