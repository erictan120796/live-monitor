'use strict';

const PHASES = [
  { id: 'design', label: 'Design (GPT)' },
  { id: 'code', label: 'Code (Cursor)' },
  { id: 'review', label: 'Review (GPT)' },
  { id: 'fix', label: 'Fix' },
];

const TAGS = new Set(['INFO', 'PLAN', 'CODE', 'LINT', 'TEST', 'GIT', 'ERROR']);
const DASH = '\u2013';
const TAIL_LIMIT = 200;
const PREVIEW_COUNT = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

const els = {
  connection: document.getElementById('connection'),
  taskList: document.getElementById('task-list'),
  viewAll: document.getElementById('view-all'),
  agentCard: document.getElementById('agent-card'),
  agentTitle: document.getElementById('agent-title'),
  agentPhaseLabel: document.getElementById('agent-phase-label'),
  agentElapsed: document.getElementById('agent-elapsed'),
  agentPill: document.getElementById('agent-pill'),
  liveOutput: document.getElementById('live-output'),
  streamState: document.getElementById('stream-state'),
  outputFooter: document.getElementById('output-footer'),
  clearOutput: document.getElementById('clear-output'),
  errorsToggle: document.getElementById('errors-toggle'),
  errorsBody: document.getElementById('errors-body'),
  errorsCount: document.getElementById('errors-count'),
  tokenPanel: document.getElementById('token-panel'),
  tokenInput: document.getElementById('token-input'),
  tokenOutput: document.getElementById('token-output'),
  tokenCached: document.getElementById('token-cached'),
  sessionMeta: document.getElementById('session-meta'),
};

let runs = [];
let selectedRunId = null;
let outputRunId = null;
let showAllRuns = false;
let source = null;
let snapshotJob = null;
let snapshotDirty = false;
const cleared = new Map();

