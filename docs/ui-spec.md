# Live Monitor UI rebuild - acceptance checklist
Target image: docs/mockup.jpg (Eric-approved). Match its layout, density and dark palette closely.
Scope: ONLY public/index.html, public/style.css, public/app.js. Do NOT change server/, wrappers/, tests, .env. If a field is truly not exposed by /api/snapshot or SSE, show '–' and list it in docs/ui-gaps.md (no server change).
Data: keep using existing /api/snapshot + SSE (read current app.js to learn field names). NO fake/placeholder data; unknown => '–'.

Layout (3 columns like mockup, ~1440x900 fits without page scroll):
- [ ] H1 Header: large title "Live Agent Monitor" with pulse icon (inline SVG); right side "Connected" with green dot (amber "Reconnecting", red "Disconnected" from SSE state). No theme toggle, no profile icon.
- [ ] L1 Left card "Tasks / Runs" with icon. Each run row: status icon (grey circle check = done, green dot = running, red circled X = failed), title, status text (green Running / grey Done / red Failed), "elapsed · Phase n/m" or "elapsed · n phases". Selected row highlighted with blue left border. Clicking a row selects it.
- [ ] L2 "View All Runs" button at bottom of list (toggles showing all vs latest ~6).
- [ ] T1 "Phase Timeline" card: 4 circular icons Design (GPT), Code (Cursor), Review (GPT), Fix. Done = green filled circle w/ check; active = blue ring w/ icon glow; pending = grey ring. Connector solid green between completed, dashed grey to pending.
- [ ] T2 Under each label: duration (e.g. 1m 08s) and status (Running/Pending/Done/Failed) or '–'.
- [ ] A1 Agent banner card: blue square icon, "Cursor – grok-4.7-medium" (tool – model) bold, sub "Phase N of M · elapsed", right a pill "Running" (green dot) / Idle / Done / Failed.
- [ ] O1 "Live Output" card with "Streaming" green-dot indicator and "Clear" button (clears view only).
- [ ] O2 Output: monospace lines "HH:MM:SS  [TAG]  text"; TAG derived from event type when possible (INFO, PLAN, CODE, TEST, GIT, ERROR, etc.), else INFO. Auto-scroll; bounded line count.
- [ ] O3 Footer "Streaming live output..." with green dot (or "Paused/Idle" when no active run).
- [ ] K1 "Token Usage" card with icon rows: Input (Prompt), Output (Completion), Cached (Shared), each with colored square icon and "N tokens" (thousands separators) or '–' (Cursor reports no tokens).
- [ ] K2 "5h limit" and "Weekly" bars with % right-aligned; blue/green normally, amber >=70%, red >=90%; text under each bar with reset time if available, else '–'.
- [ ] E1 Collapsible "Errors / stderr" section (closed by default, shows count badge) for stderr/error events.
- [ ] M1 Show session ID and branch somewhere small (agent banner subline or token card footer), '–' if unknown.
- [ ] P1 Dark palette: bg #0b0f17-ish, cards #111827-ish with 1px #1f2937 borders, radius 10-12px, accent blue #3b82f6, green #22c55e, red #ef4444, amber #f59e0b; system sans font.
- [ ] Q1 Existing npm test still passes. No console errors. No external CDN assets.
