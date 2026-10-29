import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  aggregateCursorUsage,
  applyCursorResult,
  applySessionTokenCount,
  applyTurnCompleted,
  createCursorUsageCache,
  createTokenState,
  cursorResultFromLine,
  cursorUsageBounds,
  defaultSessionsRoot,
  findSessionFile,
  projectTokens,
  scanCursorStdout,
  tokenCountFromLine,
} from '../src/usage.mjs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function line(type, payload) {
  return `${JSON.stringify({ timestamp: '2026-10-29T00:00:00.000Z', type, payload })}\n`;
}

function tokenCount(input, primary, secondary) {
  return line('event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 1,
        output_tokens: 2,
        reasoning_output_tokens: 0,
        total_tokens: input + 2,
      },
      last_token_usage: { input_tokens: 99999, output_tokens: 99999, total_tokens: 199998 },
    },
    rate_limits: {
      primary: { used_percent: primary },
      secondary: { used_percent: secondary },
    },
  });
}

async function applyFile(state, file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const snapshot = tokenCountFromLine(raw);
      if (snapshot) applySessionTokenCount(state, snapshot);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

test('cumulative codex snapshots replace and cursor tokens stay unavailable', () => {
  const codex = createTokenState('codex');
  applyTurnCompleted(codex, { input_tokens: 100, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 1 });
  applyTurnCompleted(codex, { input_tokens: 30, output_tokens: 2 });
  let view = projectTokens(codex);
  assert.equal(view.available, true);
  assert.equal(view.source, 'turn.completed');
  assert.equal(view.input_tokens, 30);
  assert.equal(view.cached_input_tokens, null);
  assert.equal(view.output_tokens, 2);
  assert.equal(view.total_tokens, 32);
  assert.equal(view.reasoning_output_tokens, null);

  const first = tokenCountFromLine(tokenCount(10, 2, 0).trim());
  const second = tokenCountFromLine(tokenCount(40, 9, 1).trim());
  assert.equal(tokenCountFromLine(line('token_usage_record', { thread_id: 't', usage: { input_tokens: 777, total_tokens: 777 } }).trim()), null);
  applySessionTokenCount(codex, first);
  applySessionTokenCount(codex, second);
  view = projectTokens(codex);
  assert.equal(view.source, 'session');
  assert.equal(view.input_tokens, 40);
  assert.equal(view.total_tokens, 42);
  assert.equal(view.rate_limits.primary.used_percent, 9);
  assert.equal(view.rate_limits.secondary.used_percent, 1);
  assert.notEqual(view.input_tokens, 70);
  assert.notEqual(view.input_tokens, 99999);

  applyTurnCompleted(codex, { input_tokens: 48, cached_input_tokens: 4, output_tokens: 3 });
  view = projectTokens(codex);
  assert.equal(view.source, 'turn.completed');
  assert.equal(view.input_tokens, 48);
  assert.equal(view.total_tokens, 51);
  assert.equal(view.rate_limits.primary.used_percent, 9);
  assert.equal(view.rate_limits.secondary.used_percent, 1);

  const cursor = createTokenState('cursor');
  applyTurnCompleted(cursor, { input_tokens: 5, output_tokens: 5 });
  applySessionTokenCount(cursor, second);
  const unavailable = projectTokens(cursor);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'unavailable');
  assert.equal(unavailable.input_tokens, null);
  assert.equal(unavailable.total_tokens, null);
  assert.equal(unavailable.rate_limits, null);

  const limitsOnly = tokenCountFromLine(line('event_msg', {
    type: 'token_count',
    rate_limits: { primary: { used_percent: 12 }, secondary: { used_percent: 3 } },
  }).trim());
  assert.equal(limitsOnly.usage, null);
  assert.equal(limitsOnly.rate_limits.primary.used_percent, 12);
  applySessionTokenCount(codex, limitsOnly);
  view = projectTokens(codex);
  assert.equal(view.source, 'turn.completed');
  assert.equal(view.input_tokens, 48);
  assert.equal(view.total_tokens, 51);
  assert.equal(view.rate_limits.primary.used_percent, 12);
  assert.equal(view.rate_limits.secondary.used_percent, 3);

  const primaryOnly = tokenCountFromLine(line('event_msg', {
    type: 'token_count',
    info: { rate_limits: { primary: { used_percent: 15 } } },
  }).trim());
  applySessionTokenCount(codex, primaryOnly);
  view = projectTokens(codex);
  assert.equal(view.input_tokens, 48);
  assert.equal(view.rate_limits.primary.used_percent, 15);
  assert.equal(view.rate_limits.secondary.used_percent, 3);
  assert.equal(tokenCountFromLine(line('event_msg', { type: 'token_count', info: {} }).trim()), null);
});