function taskKey(run) {
  if (!run || run.task_id == null || run.task_id === '') return `run:${run?.run_id || ''}`;
  return `task:${run.task_id}`;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function agentLabel(agent) {
  if (agent === 'codex') return 'Codex';
  if (agent === 'cursor') return 'Cursor';
  return stringValue(agent) || DASH;
}

function selectedRun() {
  return runs.find(run => run.run_id === selectedRunId) ?? null;
}

function repKey(run) {
  return run.phase || run.run_id;
}

function isNewer(candidate, current) {
  const attemptDelta = (Number(candidate.attempt) || 0) - (Number(current.attempt) || 0);
  if (attemptDelta) return attemptDelta > 0;
  return String(candidate.timings?.started_at || '').localeCompare(String(current.timings?.started_at || '')) > 0;
}

function representativeRuns(taskRuns) {
  const map = new Map();
  for (const run of taskRuns) {
    const key = repKey(run);
    const current = map.get(key);
    if (!current || isNewer(run, current)) map.set(key, run);
  }
  return [...map.values()];
}

function newestStamp(taskRuns) {
  let max = '';
  for (const run of taskRuns) {
    const stamp = String(run.timings?.started_at || '');
    if (stamp > max) max = stamp;
  }
  return max;
}

function orderedTasks() {
  const map = new Map();
  for (const run of runs) {
    const key = taskKey(run);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(run);
  }
  return [...map.entries()]
    .map(([key, taskRuns]) => ({ key, runs: taskRuns }))
    .sort((a, b) => newestStamp(b.runs).localeCompare(newestStamp(a.runs)) || a.key.localeCompare(b.key));
}

function taskStatus(taskRuns) {
  const reps = representativeRuns(taskRuns);
  if (reps.some(run => run.status === 'started')) return 'started';
  if (reps.some(run => run.status === 'failed')) return 'failed';
  if (reps.length && reps.every(run => run.status === 'completed')) return 'completed';
  return 'unknown';
}

function focusRun(taskRuns) {
  const reps = representativeRuns(taskRuns);
  const started = reps.filter(run => run.status === 'started').sort((a, b) => isNewer(a, b) ? -1 : 1);
  if (started[0]) return started[0];
  const failed = reps.filter(run => run.status === 'failed').sort((a, b) => isNewer(a, b) ? -1 : 1);
  if (failed[0]) return failed[0];
  return reps.slice().sort((a, b) => isNewer(a, b) ? -1 : 1)[0] ?? null;
}

function latestForPhase(taskRuns, phaseId) {
  return representativeRuns(taskRuns).find(run => run.phase === phaseId) ?? null;
}

function phaseNumber(phase) {
  if (typeof phase !== 'string' || !phase) return null;
  const index = PHASES.findIndex(item => item.id === phase);
  return index >= 0 ? index + 1 : null;
}

function plannedPhaseTotal(taskRuns) {
  if (!Array.isArray(taskRuns)) return null;
  for (const run of taskRuns) {
    const value = run?.planned_phase_total;
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function phaseProgress(taskRuns, run) {
  return { n: phaseNumber(run?.phase), m: plannedPhaseTotal(taskRuns) };
}

function statusView(status) {
  if (status === 'started') return { text: 'Running', kind: 'running' };
  if (status === 'completed') return { text: 'Done', kind: 'done' };
  if (status === 'failed') return { text: 'Failed', kind: 'failed' };
  return { text: DASH, kind: 'unknown' };
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function elapsedMs(start, end, now) {
  const started = Date.parse(start || '');
  if (!Number.isFinite(started)) return null;
  const ended = end ? Date.parse(end) : NaN;
  const stop = Number.isFinite(ended) ? ended : now;
  const delta = stop - started;
  if (!Number.isFinite(delta)) return null;
  return Math.max(0, delta);
}

function taskElapsedBounds(taskRuns) {
  let start = Infinity;
  let end = -Infinity;
  let open = false;
  for (const run of taskRuns) {
    const started = Date.parse(run.timings?.started_at || '');
    if (!Number.isFinite(started)) continue;
    if (started < start) start = started;
    const ended = Date.parse(run.timings?.ended_at || '');
    if (run.status === 'started' || !Number.isFinite(ended)) open = true;
    if (Number.isFinite(ended) && ended > end) end = ended;
  }
  if (!Number.isFinite(start)) return { start: null, end: null };
  return {
    start: new Date(start).toISOString(),
    end: open || !Number.isFinite(end) ? null : new Date(end).toISOString(),
  };
}

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : DASH;
}

function formatTokens(value) {
  const count = formatCount(value);
  return count === DASH ? DASH : `${count} tokens`;
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}%`;
}

function formatClock(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatReset(bucket) {
  if (!bucket || typeof bucket !== 'object') return DASH;
  const raw = bucket.reset_at ?? bucket.resets_at ?? bucket.reset ?? null;
  if (raw == null || raw === '') return DASH;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return DASH;
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day} ${hh}:${mm}`;
}

function parseJson(line) {
  if (typeof line !== 'string' || !line) return null;
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    return event;
  } catch {
    return null;
  }
}

function safeTag(tag) {
  return TAGS.has(tag) ? tag : 'INFO';
}

function tagFromText(text) {
  const line = String(text || '').trim();
  if (/^\$\s*git\b/i.test(line) || /^tool\s+git\b/i.test(line)) return 'GIT';
  if (/^\$\s*(npm|pnpm|yarn|bun)\s+test\b/i.test(line) || /^\$\s*(pytest|cargo test|go test|vitest|jest)\b/i.test(line)) return 'TEST';
  if (/^\$\s*(eslint|ruff|clippy|golangci-lint)\b/i.test(line) || /^tool\s+(eslint|ruff|lint)\b/i.test(line)) return 'LINT';
  if (/^tool\s+/i.test(line) || /^\$\s+/.test(line)) return 'CODE';
  if (/^(error|stderr)\b/i.test(line) || /^\[error\]/i.test(line)) return 'ERROR';
  if (/^plan\b/i.test(line)) return 'PLAN';
  return 'INFO';
}

function toolNameFromEvent(event) {
  if (typeof event?.name === 'string') return event.name;
  const call = event?.tool_call;
  if (!call || typeof call !== 'object') return '';
  if (typeof call.name === 'string') return call.name;
  const key = Object.keys(call).find(name => call[name] && typeof call[name] === 'object');
  if (!key) return '';
  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}

function tagFromEvent(rawLine, text) {
  const event = parseJson(rawLine);
  if (!event || typeof event.type !== 'string') return safeTag(tagFromText(text));
  const type = event.type;
  if (type === 'error' || type === 'turn.failed') return 'ERROR';
  if (type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (event.is_error === true || subtype.startsWith('error')) return 'ERROR';
    return safeTag(tagFromText(text));
  }
  if (type === 'tool_call') return safeTag(tagFromText(`tool ${toolNameFromEvent(event)}`));
  if (type.startsWith('item.')) {
    const item = event.item && typeof event.item === 'object' ? event.item : {};
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      return safeTag(tagFromText(`$ ${item.command}`));
    }
    if (item.type === 'reasoning' || item.type === 'plan') return 'PLAN';
    if (item.type === 'error') return 'ERROR';
  }
  return safeTag(tagFromText(text));
}

