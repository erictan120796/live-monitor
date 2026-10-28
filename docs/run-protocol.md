# Durable run protocol v1

## Identity and ownership

One wrapper invocation = one explicitly supplied phase (`design`, `code`,
`review`, `fix`). No inferred workflow transitions or percentages. An optional
`task_id` links phase handoffs and retries; the orchestrator supplies the **same**
ID across design/code/review/fix. `attempt` identifies a retry (default 1).
`run_id` combines UTC time and a random UUID; captures never use timestamps alone.

Default root: `$HOME\.orchestrator\runs` (Eric's machine:
`C:\Users\User\.orchestrator\runs`). `LIVE_MONITOR_RUNS` overrides it;
`-RunsRoot` takes precedence. Each invocation creates:

```text
<runs-root>\<run_id>\
  manifest.json
  status.jsonl
  stdout.jsonl
  stderr.log
```

Version checks may add `version.stdout.log`, `version.stderr.log` and
`version-launch.json`. `.ps1` launches use `launch.json` to transport arguments
without command-line length inflation. Codex payloads contain flags only;
prompt text is read from the supplied prompt file through redirected stdin.
These are private wrapper artifacts, not event sources.

## Manifest

`schema_version: 1`; UTF-8 without BOM. Fields always present:

| Fields | Meaning |
| --- | --- |
| `run_id`, `agent`, `phase` | Invocation identity, `codex`/`cursor`, explicit phase |
| `requested_model`, `effort` | Requested settings; null when unspecified/unsupported |
| `workdir`, `pid`, `started_at` | Absolute workdir, launched PID or null, UTC ISO 8601 |
| `files: { stdout, stderr, status }` | Absolute capture paths |
| `task_id`, `attempt` | Shared optional correlation ID, positive retry number |
| `executable`, `cli_version` | Resolved CLI launcher and best-effort version (null if unknown) |
| `transport`, `launch_executable`, `launch_entry_script` | Selected transport, CLI target and optional Node entry script; null before resolution |
| `thread_id`, `session_id`, `reported_model` | Native metadata when actually observed; otherwise null |
| `ended_at`, `exit_code` | UTC end and actual numeric native exit, or null |

Additional diagnostics: `native_failure`, `cleanup_scope`, optional `error`,
`cleanup_error`, `cli_version_error`. A native terminal error can fail the run
despite numeric exit 0. Requested and reported model are never conflated.

Manifest exists **before any CLI launch**, initially `pid: null`. Updates use
same-directory temporary files plus atomic replacement. Capture paths are final
before `started`. The launched PID is the process returned by `Start-Process`:
a PowerShell host for `.ps1`, cmd.exe for unpaired `.cmd`, or native executable.
It is **not** advertised as a descendant agent PID. A `.cmd` with a sibling
`.ps1` uses that sibling, subject to Cursor direct-Node resolution below.
The original resolved launcher remains
in `executable`. Version probe PID is not the invocation PID.

Default captures live under the run folder. Cursor's retained `OutFile` override
is absolute-resolved and explicitly recorded, with stderr `<OutFile>.err`.
Captures are replaced at invocation start, matching legacy behavior, but
exclusive `.live-monitor.lock` sidecars prevent concurrent wrapper collisions.
Normal cleanup removes the sidecars. Hard-kill may leave a stale lock: verify
no writer remains before manual removal; wrappers never steal locks.

## Status: wrapper/orchestrator ownership only

UTF-8 without BOM, newline-delimited compact JSON, flushed after each record.
Each record: `v: 1`, monotonic `seq`, UTC ISO `ts`, `run_id`, explicit `phase`,
`status` (`started`, `completed`, `failed`). Optional `reason`, numeric `exit_code`.

```json
{"v":1,"seq":1,"ts":"2026-10-29T00:00:00Z","run_id":"example","phase":"review","status":"started"}
{"v":1,"seq":2,"ts":"2026-10-29T00:00:03Z","run_id":"example","phase":"review","status":"failed","reason":"nonzero_exit","exit_code":7}
```

`started` is written before version checking/launch. One terminal record follows
exit/error cleanup. Reasons include `launch_failure`, `nonzero_exit`, `timeout`,
`cancelled`, `native_failure`, `wrapper_error`, `cleanup_failure`. Missing CLI,
prompt read failure and invalid workdir leave failed-run evidence. Invalid
PowerShell parameter binding or an unwritable runs root can fail before evidence
creation; these are caller/storage errors, not an agent run.

