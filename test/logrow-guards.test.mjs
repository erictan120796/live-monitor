import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'wrappers', 'logrow.ps1');
const windows = process.platform === 'win32';
const header = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes,run_id,prompt_sha256,cache_read_tokens,review_verdict,fix_round,tags';
const runId = `20261031T024500137Z-${'0123456789abcdef'.repeat(2)}`;
const sessionId = 'Sess-Guard';
const temps = [];

after(async () => {
  await Promise.all(temps.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

function decode(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  let nulls = 0;
  const sample = Math.min(buf.length, 80);
  for (let i = 1; i < sample; i += 2) if (buf[i] === 0) nulls++;
  if (nulls > 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'logrow-guards-'));
  temps.push(dir);
  const runs = path.join(dir, 'runs');
  await mkdir(runs, { recursive: true });
  return { dir, runs, logPath: path.join(dir, 'task-log.csv') };
}

function run(logPath, runsRoot, params) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-LogPath', logPath,
      '-RunsRoot', runsRoot,
      ...params,
    ], { cwd: root, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({
      code,
      stdout: decode(Buffer.concat(out)).trim(),
      stderr: decode(Buffer.concat(err)).trim(),
    }));
  });
}

async function writeManifest(runs, manifest, id = runId) {
  const dir = path.join(runs, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

async function assertAbsent(target) {
  await assert.rejects(readFile(target), err => err.code === 'ENOENT');
}

function rowFields(text) {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  assert.equal(lines[0], header);
  const fields = parseCsvLine(lines[1]);
  assert.equal(fields.length, 18);
  assert.match(fields[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  return fields;
}

const identity = [
  '-Repo', 'demo',
  '-TaskType', 'bug',
  '-Tool', 'codex',
  '-Model', 'gpt-5',
  '-Effort', 'high',
  '-DurationS', '3',
  '-Result', 'ok',
  '-Notes', 'from-run',
];

const winTest = (name, fn) => test(name, { skip: !windows, timeout: 60000 }, fn);

winTest('match writes row with manifest tokens', async () => {
  const { runs, logPath } = await workspace();
  const sha = 'ab'.repeat(32);
  const tags = 'task_type=bug';
  await writeManifest(runs, {
    session_id: sessionId,
    prompt_sha256: sha,
    tags,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 0 },
  });
  const result = await run(logPath, runs, [...identity, '-SessionId', sessionId, '-RunId', runId]);
  assert.equal(result.code, 0, result.stderr);
  const fields = rowFields(await readFile(logPath, 'utf8'));
  assert.equal(fields[6], '11');
  assert.equal(fields[7], '22');
  assert.equal(fields[8], '3');
  assert.equal(fields[9], sessionId);
  assert.equal(fields[12], runId);
  assert.equal(fields[13], sha);
  assert.equal(fields[14], '0');
  assert.equal(fields[17], tags);
});

winTest('token aliases fall through and missing tokens stay blank', async () => {
  const { dir, runs } = await workspace();
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: {
      input_tokens: 0,
      inputTokens: 15,
      output_tokens: null,
      outputTokens: 4,
      cached_input_tokens: null,
      cache_read_input_tokens: 3,
      cacheReadTokens: 8,
    },
  });
  const aliasLog = path.join(dir, 'alias.csv');
  const alias = await run(aliasLog, runs, [...identity, '-SessionId', sessionId, '-RunId', runId]);
  assert.equal(alias.code, 0, alias.stderr);
  const aliasFields = rowFields(await readFile(aliasLog, 'utf8'));
  assert.equal(aliasFields[6], '0');
  assert.equal(aliasFields[7], '4');
  assert.equal(aliasFields[14], '3');

  const camelId = `20261031T024500139Z-${'0011223344556677'.repeat(2)}`;
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: { inputTokens: 15, outputTokens: 4, cacheReadTokens: 6 },
  }, camelId);
  const camelLog = path.join(dir, 'camel.csv');
  const camel = await run(camelLog, runs, [...identity, '-SessionId', sessionId, '-RunId', camelId]);
  assert.equal(camel.code, 0, camel.stderr);
  const camelFields = rowFields(await readFile(camelLog, 'utf8'));
  assert.equal(camelFields[6], '15');
  assert.equal(camelFields[7], '4');
  assert.equal(camelFields[14], '6');

  const blankId = `20261031T024500138Z-${'fedcba9876543210'.repeat(2)}`;
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: '2026-10-31T02:45:00.137Z',
    prompt_sha256: 'cafebabe',
  }, blankId);
  const blankLog = path.join(dir, 'blank.csv');
  const blank = await run(blankLog, runs, [...identity, '-SessionId', sessionId, '-RunId', blankId]);
  assert.equal(blank.code, 0, blank.stderr);
  const blankFields = rowFields(await readFile(blankLog, 'utf8'));
  assert.equal(blankFields[6], '');
  assert.equal(blankFields[7], '');
  assert.equal(blankFields[14], '');
  assert.equal(blankFields[13], 'cafebabe');
});

