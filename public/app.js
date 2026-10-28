'use strict';

const PHASES = [
  { id: 'design', label: 'Design (GPT)' },
  { id: 'code', label: 'Code (Cursor)' },
  { id: 'review', label: 'Review (GPT)' },
  { id: 'fix', label: 'Fix' },
];

const STATUSES = new Set(['started', 'completed', 'failed', 'unknown']);
const TAIL_LIMIT = 200;

const els = {
  runsRoot: document.getElementById('runs-root'),
  connection: document.getElementById('connection'),
  taskList: document.getElementById('task-list'),
  sidebar: document.getElementById('sidebar'),
  agentName: document.getElementById('agent-name'),
  agentModel: document.getElementById('agent-model'),
  agentEffort: document.getElementById('agent-effort'),
  agentPhase: document.getElementById('agent-phase'),
  agentElapsed: document.getElementById('agent-elapsed'),
  outputEmpty: document.getElementById('output-empty'),
  liveOutput: document.getElementById('live-output'),
  tokenPanel: document.getElementById('token-panel'),
  tokenUnavailable: document.getElementById('token-unavailable'),
  tokenMetrics: document.getElementById('token-metrics'),
  tokenInput: document.getElementById('token-input'),
  tokenOutput: document.getElementById('token-output'),
  tokenCached: document.getElementById('token-cached'),
};

let runs = [];
let runsRoot = '';
let selectedId = null;
let outputRunId = null;
let source = null;
let snapshotJob = null;
let snapshotDirty = false;

function groupKey(run) {
  if (!run || run.task_id == null || run.task_id === '') return '';
  return String(run.task_id);
}

function statusName(status) {
  return STATUSES.has(status) ? status : 'unknown';
}

function agentLabel(agent) {
  if (agent === 'codex') return 'Codex';
  if (agent === 'cursor') return 'Cursor';
  return agent || '—';
}

function phaseLabel(phase) {
  const known = PHASES.find(item => item.id === phase);
  if (known) return known.label;
  return phase || '—';
}

function selectedRun() {
  return runs.find(run => run.run_id === selectedId) ?? null;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
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

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '—';
}

function setConnection(state) {
  const labels = {
    connecting: 'connecting',
    live: 'live',
    reconnecting: 'reconnecting',
    disconnected: 'disconnected',
    'snapshot-failed': 'snapshot failed',
  };
  els.connection.dataset.state = state;
  els.connection.textContent = labels[state] || state;
}

function bindTiming(el, run) {
  const start = run?.timings?.started_at;
  if (!start) {
    el.removeAttribute('data-start');
    el.removeAttribute('data-end');
    el.textContent = '—';
    return;
  }
  el.dataset.start = start;
  if (run.timings.ended_at) el.dataset.end = run.timings.ended_at;
  else el.removeAttribute('data-end');
  el.textContent = formatDuration(elapsedMs(start, run.timings.ended_at, Date.now()));
}