The wrapper returns a PowerShell object (it does not set the caller host's exit
code): `exit` is the native number or a failure string (`timeout`,
`launch_failure`, `wrapper_error`, `cancelled`); `duration_s` is integer elapsed
wall time including setup/version checking; `out`, `err`, `run_id` locate evidence.
For `native_failure` with exit 0, inspect status rather than `exit` alone.

Timeout covers setup/version checking plus execution; the best-effort version
probe is capped at five seconds and cannot extend that cap. Timeout cleanup
stops the **launched PID only**; descendants may survive and may retain capture
handles. No process-tree cleanup is claimed or inferred. Graceful cancellation
uses `finally` cleanup where PowerShell permits it. Hard termination, machine
failure, or storage failure may prevent terminal publication: absent terminal
status means **unknown/interrupted**, never successful. Monitor never repairs
or rewrites evidence. Silence alone means neither failure nor completion.

## CLI transport

Both wrappers use `Start-Process`, explicit working directory, hidden process
window, separate redirected stdout/stderr files. No agent-output pipeline.

Codex uses `exec --json ... -` and `-RedirectStandardInput` with the absolute
prompt-file path. No prompt text goes through argv, including empty, multiline
and long prompts. Effort uses a TOML literal string, avoiding embedded double
quotes at the PowerShell 5.1 forwarding boundary.

Cursor resolves a PowerShell shim (including a batch launcher's sibling) to
its adjacent `node.exe` and `index.js`, or the latest date-sorted directory in
`versions` matching the vendor version-name pattern. Like the shim, local Node
takes precedence and version dates sort numerically with padded month/day.
Both files must exist. The selected installed version is used without running
the shim's staged-update promotion helper. Node runs directly with CRT-quoted
argv, preserving double quotes, empty arguments and Unicode.

Manifest `transport` is `codex_stdin`, `cursor_node_direct`,
`cursor_powershell_file_fallback`, or `cursor_native_or_batch`. The original
launcher stays in `executable`; `launch_executable` and `launch_entry_script`
identify the selected target. Version probing uses the same resolved transport.
Cursor falls back to the current PowerShell host's `-File shim` only when Node
resolution fails. This fallback retains the vendor shim's lossy PowerShell 5.1
native forwarding; it is explicit evidence, not a fidelity guarantee.

Other PowerShell launches use a JSON payload and encoded bootstrap. Unpaired
batch launchers use explicit cmd.exe with AutoRun/delayed expansion disabled
and two-layer shell escaping. They reject CR/LF argv. Codex stdin is not subject
to this multiline argv restriction.

Wrapper incrementally inspects complete stdout JSONL while waiting. A persistent
UTF-8 decoder handles split characters; malformed lines stay on disk but do not
prevent subsequent metadata. Inspection bounds partial lines to 1 MiB and skips
oversized lines without truncating capture files. Final drain handles fast exits
and final unterminated metadata after confirmed process exit.

Codex `thread.started.thread_id` populates `thread_id`; `turn.failed`/`error`
flag native failure. Cursor `system` / `init` captures `session_id` and `model`;
error results flag native failure. Unknown events remain untouched on disk.
These native events never invent workflow phases. Future session enrichment
must match Codex `thread_id` against `session_meta` identity under
`C:\Users\User\.codex\sessions`; never choose the newest file. v1 does not
resume threads or claim a resumed-thread token delta. Cursor tokens unavailable.

## Operations and retention

Thirty-day retention. Wrappers and the future monitor never delete evidence.
An operator may run `wrappers/prune-runs.ps1` by hand (use `-WhatIf` first).
Nothing schedules it. The helper resolves the runs root (`LIVE_MONITOR_RUNS`,
otherwise `$HOME\.orchestrator\runs`) and deletes only a direct child whose
`manifest.run_id` matches the folder name, whose `ended_at` is strictly older
than 30 days, and whose last status record is `completed` or `failed`.

It refuses a filesystem root, a root with any reparse-point ancestor (including
the root itself), the Codex sessions root
(`$HOME\.codex\sessions`), and any runs root inside that sessions directory.
It skips junction/symlink children and any run that contains a reparse point,
so deletion cannot follow a link out of the root. Run contents are checked for
reparse points before opening their manifest/status as well. External `OutFile` captures
are not inside the run folder and are never deleted. Active runs and runs
without a terminal status (unknown/interrupted) are kept. The runs root itself
is never removed. Legacy external captures need a separate operator policy.

Monitor defaults reserved for later phases: bind `127.0.0.1`, port `5180`; no
Phase 1 server exists. See README for deployment and controlled validation.