winTest('null ended_at writes the row with blank tokens', async () => {
  const { runs, logPath } = await workspace();
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: null,
    prompt_sha256: 'ee'.repeat(32),
    tokens: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 7 },
  });
  const result = await run(logPath, runs, [...identity, '-SessionId', sessionId, '-RunId', runId]);
  assert.equal(result.code, 0, result.stderr);
  const fields = rowFields(await readFile(logPath, 'utf8'));
  assert.equal(fields[6], '');
  assert.equal(fields[7], '');
  assert.equal(fields[14], '');
  assert.equal(fields[12], runId);
  assert.equal(fields[13], 'ee'.repeat(32));
});

winTest('thread_id matching SessionId writes the row when session_id is absent', async () => {
  const { runs, logPath } = await workspace();
  const threadId = 'thread-guard';
  await writeManifest(runs, {
    thread_id: threadId,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 0 },
  });
  const result = await run(logPath, runs, [...identity, '-SessionId', threadId, '-RunId', runId]);
  assert.equal(result.code, 0, result.stderr);
  const fields = rowFields(await readFile(logPath, 'utf8'));
  assert.equal(fields[9], threadId);
  assert.equal(fields[12], runId);
});

winTest('session_id mismatch is refused and the log is not created', async () => {
  const { dir, runs } = await workspace();
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 7 },
  });
  const mismatchLog = path.join(dir, 'mismatch.csv');
  const mismatch = await run(mismatchLog, runs, [...identity, '-SessionId', 'sess-guard', '-RunId', runId]);
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /session_id mismatch/);
  await assertAbsent(mismatchLog);

  const omittedLog = path.join(dir, 'omitted.csv');
  const omitted = await run(omittedLog, runs, [...identity, '-RunId', runId]);
  assert.notEqual(omitted.code, 0);
  assert.match(omitted.stderr, /session_id mismatch/);
  await assertAbsent(omittedLog);
});

winTest('missing session_id is refused and the log is not created', async () => {
  const { dir, runs } = await workspace();
  const cases = [
    ['absent.csv', { ended_at: '2026-10-31T02:45:00.137Z', tokens: { input_tokens: 1 } }],
    ['null.csv', { session_id: null, ended_at: '2026-10-31T02:45:00.137Z' }],
    ['empty.csv', { session_id: '', ended_at: '2026-10-31T02:45:00.137Z' }],
  ];
  for (const [name, manifest] of cases) {
    await writeManifest(runs, manifest);
    const logPath = path.join(dir, name);
    const result = await run(logPath, runs, [...identity, '-SessionId', sessionId, '-RunId', runId]);
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, /session_id is empty/, name);
    await assertAbsent(logPath);
  }
});

winTest('missing manifest is refused and the log is not created', async () => {
  const { runs, logPath } = await workspace();
  const result = await run(logPath, runs, [...identity, '-SessionId', sessionId, '-RunId', runId]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`Run manifest not found for RunId ${runId}`));
  await assertAbsent(logPath);
});

winTest('hand-typed token params with RunId are refused and the log is not created', async () => {
  const { dir, runs } = await workspace();
  await writeManifest(runs, {
    session_id: sessionId,
    ended_at: '2026-10-31T02:45:00.137Z',
    tokens: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 7 },
  });
  const bound = [
    ['input.csv', ['-InputTokens', '11']],
    ['output.csv', ['-OutputTokens', '22']],
    ['cache.csv', ['-CacheReadTokens', '7']],
  ];
  for (const [name, extra] of bound) {
    const logPath = path.join(dir, name);
    const result = await run(logPath, runs, [...identity, '-SessionId', sessionId, '-RunId', runId, ...extra]);
    assert.notEqual(result.code, 0, name);
    assert.match(result.stderr, /token values must come from the run record when -RunId is given/, name);
    await assertAbsent(logPath);
  }
});

winTest('no RunId keeps hand-typed tokens and does not require a manifest', async () => {
  const { runs, logPath } = await workspace();
  const result = await run(logPath, runs, [
    ...identity,
    '-InputTokens', '11',
    '-OutputTokens', '22',
    '-CacheReadTokens', '9',
    '-SessionId', 'sess',
    '-PromptSha256', 'abc123',
    '-Tags', 'task_type=bug',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const fields = rowFields(await readFile(logPath, 'utf8'));
  assert.deepEqual(fields.slice(1), [
    'demo', 'bug', 'codex', 'gpt-5', 'high', '11', '22', '3', 'sess', 'ok', 'from-run',
    '', 'abc123', '9', '', '', 'task_type=bug',
  ]);
});