function sameTail(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function makeBadge(status, reason) {
  const span = document.createElement('span');
  span.className = `badge badge-${statusName(status)}`;
  span.textContent = typeof status === 'string' && status ? status : 'unknown';
  if (reason) span.title = String(reason);
  return span;
}

function groupRuns(list) {
  const groups = [];
  const index = new Map();
  for (const run of list) {
    const key = groupKey(run);
    let group = index.get(key);
    if (!group) {
      group = { key, label: key || 'no task', runs: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.runs.push(run);
  }
  return groups;
}

function renderHeader() {
  els.runsRoot.textContent = runsRoot || '—';
  els.runsRoot.title = runsRoot || '';
}

function renderSidebar() {
  const scroll = els.sidebar.scrollTop;
  const groups = groupRuns(runs);
  const fragment = document.createDocumentFragment();
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No runs';
    fragment.append(empty);
  }
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'task-group';
    if (group.runs.some(run => run.run_id === selectedId)) section.classList.add('is-selected');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'task-head';
    head.dataset.taskKey = `task:${group.key}`;
    const label = document.createElement('span');
    label.className = 'task-label';
    label.textContent = group.label;
    head.append(label, makeBadge(group.runs[0].status, group.runs[0].status_reason));

    const list = document.createElement('div');
    list.className = 'run-list';
    for (const run of group.runs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'run';
      button.dataset.runId = run.run_id;
      if (run.run_id === selectedId) button.classList.add('is-selected');
      const runLabel = document.createElement('span');
      runLabel.className = 'run-label';
      const parts = [run.phase || 'phase', agentLabel(run.agent)];
      if (run.attempt != null) parts.push(`attempt ${run.attempt}`);
      runLabel.textContent = parts.join(' · ');
      button.title = run.run_id;
      button.append(runLabel, makeBadge(run.status, run.status_reason));
      list.append(button);
    }
    section.append(head, list);
    fragment.append(section);
  }
  els.taskList.replaceChildren(fragment);
  els.sidebar.scrollTop = scroll;
}

function runForPhase(taskRuns, phaseId) {
  const selected = selectedRun();
  if (selected && selected.phase === phaseId && taskRuns.some(run => run.run_id === selected.run_id)) {
    return selected;
  }
  return taskRuns.find(run => run.phase === phaseId) ?? null;
}

function renderTimeline() {
  const selected = selectedRun();
  const taskRuns = selected ? runs.filter(run => groupKey(run) === groupKey(selected)) : [];
  for (const phase of PHASES) {
    const item = document.querySelector(`#timeline [data-phase="${phase.id}"]`);
    const button = item.querySelector('button');
    const duration = item.querySelector('.phase-duration');
    const run = runForPhase(taskRuns, phase.id);
    item.className = run ? `is-${statusName(run.status)}` : 'is-idle';
    if (run && selected && run.run_id === selected.run_id) item.classList.add('is-current');
    button.disabled = !run;
    if (run) button.dataset.runId = run.run_id;
    else delete button.dataset.runId;
    bindTiming(duration, run);
  }
}

function renderAgent() {
  const run = selectedRun();
  els.agentName.textContent = run ? agentLabel(run.agent) : '—';
  els.agentModel.textContent = run?.model || '—';
  els.agentEffort.textContent = run?.effort || '—';
  els.agentPhase.textContent = run ? phaseLabel(run.phase) : '—';
  bindTiming(els.agentElapsed, run);
}

function renderOutput() {
  const run = selectedRun();
  const lines = Array.isArray(run?.output_tail) ? run.output_tail : [];
  const switching = (run?.run_id ?? null) !== outputRunId;
  const distance = els.liveOutput.scrollHeight - els.liveOutput.scrollTop - els.liveOutput.clientHeight;
  const stick = switching || distance < 48;
  els.outputEmpty.hidden = lines.length > 0;
  els.liveOutput.textContent = lines.join('\n');
  if (stick) els.liveOutput.scrollTop = els.liveOutput.scrollHeight;
  outputRunId = run?.run_id ?? null;
}

function setBar(fillId, valueId, trackId, percent) {
  const fill = document.getElementById(fillId);
  const label = document.getElementById(valueId);
  const track = document.getElementById(trackId);
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    fill.style.width = '0%';
    fill.dataset.level = 'empty';
    label.textContent = '—';
    track.setAttribute('aria-valuenow', '0');
    return;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  fill.style.width = `${clamped}%`;
  fill.dataset.level = clamped >= 90 ? 'high' : clamped >= 70 ? 'mid' : 'ok';
  label.textContent = `${percent}%`;
  track.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function renderTokens() {
  const run = selectedRun();
  const unavailable = Boolean(run && run.tokens && run.tokens.available === false);
  els.tokenPanel.dataset.state = !run ? 'empty' : unavailable ? 'unavailable' : 'available';
  els.tokenUnavailable.hidden = !unavailable;
  els.tokenMetrics.hidden = unavailable;
  if (unavailable || !run) {
    if (!run) {
      els.tokenInput.textContent = '—';
      els.tokenOutput.textContent = '—';
      els.tokenCached.textContent = '—';
      setBar('limit-primary-fill', 'limit-primary-value', 'limit-primary-track', null);
      setBar('limit-secondary-fill', 'limit-secondary-value', 'limit-secondary-track', null);
    }
    return;
  }
  const tokens = run.tokens || {};
  els.tokenInput.textContent = formatCount(tokens.input_tokens);
  els.tokenOutput.textContent = formatCount(tokens.output_tokens);
  els.tokenCached.textContent = formatCount(tokens.cached_input_tokens);
  setBar('limit-primary-fill', 'limit-primary-value', 'limit-primary-track', tokens.rate_limits?.primary?.used_percent);
  setBar('limit-secondary-fill', 'limit-secondary-value', 'limit-secondary-track', tokens.rate_limits?.secondary?.used_percent);
}

function renderAll() {
  renderHeader();
  renderSidebar();
  renderTimeline();
  renderAgent();
  renderOutput();
  renderTokens();
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-start]')) {
    if (!el.dataset.start) continue;
    el.textContent = formatDuration(elapsedMs(el.dataset.start, el.dataset.end, now));
  }
}