test('cursor result usage maps into run tokens and stays absent without it', () => {
  const usage = {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 80,
    cacheWriteTokens: 15,
  };
  const line = JSON.stringify({ type: 'result', subtype: 'success', usage });
  const parsed = cursorResultFromLine(line);
  assert.deepEqual(parsed, usage);
  assert.equal(cursorResultFromLine(JSON.stringify({ type: 'result', subtype: 'success' })), null);
  assert.equal(cursorResultFromLine(JSON.stringify({ type: 'result', usage: null })), null);
  assert.equal(cursorResultFromLine(JSON.stringify({ status: 'finished' })), null);

  const cursor = createTokenState('cursor');
  applyCursorResult(cursor, parsed);
  const view = projectTokens(cursor);
  assert.equal(view.available, true);
  assert.equal(view.reason, null);
  assert.equal(view.source, 'cursor_result');
  assert.equal(view.input_tokens, 1200);
  assert.equal(view.output_tokens, 340);
  assert.equal(view.cached_input_tokens, 80);
  assert.equal(view.cache_write_input_tokens, 15);
  assert.equal(view.reasoning_output_tokens, null);
  assert.equal(view.total_tokens, 1540);
  assert.equal(view.rate_limits, null);

  const absent = createTokenState('cursor');
  applyCursorResult(absent, cursorResultFromLine(JSON.stringify({ type: 'result' })));
  applyCursorResult(absent, {});
  const empty = projectTokens(absent);
  assert.equal(empty.available, false);
  assert.equal(empty.reason, 'unavailable');
  assert.equal(empty.source, null);
  assert.equal(empty.input_tokens, null);
  assert.equal(empty.output_tokens, null);
  assert.equal(empty.cached_input_tokens, null);
  assert.equal(empty.cache_write_input_tokens, null);
  assert.equal(empty.total_tokens, null);
  assert.equal(empty.rate_limits, null);

  const codex = createTokenState('codex');
  applyTurnCompleted(codex, { input_tokens: 11, cached_input_tokens: 2, output_tokens: 3, cache_write_input_tokens: 4 });
  applyCursorResult(codex, usage);
  const codexView = projectTokens(codex);
  assert.equal(codexView.available, true);
  assert.equal(codexView.source, 'turn.completed');
  assert.equal(codexView.input_tokens, 11);
  assert.equal(codexView.cached_input_tokens, 2);
  assert.equal(codexView.cache_write_input_tokens, 4);
  assert.equal(codexView.output_tokens, 3);
  assert.equal(codexView.total_tokens, 14);
});

