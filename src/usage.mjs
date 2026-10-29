import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { homedir } from 'node:os';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function defaultSessionsRoot() {
  return path.join(homedir(), '.codex', 'sessions');
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function emptyRateLimits() {
  return {
    primary: { used_percent: null },
    secondary: { used_percent: null },
  };
}

export function createTokenState(agent) {
  return {
    agent: agent === 'codex' ? 'codex' : 'cursor',
    counts: null,
    source: null,
    rate_limits: emptyRateLimits(),
  };
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input_tokens = num(usage.input_tokens);
  const cached_input_tokens = num(usage.cached_input_tokens);
  const cache_write_input_tokens = num(usage.cache_write_input_tokens);
  const output_tokens = num(usage.output_tokens);
  const reasoning_output_tokens = num(usage.reasoning_output_tokens);
  let total_tokens = num(usage.total_tokens);
  if (
    input_tokens == null && cached_input_tokens == null && cache_write_input_tokens == null
    && output_tokens == null && reasoning_output_tokens == null && total_tokens == null
  ) return null;
  if (total_tokens == null && (input_tokens != null || output_tokens != null)) {
    total_tokens = (input_tokens ?? 0) + (output_tokens ?? 0);
  }
  return {
    input_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    output_tokens,
    reasoning_output_tokens,
    total_tokens,
  };
}

function writeCounts(state, usage, source) {
  const counts = normalizeUsage(usage);
  if (!counts) return;
  state.counts = counts;
  state.source = source;
}

export function applyTurnCompleted(state, usage) {
  if (state.agent !== 'codex') return state;
  writeCounts(state, usage, 'turn.completed');
  return state;
}

export function cursorResultFromLine(line) {
  let event;
  try {
    event = JSON.parse(String(line).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || event.type !== 'result') return null;
  const usage = event.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return usage;
}

export function applyCursorResult(state, usage) {
  if (state.agent !== 'cursor' || !usage || typeof usage !== 'object') return state;
  writeCounts(state, {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: usage.cacheReadTokens,
    cache_write_input_tokens: usage.cacheWriteTokens,
  }, 'cursor_result');
  return state;
}

export function applySessionTokenCount(state, snapshot) {
  if (state.agent !== 'codex' || !snapshot) return state;
  writeCounts(state, snapshot.usage, 'session');
  const limits = snapshot.rate_limits;
  if (limits && typeof limits === 'object') {
    const primary = num(limits.primary?.used_percent);
    const secondary = num(limits.secondary?.used_percent);
    if (primary != null) state.rate_limits.primary.used_percent = primary;
    if (secondary != null) state.rate_limits.secondary.used_percent = secondary;
  }
  return state;
}

export function projectTokens(state) {
  const blank = {
    available: false,
    reason: 'unavailable',
    source: null,
    input_tokens: null,
    cached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null,
    rate_limits: state.agent === 'cursor' ? null : emptyRateLimits(),
  };
  if (state.agent === 'cursor') {
    if (!state.counts) return blank;
  } else if (state.agent !== 'codex') {
    return blank;
  }
  const counts = state.counts;
  return {
    available: true,
    reason: null,
    source: state.source,
    input_tokens: counts?.input_tokens ?? null,
    cached_input_tokens: counts?.cached_input_tokens ?? null,
    cache_write_input_tokens: counts?.cache_write_input_tokens ?? null,
    output_tokens: counts?.output_tokens ?? null,
    reasoning_output_tokens: counts?.reasoning_output_tokens ?? null,
    total_tokens: counts?.total_tokens ?? null,
    rate_limits: state.agent === 'cursor' ? null : {
      primary: { used_percent: state.rate_limits.primary.used_percent },
      secondary: { used_percent: state.rate_limits.secondary.used_percent },
    },
  };
}

export function tokenCountFromLine(line) {
  let event;
  try {
    event = JSON.parse(String(line).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  let payload = null;
  if (event.type === 'token_count') payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  else if (event.type === 'event_msg' && event.payload?.type === 'token_count') payload = event.payload;
  if (!payload) return null;
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const rawUsage = info.total_token_usage ?? payload.total_token_usage ?? null;
  const rawLimits = payload.rate_limits ?? info.rate_limits ?? null;
  const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : null;
  const rate_limits = rawLimits && typeof rawLimits === 'object' ? rawLimits : null;
  if (!usage && !rate_limits) return null;
  return { usage, rate_limits };
}

async function collectJsonl(root, out) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await collectJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

export async function readSessionIdentity(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const line = raw.replace(/^\uFEFF/, '').trim();
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (event?.type !== 'session_meta') return null;
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      return payload.id ?? payload.thread_id ?? payload.session_id ?? null;
    }
    return undefined;
  } catch (err) {
    if (RETRYABLE.has(err?.code)) return undefined;
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const USAGE_READ_ATTEMPTS = 6;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nonnegInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

export function parseUsageStamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function resultEventTime(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.timestamp === 'string') {
    const ms = Date.parse(event.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof event.timestamp_ms === 'number' && Number.isFinite(event.timestamp_ms)) return event.timestamp_ms;
  return null;
}

export function normalizeCursorResultUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const input_tokens = nonnegInt(usage.inputTokens);
  const output_tokens = nonnegInt(usage.outputTokens);
  if (input_tokens == null || output_tokens == null) return null;
  return {
    input_tokens,
    output_tokens,
    cached_input_tokens: nonnegInt(usage.cacheReadTokens),
    total_tokens: input_tokens + output_tokens,
  };
}

export function scanCursorStdout(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const complete = raw.endsWith('\n') || raw.endsWith('\r');
  const lines = raw.split(/\r?\n/);
  if (complete && lines.length && lines[lines.length - 1] === '') lines.pop();
  let record = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^\uFEFF/, '');
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'result') continue;
    const usage = normalizeCursorResultUsage(event.usage);
    if (!usage) continue;
    record = { usage, time: resultEventTime(event) };
  }
  return { record };
}

