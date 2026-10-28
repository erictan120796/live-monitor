# Live Monitor

Durable, file-backed PowerShell agent wrappers plus a read-only local monitor.
The server never launches agents and never deletes run evidence.
No production dependencies; Node 24+ for the server and tests. Windows
PowerShell 5.1 or PowerShell 7 for wrappers. Agent CLIs installed/authenticated
separately. Start the monitor, deploy the wrappers, and use the run
folder layout below.

## Start

```powershell
npm start
```

Open http://127.0.0.1:5180. The process binds `127.0.0.1` only. `PORT` overrides
the port. `LIVE_MONITOR_RUNS` overrides the runs root (default
`C:\Users\User\.orchestrator\runs`). Codex token reads use
`C:\Users\User\.codex\sessions`. v1 does not resume Codex sessions.

The page is dark and read-only. It loads `GET /api/snapshot`, then follows
`GET /api/events` and reconnects after a drop, refreshing the snapshot on
events and heartbeats. Six regions:

- Header: runs root and the SSE connection
- Sidebar: runs grouped by `task_id`, with status badges
- Timeline: Design (GPT), Code (Cursor), Review (GPT), and Fix, each with duration
- Current agent: agent, model, effort, phase, and elapsed time
- Live output: snapshot tail, then SSE updates, rendered as text
- Tokens: input, output, and cached counts, plus 5h and weekly bars from primary and secondary `used_percent`

Cursor runs show tokens unavailable. Output is text only. The monitor never
launches agents and never deletes logs.

## Test

```powershell
node --test
node --test test/wrappers.test.mjs
```

Tests invoke real PowerShell processes with local `.ps1`, `.cmd` and compiled
native fixtures. No credentials or network needed. Temporary fixtures/logs stay
inside this repo and are removed afterward. Windows tests explicitly skip on
other OSes; those skips are not Windows validation. Set
`LIVE_MONITOR_TEST_POWERSHELL` to a `pwsh.exe` path to test PowerShell 7.

## Deploy (operator action, not performed by tests)

Copy **all three** wrapper files together into your existing
`C:\Users\User\.orchestrator\bin` after backing up the deployed `crun.ps1`.
Do not change `lastsess.ps1` or `logrow.ps1`. Wrappers do not edit PATH,
execution policy, agent permissions or the historical CSV.

```powershell
$bin = Join-Path $HOME '.orchestrator\bin'
# After backing up existing files:
Copy-Item .\wrappers\run-common.ps1, .\wrappers\codexrun.ps1, .\wrappers\crun.ps1 -Destination $bin
```

Examples may also run directly from `wrappers` without deployment:

```powershell
$task = 'feature-123' # Same ID across design/code/review/fix and retries
.\wrappers\codexrun.ps1 -PromptFile .\design.txt -Phase design -TaskId $task -Model gpt-5 -Effort high
.\wrappers\crun.ps1 -PromptFile .\code.txt -Phase code -TaskId $task -Attempt 1
.\wrappers\codexrun.ps1 -PromptFile .\review.txt -Phase review -TaskId $task
.\wrappers\crun.ps1 -PromptFile .\fix.txt -Phase fix -TaskId $task -Attempt 2 -OutFile .\legacy-fix.txt
```

`Phase` is mandatory; callers must add it. `TaskId` is optional for standalone
runs; orchestrator must supply one shared value for related phase runs.
`Attempt` is a positive integer, default 1. Each call has a unique `run_id`.
`PromptFile` is UTF-8 (with or without BOM); relative paths resolve against the
caller's directory. `WorkDir` defaults to that directory. `TimeoutMin` defaults
to 60 (fractional minutes supported). `Executable` selects a launcher explicitly.
Codex model/effort default to CLI configuration; Cursor model keeps the existing
`grok-4.7-medium` default. No resumed Codex sessions in v1.

## Run folder layout

Default root: `C:\Users\User\.orchestrator\runs` (`$HOME\.orchestrator\runs`).
`LIVE_MONITOR_RUNS`, or wrapper `-RunsRoot`, overrides it. Each invocation
creates one folder. Related design, code, review, and fix runs share one
`task_id` and keep distinct `run_id` values.

```text
<runs-root>\<run_id>\
  manifest.json
  status.jsonl
  stdout.jsonl
  stderr.log
```

