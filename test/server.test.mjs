import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { discoverRuns, defaultRunsRoot } from '../src/discovery.mjs';
import { resolvePort, startMonitor } from '../src/server.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, ms = 1500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await predicate();
    if (last) return last;
    await sleep(20);
  }
  return last;
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function withServer(options, fn) {
  const monitor = await startMonitor({ port: 0, pollMs: 40, heartbeatMs: 1000, ...options });
  try {
    await fn(monitor);
  } finally {
    await monitor.close();
  }
}

async function snapshot(monitor) {
  const response = await fetch(`${monitor.url}/api/snapshot`);
  assert.equal(response.status, 200);
  return response.json();
}

function openEvents(monitor) {
  const events = [];
  const ac = new AbortController();
  const done = (async () => {
    const response = await fetch(`${monitor.url}/api/events`, {
      signal: ac.signal,
      headers: { accept: 'text/event-stream', 'last-event-id': '999' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = 'message';
          const data = [];
          for (const raw of block.split('\n')) {
            const line = raw.replace(/\r$/, '');
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
          split = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
    }
  })();
  return {
    events,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

test('port defaults to 5180 and runs root honors LIVE_MONITOR_RUNS', () => {
  const port = process.env.PORT;
  const runs = process.env.LIVE_MONITOR_RUNS;
  try {
    delete process.env.PORT;
    delete process.env.LIVE_MONITOR_RUNS;
    assert.equal(resolvePort(undefined), 5180);
    assert.equal(defaultRunsRoot(), path.join(homedir(), '.orchestrator', 'runs'));
    process.env.PORT = '5199';
    process.env.LIVE_MONITOR_RUNS = path.join(tmpdir(), 'live-monitor-env-runs');
    assert.equal(resolvePort(undefined), 5199);
    assert.equal(defaultRunsRoot(), process.env.LIVE_MONITOR_RUNS);
    assert.equal(resolvePort(0), 0);
  } finally {
    restoreEnv('PORT', port);
    restoreEnv('LIVE_MONITOR_RUNS', runs);
  }
});

test('discovery reads direct child manifests only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-discover-'));
  try {
    assert.deepEqual(await discoverRuns(path.join(root, 'missing')), []);
    const runDir = path.join(root, 'run-1');
    await mkdir(path.join(root, 'nested', 'hidden'), { recursive: true });
    await mkdir(runDir);
    await writeFile(path.join(root, 'notes.txt'), 'ignore');
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 1, run_id: 'run-1', agent: 'codex', phase: 'design',
    }));
    await writeFile(path.join(root, 'nested', 'hidden', 'manifest.json'), JSON.stringify({
      run_id: 'hidden', agent: 'cursor',
    }));
    await writeFile(path.join(root, 'broken'), 'nope');
    await mkdir(path.join(root, 'broken-run'));
    await writeFile(path.join(root, 'broken-run', 'manifest.json'), '{');
    const found = await discoverRuns(root);
    assert.deepEqual(found.map(entry => entry.manifest.run_id), ['run-1']);
    assert.equal(found[0].dir, runDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server binds 127.0.0.1, serves static files, and sees a new run within 1s', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-http-'));
  const runs = path.join(root, 'runs');
  const publicDir = path.join(root, 'public');
  await mkdir(runs);
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'ok.txt'), 'hello static');
  try {
    await withServer({ runsRoot: runs, sessionsRoot: path.join(root, 'sessions'), publicDir }, async monitor => {
      assert.equal(monitor.address.address, '127.0.0.1');
      assert.equal(monitor.host, '127.0.0.1');
      const file = await fetch(`${monitor.url}/ok.txt`);
      assert.equal(file.status, 200);
      assert.equal(await file.text(), 'hello static');
      const escaped = await fetch(`${monitor.url}/%2e%2e/%2e%2e/package.json`);
      const escapedBody = await escaped.text();
      assert.notEqual(escaped.status, 200);
      assert.equal(escapedBody.includes('"name": "live-monitor"'), false);
      const denied = await fetch(`${monitor.url}/api/snapshot`, { method: 'POST' });
      assert.equal(denied.status, 405);

      const started = Date.now();
      const runDir = path.join(runs, 'run-new');
      await mkdir(runDir);
      const stdout = path.join(root, 'legacy-out.txt');
      await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
        schema_version: 1,
        run_id: 'run-new',
        agent: 'codex',
        phase: 'code',
        requested_model: 'gpt-5',
        effort: 'high',
        task_id: 'feature-123',
        attempt: 1,
        started_at: '2026-10-29T00:00:00.000Z',
        thread_id: null,
        files: {
          stdout,
          stderr: `${stdout}.err`,
          status: path.join(runDir, 'status.jsonl'),
        },
      }));
      await writeFile(path.join(runDir, 'status.jsonl'), `${JSON.stringify({
        v: 1, seq: 1, ts: '2026-10-29T00:00:00.000Z', run_id: 'run-new', phase: 'code', status: 'started',
      })}\n`);
      await writeFile(stdout, '');
      const body = await waitFor(async () => {
        const current = await snapshot(monitor);
        return current.runs.some(run => run.run_id === 'run-new') ? current : null;
      }, 1000);
      assert.ok(body, 'new run missing from snapshot');
      assert.ok(Date.now() - started < 1000);
      const run = body.runs.find(item => item.run_id === 'run-new');
      assert.equal(run.agent, 'codex');
      assert.equal(run.model, 'gpt-5');
      assert.equal(run.effort, 'high');
      assert.equal(run.phase, 'code');
      assert.equal(run.status, 'started');
      assert.equal(run.task_id, 'feature-123');
      assert.equal(run.timings.started_at, '2026-10-29T00:00:00.000Z');
      assert.equal(run.timings.ended_at, null);
      assert.equal(typeof run.timings.duration_ms, 'number');
      assert.equal(run.tokens.available, true);
      assert.equal(run.tokens.input_tokens, null);
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('appended stdout lines stream as SSE events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-sse-'));
  const runs = path.join(root, 'runs');
  await mkdir(runs);
  try {
    await withServer({ runsRoot: runs, sessionsRoot: path.join(root, 'sessions'), publicDir: path.join(root, 'missing-public') }, async monitor => {
      const missing = await fetch(`${monitor.url}/missing.txt`);
      assert.equal(missing.status, 404);
      const events = openEvents(monitor);
      try {
        const heartbeat = await waitFor(() => events.events.find(item => item.event === 'heartbeat'));
        assert.ok(heartbeat?.data?.ts);
        const runDir = path.join(runs, 'run-sse');
        const stdout = path.join(root, 'legacy-out.txt');
        await mkdir(runDir);
        await writeFile(stdout, '');
        await writeFile(path.join(runDir, 'status.jsonl'), '');
        await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
          schema_version: 1,
          run_id: 'run-sse',
          agent: 'codex',
          phase: 'review',
          requested_model: 'gpt-5',
          effort: 'low',
          started_at: '2026-10-29T00:00:01.000Z',
          files: { stdout, stderr: `${stdout}.err`, status: path.join(runDir, 'status.jsonl') },
        }));
        await waitFor(async () => (await snapshot(monitor)).runs.some(run => run.run_id === 'run-sse'), 1000);
        await appendFile(stdout, 'partial');
        const mid = await snapshot(monitor);
        assert.deepEqual(mid.runs.find(run => run.run_id === 'run-sse').output_tail, []);
        assert.equal(events.events.some(item => item.event === 'stdout'), false);
        await appendFile(stdout, ` line\n${JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_1', type: 'agent_message', text: 'hello line' },
        })}\n`);
        const streamed = await waitFor(() => {
          const found = events.events.filter(item => item.event === 'stdout' && item.data.run_id === 'run-sse');
          return found.length >= 2 ? found : null;
        });
        assert.ok(streamed);
        assert.equal(streamed[0].data.line, 'partial line');
        assert.equal(streamed[1].data.text, 'hello line');
        const after = await snapshot(monitor);
        assert.deepEqual(after.runs.find(run => run.run_id === 'run-sse').output_tail, ['partial line', 'hello line']);
      } finally {
        await events.stop();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('codex tokens come from snapshots and cursor tokens are unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-tokens-'));
  const runs = path.join(root, 'runs');
  const sessions = path.join(root, 'sessions');
  await mkdir(runs);
  try {
    await withServer({ runsRoot: runs, sessionsRoot: sessions }, async monitor => {
      const threadId = 'thread-live';
      const runDir = path.join(runs, 'run-codex');
      const stdout = path.join(runDir, 'stdout.jsonl');
      await mkdir(runDir);
      await writeFile(stdout, `${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n${JSON.stringify({
        type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 },
      })}\n`);
      await writeFile(path.join(runDir, 'status.jsonl'), `${JSON.stringify({
        v: 1, seq: 1, ts: '2026-10-29T00:00:02.000Z', run_id: 'run-codex', phase: 'fix', status: 'started',
      })}\n`);
      await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
        schema_version: 1,
        run_id: 'run-codex',
        agent: 'codex',
        phase: 'fix',
        requested_model: 'gpt-5',
        reported_model: null,
        effort: 'medium',
        task_id: 'feature-123',
        attempt: 2,
        started_at: '2026-10-29T00:00:02.000Z',
        thread_id: threadId,
        files: { stdout, stderr: path.join(runDir, 'stderr.log'), status: path.join(runDir, 'status.jsonl') },
      }));
      const first = await waitFor(async () => {
        const body = await snapshot(monitor);
        const run = body.runs.find(item => item.run_id === 'run-codex');
        return run?.tokens?.input_tokens === 10 ? run : null;
      }, 1000);
      assert.ok(first);
      assert.equal(first.tokens.source, 'turn.completed');
      assert.equal(first.tokens.total_tokens, 14);
      assert.equal(first.tokens.rate_limits.primary.used_percent, null);
      assert.equal(first.output_tail.includes('thread.started'), false);

      const matchDir = path.join(sessions, '2026', '10', '28');
      const decoyDir = path.join(sessions, '2026', '10', '29');
      await mkdir(matchDir, { recursive: true });
      await mkdir(decoyDir, { recursive: true });
      const count = (input, primary, secondary) => JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: input, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: input + 2 },
            last_token_usage: { input_tokens: 99999, output_tokens: 1, total_tokens: 100000 },
          },
          rate_limits: { primary: { used_percent: primary }, secondary: { used_percent: secondary } },
        },
      });
      await writeFile(path.join(matchDir, 'rollout-match.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: threadId, session_id: threadId } }),
        count(12, 3, 0),
        JSON.stringify({ type: 'token_usage_record', payload: { thread_id: threadId, usage: { input_tokens: 777777, total_tokens: 777778 } } }),
        count(40, 6, 0),
      ].join('\n') + '\n');
      await writeFile(path.join(decoyDir, 'rollout-new.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: 'someone-else' } }),
        count(999999, 99, 99),
      ].join('\n') + '\n');

      const matched = await waitFor(async () => {
        const body = await snapshot(monitor);
        const run = body.runs.find(item => item.run_id === 'run-codex');
        return run?.tokens?.input_tokens === 40 ? run : null;
      }, 1000);
      assert.ok(matched);
      assert.equal(matched.tokens.source, 'session');
      assert.equal(matched.tokens.total_tokens, 42);
      assert.equal(matched.tokens.cached_input_tokens, 1);
      assert.equal(matched.tokens.rate_limits.primary.used_percent, 6);
      assert.equal(matched.tokens.rate_limits.secondary.used_percent, 0);
      assert.notEqual(matched.tokens.input_tokens, 50);
      assert.notEqual(matched.tokens.input_tokens, 99999);
      assert.notEqual(matched.tokens.input_tokens, 777777);

      await appendFile(stdout, `${JSON.stringify({
        type: 'turn.completed', usage: { input_tokens: 48, cached_input_tokens: 5, output_tokens: 6 },
      })}\n`);
      const replaced = await waitFor(async () => {
        const body = await snapshot(monitor);
        const run = body.runs.find(item => item.run_id === 'run-codex');
        return run?.tokens?.input_tokens === 48 ? run : null;
      }, 1000);
      assert.ok(replaced);
      assert.equal(replaced.tokens.total_tokens, 54);
      assert.equal(replaced.tokens.rate_limits.primary.used_percent, 6);
      assert.notEqual(replaced.tokens.input_tokens, 88);

      const cursorDir = path.join(runs, 'run-cursor');
      const cursorOut = path.join(cursorDir, 'stdout.jsonl');
      await mkdir(cursorDir);
      await writeFile(cursorOut, [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'grok-4.7-medium' }),
        JSON.stringify({ type: 'assistant', timestamp_ms: 10, message: { content: [{ type: 'text', text: 'Hel' }] } }),
        JSON.stringify({ type: 'assistant', timestamp_ms: 11, message: { content: [{ type: 'text', text: 'lo' }] } }),
        JSON.stringify({ type: 'assistant', timestamp_ms: 12, model_call_id: 'call-1', message: { content: [{ type: 'text', text: 'Hello' }] } }),
        JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'toolu_1', tool_call: { readToolCall: { args: { path: 'a.js' } } } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello', session_id: 'sess-9' }),
      ].join('\n') + '\n');
      await writeFile(path.join(cursorDir, 'status.jsonl'), `${JSON.stringify({
        v: 1, seq: 1, ts: '2026-10-29T00:00:03.000Z', run_id: 'run-cursor', phase: 'code', status: 'started',
      })}\n`);
      await writeFile(path.join(cursorDir, 'manifest.json'), JSON.stringify({
        schema_version: 1,
        run_id: 'run-cursor',
        agent: 'cursor',
        phase: 'code',
        requested_model: 'grok-4.7-medium',
        effort: null,
        task_id: 'feature-123',
        attempt: 1,
        started_at: '2026-10-29T00:00:03.000Z',
        files: {
          stdout: cursorOut,
          stderr: path.join(cursorDir, 'stderr.log'),
          status: path.join(cursorDir, 'status.jsonl'),
        },
      }));
      const cursor = await waitFor(async () => {
        const body = await snapshot(monitor);
        return body.runs.find(item => item.run_id === 'run-cursor' && item.output_tail.includes('Hello'));
      }, 1000);
      assert.ok(cursor);
      assert.equal(cursor.agent, 'cursor');
      assert.equal(cursor.model, 'grok-4.7-medium');
      assert.equal(cursor.reported_model, 'grok-4.7-medium');
      assert.equal(cursor.effort, null);
      assert.equal(cursor.session_id, 'sess-9');
      assert.equal(cursor.tokens.available, false);
      assert.equal(cursor.tokens.reason, 'unavailable');
      assert.equal(cursor.tokens.input_tokens, null);
      assert.equal(cursor.tokens.total_tokens, null);
      assert.deepEqual(cursor.output_tail, ['Hello', 'tool read']);
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('output chunks keep monotonic seq numbers across snapshots, SSE, and tail trim', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-seq-'));
  const runs = path.join(root, 'runs');
  await mkdir(runs);
  try {
    await withServer({ runsRoot: runs, sessionsRoot: path.join(root, 'sessions'), publicDir: path.join(root, 'missing-public') }, async monitor => {
      const events = openEvents(monitor);
      try {
        const runDir = path.join(runs, 'run-seq');
        const stdout = path.join(root, 'seq-out.txt');
        await mkdir(runDir);
        await writeFile(stdout, '');
        await writeFile(path.join(runDir, 'status.jsonl'), '');
        await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
          schema_version: 1,
          run_id: 'run-seq',
          agent: 'codex',
          phase: 'review',
          requested_model: 'gpt-5',
          effort: 'low',
          started_at: '2026-10-29T00:00:04.000Z',
          files: { stdout, stderr: `${stdout}.err`, status: path.join(runDir, 'status.jsonl') },
        }));
        await waitFor(async () => (await snapshot(monitor)).runs.some(run => run.run_id === 'run-seq'), 1000);
        await appendFile(stdout, 'alpha\nbeta\n');
        const streamed = await waitFor(() => {
          const found = events.events.filter(item => item.event === 'stdout' && item.data.run_id === 'run-seq');
          return found.length >= 2 ? found : null;
        });
        assert.ok(streamed);
        assert.equal(streamed[0].data.seq, 1);
        assert.equal(streamed[1].data.seq, 2);
        assert.ok(streamed[1].data.seq > streamed[0].data.seq);

        const first = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-seq');
          return run?.output_seq?.length === 2 ? run : null;
        });
        assert.deepEqual(first.output_tail, ['alpha', 'beta']);
        assert.deepEqual(first.output_seq, [1, 2]);
        const again = await snapshot(monitor);
        assert.deepEqual(again.runs.find(item => item.run_id === 'run-seq').output_seq, [1, 2]);

        await appendFile(stdout, 'alpha\n');
        await appendFile(stdout, `${JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_blank', type: 'agent_message', text: '\nbeta' },
        })}\n`);
        const grown = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-seq');
          return run?.output_seq?.length === 5 ? run : null;
        });
        assert.deepEqual(grown.output_tail, ['alpha', 'beta', 'alpha', '', 'beta']);
        assert.deepEqual(grown.output_seq, [1, 2, 3, 4, 5]);
        const blankEvent = events.events.find(item => item.event === 'stdout' && item.data.run_id === 'run-seq' && item.data.seq === 4);
        assert.equal(blankEvent?.data?.seq, 4);

        const pads = Array.from({ length: 196 }, (_, index) => `pad ${index}`).join('\n');
        await appendFile(stdout, `${pads}\n`);
        const trimmed = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-seq');
          return run?.output_tail?.length === 200 ? run : null;
        }, 2000);
        assert.equal(trimmed.output_seq.length, 200);
        assert.equal(trimmed.output_seq[0], 2);
        assert.equal(trimmed.output_seq[199], 201);
        for (let i = 1; i < trimmed.output_seq.length; i += 1) {
          assert.equal(trimmed.output_seq[i], trimmed.output_seq[i - 1] + 1);
        }
        assert.equal(trimmed.output_tail[0], 'beta');
        const held = await snapshot(monitor);
        assert.deepEqual(held.runs.find(item => item.run_id === 'run-seq').output_seq, trimmed.output_seq);

        await appendFile(stdout, 'after\n');
        const after = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-seq');
          return run?.output_seq?.[199] === 202 ? run : null;
        });
        assert.equal(after.output_seq[0], 3);
        assert.equal(after.output_seq[199], 202);
        assert.equal(after.output_tail[199], 'after');
      } finally {
        await events.stop();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('partial chunks get increasing seqs and the snapshot line seq advances', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-partial-seq-'));
  const runs = path.join(root, 'runs');
  await mkdir(runs);
  try {
    await withServer({ runsRoot: runs, sessionsRoot: path.join(root, 'sessions'), publicDir: path.join(root, 'missing-public') }, async monitor => {
      const events = openEvents(monitor);
      try {
        const runDir = path.join(runs, 'run-partial');
        const stdout = path.join(runDir, 'stdout.jsonl');
        await mkdir(runDir);
        await writeFile(stdout, '');
        await writeFile(path.join(runDir, 'status.jsonl'), '');
        await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
          schema_version: 1,
          run_id: 'run-partial',
          agent: 'cursor',
          phase: 'code',
          requested_model: 'grok-4.7-medium',
          started_at: '2026-10-29T00:00:05.000Z',
          files: { stdout, stderr: path.join(runDir, 'stderr.log'), status: path.join(runDir, 'status.jsonl') },
        }));
        await waitFor(async () => (await snapshot(monitor)).runs.some(run => run.run_id === 'run-partial'), 1000);
        const partial = (text, ts) => `${JSON.stringify({
          type: 'assistant',
          timestamp_ms: ts,
          message: { content: [{ type: 'text', text }] },
        })}\n`;
        await appendFile(stdout, partial('Hel', 10));
        const first = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-partial');
          return run?.output_seq?.length === 1 ? run : null;
        });
        assert.deepEqual(first.output_tail, ['Hel']);
        assert.deepEqual(first.output_seq, [1]);
        await appendFile(stdout, partial('lo', 11));
        const second = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-partial');
          return run?.output_seq?.[0] === 2 ? run : null;
        });
        assert.deepEqual(second.output_tail, ['Hello']);
        assert.deepEqual(second.output_seq, [2]);
        await appendFile(stdout, partial('!', 12));
        const third = await waitFor(async () => {
          const run = (await snapshot(monitor)).runs.find(item => item.run_id === 'run-partial');
          return run?.output_seq?.[0] === 3 ? run : null;
        });
        assert.deepEqual(third.output_tail, ['Hello!']);
        assert.deepEqual(third.output_seq, [3]);
        const streamed = await waitFor(() => {
          const found = events.events.filter(item => item.event === 'stdout' && item.data.run_id === 'run-partial');
          return found.length >= 3 ? found : null;
        });
        assert.ok(streamed);
        assert.deepEqual(streamed.slice(0, 3).map(item => item.data.seq), [1, 2, 3]);
        assert.deepEqual(streamed.slice(0, 3).map(item => item.data.text), ['Hel', 'lo', '!']);
        assert.ok(streamed[1].data.seq > streamed[0].data.seq);
        assert.ok(streamed[2].data.seq > streamed[1].data.seq);
      } finally {
        await events.stop();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
