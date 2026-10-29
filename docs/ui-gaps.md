# UI data gaps

These values render as `–` because `/api/snapshot` and the SSE stream (`stdout`, `status`, `run`, `heartbeat`) do not expose them. The server was not changed.

- **Branch.** Run objects have no `branch` or git ref. The token-card footer shows `–` until a `branch` or `git_branch` field exists.
- **Rate-limit reset time.** `tokens.rate_limits.primary` and `tokens.rate_limits.secondary` only include `used_percent`. Text under the 5h and Weekly bars is `–` unless `reset_at`, `resets_at`, or `reset` is present.
- **stderr capture.** Wrappers write `stderr.log`, but that file is not in the snapshot or the SSE stream. Errors / stderr lists what does arrive: stdout lines tagged ERROR, SSE `error` / `turn.failed` / Cursor error `result` events, failed command executions, and a failed run's `status_reason` (plus `exit_code` / `native_failure` when that is all the API sends). Bytes that exist only in `stderr.log` stay unavailable.
- **Per-line timestamps on historical output.** `output_tail` is plain text. A clock is shown only when an SSE stdout payload includes `timestamp_ms`, `timestamp`, `ts`, or `time`. Lines known only from the snapshot show `–`.
- **Task title.** There is no human-readable task name. Each row uses `task_id`, or `–` when `task_id` is null.
- **Cursor tokens.** For Cursor, `tokens.available` is false and counts are null. Input, output, cached, and both limit percents render as `–`.
- **Codex session id.** Codex runs expose `thread_id` and often leave `session_id` null. The footer shows `session_id` when set, otherwise `thread_id`.
