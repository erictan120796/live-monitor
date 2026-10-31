import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const temps = [];
const copies = [
  { name: 'live', script: path.join(root, '.bin-staging', 'run-common.ps1') },
  { name: 'repo', script: path.join(root, 'wrappers', 'run-common.ps1') },
];

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

function quote(p) {
  return "'" + p.replace(/'/g, "''") + "'";
}

function runPs(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { windowsHide: true });
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

function seq2(text) {
  const rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(row => row.seq === 2);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function exists(p) {
  try {
    await readFile(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

const winTest = (name, fn) => test(name, { skip: !windows, timeout: 60000 }, fn);

for (const copy of copies) {
  winTest('Close-OrphanRuns ' + copy.name, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
    temps.push(dir);
    const runs = path.join(dir, 'runs');
    await mkdir(runs);

    async function fixture(id, manifest, status, extra) {
      const runDir = path.join(runs, id);
      await mkdir(runDir);
      const manifestPath = path.join(runDir, 'manifest.json');
      const statusPath = path.join(runDir, 'status.jsonl');
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(statusPath, status);
      if (extra) {
        for (const [name, body] of Object.entries(extra)) {
          await writeFile(path.join(runDir, name), body);
        }
      }
      return {
        runDir,
        manifest: await readFile(manifestPath),
        status: await readFile(statusPath),
      };
    }

    const started = id => JSON.stringify({ v: 1, seq: 1, run_id: id, status: 'started' }) + '\n';
    const base = (id, pid) => ({
      run_id: id,
      phase: 'impl',
      ended_at: null,
      pid,
      session_id: 'sess-' + id,
      tokens: 12,
      exit_code: null,
    });

    const runA = await fixture('run-a', base('run-a', 999999), started('run-a'), { 'note.txt': 'keep-a' });
    const runB = await fixture('run-b', base('run-b', 999999), started('run-b'), {
      'agent-exit.json': JSON.stringify({ run_id: 'run-b', exit_code: 0 }),
    });
    const runC = await fixture('run-c', base('run-c', 999999), started('run-c') + JSON.stringify({ v: 1, seq: 2, run_id: 'run-c', status: 'completed' }) + '\n');
    const runD = await fixture('run-d', { ...base('run-d', process.pid), process_started_ticks: '1' }, started('run-d'));
    const runE = await fixture('run-e', base('run-e', 999999), started('run-e'), { 'note.txt': 'keep-e' });
    await mkdir(path.join(runs, 'run-bad'));
    await writeFile(path.join(runs, 'run-bad', 'manifest.json'), '{not json');

    const exitB = await readFile(path.join(runB.runDir, 'agent-exit.json'));
    const command = '. ' + quote(copy.script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + " -ExcludeRunId 'run-e'; Write-Output $n";
    const result = await runPs(command);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.equal(Number(lines[lines.length - 1]), 3, result.stdout);

    const manifestA = JSON.parse(await readFile(path.join(runA.runDir, 'manifest.json'), 'utf8'));
    const lineA = seq2(await readFile(path.join(runA.runDir, 'status.jsonl'), 'utf8'));
    assert.equal(lineA.status, 'failed');
    assert.equal(lineA.reason, 'killed');
    assert.equal(lineA.tokens, null);
    assert.equal(lineA.exit_code, null);
    assert.equal(lineA.duration_s, null);
    assert.equal(lineA.session_id, 'sess-run-a');
    assert.equal(lineA.run_id, 'run-a');
    assert.ok(manifestA.ended_at);
    assert.equal(manifestA.tokens, null);
    assert.equal(manifestA.exit_code, null);
    assert.equal(await readFile(path.join(runA.runDir, 'note.txt'), 'utf8'), 'keep-a');

    const lineB = seq2(await readFile(path.join(runB.runDir, 'status.jsonl'), 'utf8'));
    const manifestB = JSON.parse(await readFile(path.join(runB.runDir, 'manifest.json'), 'utf8'));
    assert.equal(lineB.reason, 'no_result');
    assert.equal(lineB.status, 'failed');
    assert.equal(lineB.exit_code, 0);
    assert.equal(lineB.tokens, null);
    assert.equal(manifestB.exit_code, 0);
    assert.equal(manifestB.tokens, null);
    assert.deepEqual(await readFile(path.join(runB.runDir, 'agent-exit.json')), exitB);

    assert.deepEqual(await readFile(path.join(runC.runDir, 'manifest.json')), runC.manifest);
    assert.deepEqual(await readFile(path.join(runC.runDir, 'status.jsonl')), runC.status);
    assert.equal(await exists(path.join(runC.runDir, 'finalize.lock')), false);

    const lineD = seq2(await readFile(path.join(runD.runDir, 'status.jsonl'), 'utf8'));
    assert.equal(lineD.reason, 'killed');
    assert.equal(lineD.status, 'failed');
    assert.equal(lineD.tokens, null);
    assert.equal(lineD.session_id, 'sess-run-d');

    assert.deepEqual(await readFile(path.join(runE.runDir, 'manifest.json')), runE.manifest);
    assert.deepEqual(await readFile(path.join(runE.runDir, 'status.jsonl')), runE.status);
    assert.equal(await readFile(path.join(runE.runDir, 'note.txt'), 'utf8'), 'keep-e');
    assert.equal(await exists(path.join(runE.runDir, 'finalize.lock')), false);
    assert.equal(await readFile(path.join(runs, 'run-bad', 'manifest.json'), 'utf8'), '{not json');
  });

  winTest('Close-OrphanRuns live pid without process_started_ticks is untouched ' + copy.name, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
    temps.push(dir);
    const runs = path.join(dir, 'runs');
    const runDir = path.join(runs, 'run-live');
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, 'manifest.json');
    const statusPath = path.join(runDir, 'status.jsonl');
    const manifest = {
      run_id: 'run-live',
      phase: 'impl',
      ended_at: null,
      pid: process.pid,
      session_id: 'sess-run-live',
      tokens: 12,
      exit_code: null,
    };
    const status = JSON.stringify({ v: 1, seq: 1, run_id: 'run-live', status: 'started' }) + '\n';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(statusPath, status);
    const beforeManifest = await readFile(manifestPath);
    const beforeStatus = await readFile(statusPath);
    const command = '. ' + quote(copy.script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
    const result = await runPs(command);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.equal(Number(lines[lines.length - 1]), 0, result.stdout);
    assert.deepEqual(await readFile(manifestPath), beforeManifest);
    assert.deepEqual(await readFile(statusPath), beforeStatus);
    assert.equal(await exists(path.join(runDir, 'finalize.lock')), false);
  });

  winTest('Close-OrphanRuns live wrapper pid without ticks leaves a dead agent untouched ' + copy.name, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
    temps.push(dir);
    const runs = path.join(dir, 'runs');
    const runDir = path.join(runs, 'run-wrap');
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, 'manifest.json');
    const statusPath = path.join(runDir, 'status.jsonl');
    const manifest = {
      run_id: 'run-wrap',
      phase: 'impl',
      ended_at: null,
      pid: 999999,
      wrapper_pid: process.pid,
      session_id: 'sess-run-wrap',
      tokens: 12,
      exit_code: null,
    };
    const status = JSON.stringify({ v: 1, seq: 1, run_id: 'run-wrap', status: 'started' }) + '\n';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(statusPath, status);
    const beforeManifest = await readFile(manifestPath);
    const beforeStatus = await readFile(statusPath);
    const command = '. ' + quote(copy.script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
    const result = await runPs(command);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.equal(Number(lines[lines.length - 1]), 0, result.stdout);
    assert.deepEqual(await readFile(manifestPath), beforeManifest);
    assert.deepEqual(await readFile(statusPath), beforeStatus);
    assert.equal(await exists(path.join(runDir, 'finalize.lock')), false);
  });

  winTest('Close-OrphanRuns repairs a partial last status line ' + copy.name, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
    temps.push(dir);
    const runs = path.join(dir, 'runs');
    const runDir = path.join(runs, 'run-partial');
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, 'manifest.json');
    const statusPath = path.join(runDir, 'status.jsonl');
    const good = JSON.stringify({ v: 1, seq: 1, run_id: 'run-partial', status: 'started' });
    await writeFile(manifestPath, JSON.stringify({
      run_id: 'run-partial',
      phase: 'impl',
      ended_at: null,
      pid: 999999,
      session_id: 'sess-partial',
      tokens: 12,
      exit_code: null,
    }));
    await writeFile(statusPath, good + '\n{"v":1,"seq":9,"status":"brok');
    const command = '. ' + quote(copy.script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
    const result = await runPs(command);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.equal(Number(lines[lines.length - 1]), 1, result.stdout);
    const text = await readFile(statusPath, 'utf8');
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.includes('brok'), false);
    const rows = text.split(/\r?\n/).filter(line => line.length > 0);
    for (const row of rows) JSON.parse(row);
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(rows[0]).seq, 1);
    assert.equal(JSON.parse(rows[1]).seq, 2);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(manifest.ended_at);
  });
}