test('session token_count matches thread_id and ignores a newer file', async () => {
  assert.equal(defaultSessionsRoot(), path.join(homedir(), '.codex', 'sessions'));
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-sessions-'));
  try {
    const match = path.join(root, '2026', '10', '28', 'rollout-match.jsonl');
    const olderDecoy = path.join(root, '2026', '10', '01', 'rollout-old.jsonl');
    const newer = path.join(root, '2026', '10', '29', 'rollout-new.jsonl');
    await mkdir(path.dirname(match), { recursive: true });
    await mkdir(path.dirname(olderDecoy), { recursive: true });
    await mkdir(path.dirname(newer), { recursive: true });
    const threadId = 'thread-match';
    await writeFile(olderDecoy, line('session_meta', { id: 'other-old' }) + tokenCount(111, 80, 80));
    await writeFile(match, [
      line('session_meta', { id: threadId, session_id: threadId }),
      tokenCount(10, 2, 0),
      line('token_usage_record', { thread_id: threadId, usage: { input_tokens: 777777, output_tokens: 1, total_tokens: 777778 } }),
      tokenCount(40, 6, 0),
    ].join(''));
    await sleep(20);
    await writeFile(newer, line('session_meta', { id: 'other-new', session_id: 'other-new' }) + tokenCount(999999, 99, 99));
    const future = new Date('2030-01-01T00:00:00Z');
    await utimes(newer, future, future);

    const found = await findSessionFile(root, threadId);
    assert.equal(found, match);
    const state = createTokenState('codex');
    await applyFile(state, found);
    const view = projectTokens(state);
    assert.equal(view.input_tokens, 40);
    assert.equal(view.total_tokens, 42);
    assert.equal(view.rate_limits.primary.used_percent, 6);
    assert.equal(view.rate_limits.secondary.used_percent, 0);
    assert.equal(await findSessionFile(root, 'missing'), null);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function cursorResult(usage, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', ...extra, usage });
}

function contribution(usage, at) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: Object.hasOwn(usage, 'cacheReadTokens') && Number.isInteger(usage.cacheReadTokens) && usage.cacheReadTokens >= 0
      ? usage.cacheReadTokens
      : null,
    total_tokens: usage.inputTokens + usage.outputTokens,
    at,
  };
}

test('cursor usage scans the last valid result and sums overlapping MYT buckets', () => {
  const text = [
    'not json',
    cursorResult({ inputTokens: 1.5, outputTokens: 1 }),
    cursorResult({ inputTokens: -1, outputTokens: 2 }),
    cursorResult({ inputTokens: '4', outputTokens: 2 }),
    cursorResult({ outputTokens: 2 }),
    cursorResult({ inputTokens: 9, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 50 }, { timestamp: 'nope' }),
    cursorResult({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 999 }, { timestamp: '2026-11-01T02:00:00.000Z' }),
    '{"type":"result","usage":{"inputTokens":3,"outputTokens":1}',
    cursorResult({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, { timestamp_ms: Date.parse('2026-11-01T03:00:00.000Z') }),
  ].join('\n');
  const scanned = scanCursorStdout(text);
  assert.equal(scanned.record.usage.input_tokens, 0);
  assert.equal(scanned.record.usage.output_tokens, 0);
  assert.equal(scanned.record.usage.cached_input_tokens, 0);
  assert.equal(scanned.record.usage.total_tokens, 0);
  assert.equal(scanned.record.time, Date.parse('2026-11-01T03:00:00.000Z'));

  const partial = scanCursorStdout(`${cursorResult({ inputTokens: 2, outputTokens: 2, cacheReadTokens: 1 }, { timestamp: '2026-11-01T02:00:00.000Z' })}\n{"type":"result","usage":`);
  assert.equal(partial.record.usage.input_tokens, 2);
  assert.equal(partial.record.usage.total_tokens, 4);

  const noNewline = scanCursorStdout(cursorResult(
    { inputTokens: 5, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 40 },
    { timestamp: '2026-10-31T16:30:00.000Z' },
  ));
  assert.equal(noNewline.record.usage.total_tokens, 6);
  assert.equal(noNewline.record.usage.cached_input_tokens, 2);
  assert.equal(noNewline.record.time, Date.parse('2026-10-31T16:30:00.000Z'));

  const fallback = scanCursorStdout(cursorResult(
    { inputTokens: 2, outputTokens: 2 },
    { timestamp: 'not-iso', timestamp_ms: Date.parse('2026-11-02T00:00:00.000Z') },
  ));
  assert.equal(fallback.record.time, Date.parse('2026-11-02T00:00:00.000Z'));
  assert.equal(fallback.record.usage.cached_input_tokens, null);
  assert.equal(fallback.record.usage.total_tokens, 4);

  const now = Date.parse('2026-11-01T04:00:00.000Z');
  const bounds = cursorUsageBounds(now);
  assert.equal(bounds.today.start, Date.parse('2026-10-31T16:00:00.000Z'));
  assert.equal(bounds.today.end, Date.parse('2026-11-01T16:00:00.000Z'));
  assert.equal(bounds.last_7_days.start, Date.parse('2026-10-25T16:00:00.000Z'));
  assert.equal(bounds.last_7_days.end, bounds.today.end);
  assert.equal(bounds.this_month.start, Date.parse('2026-10-31T16:00:00.000Z'));
  assert.equal(bounds.this_month.end, Date.parse('2026-11-30T16:00:00.000Z'));

  const oldest = bounds.last_7_days.start;
  const items = [
    contribution({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 999 }, Date.parse('2026-11-01T02:00:00.000Z')),
    contribution({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, Date.parse('2026-11-01T03:00:00.000Z')),
    contribution({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 2 }, Date.parse('2026-10-31T16:30:00.000Z')),
    contribution({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 1 }, oldest),
    contribution({ inputTokens: 99, outputTokens: 99, cacheReadTokens: 99 }, oldest - 1),
    { input_tokens: 3, output_tokens: 4, cached_input_tokens: null, total_tokens: 7, at: Date.parse('2026-10-20T00:00:00.000Z') },
  ];
  const totals = aggregateCursorUsage(items, now);
  assert.equal(totals.timezone, 'Asia/Kuala_Lumpur');
  assert.equal(totals.today.run_count, 3);
  assert.equal(totals.today.input_tokens, 15);
  assert.equal(totals.today.output_tokens, 5);
  assert.equal(totals.today.cached_input_tokens, 82);
  assert.equal(totals.today.total_tokens, 20);
  assert.notEqual(totals.today.total_tokens, 20 + 999);
  assert.equal(totals.last_7_days.run_count, 4);
  assert.equal(totals.last_7_days.input_tokens, 22);
  assert.equal(totals.last_7_days.total_tokens, 28);
  assert.equal(totals.this_month.run_count, 3);
  assert.equal(totals.this_month.cached_input_tokens, 82);
  assert.equal(aggregateCursorUsage([], now).today.cached_input_tokens, 0);
  assert.equal(aggregateCursorUsage([], now).today.run_count, 0);

  const withUnknown = aggregateCursorUsage([
    items[0],
    { input_tokens: 1, output_tokens: 1, cached_input_tokens: null, total_tokens: 2, at: Date.parse('2026-11-01T05:00:00.000Z') },
  ], now);
  assert.equal(withUnknown.today.input_tokens, 11);
  assert.equal(withUnknown.today.cached_input_tokens, null);
  assert.equal(withUnknown.today.total_tokens, 16);
});

test('non-ISO result timestamp "1" buckets cursor usage by timestamp_ms', () => {
  const stamp = Date.parse('2026-11-01T03:00:00.000Z');
  const scanned = scanCursorStdout(cursorResult(
    { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2 },
    { timestamp: '1', timestamp_ms: stamp },
  ));
  assert.equal(scanned.record.time, stamp);
  const now = Date.parse('2026-11-01T04:00:00.000Z');
  const totals = aggregateCursorUsage([{
    input_tokens: scanned.record.usage.input_tokens,
    output_tokens: scanned.record.usage.output_tokens,
    cached_input_tokens: scanned.record.usage.cached_input_tokens,
    total_tokens: scanned.record.usage.total_tokens,
    at: scanned.record.time,
  }], now);
  assert.equal(totals.today.run_count, 1);
  assert.equal(totals.today.input_tokens, 4);
  assert.equal(totals.this_month.run_count, 1);
});

test('MYT day, month, and seven-day edges include midnight and drop the previous instant', () => {
  const beforeMidnight = Date.parse('2026-10-31T15:59:59.999Z');
  const midnight = Date.parse('2026-10-31T16:00:00.000Z');
  const lateOctober = { input_tokens: 4, output_tokens: 1, cached_input_tokens: 0, total_tokens: 5, at: beforeMidnight };
  const novemberStart = { input_tokens: 8, output_tokens: 1, cached_input_tokens: 0, total_tokens: 9, at: midnight };
  const octoberNow = aggregateCursorUsage([lateOctober, novemberStart], beforeMidnight);
  assert.equal(octoberNow.today.run_count, 1);
  assert.equal(octoberNow.today.input_tokens, 4);
  assert.equal(octoberNow.this_month.input_tokens, 4);
  assert.equal(octoberNow.last_7_days.run_count, 1);

  const novemberNow = aggregateCursorUsage([lateOctober, novemberStart], midnight);
  assert.equal(novemberNow.today.run_count, 1);
  assert.equal(novemberNow.today.input_tokens, 8);
  assert.equal(novemberNow.this_month.input_tokens, 8);
  assert.equal(novemberNow.last_7_days.run_count, 2);
  assert.equal(novemberNow.last_7_days.input_tokens, 12);

  const idle = aggregateCursorUsage([lateOctober], midnight);
  assert.equal(idle.today.run_count, 0);
  assert.equal(idle.last_7_days.run_count, 1);
  assert.equal(idle.this_month.run_count, 0);

  const yearNow = Date.parse('2026-01-02T04:00:00.000Z');
  const yearBounds = cursorUsageBounds(yearNow);
  assert.equal(yearBounds.last_7_days.start, Date.parse('2025-12-26T16:00:00.000Z'));
  assert.equal(yearBounds.this_month.start, Date.parse('2025-12-31T16:00:00.000Z'));
  const oldest = { input_tokens: 2, output_tokens: 1, cached_input_tokens: 0, total_tokens: 3, at: yearBounds.last_7_days.start };
  const tooOld = { input_tokens: 6, output_tokens: 1, cached_input_tokens: 0, total_tokens: 7, at: yearBounds.last_7_days.start - 1 };
  const newYear = { input_tokens: 3, output_tokens: 1, cached_input_tokens: 0, total_tokens: 4, at: yearBounds.this_month.start };
  const crossed = aggregateCursorUsage([oldest, tooOld, newYear], yearNow);
  assert.equal(crossed.last_7_days.run_count, 2);
  assert.equal(crossed.last_7_days.input_tokens, 5);
  assert.equal(crossed.this_month.run_count, 1);
  assert.equal(crossed.this_month.input_tokens, 3);
  assert.equal(crossed.today.run_count, 0);
});

function memoryStdout(initial) {
  let file = {
    text: initial,
    size: Buffer.byteLength(initial),
    mtimeMs: 10,
  };
  let missing = false;
  let reads = 0;
  let failReads = 0;
  let unstable = false;
  let clock = 10;
  return {
    get reads() { return reads; },
    failReads(count) { failReads = count; },
    setUnstable(value) { unstable = value; },
    setMissing(value) { missing = value; },
    setText(text, { size = Buffer.byteLength(text), mtimeMs = file.mtimeMs + 1 } = {}) {
      missing = false;
      file = { text, size, mtimeMs };
    },
    async stat() {
      if (missing) {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      }
      clock += 1;
      return {
        size: file.size,
        mtimeMs: unstable ? clock : file.mtimeMs,
        isFile: () => true,
      };
    },
    async readFile() {
      reads += 1;
      if (missing) {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      }
      if (failReads > 0) {
        failReads -= 1;
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return file.text;
    },
  };
}

test('cursor usage cache replaces one run, rebuckets from ended_at, and skips unchanged reads', async () => {
  const fs = memoryStdout(`${cursorResult({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 80 }, { timestamp: '2026-09-01T00:00:00.000Z' })}\n`);
  const cache = createCursorUsageCache({ readFile: () => fs.readFile(), stat: () => fs.stat() });
  const run = { dir: 'C:\\runs\\one', stdoutPath: 'C:\\runs\\one\\stdout.jsonl', endedAt: null };
  const now = Date.parse('2026-11-15T04:00:00.000Z');
  await cache.reconcile([run]);
  assert.equal(fs.reads, 1);
  assert.equal(cache.aggregate(now).this_month.run_count, 0);
  assert.equal(cache.aggregate(now).today.run_count, 0);

  await cache.reconcile([run]);
  assert.equal(fs.reads, 1);

  run.endedAt = '2026-11-15T01:00:00.000Z';
  await cache.reconcile([run]);
  assert.equal(fs.reads, 1);
  let totals = cache.aggregate(now);
  assert.equal(totals.today.run_count, 1);
  assert.equal(totals.today.input_tokens, 10);
  assert.equal(totals.today.total_tokens, 11);
  assert.equal(totals.last_7_days.run_count, 1);
  assert.equal(totals.this_month.run_count, 1);

  await cache.reconcile([{ ...run, endedAt: '2026-09-02T00:00:00.000Z' }]);
  assert.equal(fs.reads, 1);
  assert.equal(cache.aggregate(now).today.run_count, 0);
  assert.equal(cache.aggregate(now).this_month.run_count, 0);

  const appended = `${cursorResult({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 4 }, { timestamp: '2026-09-01T00:00:00.000Z' })}\n${cursorResult({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 50 }, { timestamp: '2026-09-01T01:00:00.000Z' })}\n`;
  fs.setText(appended);
  await cache.reconcile([{ ...run, endedAt: '2026-11-15T02:00:00.000Z' }]);
  assert.equal(fs.reads, 2);
  totals = cache.aggregate(now);
  assert.equal(totals.today.run_count, 1);
  assert.equal(totals.today.input_tokens, 3);
  assert.equal(totals.today.output_tokens, 2);
  assert.equal(totals.today.total_tokens, 5);
  assert.equal(totals.today.cached_input_tokens, 1);

  const sameSize = cursorResult({ inputTokens: 6, outputTokens: 1, cacheReadTokens: 0 }, { timestamp: '2026-11-15T02:00:00.000Z' });
  fs.setText(sameSize, { size: Buffer.byteLength(appended), mtimeMs: 40 });
  await cache.reconcile([run]);
  assert.equal(fs.reads, 3);
  assert.equal(cache.aggregate(now).today.input_tokens, 6);
  assert.equal(cache.aggregate(now).today.total_tokens, 7);

  fs.setText(cursorResult({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 }, { timestamp: '2026-11-15T02:00:00.000Z' }), { mtimeMs: 41 });
  await cache.reconcile([run]);
  assert.equal(cache.aggregate(now).today.input_tokens, 1);

  fs.setMissing(true);
  await cache.reconcile([run]);
  assert.equal(cache.aggregate(now).today.run_count, 0);

  fs.setMissing(false);
  fs.setText(cursorResult({ inputTokens: 4, outputTokens: 1, cacheReadTokens: 0 }, { timestamp: '2026-11-15T02:00:00.000Z' }), { mtimeMs: 42 });
  await cache.reconcile([run]);
  assert.equal(cache.aggregate(now).today.input_tokens, 4);
  const readsAfterRestore = fs.reads;
  fs.failReads(1);
  fs.setText(cursorResult({ inputTokens: 4, outputTokens: 1, cacheReadTokens: 0 }, { timestamp: '2026-11-15T02:00:00.000Z' }), { mtimeMs: 43 });
  await cache.reconcile([run]);
  assert.ok(fs.reads > readsAfterRestore);
  assert.equal(cache.aggregate(now).today.input_tokens, 4);

  const kept = fs.reads;
  fs.failReads(20);
  fs.setText('nope', { mtimeMs: 44 });
  await cache.reconcile([run]);
  assert.ok(fs.reads > kept);
  assert.equal(cache.aggregate(now).today.input_tokens, 4);
  assert.equal(cache.aggregate(now).today.run_count, 1);

  fs.setUnstable(true);
  fs.failReads(0);
  const beforeUnstable = cache.aggregate(now).today.input_tokens;
  await cache.reconcile([run]);
  assert.equal(cache.aggregate(now).today.input_tokens, beforeUnstable);

  await cache.reconcile([]);
  assert.equal(cache.aggregate(now).today.run_count, 0);
});

test('parallel cursor usage reconcile reads an unchanged file once', async () => {
  let reads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const body = `${cursorResult({ inputTokens: 2, outputTokens: 2, cacheReadTokens: 0 }, { timestamp: '2026-11-15T01:00:00.000Z' })}\n`;
  const cache = createCursorUsageCache({
    async stat() {
      return { size: Buffer.byteLength(body), mtimeMs: 7, isFile: () => true };
    },
    async readFile() {
      reads += 1;
      if (reads === 1) await gate;
      return body;
    },
  });
  const run = { dir: 'C:\\runs\\two', stdoutPath: 'C:\\runs\\two\\stdout.jsonl', endedAt: '2026-11-15T01:00:00.000Z' };
  const first = cache.reconcile([run]);
  const second = cache.reconcile([run]);
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  const now = Date.parse('2026-11-15T04:00:00.000Z');
  assert.equal(cache.aggregate(now).today.run_count, 1);
  assert.equal(cache.aggregate(now).today.total_tokens, 4);
  await cache.reconcile([run]);
  assert.equal(reads, 1);
});
