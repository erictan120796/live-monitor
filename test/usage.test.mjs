import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  applySessionTokenCount,
  applyTurnCompleted,
  createTokenState,
  defaultSessionsRoot,
  findSessionFile,
  projectTokens,
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
  assert.equal(unavailable.rate_limits.primary.used_percent, null);

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