function timeFromRaw(line) {
  const event = parseJson(line);
  if (!event) return null;
  if (typeof event.timestamp_ms === 'number' && Number.isFinite(event.timestamp_ms)) {
    return formatClock(event.timestamp_ms);
  }
  for (const key of ['timestamp', 'ts', 'time']) {
    if (typeof event[key] === 'number' && Number.isFinite(event[key])) return formatClock(event[key]);
    if (typeof event[key] === 'string') {
      const parsed = Date.parse(event[key]);
      if (Number.isFinite(parsed)) return formatClock(parsed);
    }
  }
  return null;
}

function errorTextFromRaw(line) {
  const event = parseJson(line);
  if (!event || typeof event.type !== 'string') return '';
  if (event.type === 'error' || event.type === 'turn.failed') {
    if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
    if (typeof event.error?.message === 'string' && event.error.message.trim()) return event.error.message.trim();
    return '';
  }
  if (event.type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (event.is_error === true || subtype.startsWith('error')) {
      return typeof event.result === 'string' && event.result.trim() ? event.result.trim() : subtype || 'error';
    }
  }
  const item = event.item;
  if (item && item.type === 'command_execution' && item.exit_code != null && Number(item.exit_code) !== 0) {
    const command = typeof item.command === 'string' ? item.command : 'command';
    return `$ ${command} · exit ${item.exit_code}`;
  }
  return '';
}

function noteError(run, text, time) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (!Array.isArray(run._errors)) run._errors = [];
  if (run._errors.some(item => item.text === clean)) return;
  run._errors.push({ text: clean, time: time || null, tag: 'ERROR' });
  if (run._errors.length > TAIL_LIMIT) run._errors.splice(0, run._errors.length - TAIL_LIMIT);
}

