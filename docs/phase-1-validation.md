# Phase 1 review closure

Review input: `p1-review3-last.md`. Its missing-file findings describe an empty
tree; the repository now contains the Phase 1 implementation below.

| Review blocker | Repository evidence |
| --- | --- |
| Missing wrappers | `wrappers/run-common.ps1`, `codexrun.ps1`, `crun.ps1`: durable manifest/status, redirected captures, bounded timeout/version probe, metadata discovery, legacy `OutFile` and return fields |
| Missing fixture tests / zero tests | `test/wrappers.test.mjs`, `test/fixtures/fake-agent.*`: PowerShell, batch and native launchers; quoting/Unicode/multiline; live output; final drain; concurrent runs; failures; cancellation; retention containment |
| Missing protocol/deployment/package | `docs/run-protocol.md`, `README.md`, `package.json`: versioned protocol, deployment, approved defaults and retention policy; Node 24, built-in modules, no production dependencies |

Additional regression checks cover manifest and flushed `started` publication
before the version process launches, a stalled version probe consuming the run
timeout, and malformed/oversized output followed by final metadata. The manual
prune helper rejects junction ancestors as well as junction roots, and checks
run contents for reparse points before opening manifest/status evidence.

## Local verification

Verified 2026-10-29: Node v24.18.0, Windows PowerShell 5.1.26100.9711.
`node --test`: 34 discovered, 32 passed, 0 failed, 2 opt-in real-CLI checks
skipped; exit code 0.

Run `node --test` from the repository root. Fixture tests run on Windows
PowerShell 5.1; `LIVE_MONITOR_TEST_POWERSHELL` selects another host. Test artifacts
stay inside the repository and are removed after testing. The full suite includes
two opt-in real-CLI checks, skipped unless explicitly requested.

Transport regressions use a fake PowerShell shim that forwards $args to Node,
reproducing the installed launchers' Windows PowerShell 5.1 boundary. Codex
uses redirected stdin (including empty and long prompts); Cursor bypasses the
shim using local or date-selected versioned node.exe plus index.js. Tests cover
embedded double quotes, empty argv, Unicode, multiline text, and the explicitly
recorded powershell -File fallback. These do not validate provider schemas.
Real Codex/Cursor checks, deployment and repository history remain operator
actions. No real agent, deployment, production-log pruning, resumed Codex
session, or Phase 2–5 service is required or claimed by this fixture validation.
