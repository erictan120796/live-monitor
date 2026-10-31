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
const ps = process.env.LIVE_MONITOR_TEST_POWERSHELL || 'powershell.exe';
const testRoot = windows ? await mkdtemp(path.join(root, '.wrapper-test-')) : null;
const header = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes,run_id,prompt_sha256,cache_read_tokens,review_verdict,fix_round,tags';
const homeLog = path.resolve(path.join(os.homedir(), '.orchestrator', 'task-log.csv'));
let number = 0;

after(async () => { if (testRoot) await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

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

function assertTemp(target) {
  const resolved = path.resolve(target);
  const base = path.resolve(testRoot).toLowerCase() + path.sep;
  assert.ok(resolved.toLowerCase().startsWith(base), resolved);
  assert.notEqual(resolved.toLowerCase(), homeLog.toLowerCase());
}

async function workspace() {
  const dir = path.join(testRoot, String(++number));
  const runs = path.join(dir, 'runs');
  await mkdir(runs, { recursive: true });
  const logPath = path.join(dir, 'task-log.csv');
  assertTemp(logPath);
  assertTemp(runs);
  return { dir, runs, logPath };
}

function run(logPath, runsRoot, params) {
  assertTemp(logPath);
  assertTemp(runsRoot);
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-File', script, '-LogPath', logPath, '-RunsRoot', runsRoot, ...params], {
      cwd: root,
      windowsHide: true,
    });
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

const base = [
  '-Repo', 'demo',
  '-TaskType', 'bug',
  '-Tool', 'codex',
  '-Model', 'gpt-5',
  '-Effort', 'high',
  '-InputTokens', '11',
  '-OutputTokens', '22',
  '-DurationS', '3',
  '-SessionId', 'sess',
  '-Result', 'ok',
];

const winTest = (name, fn) => test(name, { skip: !windows, timeout: 30000 }, fn);

winTest('new file gets 18-column header and row', async () => {
  const { runs, logPath } = await workspace();
  const result = await run(logPath, runs, [
    ...base,
    '-Notes', 'plain',
    '-PromptSha256', 'abc123',
    '-CacheReadTokens', '9',
    '-ReviewVerdict', 'approve',
    '-FixRound', '1',
    '-Tags', 'task_type=bug',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const buf = await readFile(logPath);
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  const lines = buf.toString('utf8').split(/\r?\n/).filter(line => line.length > 0);
  assert.deepEqual(lines[0], header);
  const fields = parseCsvLine(lines[1]);
  assert.equal(fields.length, 18);
  assert.match(fields[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(fields.slice(1), [
    'demo', 'bug', 'codex', 'gpt-5', 'high', '11', '22', '3', 'sess', 'ok', 'plain',
    '', 'abc123', '9', 'approve', '1', 'task_type=bug',
  ]);
});

winTest('existing 12-column file is appended and original bytes stay', async () => {
  const { runs, logPath } = await workspace();
  const legacy = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes\r\n2026-01-02 03:04,oldrepo,bug,codex,old-model,low,1,2,3,old-sess,ok,old note\r\n';
  const original = Buffer.from(legacy, 'utf8');
  await writeFile(logPath, original);
  const result = await run(logPath, runs, [...base, '-Notes', 'fresh']);
  assert.equal(result.code, 0, result.stderr);
  const buf = await readFile(logPath);
  assert.deepEqual(buf.subarray(0, original.length), original);
  const added = buf.subarray(original.length).toString('utf8').split(/\r?\n/).filter(line => line.length > 0);
  assert.equal(added.length, 1);
  const fields = parseCsvLine(added[0]);
  assert.equal(fields.length, 18);
  assert.equal(fields[1], 'demo');
  assert.equal(fields[11], 'fresh');
  assert.equal(buf.toString('utf8').split(/\r?\n/)[0], legacy.split(/\r?\n/)[0]);
});

winTest('manifest fills empty prompt_sha256 and tags', async () => {
  const { runs, logPath } = await workspace();
  const runId = `20261031T105012345Z-${'0123456789abcdef'.repeat(2)}`;
  const sha = 'deadbeef'.repeat(8);
  const tags = 'flow_step=review;task_type=bug';
  await mkdir(path.join(runs, runId));
  await writeFile(path.join(runs, runId, 'manifest.json'), JSON.stringify({
    prompt_sha256: sha,
    tags,
    schema_version: 1,
  }));
  const result = await run(logPath, runs, [...base, '-Notes', 'from-run', '-RunId', runId]);
  assert.equal(result.code, 0, result.stderr);
  const lines = (await readFile(logPath, 'utf8')).split(/\r?\n/).filter(line => line.length > 0);
  const fields = parseCsvLine(lines[1]);
  assert.equal(fields.length, 18);
  assert.equal(fields[12], runId);
  assert.equal(fields[13], sha);
  assert.equal(fields[17], tags);

  const explicitLog = path.join(path.dirname(logPath), 'explicit.csv');
  assertTemp(explicitLog);
  const kept = await run(explicitLog, runs, [
    ...base,
    '-Notes', 'kept',
    '-RunId', runId,
    '-PromptSha256', 'explicit-sha',
    '-Tags', 'task_type=kept',
  ]);
  assert.equal(kept.code, 0, kept.stderr);
  const explicit = parseCsvLine((await readFile(explicitLog, 'utf8')).split(/\r?\n/).filter(line => line.length > 0)[1]);
  assert.equal(explicit[13], 'explicit-sha');
  assert.equal(explicit[17], 'task_type=kept');
});

winTest('invalid RunId throws and leaves the log unchanged', async () => {
  const { runs, logPath } = await workspace();
  const original = Buffer.from('date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes\r\nexisting\r\n', 'utf8');
  await writeFile(logPath, original);
  const missing = path.join(path.dirname(logPath), 'missing.csv');
  assertTemp(missing);
  const result = await run(logPath, runs, [...base, '-RunId', 'not-a-run-id']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Invalid RunId/);
  assert.deepEqual(await readFile(logPath), original);
  const absent = await run(missing, runs, [...base, '-RunId', '20261031T105012345Z-ABCDEF0123456789ABCDEF0123456789']);
  assert.notEqual(absent.code, 0);
  await assert.rejects(readFile(missing), err => err.code === 'ENOENT');
});

winTest('comma in notes is quoted', async () => {
  const { runs, logPath } = await workspace();
  const result = await run(logPath, runs, [...base, '-Notes', 'hello, world']);
  assert.equal(result.code, 0, result.stderr);
  const raw = await readFile(logPath, 'utf8');
  assert.match(raw, /"hello, world"/);
  const fields = parseCsvLine(raw.split(/\r?\n/).filter(line => line.length > 0)[1]);
  assert.equal(fields.length, 18);
  assert.equal(fields[11], 'hello, world');
});