function emptyBucket() {
  return {
    run_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    total_tokens: 0,
  };
}

function mytMidnight(year, month, day) {
  return Date.UTC(year, month, day) - MYT_OFFSET_MS;
}

export function cursorUsageBounds(now) {
  const nowMs = resolveNow(now);
  const shifted = new Date(nowMs + MYT_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const todayStart = mytMidnight(year, month, day);
  const tomorrow = mytMidnight(year, month, day + 1);
  return {
    today: { start: todayStart, end: tomorrow },
    last_7_days: { start: mytMidnight(year, month, day - 6), end: tomorrow },
    this_month: { start: mytMidnight(year, month, 1), end: mytMidnight(year, month + 1, 1) },
  };
}

function addContribution(bucket, item) {
  bucket.run_count += 1;
  bucket.input_tokens += item.input_tokens;
  bucket.output_tokens += item.output_tokens;
  bucket.total_tokens += item.total_tokens;
  if (bucket.cached_input_tokens == null || item.cached_input_tokens == null) bucket.cached_input_tokens = null;
  else bucket.cached_input_tokens += item.cached_input_tokens;
}

export function aggregateCursorUsage(items, now) {
  const bounds = cursorUsageBounds(now);
  const buckets = {
    today: emptyBucket(),
    last_7_days: emptyBucket(),
    this_month: emptyBucket(),
  };
  for (const item of items || []) {
    if (!item || typeof item.at !== 'number' || !Number.isFinite(item.at)) continue;
    for (const name of Object.keys(buckets)) {
      const range = bounds[name];
      if (item.at >= range.start && item.at < range.end) addContribution(buckets[name], item);
    }
  }
  return { timezone: 'Asia/Kuala_Lumpur', ...buckets };
}

function fingerprintOf(info) {
  if (!info || typeof info.size !== 'number' || typeof info.mtimeMs !== 'number') return null;
  if (typeof info.isFile === 'function' && !info.isFile()) return null;
  return { size: info.size, mtimeMs: info.mtimeMs };
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs);
}

