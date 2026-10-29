import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
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