function applySnapshot(body) {
  const previous = new Map(runs.map(run => [run.run_id, run]));
  runsRoot = typeof body?.runs_root === 'string' ? body.runs_root : '';
  const next = Array.isArray(body?.runs) ? body.runs : [];
  for (const run of next) {
    if (!Array.isArray(run.output_tail)) run.output_tail = [];
    const old = previous.get(run.run_id);
    if (old?._openPartial && sameTail(old.output_tail, run.output_tail)) run._openPartial = true;
  }
  runs = next;
  if (!runs.some(run => run.run_id === selectedId)) selectedId = runs[0]?.run_id ?? null;
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
  if (typeof line !== 'string' || !line) return false;
  try {
    const event = JSON.parse(line);
    return Boolean(event && event.type === 'assistant' && event.timestamp_ms != null && event.model_call_id == null);
  } catch {
    return false;
  }
}

function applyStdout(run, data) {
  if (!Array.isArray(run.output_tail)) run.output_tail = [];
  if (isPartial(data.line)) {
    const chunk = typeof data.text === 'string' ? data.text : '';
    if (!chunk) return;
    if (!run._openPartial) {
      run.output_tail.push(chunk);
      run._openPartial = true;
    } else {
      run.output_tail[run.output_tail.length - 1] += chunk;
    }
  } else {
    run._openPartial = false;
    if (typeof data.text === 'string' && data.text.length) {
      for (const line of data.text.split('\n')) {
        if (line.length) run.output_tail.push(line);
      }
    }
  }
  if (run.output_tail.length > TAIL_LIMIT) {
    run.output_tail.splice(0, run.output_tail.length - TAIL_LIMIT);
  }
}

function onStdout(data) {
  if (!data || typeof data.run_id !== 'string') {
    requestSnapshot();
    return;
  }
  const run = runs.find(item => item.run_id === data.run_id);
  if (run) {
    applyStdout(run, data);
    if (run.run_id === selectedId) renderOutput();
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
  const runButton = event.target.closest('[data-run-id]');
  if (runButton?.dataset.runId) {
    selectedId = runButton.dataset.runId;
    renderAll();
    return;
  }
  const taskButton = event.target.closest('[data-task-key]');
  if (!taskButton) return;
  const group = groupRuns(runs).find(item => `task:${item.key}` === taskButton.dataset.taskKey);
  if (!group?.runs[0]) return;
  selectedId = group.runs[0].run_id;
  renderAll();
}

function onTimelineClick(event) {
  const button = event.target.closest('#timeline button');
  if (!button || button.disabled || !button.dataset.runId) return;
  selectedId = button.dataset.runId;
  renderAll();
}

async function main() {
  els.taskList.addEventListener('click', onTaskClick);
  document.getElementById('timeline').addEventListener('click', onTimelineClick);
  setConnection('connecting');
  await requestSnapshot();
  connect();
  setInterval(tick, 1000);
}

main();