function harvestErrors(run) {
  if (Array.isArray(run._meta)) {
    for (const entry of run._meta) {
      if (entry.tag === 'ERROR') noteError(run, entry.text, entry.time);
    }
  }
  if (run.status !== 'failed') return;
  const parts = [];
  if (stringValue(run.status_reason)) parts.push(stringValue(run.status_reason));
  if (run.exit_code != null && run.exit_code !== '') parts.push(`exit ${run.exit_code}`);
  if (!parts.length && run.native_failure === true) parts.push('native_failure');
  if (parts.length) noteError(run, parts.join(' · '), null);
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function statusIcon(status) {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' });
  if (status === 'started') {
    svg.append(svgEl('circle', { cx: 8, cy: 8, r: 4, fill: '#22c55e' }));
    return svg;
  }
  if (status === 'failed') {
    svg.append(svgEl('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: '#ef4444', 'stroke-width': 1.4 }));
    svg.append(svgEl('path', {
      d: 'M5.4 5.4 10.6 10.6M10.6 5.4 5.4 10.6',
      fill: 'none',
      stroke: '#ef4444',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
    }));
    return svg;
  }
  svg.append(svgEl('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: '#6b7280', 'stroke-width': 1.4 }));
  if (status === 'completed') {
    svg.append(svgEl('path', {
      d: 'M4.8 8.2 7 10.3 11.3 5.8',
      fill: 'none',
      stroke: '#6b7280',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
  }
  return svg;
}

function setConnection(state) {
  const labels = {
    connecting: 'Reconnecting',
    live: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
    'snapshot-failed': 'Reconnecting',
  };
  els.connection.dataset.state = state;
  els.connection.textContent = labels[state] || 'Disconnected';
}

function bindTiming(el, start, end) {
  if (!start) {
    el.removeAttribute('data-start');
    el.removeAttribute('data-end');
    el.textContent = DASH;
    return;
  }
  el.dataset.start = start;
  if (end) el.dataset.end = end;
  else el.removeAttribute('data-end');
  el.textContent = formatDuration(elapsedMs(start, end, Date.now()));
}

function sameTail(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function phaseSuffix(taskRuns, status) {
  const focus = focusRun(taskRuns);
  const progress = phaseProgress(taskRuns, focus);
  const active = status === 'started' || status === 'failed';
  if (!progress.n) return active ? ` · ${DASH}` : '';
  if (progress.m && !active) {
    const noun = progress.m === 1 ? 'phase' : 'phases';
    return ` · ${progress.m} ${noun}`;
  }
  const total = progress.m == null ? DASH : progress.m;
  return ` · Phase ${progress.n}/${total}`;
}

function renderSidebar() {
  const scroll = els.taskList.scrollTop;
  const tasks = orderedTasks();
  const visible = showAllRuns ? tasks : tasks.slice(0, PREVIEW_COUNT);
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No runs';
    fragment.append(empty);
  }
  const selected = selectedRun();
  const selectedKey = selected ? taskKey(selected) : '';
  for (const task of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run';
    button.dataset.taskKey = task.key;
    if (task.key === selectedKey) button.classList.add('is-selected');
    const status = taskStatus(task.runs);
    const view = statusView(status);
    const focus = focusRun(task.runs);
    const rawId = task.runs.find(item => item.task_id != null && item.task_id !== '')?.task_id;
    const title = rawId == null ? DASH : String(rawId);
    if (focus?.run_id) button.title = focus.run_id;
    const icon = document.createElement('span');
    icon.className = 'status-icon';
    icon.append(statusIcon(status));
    const titleEl = document.createElement('span');
    titleEl.className = 'run-title';
    titleEl.textContent = title;
    const statusEl = document.createElement('span');
    statusEl.className = 'run-status';
    statusEl.dataset.status = view.kind;
    statusEl.textContent = view.text;
    const meta = document.createElement('span');
    meta.className = 'run-meta';
    const elapsed = document.createElement('span');
    elapsed.className = 'run-elapsed';
    const bounds = taskElapsedBounds(task.runs);
    bindTiming(elapsed, bounds.start, bounds.end);
    const suffix = document.createElement('span');
    suffix.textContent = phaseSuffix(task.runs, status);
    meta.append(elapsed, suffix);
    button.append(icon, titleEl, statusEl, meta);
    fragment.append(button);
  }
  els.taskList.replaceChildren(fragment);
  els.taskList.scrollTop = scroll;
  els.viewAll.setAttribute('aria-pressed', showAllRuns ? 'true' : 'false');
  els.viewAll.title = showAllRuns ? 'Show latest runs' : 'Show all runs';
}

function renderTimeline() {
  const run = selectedRun();
  const taskRuns = run ? runs.filter(item => taskKey(item) === taskKey(run)) : [];
  for (const phase of PHASES) {
    const item = document.querySelector(`#timeline [data-phase="${phase.id}"]`);
    const button = item.querySelector('button');
    const duration = item.querySelector('.phase-duration');
    const status = item.querySelector('.phase-status');
    const phaseRun = latestForPhase(taskRuns, phase.id);
    let kind = 'pending';
    if (phaseRun?.status === 'started') kind = 'active';
    else if (phaseRun?.status === 'completed') kind = 'done';
    else if (phaseRun?.status === 'failed') kind = 'failed';
    item.className = `is-${kind}`;
    if (phaseRun && run && phaseRun.run_id === run.run_id) item.classList.add('is-current');
    button.disabled = !phaseRun;
    if (phaseRun) button.dataset.runId = phaseRun.run_id;
    else delete button.dataset.runId;
    bindTiming(duration, phaseRun?.timings?.started_at, phaseRun?.timings?.ended_at);
    if (!phaseRun) {
      status.textContent = 'Pending';
      status.dataset.status = 'pending';
    } else if (phaseRun.status === 'started') {
      status.textContent = 'Running';
      status.dataset.status = 'running';
    } else if (phaseRun.status === 'completed') {
      status.textContent = 'Done';
      status.dataset.status = 'done';
    } else if (phaseRun.status === 'failed') {
      status.textContent = 'Failed';
      status.dataset.status = 'failed';
    } else {
      status.textContent = DASH;
      status.dataset.status = 'unknown';
    }
  }
}

function renderAgent() {
  const run = selectedRun();
  els.agentCard.dataset.empty = run ? 'false' : 'true';
  if (!run) {
    els.agentTitle.textContent = DASH;
    els.agentPhaseLabel.textContent = DASH;
    els.agentElapsed.textContent = '';
    els.agentElapsed.removeAttribute('data-start');
    els.agentElapsed.removeAttribute('data-end');
    els.agentPill.dataset.status = 'idle';
    els.agentPill.textContent = 'Idle';
    return;
  }
  const model = stringValue(run.model) || DASH;
  const tool = agentLabel(run.agent);
  els.agentTitle.textContent = tool === DASH && model === DASH ? DASH : `${tool} ${DASH} ${model}`;
  const taskRuns = runs.filter(item => taskKey(item) === taskKey(run));
  const progress = phaseProgress(taskRuns, run);
  if (progress.n) {
    const total = progress.m == null ? DASH : progress.m;
    els.agentPhaseLabel.textContent = `Phase ${progress.n} of ${total} · `;
  } else {
    els.agentPhaseLabel.textContent = DASH;
  }
  if (run.timings?.started_at) bindTiming(els.agentElapsed, run.timings.started_at, run.timings.ended_at);
  else {
    els.agentElapsed.removeAttribute('data-start');
    els.agentElapsed.removeAttribute('data-end');
    els.agentElapsed.textContent = progress.n ? DASH : '';
  }
  if (run.status === 'started') {
    els.agentPill.dataset.status = 'running';
    els.agentPill.textContent = 'Running';
  } else if (run.status === 'completed') {
    els.agentPill.dataset.status = 'done';
    els.agentPill.textContent = 'Done';
  } else if (run.status === 'failed') {
    els.agentPill.dataset.status = 'failed';
    els.agentPill.textContent = 'Failed';
  } else {
    els.agentPill.dataset.status = 'idle';
    els.agentPill.textContent = 'Idle';
  }
}

function showTime(value) {
  return (value || DASH).padEnd(8, ' ');
}

function renderLogLine(entry) {
  const row = document.createElement('div');
  row.className = 'log-line';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = `${showTime(entry.time)}  `;
  const tag = document.createElement('span');
  const safe = safeTag(entry.tag);
  tag.className = `log-tag tag-${safe.toLowerCase()}`;
  tag.textContent = `${`[${safe}]`.padEnd(7, ' ')}  `;
  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = entry.text;
  row.append(time, tag, text);
  return row;
}

function clearMark(run) {
  const saved = cleared.get(run.run_id);
  if (!saved) return null;
  if (Array.isArray(saved)) return { lines: saved, partial: false };
  if (!Array.isArray(saved.lines)) return null;
  return { lines: saved.lines, partial: Boolean(saved.partial) };
}

function visibleEntries(run) {
  if (!run) return [];
  const entries = Array.isArray(run._meta) ? run._meta : [];
  const mark = clearMark(run);
  if (!mark || !mark.lines.length) return entries;
  const texts = entries.map(entry => entry.text);
  for (let offset = 0; offset <= mark.lines.length; offset += 1) {
    const suffix = mark.lines.slice(offset);
    if (suffix.length > texts.length) continue;
    let remainder = '';
    let ok = true;
    for (let i = 0; ok && i < suffix.length; i += 1) {
      const expected = suffix[i];
      const current = texts[i];
      if (current === expected) continue;
      const boundary = mark.partial && i === suffix.length - 1;
      if (boundary && typeof expected === 'string' && expected && typeof current === 'string' && current.startsWith(expected)) {
        remainder = current.slice(expected.length);
        continue;
      }
      ok = false;
    }
    if (!ok) continue;
    const rest = entries.slice(suffix.length);
    if (!remainder) return rest;
    const source = entries[suffix.length - 1];
    return [{
      text: remainder,
      time: source?.time || null,
      tag: safeTag(source?.tag || 'INFO'),
    }, ...rest];
  }
  return entries;
}

function renderStream(run) {
  const live = run?.status === 'started';
  els.streamState.dataset.state = live ? 'live' : 'idle';
  els.streamState.textContent = live ? 'Streaming' : 'Idle';
  els.outputFooter.dataset.state = live ? 'live' : 'idle';
  els.outputFooter.textContent = live ? 'Streaming live output...' : 'Paused/Idle';
}

function renderOutput() {
  const run = selectedRun();
  const entries = visibleEntries(run);
  const switching = (run?.run_id ?? null) !== outputRunId;
  const distance = els.liveOutput.scrollHeight - els.liveOutput.scrollTop - els.liveOutput.clientHeight;
  const stick = switching || distance < 48;
  const fragment = document.createDocumentFragment();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'output-empty';
    empty.textContent = 'No output';
    fragment.append(empty);
  } else {
    const start = Math.max(0, entries.length - TAIL_LIMIT);
    for (let i = start; i < entries.length; i += 1) fragment.append(renderLogLine(entries[i]));
  }
  els.liveOutput.replaceChildren(fragment);
  if (stick) els.liveOutput.scrollTop = els.liveOutput.scrollHeight;
  outputRunId = run?.run_id ?? null;
  renderStream(run);
}

function renderErrors() {
  const run = selectedRun();
  const errors = Array.isArray(run?._errors) ? run._errors : [];
  els.errorsCount.textContent = String(errors.length);
  els.errorsCount.dataset.hot = errors.length > 0 ? 'true' : 'false';
  const fragment = document.createDocumentFragment();
  if (!errors.length) {
    const empty = document.createElement('p');
    empty.className = 'output-empty';
    empty.textContent = DASH;
    fragment.append(empty);
  } else {
    for (const entry of errors) fragment.append(renderLogLine(entry));
  }
  els.errorsBody.replaceChildren(fragment);
}

function setBar(fillId, valueId, trackId, resetId, bucket, which) {
  const fill = document.getElementById(fillId);
  const label = document.getElementById(valueId);
  const track = document.getElementById(trackId);
  const reset = document.getElementById(resetId);
  const percent = bucket?.used_percent;
  reset.textContent = formatReset(bucket);
  fill.dataset.which = which;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    fill.style.width = '0%';
    fill.dataset.level = 'empty';
    label.textContent = DASH;
    track.setAttribute('aria-valuenow', '0');
    return;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  fill.style.width = `${clamped}%`;
  fill.dataset.level = clamped >= 90 ? 'high' : clamped >= 70 ? 'mid' : 'ok';
  label.textContent = formatPercent(percent);
  track.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function renderSession(run) {
  const session = stringValue(run?.session_id) || stringValue(run?.thread_id) || DASH;
  const branch = stringValue(run?.branch) || stringValue(run?.git_branch) || DASH;
  const text = `session ${session} · branch ${branch}`;
  els.sessionMeta.textContent = text;
  els.sessionMeta.title = text;
}

function renderTokens() {
  const run = selectedRun();
  const tokens = run?.tokens && typeof run.tokens === 'object' ? run.tokens : {};
  const unavailable = Boolean(run && tokens.available === false);
  els.tokenPanel.dataset.state = !run ? 'empty' : unavailable ? 'unavailable' : 'available';
  els.tokenInput.textContent = formatTokens(tokens.input_tokens);
  els.tokenOutput.textContent = formatTokens(tokens.output_tokens);
  els.tokenCached.textContent = formatTokens(tokens.cached_input_tokens);
  setBar('limit-primary-fill', 'limit-primary-value', 'limit-primary-track', 'limit-primary-reset', tokens.rate_limits?.primary, 'primary');
  setBar('limit-secondary-fill', 'limit-secondary-value', 'limit-secondary-track', 'limit-secondary-reset', tokens.rate_limits?.secondary, 'secondary');
  renderSession(run);
}

function renderAll() {
  renderSidebar();
  renderTimeline();
  renderAgent();
  renderOutput();
  renderErrors();
  renderTokens();
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-start]')) {
    if (!el.dataset.start) continue;
    el.textContent = formatDuration(elapsedMs(el.dataset.start, el.dataset.end, now));
  }
}

function realignMeta(previous, tail) {
  const result = [];
  let cursor = 0;
  const prior = Array.isArray(previous) ? previous : [];
  for (const text of tail) {
    let found = -1;
    for (let i = cursor; i < prior.length; i += 1) {
      if (prior[i].text === text) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      result.push({
        text,
        time: prior[found].time || null,
        tag: safeTag(prior[found].tag || tagFromText(text)),
      });
      cursor = found + 1;
    } else {
      result.push({ text, time: null, tag: safeTag(tagFromText(text)) });
    }
  }
  return result;
}

function applySnapshot(body) {
  const previous = new Map(runs.map(run => [run.run_id, run]));
  const next = Array.isArray(body?.runs) ? body.runs : [];
  for (const run of next) {
    if (!Array.isArray(run.output_tail)) run.output_tail = [];
    const old = previous.get(run.run_id);
    run._meta = realignMeta(old?._meta, run.output_tail);
    run._errors = Array.isArray(old?._errors) ? old._errors : [];
    run._openPartial = Boolean(old?._openPartial && sameTail(old?.output_tail, run.output_tail));
    harvestErrors(run);
  }
  runs = next;
  if (!runs.some(run => run.run_id === selectedRunId)) {
    const first = orderedTasks()[0];
    selectedRunId = first ? focusRun(first.runs)?.run_id ?? null : null;
  }
  renderAll();
}

async function pullSnapshot() {
  const response = await fetch('/api/snapshot', { cache: 'no-store' });
  if (!response.ok) throw new Error(`snapshot ${response.status}`);
  applySnapshot(await response.json());
  if (source && source.readyState === EventSource.OPEN) setConnection('live');
}

function requestSnapshot() {
  snapshotDirty = true;
  if (!snapshotJob) snapshotJob = drainSnapshots();
  return snapshotJob;
}

async function drainSnapshots() {
  try {
    do {
      snapshotDirty = false;
      await pullSnapshot();
    } while (snapshotDirty);
  } catch {
    setConnection('snapshot-failed');
    await new Promise(resolve => setTimeout(resolve, 1000));
  } finally {
    snapshotJob = null;
    if (snapshotDirty) requestSnapshot();
  }
}

function isPartial(line) {
  const event = parseJson(line);
  return Boolean(event && event.type === 'assistant' && event.timestamp_ms != null && event.model_call_id == null);
}

function trimTail(run) {
  if (run.output_tail.length <= TAIL_LIMIT) return;
  const drop = run.output_tail.length - TAIL_LIMIT;
  run.output_tail.splice(0, drop);
  if (Array.isArray(run._meta)) run._meta.splice(0, Math.min(drop, run._meta.length));
}

function applyStdout(run, data) {
  if (!Array.isArray(run.output_tail)) run.output_tail = [];
  if (!Array.isArray(run._meta)) run._meta = [];
  const time = timeFromRaw(data.line);
  const errText = errorTextFromRaw(data.line);
  if (errText) noteError(run, errText, time);
  if (isPartial(data.line)) {
    const chunk = typeof data.text === 'string' ? data.text : '';
    if (!chunk) return;
    const tag = tagFromEvent(data.line, chunk);
    if (!run._openPartial || !run.output_tail.length) {
      run.output_tail.push(chunk);
      run._meta.push({ text: chunk, time, tag });
      run._openPartial = true;
    } else {
      const last = run.output_tail.length - 1;
      run.output_tail[last] += chunk;
      if (run._meta[last]) run._meta[last].text += chunk;
      else run._meta[last] = { text: run.output_tail[last], time, tag };
    }
  } else {
    run._openPartial = false;
    if (typeof data.text === 'string' && data.text.length) {
      const parts = data.text.split('\n').filter(line => line.length);
      parts.forEach((line, index) => {
        const tag = index === 0 ? tagFromEvent(data.line, line) : safeTag(tagFromText(line));
        run.output_tail.push(line);
        run._meta.push({ text: line, time, tag });
        if (tag === 'ERROR') noteError(run, line, time);
      });
    }
  }
  trimTail(run);
}

function onStdout(data) {
  if (!data || typeof data.run_id !== 'string') {
    requestSnapshot();
    return;
  }
  const run = runs.find(item => item.run_id === data.run_id);
  if (run) {
    applyStdout(run, data);
    if (run.run_id === selectedRunId) {
      renderOutput();
      renderErrors();
    }
  }
  requestSnapshot();
}

function onStatus(data) {
  if (!data || typeof data.run_id !== 'string') {
    requestSnapshot();
    return;
  }
  const run = runs.find(item => item.run_id === data.run_id);
  if (run) {
    if (typeof data.status === 'string') run.status = data.status;
    if (data.phase) run.phase = data.phase;
    run.status_reason = data.reason ?? null;
    if (data.exit_code != null) run.exit_code = data.exit_code;
    harvestErrors(run);
    renderAll();
  }
  requestSnapshot();
}

function onEvent(type, event) {
  let data = null;
  if (type !== 'heartbeat') {
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
  }
  if (type === 'stdout') onStdout(data);
  else if (type === 'status') onStatus(data);
  else requestSnapshot();
}

function connect() {
  source = new EventSource('/api/events');
  source.addEventListener('stdout', event => onEvent('stdout', event));
  source.addEventListener('status', event => onEvent('status', event));
  source.addEventListener('run', event => onEvent('run', event));
  source.addEventListener('heartbeat', event => onEvent('heartbeat', event));
  source.onopen = () => {
    setConnection('live');
    requestSnapshot();
  };
  source.onerror = () => {
    setConnection(source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting');
  };
}

function onTaskClick(event) {
  const button = event.target.closest('[data-task-key]');
  if (!button) return;
  const task = orderedTasks().find(item => item.key === button.dataset.taskKey);
  const focus = task ? focusRun(task.runs) : null;
  if (!focus) return;
  selectedRunId = focus.run_id;
  renderAll();
}

function onTimelineClick(event) {
  const button = event.target.closest('#timeline button');
  if (!button || button.disabled || !button.dataset.runId) return;
  selectedRunId = button.dataset.runId;
  renderAll();
}

function onClear() {
  const run = selectedRun();
  if (!run) return;
  const lines = Array.isArray(run.output_tail) ? run.output_tail.slice() : [];
  cleared.set(run.run_id, { lines, partial: Boolean(run._openPartial) });
  run.output_tail = [];
  run._meta = [];
  run._openPartial = false;
  renderOutput();
}

function onErrorsToggle() {
  const open = els.errorsToggle.getAttribute('aria-expanded') === 'true';
  els.errorsToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
  els.errorsBody.hidden = open;
}

async function main() {
  els.taskList.addEventListener('click', onTaskClick);
  els.viewAll.addEventListener('click', () => {
    showAllRuns = !showAllRuns;
    renderSidebar();
  });
  document.getElementById('timeline').addEventListener('click', onTimelineClick);
  els.clearOutput.addEventListener('click', onClear);
  els.errorsToggle.addEventListener('click', onErrorsToggle);
  renderAll();
  setConnection('connecting');
  await requestSnapshot();
  connect();
  setInterval(tick, 1000);
}

main();
