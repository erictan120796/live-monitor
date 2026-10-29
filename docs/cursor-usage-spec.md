## Data model
- Add top-level `/api/snapshot.cursor_usage`; preserve existing `runs[].tokens`.
- Shape:
  ```js
  {
    timezone: "Asia/Kuala_Lumpur",
    today: { run_count, input_tokens, output_tokens, cached_input_tokens, total_tokens },
    last_7_days: { run_count, input_tokens, output_tokens, cached_input_tokens, total_tokens },
    this_month: { run_count, input_tokens, output_tokens, cached_input_tokens, total_tokens }
  }
  ```
- Source: every discovered run under `runs_root` whose `manifest.json.agent === "cursor"`; read its `stdout.jsonl`, not the 200-line output tail.
- Use last valid `type: "result"` event containing usage per run. Replace previous contribution; never double-count replayed events.
- Map `inputTokens` â†’ `input_tokens`, `outputTokens` â†’ `output_tokens`, `cacheReadTokens` â†’ `cached_input_tokens`.
- Require finite, nonnegative integer input/output counters; zero valid. Missing/invalid input/output means unusable usage.
- `total_tokens = input_tokens + output_tokens`. Neither cache-read nor `cacheWriteTokens` added.
- Missing/invalid cache-read counter remains unknown; bucket cached total becomes `null` if any contributing run lacks it.
- Runs without usable result usage excluded, including completed runs; failed runs with usable usage included.

## Time buckets
- Bucket timestamp: valid run `ended_at` (existing manifest/status-derived value), otherwise result event time.
- Result time: valid ISO `timestamp`, otherwise finite epoch-millisecond `timestamp_ms`.
- Neither timestamp valid: exclude contribution until timestamp becomes available. Never substitute `started_at`, file mtime, or receipt time.
- Later `ended_at` availability rebuckets existing contribution; no stdout reread required.
- Calendar calculations use Asia/Kuala_Lumpur (UTC+8), independent of server/browser timezone.
- Today: local midnight through next midnight.
- Last 7 days: local midnight six dates before today through tomorrowâ€™s midnight; not trailing 168 hours.
- This month: local first-of-month midnight through next monthâ€™s first midnight.
- All intervals start-inclusive, end-exclusive. Recompute against current server time, including idle midnight rollover.

## Exact files to change
- `src/usage.mjs`: result-record extraction retaining event time; validation, per-run file cache, pure bucket aggregation with injectable `now`.
- `src/server.mjs`: own cache; reconcile all discovered Cursor runs during refresh; expose aggregates; emit SSE invalidation after aggregate changes.
- `public/index.html`: always-visible â€œCursor usageâ€ subsection inside Token Usage; rows Today, Last 7 days, This month; columns Input, Output, Cached, Total; timezone label â€œMYT (UTC+8)â€.
- `public/app.js`: retain `cursor_usage` separately from selected run; render via `textContent`; listen for `cursor_usage` SSE event and call existing coalesced `requestSnapshot()`.
- `public/style.css`: compact responsive aggregate layout; ensure selected-run empty/unavailable styling never hides subsection.
- `test/usage.test.mjs`: parser, aggregation, calendar, cache tests.
- `test/server.test.mjs`: historical snapshot totals, append/status updates, SSE, cache integration.
- `test/ui.test.mjs`: section visibility, values, selection independence, link attributes.
- No changes needed in `src/tailer.mjs` or `src/discovery.mjs`; reuse existing discovery and polling.

## Cache and live updates
- Per-run cache keyed by run directory + resolved stdout path; fingerprint `{ size, mtimeMs }`.
- Cache normalized latest valid result, result time, and no-usage outcomes; unchanged fingerprint means no stdout content reread.
- Changed size **or** mtime: rescan file and replace cached result, handling append, truncation, and same-size rewrites.
- Ignore malformed JSON lines; retry incomplete final line when file changes. Accept complete final JSON without newline.
- Stat before/after scan; publish/cache only stable reads. Retry transient read failures; never cache them as successful empty reads.
- Reconcile removed runs; evict their cache/contributions. Refresh metadata independently from stdout fingerprint.
- Serialize refresh/cache work. Snapshot waits for reconciliation; aggregation itself uses memory only.
- Poll reconciliation emits `cursor_usage` invalidation when totals change, including manifest-only rebucketing and midnight rollover; existing stdout/status events remain unchanged.
- No budget, allowance, remaining-token estimate, or settings.

## Acceptance checklist
- **U1** Multiple Cursor runs sum correctly across overlapping buckets; Codex excluded; cached/write tokens never inflate total.
- **U2** Runs without usable usage excluded; explicit all-zero usage counted; malformed lines ignored without aborting scan.
- **U3** UTC+8 day/month boundaries correct: `2026-10-31T16:30Z` counts as Nov 1 MYT; test immediately before/at midnight.
- **U4** Seven-day window includes today plus six preceding calendar dates; test oldest boundary, month/year crossover, idle rollover.
- **U5** `ended_at` wins over result time; fallback works; missing times excluded; later end timestamp rebuckets without duplication.
- **U6** In-progress run contributes only after valid result appears; repeated snapshots/result replay do not accumulate duplicates.
- **U7** Read-count tests prove unchanged files not reread; append, size change, same-size mtime change, truncation, deletion, and transient retry covered.
- **U8** Appended result and later completion update snapshot/UI through SSE without reload; manifest-only changes also notify.
- **U9** Before first successful snapshot: `â€“`. Successful empty buckets: `0`. Unknown cached metric: `â€“`; numeric zero never becomes `â€“`.
- **U10** Section stays visible with no runs, selected Codex, selected Cursor without usage, and selection changes; totals unchanged by selection.
- **U11** Link text â€œCheck remaining on Cursorâ€; `href="https://cursor.com/dashboard"`, `target="_blank"`, `rel="noopener"`; no allowance controls.
- **U12** Add deterministic unit/integration/UI tests above; existing token, tailer, discovery, and SSE tests remain passing.