winTest('Close-OrphanRuns live result event completes instead of killed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
  temps.push(dir);
  const runs = path.join(dir, 'runs');
  const runDir = path.join(runs, 'run-result');
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.jsonl');
  const usage = { input_tokens: 3, output_tokens: 4 };
  await writeFile(stdoutPath, JSON.stringify({ type: 'result', subtype: 'success', usage }) + '\n');
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
    run_id: 'run-result',
    agent: 'cursor',
    phase: 'impl',
    ended_at: null,
    pid: 999999,
    wrapper_pid: 999998,
    session_id: 'sess-result',
    tokens: null,
    exit_code: null,
    files: { stdout: stdoutPath },
  }));
  await writeFile(path.join(runDir, 'status.jsonl'), JSON.stringify({ v: 1, seq: 1, run_id: 'run-result', status: 'started' }) + '\n');
  const command = '. ' + quote(copies[0].script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
  const result = await runPs(command);
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  const outLines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(Number(outLines[outLines.length - 1]), 1, result.stdout);
  const text = await readFile(path.join(runDir, 'status.jsonl'), 'utf8');
  assert.equal(text.includes('killed'), false);
  const line = seq2(text);
  assert.equal(line.status, 'completed');
  assert.equal(line.reason, undefined);
  assert.equal(line.tokens.input_tokens, 3);
  assert.equal(line.tokens.output_tokens, 4);
  const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.ended_at);
  assert.equal(manifest.tokens.input_tokens, 3);
});

