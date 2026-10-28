# Unbound args deliberately preserve literal values, including empty strings.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
if ($args.Count -eq 1 -and $args[0] -eq '--version') {
    if ($env:FAKE_AGENT_MODE -eq 'version-timeout') { Start-Sleep -Seconds 30 }
    if ($env:FAKE_AGENT_MODE -eq 'prelaunch-contract') {
        $runs = @(Get-ChildItem -LiteralPath $env:LIVE_MONITOR_RUNS -Directory)
        if ($runs.Count -ne 1) { exit 91 }
        $manifest = [IO.File]::ReadAllText((Join-Path $runs[0].FullName 'manifest.json')) | ConvertFrom-Json
        $stream = [IO.File]::Open($manifest.files.status, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $reader = New-Object IO.StreamReader($stream)
        try { $records = @($reader.ReadToEnd().Trim() -split "`n") } finally { $reader.Dispose() }
        if ($null -ne $manifest.pid -or $null -ne $manifest.ended_at -or $records.Count -ne 1) { exit 92 }
        $record = $records[0] | ConvertFrom-Json
        if ($record.status -ne 'started' -or $record.run_id -ne $manifest.run_id -or $record.phase -ne $manifest.phase) { exit 93 }
        [Console]::WriteLine('prelaunch-evidence-ok'); exit 0
    }
    [Console]::WriteLine('fake-agent 1.2.3'); exit 0
}
# 8189 ASCII bytes + 3 lead bytes of a 4-byte emoji, then the final byte + 8191 ASCII.
# A fixed 8192-char decoder buffer throws on the second chunk.
if ($env:FAKE_AGENT_MODE -eq 'split-utf8') {
    $raw = [Console]::OpenStandardOutput()
    $lead = New-Object byte[] 8192
    for ($i = 0; $i -lt 8189; $i++) { $lead[$i] = 65 }
    $lead[8189] = 0xF0; $lead[8190] = 0x9F; $lead[8191] = 0x98
    $tail = New-Object byte[] 8192
    $tail[0] = 0x80
    for ($i = 1; $i -lt 8192; $i++) { $tail[$i] = 66 }
    $raw.Write($lead, 0, $lead.Length)
    $raw.Write($tail, 0, $tail.Length)
    $raw.WriteByte(10)
    $raw.Flush()
}
$stdin = $(if ($args.Count -and $args[-1] -eq '-') { [Console]::In.ReadToEnd() } else { $null })
$received = @{ stdin = $stdin; type = 'fixture.args'; arguments = @($args); cwd = (Get-Location).Path; pid = $PID }
[Console]::WriteLine(($received | ConvertTo-Json -Compress -Depth 5))
[Console]::Out.Flush()
[Console]::Error.WriteLine(('fixture stderr: caf' + [char]0xE9 + ' ' + [char]0x4E2D + [char]0x6587))
switch ($env:FAKE_AGENT_MODE) {
    'metadata-noise' {
        [Console]::WriteLine('not JSON')
        [Console]::WriteLine(('x' * 1100000))
        [Console]::WriteLine('{"type":"future.unknown","payload":true}')
        [Console]::Write('{"type":"thread.started","thread_id":"after-noise"}')
    }
    'timeout' { Start-Sleep -Seconds 30 }
    'late' {
        Start-Sleep -Milliseconds 1500
        [Console]::WriteLine('{"type":"thread.started","thread_id":"late-thread"}')
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds 1500
    }
    'nonzero' { exit 7 }
    'native-failure' { [Console]::WriteLine('{"type":"turn.failed","error":{"message":"fixture failure"}}') }
    'cursor-failure' { [Console]::WriteLine('{"type":"result","subtype":"error_during_execution","is_error":true}') }
    'cursor' { [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"cursor-session","model":"reported-model"}') }
    'unterminated' { [Console]::Write('{"type":"thread.started","thread_id":"final-thread"}'); exit 0 }
    default { [Console]::WriteLine('{"type":"thread.started","thread_id":"fast-thread"}') }
}
exit 0