export function createCursorUsageCache({
  readFile: readFileImpl = readFile,
  stat: statImpl = stat,
} = {}) {
  const entries = new Map();
  let published = [];
  let chain = Promise.resolve();

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function refreshEntry(entry, file) {
    for (let attempt = 0; attempt < USAGE_READ_ATTEMPTS; attempt += 1) {
      let beforeInfo;
      try {
        beforeInfo = await statImpl(file);
      } catch (err) {
        if (err?.code === 'ENOENT') return 'missing';
        if (RETRYABLE.has(err?.code) && attempt < USAGE_READ_ATTEMPTS - 1) {
          await delay(5);
          continue;
        }
        if (RETRYABLE.has(err?.code)) return 'failed';
        throw err;
      }
      const before = fingerprintOf(beforeInfo);
      if (!before) return 'missing';
      if (sameFingerprint(entry.fingerprint, before)) return 'unchanged';
      let text;
      try {
        text = await readFileImpl(file, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return 'missing';
        if (RETRYABLE.has(err?.code) && attempt < USAGE_READ_ATTEMPTS - 1) {
          await delay(5);
          continue;
        }
        if (RETRYABLE.has(err?.code)) return 'failed';
        throw err;
      }
      let afterInfo;
      try {
        afterInfo = await statImpl(file);
      } catch (err) {
        if (err?.code === 'ENOENT') return 'missing';
        if (RETRYABLE.has(err?.code) && attempt < USAGE_READ_ATTEMPTS - 1) {
          await delay(5);
          continue;
        }
        if (RETRYABLE.has(err?.code)) return 'failed';
        throw err;
      }
      const after = fingerprintOf(afterInfo);
      if (!after) return 'missing';
      if (!sameFingerprint(before, after)) {
        if (attempt < USAGE_READ_ATTEMPTS - 1) {
          await delay(5);
          continue;
        }
        return 'failed';
      }
      const body = typeof text === 'string' ? text : Buffer.from(text).toString('utf8');
      entry.fingerprint = after;
      entry.record = scanCursorStdout(body).record;
      return 'updated';
    }
    return 'failed';
  }

  function publish() {
    const next = [];
    for (const entry of entries.values()) {
      if (!entry.record?.usage) continue;
      const at = entry.endedAt ?? entry.record.time;
      if (at == null) continue;
      next.push({
        input_tokens: entry.record.usage.input_tokens,
        output_tokens: entry.record.usage.output_tokens,
        cached_input_tokens: entry.record.usage.cached_input_tokens,
        total_tokens: entry.record.usage.total_tokens,
        at,
      });
    }
    published = next;
  }

  async function reconcileBody(runs) {
    const live = new Set();
    for (const run of runs || []) {
      if (!run?.dir || !run?.stdoutPath) continue;
      const dir = path.resolve(run.dir);
      const stdoutPath = path.resolve(run.stdoutPath);
      const key = `${dir}\0${stdoutPath}`;
      live.add(key);
      let entry = entries.get(key);
      if (!entry) {
        entry = { fingerprint: null, record: null, endedAt: null };
        entries.set(key, entry);
      }
      entry.endedAt = parseUsageStamp(run.endedAt);
      const outcome = await refreshEntry(entry, stdoutPath);
      if (outcome === 'missing') entries.delete(key);
    }
    for (const key of [...entries.keys()]) {
      if (!live.has(key)) entries.delete(key);
    }
    publish();
  }

  return {
    reconcile(runs) {
      return enqueue(() => reconcileBody(runs));
    },
    aggregate(now) {
      return aggregateCursorUsage(published, now);
    },
  };
}

export async function findSessionFile(sessionsRoot, threadId, cache = new Map()) {
  if (!sessionsRoot || !threadId) return null;
  const files = await collectJsonl(sessionsRoot, []);
  files.sort();
  for (const file of files) {
    if (!cache.has(file)) {
      const id = await readSessionIdentity(file);
      if (id === undefined) continue;
      cache.set(file, id);
    }
    if (cache.get(file) === threadId) return file;
  }
  return null;
}