winTest('Complete-AgentRun no_result live', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
  temps.push(dir);
  const runDir = path.join(dir, 'live-1');
  const stdout = path.join(runDir, 'stdout.jsonl');
  await mkdir(runDir);
  const stdoutBody = '{"type":"assistant","usage":{"input_tokens":9,"output_tokens":1}}\n';
  await writeFile(stdout, stdoutBody);
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    run_id: 'live-1',
    agent: 'cursor',
    phase: 'impl',
    session_id: 'sess-keep',
    ended_at: null,
    exit_code: null,
    tokens: 99,
    started_at: new Date().toISOString(),
    files: { stdout, stderr: stdout + '.err', status: path.join(runDir, 'status.jsonl') },
  }));
  await writeFile(path.join(runDir, 'status.jsonl'), '{"v":1,"seq":1,"run_id":"live-1","status":"started"}\n');
  const script = copies[0].script;
  const command = '. ' + quote(script) + '; Complete-AgentRun -RunDir ' + quote(runDir) + ' -ExitCode 0 | Out-Null';
  const result = await runPs(command);
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  const line = seq2(await readFile(path.join(runDir, 'status.jsonl'), 'utf8'));
  assert.equal(line.status, 'failed');
  assert.equal(line.reason, 'no_result');
  assert.equal(line.tokens, null);
  assert.equal(line.exit_code, 0);
  assert.equal(line.session_id, 'sess-keep');
  const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tokens, null);
  assert.equal(manifest.session_id, 'sess-keep');
  assert.equal(manifest.exit_code, 0);
  assert.ok(manifest.ended_at);
  assert.equal(await readFile(stdout, 'utf8'), stdoutBody);
});

winTest('Close-OrphanRuns repo nonzero exit overrides codex turn.completed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
  temps.push(dir);
  const runs = path.join(dir, 'runs');
  const runId = 'run-nonzero';
  const runDir = path.join(runs, runId);
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.jsonl');
  const usage = { input_tokens: 3, output_tokens: 4 };
  await writeFile(stdoutPath, JSON.stringify({ type: 'turn.completed', usage }) + '\n');
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
    run_id: runId,
    agent: 'codex',
    phase: 'impl',
    ended_at: null,
    pid: 999999,
    wrapper_pid: 999998,
    session_id: 'sess-nonzero',
    tokens: null,
    exit_code: null,
    files: { stdout: stdoutPath },
  }));
  await writeFile(path.join(runDir, 'status.jsonl'), JSON.stringify({ v: 1, seq: 1, run_id: runId, status: 'started' }) + '\n');
  await writeFile(path.join(runDir, 'agent-exit.json'), JSON.stringify({ run_id: runId, exit_code: 7 }));
  const command = '. ' + quote(copies[1].script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
  const result = await runPs(command);
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  const outLines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(Number(outLines[outLines.length - 1]), 1, result.stdout);
  const line = seq2(await readFile(path.join(runDir, 'status.jsonl'), 'utf8'));
  assert.equal(line.status, 'failed');
  assert.equal(line.reason, 'nonzero_exit');
  assert.equal(line.exit_code, 7);
  assert.deepEqual(line.tokens, usage);
});

winTest('Close-OrphanRuns repo codex turn.failed overrides turn.completed with exit zero', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-closeout-'));
  temps.push(dir);
  const runs = path.join(dir, 'runs');
  const runId = 'run-native-failure';
  const runDir = path.join(runs, runId);
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.jsonl');
  await writeFile(stdoutPath, [
    { type: 'thread.started', thread_id: 'sess-native-failure' },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } },
    { type: 'turn.failed', error: { message: 'native failure' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify({
    run_id: runId,
    agent: 'codex',
    phase: 'impl',
    ended_at: null,
    pid: 999999,
    wrapper_pid: 999998,
    session_id: 'sess-native-failure',
    tokens: null,
    exit_code: null,
    files: { stdout: stdoutPath },
  }));
  await writeFile(path.join(runDir, 'status.jsonl'), JSON.stringify({ v: 1, seq: 1, run_id: runId, status: 'started' }) + '\n');
  await writeFile(path.join(runDir, 'agent-exit.json'), JSON.stringify({ run_id: runId, exit_code: 0 }));
  const command = '. ' + quote(copies[1].script) + '; $n = Close-OrphanRuns -RunsRoot ' + quote(runs) + '; Write-Output $n';
  const result = await runPs(command);
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  const outLines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(Number(outLines[outLines.length - 1]), 1, result.stdout);
  const line = seq2(await readFile(path.join(runDir, 'status.jsonl'), 'utf8'));
  assert.equal(line.status, 'failed');
  assert.equal(line.reason, 'native_failure');
  assert.equal(line.exit_code, 0);
});
