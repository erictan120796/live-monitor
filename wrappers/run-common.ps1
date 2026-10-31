# Windows PowerShell 5.1 / PowerShell 7. No agent-output pipeline.
. (Join-Path $PSScriptRoot 'prompt-trace.ps1')

function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Value)
    # CommandLineToArgvW/CRT rules, including backslashes before quotes and at end.
    '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function Resolve-AgentLauncher {
    param([string]$Executable)
    $command = Get-Command -Name $Executable -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
    $path = $command.Source
    $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($ext -notin @('.ps1','.cmd','.bat','.exe','.com')) { throw "Unsupported launcher: $path" }
    return $path
}

function Resolve-CursorTransport {
    param([string]$Executable)
    $extension = [IO.Path]::GetExtension($Executable).ToLowerInvariant()
    if ($extension -in @('.cmd','.bat')) {
        $sibling = [IO.Path]::ChangeExtension($Executable, '.ps1')
        if (Test-Path -LiteralPath $sibling -PathType Leaf) { $Executable = $sibling; $extension = '.ps1' }
    }
    if ($extension -eq '.ps1') {
        $directory = Split-Path -Parent $Executable
        # Same local-node preference and date-based version selection as the
        # Cursor shim. Never evaluate vendor source or forward prompt argv in PS.
        if (-not (Test-Path -LiteralPath (Join-Path $directory 'node.exe') -PathType Leaf)) {
            $versions = Join-Path $directory 'versions'
            $latest = Get-ChildItem -LiteralPath $versions -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$' } |
                Sort-Object { $parts = $_.Name.Split('-')[0].Split('.'); [int]($parts[0] + $parts[1].PadLeft(2,'0') + $parts[2].PadLeft(2,'0')) } -Descending |
                Select-Object -First 1
            if ($latest) { $directory = $latest.FullName }
        }
        $node = Join-Path $directory 'node.exe'
        $entry = Join-Path $directory 'index.js'
        if ((Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $entry -PathType Leaf)) {
            return @{ executable = $node; prefix = @($entry); transport = 'cursor_node_direct'; fileShim = $false }
        }
        return @{ executable = $Executable; prefix = @(); transport = 'cursor_powershell_file_fallback'; fileShim = $true }
    }
    return @{ executable = $Executable; prefix = @(); transport = 'cursor_native_or_batch'; fileShim = $false }
}