Version checks may add `version.stdout.log`, `version.stderr.log`, and
`version-launch.json`. `.ps1` launches may add `launch.json`. Cursor `-OutFile`
captures stay at the given path, outside the run folder, with stderr at
`<OutFile>.err`.

`crun.ps1 -OutFile` remains supported: stdout uses that exact absolute-resolved
path and stderr uses `<OutFile>.err`. Result fields remain `exit`, `duration_s`,
`out`, `err`, with added `run_id`. Output format changes from text to JSONL.
Use distinct overrides for concurrent runs; an active override is locked, not
silently overwritten. Without `OutFile`, every capture is inside its run folder.

## Approved defaults

| Setting | Value |
| --- | --- |
| Runs root | `C:\Users\User\.orchestrator\runs` (`$HOME\.orchestrator\runs`) |
| Override | `LIVE_MONITOR_RUNS`, or wrapper `-RunsRoot` |
| Codex sessions root | `C:\Users\User\.codex\sessions` (`$HOME\.codex\sessions`) |
| Monitor address | `127.0.0.1:5180` (`PORT` overrides the port) |
| Log retention policy | 30 days; optional manual `wrappers/prune-runs.ps1`; wrappers never delete |
| Cursor permission policy | Preserve `--force` and `--trust`; separate from monitoring |
| Codex sessions | New `exec` only; no `resume` support in v1 |

Logs, prompts, tool output and session files may contain secrets. Keep them
local with appropriate Windows ACLs; do not publish or commit production data.
Retention applies to terminal run folders strictly older than 30 days, under the
resolved runs root only. Wrappers never delete logs. The optional helper
`wrappers/prune-runs.ps1` is manual: nothing invokes it during a run. Pass
`-WhatIf` to list matches without deleting. It refuses a drive root, a junction
root or junction ancestor, the Codex sessions root, and any root inside that sessions directory. It
does not follow junctions or symlinks, and it never removes the runs root,
active/unknown runs, external `OutFile` captures, or session files. Review the
dry-run paths before a real prune. Legacy external captures need a separate
operator policy.

```powershell
.\wrappers\prune-runs.ps1 -WhatIf
.\wrappers\prune-runs.ps1
.\wrappers\prune-runs.ps1 -RunsRoot $env:LIVE_MONITOR_RUNS -RetentionDays 30
```

## Server

See [Start](#start). Static files are `public/index.html`, `public/app.js`, and
`public/style.css`. Codex token enrichment reads `$HOME\.codex\sessions` and
keeps the session file whose `session_meta` id equals that run's `thread_id`.
It does not pick the newest session file. There is no resumed-session support
in v1.

- `GET /` — dark live monitor page
- `GET /api/snapshot` — JSON runs with agent, model, effort, phase, status, timings, output tail, and tokens
- `GET /api/events` — server-sent events for appended stdout lines, status changes, and heartbeats. No replay buffer and `Last-Event-ID` is ignored. The page reconnects and reloads the snapshot.

Cursor token counts are unavailable. Codex totals are cumulative snapshots: a
later `turn.completed` usage or session `token_count` replaces the previous
totals instead of adding to them. `used_percent` for primary and secondary rate
limits comes from the matched session `token_count`. The server only reads
evidence. Retention stays on the manual prune helper.

## Validation boundaries

Fixture tests verify transport, quoting, encoding and lifecycle on the selected
PowerShell, including fake vendor shims that forward `$args` to Node. Codex
passes prompts through redirected stdin, never argv. Cursor bypasses its shim
using adjacent or version-selected `node.exe` plus `index.js`. Manifest
`transport` records the selected route. If resolution fails, Cursor uses
PowerShell `-File`; this explicit fallback still has the vendor shim's
PowerShell 5.1 quoting limitations. Unpaired batch launchers reject multiline
argv (not Codex stdin). Fixture success does not validate provider schemas.

Real CLI checks are opt-in and may cost money or allow agent tool execution:
use a disposable workdir, inspect CLI versions/authentication, then set
`LIVE_MONITOR_REAL_SMOKE=codex` or `cursor` (or `codex,cursor`) and run
`node --test test/real-cli.test.mjs`. No smoke runs happen by default. Cursor
availability/version failure blocks real Cursor validation, never fixture work.

See [run protocol](docs/run-protocol.md) for evidence and failure semantics.
See [Phase 1 review validation](docs/phase-1-validation.md) for blocker coverage
and outstanding operator-only checks.