function New-AgentStartInfo {
    param([string]$Executable, [string[]]$Arguments, [string]$PayloadPath, [switch]$FileShim)
    $extension = [IO.Path]::GetExtension($Executable).ToLowerInvariant()
    if ($extension -eq '.ps1') {
        if ($FileShim) {
            $hostExe = (Get-Process -Id $PID).Path
            return @{ FilePath = $hostExe; ArgumentList = '-NoLogo -NoProfile -NonInteractive -File ' + ((@($Executable) + $Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ') }
        }
        # Encoded bootstrap avoids powershell.exe -File's lossy argument parser.
        # Data is base64, never interpolated as executable PowerShell source.
        $payload = @{ executable = $Executable; arguments = @($Arguments) } | ConvertTo-Json -Compress -Depth 5
        [IO.File]::WriteAllText($PayloadPath, $payload, (New-Object Text.UTF8Encoding($false)))
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PayloadPath))
        $bootstrap = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{{PAYLOAD}}'))
$data = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
$nativeArgs = @($data.arguments)
$global:LASTEXITCODE = 0
try { & $data.executable @nativeArgs; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
'@
        $bootstrap = $bootstrap.Replace('{{PAYLOAD}}', $encoded)
        $hostExe = (Get-Process -Id $PID).Path
        return @{ FilePath = $hostExe; ArgumentList = '-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap)) }
    }
    if ($extension -in @('.cmd','.bat')) {
        # Prefer the sibling PowerShell shim: cmd.exe cannot represent arbitrary
        # multiline prompts reliably. No guessing/parsing of vendor shim source.
        $sibling = [IO.Path]::ChangeExtension($Executable, '.ps1')
        if (Test-Path -LiteralPath $sibling -PathType Leaf) {
            return New-AgentStartInfo -Executable $sibling -Arguments $Arguments -PayloadPath $PayloadPath
        }
        $escaped = @()
        foreach ($argument in $Arguments) {
            if ($argument -match '[\r\n]') { throw 'Multiline arguments require a .ps1 or native launcher, not an unpaired .cmd launcher.' }
            $value = ConvertTo-WindowsArgument $argument
            $value = [regex]::Replace($value, '([()%!^"<>&| ])', '^$1')
            $value = [regex]::Replace($value, '([()%!^"<>&| ])', '^$1')
            $escaped += $value
        }
        $command = [regex]::Replace($Executable, '([()%!^"<>&| ])', '^$1')
        return @{ FilePath = $env:ComSpec; ArgumentList = '/d /v:off /s /c "' + $command + ' ' + ($escaped -join ' ') + '"' }
    }
    return @{ FilePath = $Executable; ArgumentList = (($Arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ') }
}

function Start-AgentProcess {
    param([string]$Executable, [string[]]$Arguments, [string]$PayloadPath, [string]$WorkDir, [string]$Stdout, [string]$Stderr, [string]$Stdin, [switch]$FileShim)
    $startInfo = New-AgentStartInfo -Executable $Executable -Arguments $Arguments -PayloadPath $PayloadPath -FileShim:$FileShim
    if ($Stdin) { $startInfo.RedirectStandardInput = $Stdin }
    $process = Start-Process @startInfo -WorkingDirectory $WorkDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    # Cache the native handle immediately: ExitCode otherwise disappears for fast exits on PS 5.1.
    [void]$process.Handle
    return $process
}

function Write-RunManifest {
    param([string]$Path, $Manifest)
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Manifest | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-AgentMetadata {
    param($State, $Manifest, [switch]$Final)
    # Byte offset + persistent UTF-8 decoder. Do not split multibyte characters.
    $stream = [IO.File]::Open($Manifest.files.stdout, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        [void]$stream.Seek($State.offset, [IO.SeekOrigin]::Begin)
        # Snapshot EOF: a continuously writing CLI must not starve timeout checks.
        $limit = $stream.Length
        if (-not $Final) { $limit = [Math]::Min($limit, $State.offset + 262144) }
        $bytes = New-Object byte[] 8192
        while ($State.offset -lt $limit) {
            $count = $stream.Read($bytes, 0, [int][Math]::Min($bytes.Length, $limit - $State.offset))
            if ($count -eq 0) { break }
            $State.offset += $count
            # UTF-8 decoder has no GetMaxCharCount. Encoding max is count+1, enough for a
            # leftover 4-byte sequence that becomes a surrogate pair plus ASCII.
            $chars = New-Object char[] ([Text.Encoding]::UTF8.GetMaxCharCount($count))
            $n = $State.decoder.GetChars($bytes, 0, $count, $chars, 0, $false)
            if ($n -gt 0) { $State.pending += -join $chars[0..($n - 1)] }
            while (($newline = $State.pending.IndexOf("`n")) -ge 0) {
                $line = $State.pending.Substring(0, $newline).TrimStart([char]0xFEFF).TrimEnd("`r")
                $State.pending = $State.pending.Substring($newline + 1)
                if (-not $State.dropping) { Update-AgentMetadata -Line $line -Manifest $Manifest }
                $State.dropping = $false
            }
            # Metadata inspection is bounded; full evidence remains untouched.
            if ($State.pending.Length -gt 1048576) { $State.pending = ''; $State.dropping = $true }
        }
        if ($Final) {
            # Emit a trailing partial UTF-8 sequence only after the process has exited.
            $dummy = New-Object byte[] 1
            $flushChars = New-Object char[] ([Text.Encoding]::UTF8.GetMaxCharCount(4))
            $n = $State.decoder.GetChars($dummy, 0, 0, $flushChars, 0, $true)
            if ($n -gt 0 -and -not $State.dropping) { $State.pending += -join $flushChars[0..($n - 1)] }
            while (($newline = $State.pending.IndexOf("`n")) -ge 0) {
                $line = $State.pending.Substring(0, $newline).TrimStart([char]0xFEFF).TrimEnd("`r")
                $State.pending = $State.pending.Substring($newline + 1)
                if (-not $State.dropping) { Update-AgentMetadata -Line $line -Manifest $Manifest }
                $State.dropping = $false
            }
        }
    } finally { $stream.Dispose() }
}

function Update-AgentMetadata {
    param([string]$Line, $Manifest)
    try { $event = $Line | ConvertFrom-Json -ErrorAction Stop } catch { return }
    if ($Manifest.agent -eq 'codex') {
        if ($event.type -eq 'thread.started' -and $event.thread_id) { $Manifest.thread_id = [string]$event.thread_id }
        if ($event.type -in @('turn.failed','error')) { $Manifest.native_failure = $true }
    } else {
        if ($event.type -eq 'system' -and $event.subtype -eq 'init') {
            if ($event.session_id) { $Manifest.session_id = [string]$event.session_id }
            if ($event.model) { $Manifest.reported_model = [string]$event.model }
        }
        if ($event.type -eq 'result' -and ($event.is_error -eq $true -or $event.subtype -match '^error')) { $Manifest.native_failure = $true }
    }
}

function Close-OrphanRuns {
    param([string]$RunsRoot, [string]$ExcludeRunId)
    $closed = 0
    if (-not $RunsRoot -or -not [IO.Directory]::Exists($RunsRoot)) { return 0 }
    $hasSeq2 = {
        param([string]$Path)
        if (-not $Path -or -not [IO.File]::Exists($Path)) { return $false }
        $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8, $true)
            while ($null -ne ($line = $reader.ReadLine())) {
                $trim = $line.TrimStart([char]0xFEFF).Trim()
                if (-not $trim) { continue }
                try { $obj = $trim | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                if ($obj.seq -eq 2) { return $true }
            }
        } finally { $fs.Dispose() }
        return $false
    }
    # alive: process running and recorded ticks missing or equal. dead: exited or pid reused.
    $identityState = {
        param($IdValue, $TicksValue)
        $hasPid = $false
        $procId = 0
        if ($null -ne $IdValue -and "$IdValue" -match '^\d+$') {
            $hasPid = [int]::TryParse("$IdValue", [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$procId)
        }
        if (-not $hasPid) { return 'nopid' }
        $alive = $false
        $startTicks = $null
        if ($procId -gt 0) {
            try {
                $proc = Get-Process -Id $procId -ErrorAction Stop
                if (-not $proc.HasExited) {
                    $alive = $true
                    try { $startTicks = $proc.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } catch { $startTicks = $null }
                }
            } catch { $alive = $false }
        }
        if (-not $alive) { return 'dead' }
        if ($null -ne $startTicks) {
            $want = ''
            if ($null -ne $TicksValue) { $want = "$TicksValue".Trim() }
            if (-not [string]::IsNullOrEmpty($want) -and $want -ne $startTicks) { return 'dead' }
        }
        return 'alive'
    }
    $isOrphan = {
        param($Row)
        $agentState = & $identityState $Row.pid $(if ($null -ne $Row.process_started_ticks) { $Row.process_started_ticks } else { $null })
        $agentDead = $false
        if ($agentState -eq 'dead') { $agentDead = $true }
        elseif ($agentState -eq 'nopid') {
            $deadlinePassed = $false
            if ($Row.deadline_utc) {
                try {
                    $deadline = [DateTime]::Parse([string]$Row.deadline_utc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
                    if ([DateTime]::UtcNow -gt $deadline) { $deadlinePassed = $true }
                } catch { $deadlinePassed = $false }
            }
            if ($deadlinePassed) { $agentDead = $true }
        }
        if (-not $agentDead) { return $false }
        $wrapperProp = $Row.PSObject.Properties['wrapper_pid']
        $wrapperAbsent = ($null -eq $wrapperProp) -or ($null -eq $wrapperProp.Value) -or ("$($wrapperProp.Value)".Trim() -eq '')
        if ($wrapperAbsent) {
            $oldEnough = $true
            $startedProp = $Row.PSObject.Properties['started_at']
            if ($null -ne $startedProp -and $null -ne $startedProp.Value -and "$($startedProp.Value)".Trim()) {
                $oldEnough = $false
                try {
                    $started = [DateTime]::Parse([string]$startedProp.Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
                    if (([DateTime]::UtcNow - $started).TotalMinutes -gt 10) { $oldEnough = $true }
                } catch { $oldEnough = $false }
            }
            return $oldEnough
        }
        $wrapperTicks = $null
        if ($Row.PSObject.Properties['wrapper_start_ticks']) { $wrapperTicks = $Row.wrapper_start_ticks }
        return ((& $identityState $Row.wrapper_pid $wrapperTicks) -ne 'alive')
    }
    $repairStatus = {
        param([string]$Path)
        if (-not $Path -or -not [IO.File]::Exists($Path)) { return }
        $utf8 = New-Object Text.UTF8Encoding($false)
        $raw = [IO.File]::ReadAllText($Path, $utf8)
        if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
        if ($raw.Length -eq 0) { return }
        $endsNl = $raw.EndsWith("`n")
        $parts = $raw.Split([char]10)
        $lastIdx = $parts.Length - 1
        if ($endsNl) {
            while ($lastIdx -ge 0 -and -not $parts[$lastIdx].TrimEnd("`r").Trim()) { $lastIdx-- }
        }
        if ($lastIdx -lt 0) { return }
        $lastTrim = $parts[$lastIdx].TrimEnd("`r").TrimStart([char]0xFEFF).Trim()
        $lastValid = $false
        if ($lastTrim) {
            try { $null = $lastTrim | ConvertFrom-Json -ErrorAction Stop; $lastValid = $true } catch { $lastValid = $false }
        }
        $dropLast = (-not $endsNl) -or (-not $lastValid)
        if (-not $dropLast) { return }
        $kept = New-Object System.Collections.Generic.List[string]
        for ($i = 0; $i -lt $lastIdx; $i++) {
            $trim = $parts[$i].TrimEnd("`r").TrimStart([char]0xFEFF).Trim()
            if (-not $trim) { continue }
            try { $null = $trim | ConvertFrom-Json -ErrorAction Stop } catch { continue }
            [void]$kept.Add($trim)
        }
        $body = ''
        if ($kept.Count -gt 0) { $body = ([string]::Join("`n", $kept.ToArray())) + "`n" }
        [IO.File]::WriteAllText($Path, $body, $utf8)
    }
    $readTerminalEvent = {
        param($Row, [string]$RunDirectory)
        $scan = @{ found = $false; native_failure = $false; tokens = $null }
        $stdoutPath = $null
        if ($Row.files -and $Row.files.PSObject.Properties['stdout'] -and $Row.files.stdout) { $stdoutPath = [string]$Row.files.stdout }
        if (-not $stdoutPath) {
            $fallback = Join-Path $RunDirectory 'stdout.jsonl'
            if ([IO.File]::Exists($fallback)) { $stdoutPath = $fallback }
        }
        if (-not $stdoutPath -or -not [IO.File]::Exists($stdoutPath)) { return $scan }
        $agentName = ''
        if ($Row.PSObject.Properties['agent'] -and $Row.agent) { $agentName = [string]$Row.agent }
        $inFs = New-Object IO.FileStream($stdoutPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $inReader = New-Object IO.StreamReader($inFs, [Text.Encoding]::UTF8, $true)
            while ($null -ne ($outLine = $inReader.ReadLine())) {
                $outTrim = $outLine.TrimStart([char]0xFEFF).Trim()
                if (-not $outTrim) { continue }
                try { $outEvent = $outTrim | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                if ($agentName -eq 'codex') {
                    if ($outEvent.type -eq 'turn.failed' -or $outEvent.type -eq 'error') { $scan.native_failure = $true }
                    $match = $outEvent.type -eq 'turn.completed'
                } else {
                    $match = $outEvent.type -eq 'result'
                    if ($match) { $scan.native_failure = ($outEvent.is_error -eq $true) -or ([string]$outEvent.subtype -match '^error') }
                }
                if ($match) {
                    $scan.found = $true
                    $usageProp = $outEvent.PSObject.Properties['usage']
                    $scan.tokens = $(if ($usageProp -and $null -ne $usageProp.Value) { $usageProp.Value } else { $null })
                }
            }
        } finally { $inFs.Dispose() }
        $scan.found = $scan.found -and -not $scan.native_failure
        return $scan
    }
    foreach ($dir in [IO.Directory]::GetDirectories($RunsRoot)) {
        try {
            if ($ExcludeRunId -and ([IO.Path]::GetFileName($dir) -eq $ExcludeRunId)) { continue }
            $manifestPath = Join-Path $dir 'manifest.json'
            if (-not [IO.File]::Exists($manifestPath)) { continue }
            $disk = $null
            try { $disk = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
            if (-not $disk -or $disk -is [array]) { continue }
            if ($ExcludeRunId -and [string]$disk.run_id -eq $ExcludeRunId) { continue }
            if ($disk.ended_at) { continue }
            $statusPath = Join-Path $dir 'status.jsonl'
            if (& $hasSeq2 $statusPath) { continue }
            if (-not (& $isOrphan $disk)) { continue }
            $lock = $null
            try {
                $lock = New-Object IO.FileStream((Join-Path $dir 'finalize.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            } catch { continue }
            try {
                try { $disk = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { continue }
                if (-not $disk -or $disk -is [array] -or $disk.ended_at) { continue }
                if (& $hasSeq2 $statusPath) { continue }
                if (-not (& $isOrphan $disk)) { continue }
                $exitCode = $null
                $exitPath = Join-Path $dir 'agent-exit.json'
                if ([IO.File]::Exists($exitPath)) {
                    try {
                        $exitObj = [IO.File]::ReadAllText($exitPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
                        if ($exitObj -and -not ($exitObj -is [array]) -and [string]$exitObj.run_id -eq [string]$disk.run_id -and $null -ne $exitObj.exit_code -and -not ($exitObj.exit_code -is [string])) {
                            $parsed = 0
                            $exitText = "$($exitObj.exit_code)"
                            if ($exitText -match '^-?\d+$' -and [int]::TryParse($exitText, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
                                $exitCode = $parsed
                            }
                        }
                    } catch { $exitCode = $null }
                }
                & $repairStatus $statusPath
                $terminalEvent = & $readTerminalEvent $disk $dir
                $closeStatus = 'failed'
                $closeReason = $(if ($null -ne $exitCode) { 'no_result' } else { 'killed' })
                $tokenOut = $terminalEvent.tokens
                if ($exitCode -is [int] -and $exitCode -ne 0) { $closeStatus = 'failed'; $closeReason = 'nonzero_exit' }
                elseif ($terminalEvent.native_failure -or $disk.native_failure -eq $true) { $closeStatus = 'failed'; $closeReason = 'native_failure' }
                elseif ($terminalEvent.found) { $closeStatus = 'completed'; $closeReason = $null }
                $now = [DateTime]::UtcNow.ToString('o')
                $session = $null
                if ($disk.session_id) { $session = [string]$disk.session_id }
                $record = [ordered]@{
                    v = 1; seq = 2; ts = $now
                    run_id = $(if ($disk.run_id) { [string]$disk.run_id } else { $null })
                    phase = $disk.phase; status = $closeStatus
                    exit_code = $exitCode; duration_s = $null; session_id = $session; tokens = $tokenOut
                }
                if ($closeReason) { $record.reason = $closeReason }
                $line = $record | ConvertTo-Json -Compress -Depth 8
                $writer = New-Object IO.StreamWriter($statusPath, $true, (New-Object Text.UTF8Encoding($false)))
                try { $writer.WriteLine($line) } finally { $writer.Dispose() }
                foreach ($pair in @(
                    @{ Name = 'ended_at'; Value = $now },
                    @{ Name = 'exit_code'; Value = $exitCode },
                    @{ Name = 'tokens'; Value = $tokenOut }
                )) {
                    $prop = $disk.PSObject.Properties[$pair.Name]
                    if ($prop) { $prop.Value = $pair.Value }
                    else { $disk | Add-Member -NotePropertyName $pair.Name -NotePropertyValue $pair.Value }
                }
                Write-RunManifest $manifestPath $disk
                $closed++
            } finally { if ($lock) { $lock.Dispose() } }
        } catch { continue }
    }
    return $closed
}

function Invoke-AgentRun {
    [CmdletBinding()]
    param([string]$Agent, [string]$PromptFile, [string]$Phase, [string]$TaskId, [int]$Attempt,
          [string]$Model, [string]$Effort, [string]$WorkDir, [string]$OutFile,
          [double]$TimeoutMin, [string]$RunsRoot, [string]$Executable,
          [hashtable]$Tags, [string]$PromptStore)
    $ErrorActionPreference = 'Stop'
    # Invalid tags must fail before the run directory or any launcher exists.
    $tagString = ConvertTo-TagString $Tags
    $runsRootExplicit = $PSBoundParameters.ContainsKey('RunsRoot') -and -not [string]::IsNullOrEmpty($RunsRoot)
    if (-not $RunsRoot) { $RunsRoot = Join-Path $HOME '.orchestrator\runs' }
    $RunsRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RunsRoot)
    try { [void](Close-OrphanRuns -RunsRoot $RunsRoot) } catch {}
    if (-not $PromptStore) {
        if ($runsRootExplicit) { $PromptStore = Join-Path (Split-Path -Parent $RunsRoot) 'prompts' }
        else { $PromptStore = Join-Path $HOME '.orchestrator\prompts' }
    }
    [void][IO.Directory]::CreateDirectory($RunsRoot)
    $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N')
    $runDir = Join-Path $RunsRoot $runId
    [void][IO.Directory]::CreateDirectory($runDir)
    $stdout = Join-Path $runDir 'stdout.jsonl'
    $stderr = Join-Path $runDir 'stderr.log'
    if ($OutFile) {
        $stdout = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
        $stderr = $stdout + '.err'
    }
    $status = Join-Path $runDir 'status.jsonl'
    $manifestPath = Join-Path $runDir 'manifest.json'
    $manifest = [ordered]@{
        schema_version = 1; run_id = $runId; agent = $Agent
        requested_model = $(if ($Model) { $Model } else { $null })
        effort = $(if ($Agent -eq 'codex' -and $Effort) { $Effort } else { $null })
        phase = $Phase; workdir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkDir)
        pid = $null; wrapper_pid = $PID
        wrapper_start_ticks = $(try { (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } catch { $null })
        started_at = [DateTime]::UtcNow.ToString('o')
        files = @{ stdout = $stdout; stderr = $stderr; status = $status }
        task_id = $(if ($TaskId) { $TaskId } else { $null }); attempt = $Attempt
        executable = $Executable; transport = $null; launch_executable = $null; launch_entry_script = $null
        cli_version = $null; thread_id = $null; session_id = $null
        reported_model = $null; ended_at = $null; exit_code = $null
        native_failure = $false; cleanup_scope = 'launched_process_only'
        tags = $tagString
        prompt_sha256 = $null; prompt_chars = $null; prompt_source = $null; prompt_redacted = $null
    }
    Write-RunManifest $manifestPath $manifest
    $encoding = New-Object Text.UTF8Encoding($false)
    $statusWriter = New-Object IO.StreamWriter($status, $false, $encoding)
    $statusWriter.AutoFlush = $true
    $record = [ordered]@{ v = 1; seq = 1; ts = [DateTime]::UtcNow.ToString('o'); run_id = $runId; phase = $Phase; status = 'started' }
    $statusWriter.WriteLine(($record | ConvertTo-Json -Compress))
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $reason = 'cancelled'
    $exit = 'cancelled'
    $terminal = 'failed'
    $state = @{ offset = 0L; decoder = [Text.Encoding]::UTF8.GetDecoder(); pending = ''; dropping = $false }
    $captureLocks = @()
    $versionProcess = $null
    $cursorEnvironment = @{}
    try {
        # Reserve both capture paths exclusively for the lifetime of this run.
        # FileShare.ReadWrite allows Start-Process redirection, but a separate
        # CreateNew sidecar prevents concurrent legacy -OutFile users colliding.
        foreach ($capture in @($stdout, $stderr)) {
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($capture))
            $lockPath = $capture + '.live-monitor.lock'
            $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $captureLocks += @{ stream = $lock; path = $lockPath }
            [IO.File]::WriteAllText($capture, '', $encoding)
        }
        $promptPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PromptFile)
        $prompt = [IO.File]::ReadAllText($promptPath, [Text.Encoding]::UTF8)
        $trace = Save-PromptTrace -Prompt $prompt -PromptPath $promptPath -RunDir $runDir -StoreRoot $PromptStore
        foreach ($name in @('prompt_sha256', 'prompt_chars', 'prompt_source', 'prompt_redacted')) {
            $manifest[$name] = $trace[$name]
        }
        $manifest.executable = Resolve-AgentLauncher $Executable
        $launch = @{ executable = $manifest.executable; prefix = @(); transport = 'codex_stdin'; fileShim = $false }
        if ($Agent -eq 'cursor') { $launch = Resolve-CursorTransport $manifest.executable }
        if ($launch.transport -eq 'cursor_node_direct') {
            # Preserve the shim's runtime defaults, scoped to this invocation.
            foreach ($name in @('CURSOR_INVOKED_AS','NODE_COMPILE_CACHE')) {
                if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
                    $cursorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                    $value = $(if ($name -eq 'CURSOR_INVOKED_AS') { [IO.Path]::GetFileName([IO.Path]::ChangeExtension($manifest.executable, '.ps1')) } else { Join-Path $env:LOCALAPPDATA 'cursor-compile-cache' })
                    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
                }
            }
        }
        $manifest.transport = $launch.transport
        $manifest.launch_executable = $launch.executable
        if ($launch.prefix.Count) { $manifest.launch_entry_script = $launch.prefix[0] }
        Write-RunManifest $manifestPath $manifest
        # Best-effort, bounded version check. Never mix it into agent stdout.
        try {
            $versionOut = Join-Path $runDir 'version.stdout.log'
            $versionErr = Join-Path $runDir 'version.stderr.log'
            $versionProcess = Start-AgentProcess -Executable $launch.executable -Arguments ($launch.prefix + @('--version')) -FileShim:$launch.fileShim -PayloadPath (Join-Path $runDir 'version-launch.json') -WorkDir $manifest.workdir -Stdout $versionOut -Stderr $versionErr
            $remainingMs = [Math]::Max(1, [Math]::Min(5000, [int](($TimeoutMin * 60000) - $clock.Elapsed.TotalMilliseconds)))
            if ($versionProcess.WaitForExit($remainingMs)) {
                if ($versionProcess.ExitCode -eq 0) {
                    $versionText = [IO.File]::ReadAllText($versionOut, [Text.Encoding]::UTF8).Trim()
                    if ($versionText.Length -gt 1024) { $versionText = $versionText.Substring(0,1024) }
                    if ($versionText) { $manifest.cli_version = $versionText }
                } else { $manifest.cli_version_error = 'Version probe returned nonzero exit code' }
            } else { $manifest.cli_version_error = 'Version probe timed out'; Stop-Process -Id $versionProcess.Id -Force }
        } catch { $manifest.cli_version_error = $_.Exception.Message }
        finally {
            if ($null -ne $versionProcess) {
                try { if (-not $versionProcess.HasExited) { Stop-Process -Id $versionProcess.Id -Force } }
                finally { $versionProcess.Dispose(); $versionProcess = $null }
            }
        }
        Write-RunManifest $manifestPath $manifest
        if ($Agent -eq 'codex') {
            $arguments = @('exec', '--json', '--cd', $manifest.workdir)
            if ($Model) { $arguments += @('--model', $Model) }
            # TOML literal strings avoid double quotes in PS 5.1 forwarding.
            if ($Effort) {
                if ($Effort -match "['\r\n]") { throw 'Effort must be a single-line TOML literal string without apostrophes.' }
                $arguments += @('-c', ("model_reasoning_effort='" + $Effort + "'"))
            }
            # No resume entrypoint or arbitrary extra arguments in v1.
            $arguments += @('-')
        } else {
            # Existing permission policy, not introduced by the monitor.
            $arguments = @('--print', '--force', '--trust', '--output-format', 'stream-json', '--stream-partial-output')
            if ($Model) { $arguments += @('--model', $Model) }
            $arguments += @('--', $prompt)
        }
        if ($clock.Elapsed.TotalMinutes -ge $TimeoutMin) { throw [TimeoutException]::new('Run timeout exhausted before agent launch') }
        $stdin = $(if ($Agent -eq 'codex') { $promptPath } else { $null })
        $process = Start-AgentProcess -Executable $launch.executable -Arguments ($launch.prefix + $arguments) -FileShim:$launch.fileShim -Stdin $stdin -PayloadPath (Join-Path $runDir 'launch.json') -WorkDir $manifest.workdir -Stdout $stdout -Stderr $stderr
        $manifest.pid = $process.Id
        Write-RunManifest $manifestPath $manifest
        while (-not $process.WaitForExit(50)) {
            Read-AgentMetadata $state $manifest
            Write-RunManifest $manifestPath $manifest
            if ($clock.Elapsed.TotalMinutes -ge $TimeoutMin) { break }
        }
        if ($process.HasExited) {
            $exit = $process.ExitCode
            if ($null -eq $exit) { throw 'Launched process exit code unavailable' }
            $manifest.exit_code = $exit
            if ($exit -eq 0) { $terminal = 'completed'; $reason = $null }
            else { $reason = 'nonzero_exit' }
        } else { $exit = 'timeout'; $reason = 'timeout' }
    } catch [TimeoutException] {
        $terminal = 'failed'; $reason = 'timeout'; $exit = 'timeout'
    } catch [System.Management.Automation.PipelineStoppedException] {
        $terminal = 'failed'; $reason = 'cancelled'; $exit = 'cancelled'
    } catch {
        $terminal = 'failed'
        $reason = $(if ($null -eq $process) { 'launch_failure' } else { 'wrapper_error' })
        $exit = $(if ($null -eq $process) { 'launch_failure' } else { 'wrapper_error' })
        $manifest.error = $_.Exception.Message
    } finally {
        try {
            if ($null -ne $process) {
                if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
                # Do not wait on inherited stdout handles after killing a launcher:
                # descendants may still own them. Only direct-PID cleanup is claimed.
                [void]$process.WaitForExit(2000)
                Read-AgentMetadata $state $manifest -Final
                if ($process.HasExited -and $state.pending -and -not $state.dropping) {
                    $tail = $state.pending.Trim().TrimStart([char]0xFEFF)
                    if ($tail) { Update-AgentMetadata -Line $tail -Manifest $manifest }
                }
                if ($terminal -eq 'completed' -and $manifest.native_failure) { $terminal = 'failed'; $reason = 'native_failure' }
                elseif ($terminal -eq 'completed') {
                    $sawResult = $false
                    try {
                        $outPath = [string]$manifest.files.stdout
                        if ($outPath -and [IO.File]::Exists($outPath)) {
                            $inFs = New-Object IO.FileStream($outPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                            try {
                                $inReader = New-Object IO.StreamReader($inFs, [Text.Encoding]::UTF8, $true)
                                while ($null -ne ($outLine = $inReader.ReadLine())) {
                                    $outTrim = $outLine.TrimStart([char]0xFEFF).Trim()
                                    if (-not $outTrim) { continue }
                                    try { $outEvent = $outTrim | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                                    if ($manifest.agent -eq 'codex') {
                                        if ($outEvent.type -eq 'turn.completed') { $sawResult = $true; break }
                                    } elseif ($outEvent.type -eq 'result') { $sawResult = $true; break }
                                }
                            } finally { $inFs.Dispose() }
                        }
                    } catch {}
                    if (-not $sawResult) { $terminal = 'failed'; $reason = 'no_result' }
                }
            }
        } catch {
            $terminal = 'failed'
            $reason = 'cleanup_failure'
            $manifest.cleanup_error = $_.Exception.Message
        } finally {
            $manifest.ended_at = [DateTime]::UtcNow.ToString('o')
            try { Write-RunManifest $manifestPath $manifest }
            finally {
                $record.seq = 2; $record.ts = [DateTime]::UtcNow.ToString('o'); $record.status = $terminal
                if ($reason) { $record.reason = $reason }
                if ($null -ne $manifest.exit_code) { $record.exit_code = $manifest.exit_code }
                if ($reason -eq 'no_result') {
                    $record.tokens = $null
                    if ($manifest.session_id) { $record.session_id = [string]$manifest.session_id }
                    elseif ($manifest.thread_id) { $record.session_id = [string]$manifest.thread_id }
                    else { $record.session_id = $null }
                }
                try { $statusWriter.WriteLine(($record | ConvertTo-Json -Compress)) }
                finally {
                    $statusWriter.Dispose()
                    foreach ($lock in $captureLocks) { $lock.stream.Dispose(); [IO.File]::Delete($lock.path) }
                    if ($null -ne $process) { $process.Dispose() }
                    foreach ($name in $cursorEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $cursorEnvironment[$name], 'Process') }
                }
            }
        }
    }
    [pscustomobject]@{ exit = $exit; duration_s = [int]$clock.Elapsed.TotalSeconds; out = $stdout; err = $stderr; run_id = $runId }
}
