import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'wrappers', 'prompt-rank.ps1');
const windows = process.platform === 'win32';
const ps = process.env.LIVE_MONITOR_TEST_POWERSHELL || 'powershell.exe';
const testRoot = windows ? await mkdtemp(path.join(os.tmpdir(), 'prompt-rank-')) : null;
const header = 'date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes,run_id,prompt_sha256,cache_read_tokens,review_verdict,fix_round,tags';
const homeLog = path.resolve(path.join(os.homedir(), '.orchestrator', 'task-log.csv'));
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);
const shaD = 'd'.repeat(64);
const shaE = 'e'.repeat(64);
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

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.length > 0);
  assert.ok(lines.length > 0, text);
  assert.equal(lines.some(line => line.startsWith('#TYPE')), false, text);
  const head = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const row = {};
    head.forEach((name, i) => { row[name] = fields[i] ?? ''; });
    return row;
  });
}

function assertTemp(target) {
  const resolved = path.resolve(target);
  const base = path.resolve(testRoot).toLowerCase() + path.sep;
  assert.ok(resolved.toLowerCase().startsWith(base), resolved);
  assert.equal(resolved.toLowerCase().includes(`${path.sep}.orchestrator${path.sep}`), false);
  assert.notEqual(resolved.toLowerCase(), homeLog.toLowerCase());
}

async function workspace() {
  const dir = path.join(testRoot, String(++number));
  const runs = path.join(dir, 'runs');
  const store = path.join(dir, 'prompts');
  await mkdir(runs, { recursive: true });
  await mkdir(store, { recursive: true });
  assertTemp(dir);
  assertTemp(runs);
  assertTemp(store);
  return { dir, runs, store };
}

function run(args) {
  for (const arg of args) assertTemp(arg.includes('\\') || arg.includes('/') ? arg : path.join(testRoot, 'unused'));
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-File', script, ...args], {
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
      stdout: decode(Buffer.concat(out)).replace(/^\uFEFF/, '').trim(),
      stderr: decode(Buffer.concat(err)).replace(/^\uFEFF/, '').trim(),
    }));
  });
}

function argsOf({ logPath, runs, store, outCsv, groupBy, top, cacheWeight }) {
  const args = ['-LogPath', logPath, '-RunsRoot', runs, '-PromptStore', store];
  if (groupBy) args.push('-GroupBy', groupBy);
  if (top !== undefined) args.push('-Top', String(top));
  if (outCsv) args.push('-OutCsv', outCsv);
  if (cacheWeight !== undefined) args.push('-CacheWeight', String(cacheWeight));
  return args;
}

function csv(rows) {
  const lines = [header];
  for (const row of rows) {
    lines.push(header.split(',').map(name => row[name] ?? '').join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function promptLines(stdout) {
  const parts = stdout.split(/Top prompts/);
  assert.equal(parts.length, 2, stdout);
  return parts[1].split(/\r?\n/).map(line => line.trim()).filter(line => /^[0-9a-f]{12}\s/.test(line));
}

async function snapshot(dir) {
  const found = [];
  async function walk(current) {
    for (const ent of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) await walk(full);
      else found.push(full);
    }
  }
  await walk(dir);
  const bytes = new Map();
  for (const file of found.sort()) bytes.set(file, await readFile(file));
  return bytes;
}

const cols = [
  'group', 'runs', 'successes', 'success_rate',
  'median_duration_s', 'median_input_tokens', 'median_output_tokens',
  'median_cache_read_tokens', 'cost_per_success',
];

function pick(row) {
  const out = {};
  for (const name of cols) out[name] = row[name] ?? '';
  return out;
}

const winTest = (name, fn) => test(name, { skip: !windows, timeout: 60000 }, fn);

winTest('groups by model, applies the success rule and cost math, ranks prompts, writes only OutCsv', async () => {
  const { dir, runs, store } = await workspace();
  const logPath = path.join(dir, 'task-log.csv');
  const outCsv = path.join(dir, 'out-default.csv');
  const halfCsv = path.join(dir, 'out-half.csv');
  const promptPath = path.join(store, `${shaA}.md`);
  const decoy = path.join(dir, 'decoy.txt');
  assertTemp(logPath);
  assertTemp(outCsv);
  assertTemp(halfCsv);
  assertTemp(promptPath);

  const body = csv([
    { date: '2026-10-31 01:00', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'gpt', effort: 'high', input_tokens: '100', output_tokens: '40', duration_s: '10', session_id: 's1', result: 'ok', notes: 'a', run_id: 'run-a1', prompt_sha256: shaA, cache_read_tokens: '100', review_verdict: 'approve', fix_round: '0', tags: 'scope_style=narrow' },
    { date: '2026-10-31 01:01', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'gpt', effort: 'high', input_tokens: '10', output_tokens: '10', duration_s: '30', session_id: 's2', result: 'completed', notes: 'b', run_id: 'run-a2', prompt_sha256: shaA, cache_read_tokens: '', review_verdict: '', fix_round: '', tags: '' },
    { date: '2026-10-31 01:02', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'gpt', effort: 'high', input_tokens: '50', output_tokens: '50', duration_s: '20', session_id: 's3', result: 'interrupted', notes: 'c', run_id: 'run-a3', prompt_sha256: shaB, cache_read_tokens: '200', review_verdict: 'approve', fix_round: '0', tags: '' },
    { date: '2026-10-31 01:03', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'gpt', effort: 'high', input_tokens: '5', output_tokens: '5', duration_s: '40', session_id: 's4', result: 'ok', notes: 'd', run_id: 'run-a4', prompt_sha256: shaC, cache_read_tokens: '0', review_verdict: 'approve', fix_round: '2', tags: '' },
    { date: '2026-10-31 01:04', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'gpt', effort: 'low', input_tokens: '8', output_tokens: '2', duration_s: '4', session_id: 's5', result: 'approved', notes: 'e', run_id: 'run-b1', prompt_sha256: shaB, cache_read_tokens: '10', review_verdict: 'n-a', fix_round: '1', tags: '' },
    { date: '2026-10-31 01:05', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'claude', effort: 'mid', input_tokens: '1', output_tokens: '1', duration_s: '2', session_id: 's6', result: 'ok', notes: 'f', run_id: 'run-c1', prompt_sha256: shaE, cache_read_tokens: '0', review_verdict: 'blockers', fix_round: '0', tags: '' },
    { date: '2026-10-31 01:06', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'solo', effort: 'x', input_tokens: '1', output_tokens: '0', duration_s: '1', session_id: 's7', result: 'interrupted', notes: 'g', run_id: 'run-d1', prompt_sha256: shaD, cache_read_tokens: '0', review_verdict: '', fix_round: '', tags: '' },
  ]);
  const ragged = '2026-10-31 01:07,demo,bug,codex,short,z,1,2,3,s8,ok,note,run-short\r\n';
  const original = Buffer.from(body + ragged, 'utf8');
  const promptBytes = Buffer.from('prompt-a\n', 'utf8');
  const decoyBytes = Buffer.from('leave me\n', 'utf8');
  await writeFile(logPath, original);
  await writeFile(promptPath, promptBytes);
  await writeFile(decoy, decoyBytes);
  const before = await snapshot(dir);

  const ranked = await run(argsOf({ logPath, runs, store, outCsv }));
  assert.equal(ranked.code, 0, `${ranked.stderr}\n${ranked.stdout}`);
  assert.match(ranked.stdout, /success_rate/);
  assert.match(ranked.stdout, /gpt\/high/);
  assert.match(ranked.stdout, /Top prompts/);
  const lines = promptLines(ranked.stdout);
  assert.deepEqual(lines, [
    `${shaB.slice(0, 12)} gpt/low 11`,
    `${shaA.slice(0, 12)} gpt/high 20 ${promptPath}`,
  ]);
  const table = (await readFile(outCsv, 'utf8'));
  assert.deepEqual(parseCsv(table).map(pick), [
    { group: 'short/z', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '3', median_input_tokens: '1', median_output_tokens: '2', median_cache_read_tokens: '0', cost_per_success: '3' },
    { group: 'gpt/low', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '4', median_input_tokens: '8', median_output_tokens: '2', median_cache_read_tokens: '10', cost_per_success: '11' },
    { group: 'gpt/high', runs: '4', successes: '2', success_rate: '0.50', median_duration_s: '25', median_input_tokens: '30', median_output_tokens: '25', median_cache_read_tokens: '50', cost_per_success: '150' },
    { group: 'claude/mid', runs: '1', successes: '0', success_rate: '0.00', median_duration_s: '2', median_input_tokens: '1', median_output_tokens: '1', median_cache_read_tokens: '0', cost_per_success: '' },
    { group: 'solo/x', runs: '1', successes: '0', success_rate: '0.00', median_duration_s: '1', median_input_tokens: '1', median_output_tokens: '0', median_cache_read_tokens: '0', cost_per_success: '' },
  ]);

  const half = await run(argsOf({ logPath, runs, store, outCsv: halfCsv, top: 1, cacheWeight: 0.5 }));
  assert.equal(half.code, 0, `${half.stderr}\n${half.stdout}`);
  assert.deepEqual(promptLines(half.stdout), [`${shaB.slice(0, 12)} gpt/low 15`]);
  assert.deepEqual(parseCsv(await readFile(halfCsv, 'utf8')).map(pick), [
    { group: 'short/z', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '3', median_input_tokens: '1', median_output_tokens: '2', median_cache_read_tokens: '0', cost_per_success: '3' },
    { group: 'gpt/low', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '4', median_input_tokens: '8', median_output_tokens: '2', median_cache_read_tokens: '10', cost_per_success: '15' },
    { group: 'gpt/high', runs: '4', successes: '2', success_rate: '0.50', median_duration_s: '25', median_input_tokens: '30', median_output_tokens: '25', median_cache_read_tokens: '50', cost_per_success: '210' },
    { group: 'claude/mid', runs: '1', successes: '0', success_rate: '0.00', median_duration_s: '2', median_input_tokens: '1', median_output_tokens: '1', median_cache_read_tokens: '0', cost_per_success: '' },
    { group: 'solo/x', runs: '1', successes: '0', success_rate: '0.00', median_duration_s: '1', median_input_tokens: '1', median_output_tokens: '0', median_cache_read_tokens: '0', cost_per_success: '' },
  ]);

  const after = await snapshot(dir);
  for (const [file, bytes] of before) assert.deepEqual(after.get(file), bytes, file);
  const extra = [...after.keys()].filter(file => !before.has(file)).map(file => path.basename(file)).sort();
  assert.deepEqual(extra, ['out-default.csv', 'out-half.csv']);
  assert.deepEqual(await readdir(runs), []);
});

winTest('groups by scope_style, template, and flow_step with manifest tag fallback', async () => {
  const { dir, runs, store } = await workspace();
  const logPath = path.join(dir, 'task-log.csv');
  const scopeCsv = path.join(dir, 'scope.csv');
  const templateCsv = path.join(dir, 'template.csv');
  const flowCsv = path.join(dir, 'flow.csv');
  const broken = Buffer.from('{', 'utf8');
  const manifestWide = Buffer.from('{"tags":"scope_style=wide;template=beta;flow_step=ship"}\n', 'utf8');
  const manifestIgnored = Buffer.from('{"tags":"scope_style=wide;template=nope;flow_step=nope"}\n', 'utf8');
  await mkdir(path.join(runs, 'r1'));
  await mkdir(path.join(runs, 'r2'));
  await mkdir(path.join(runs, 'r3'));
  await writeFile(path.join(runs, 'r1', 'manifest.json'), broken);
  await writeFile(path.join(runs, 'r2', 'manifest.json'), manifestWide);
  await writeFile(path.join(runs, 'r3', 'manifest.json'), manifestIgnored);
  const logBytes = Buffer.from(csv([
    { date: '2026-10-31 02:00', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'm', effort: 'e', input_tokens: '10', output_tokens: '5', duration_s: '10', session_id: 's1', result: 'ok', notes: '', run_id: 'r1', prompt_sha256: shaA, cache_read_tokens: '0', review_verdict: 'approve', fix_round: '0', tags: 'scope_style=narrow;template=alpha;flow_step=plan' },
    { date: '2026-10-31 02:01', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'm', effort: 'e', input_tokens: '30', output_tokens: '0', duration_s: '30', session_id: 's2', result: 'ok', notes: '', run_id: 'r2', prompt_sha256: shaB, cache_read_tokens: '10', review_verdict: 'approve', fix_round: '0', tags: '' },
    { date: '2026-10-31 02:02', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'm', effort: 'e', input_tokens: '4', output_tokens: '1', duration_s: '4', session_id: 's3', result: 'ok', notes: '', run_id: 'r3', prompt_sha256: shaC, cache_read_tokens: '0', review_verdict: 'approve', fix_round: '0', tags: 'template=alpha' },
    { date: '2026-10-31 02:03', repo: 'demo', task_type: 'bug', tool: 'codex', model: 'm', effort: 'e', input_tokens: '1', output_tokens: '1', duration_s: '8', session_id: 's4', result: 'ok', notes: '', run_id: 'r4', prompt_sha256: shaD, cache_read_tokens: '0', review_verdict: 'approve', fix_round: '0', tags: 'flow_step=plan' },
  ]), 'utf8');
  await writeFile(logPath, logBytes);
  const before = await snapshot(dir);

  const scope = await run(argsOf({ logPath, runs, store, outCsv: scopeCsv, groupBy: 'scope_style' }));
  assert.equal(scope.code, 0, `${scope.stderr}\n${scope.stdout}`);
  assert.deepEqual(parseCsv(await readFile(scopeCsv, 'utf8')).map(pick), [
    { group: '(none)', runs: '2', successes: '2', success_rate: '1.00', median_duration_s: '6', median_input_tokens: '2.5', median_output_tokens: '1', median_cache_read_tokens: '0', cost_per_success: '3.5' },
    { group: 'narrow', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '10', median_input_tokens: '10', median_output_tokens: '5', median_cache_read_tokens: '0', cost_per_success: '15' },
    { group: 'wide', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '30', median_input_tokens: '30', median_output_tokens: '0', median_cache_read_tokens: '10', cost_per_success: '31' },
  ]);

  const template = await run(argsOf({ logPath, runs, store, outCsv: templateCsv, groupBy: 'template' }));
  assert.equal(template.code, 0, `${template.stderr}\n${template.stdout}`);
  assert.deepEqual(parseCsv(await readFile(templateCsv, 'utf8')).map(pick), [
    { group: '(none)', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '8', median_input_tokens: '1', median_output_tokens: '1', median_cache_read_tokens: '0', cost_per_success: '2' },
    { group: 'alpha', runs: '2', successes: '2', success_rate: '1.00', median_duration_s: '7', median_input_tokens: '7', median_output_tokens: '3', median_cache_read_tokens: '0', cost_per_success: '10' },
    { group: 'beta', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '30', median_input_tokens: '30', median_output_tokens: '0', median_cache_read_tokens: '10', cost_per_success: '31' },
  ]);

  const flow = await run(argsOf({ logPath, runs, store, outCsv: flowCsv, groupBy: 'flow_step' }));
  assert.equal(flow.code, 0, `${flow.stderr}\n${flow.stdout}`);
  assert.deepEqual(parseCsv(await readFile(flowCsv, 'utf8')).map(pick), [
    { group: '(none)', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '4', median_input_tokens: '4', median_output_tokens: '1', median_cache_read_tokens: '0', cost_per_success: '5' },
    { group: 'plan', runs: '2', successes: '2', success_rate: '1.00', median_duration_s: '9', median_input_tokens: '5.5', median_output_tokens: '3', median_cache_read_tokens: '0', cost_per_success: '8.5' },
    { group: 'ship', runs: '1', successes: '1', success_rate: '1.00', median_duration_s: '30', median_input_tokens: '30', median_output_tokens: '0', median_cache_read_tokens: '10', cost_per_success: '31' },
  ]);
  assert.equal(JSON.stringify(parseCsv(await readFile(scopeCsv, 'utf8'))).includes('nope'), false);

  const after = await snapshot(dir);
  for (const [file, bytes] of before) assert.deepEqual(after.get(file), bytes, file);
  const extra = [...after.keys()].filter(file => !before.has(file)).map(file => path.basename(file)).sort();
  assert.deepEqual(extra, ['flow.csv', 'scope.csv', 'template.csv']);
  assert.deepEqual(await readdir(store), []);
});

winTest('missing log warns and exits 0 without creating files', async () => {
  const { dir, runs, store } = await workspace();
  const logPath = path.join(dir, 'missing.csv');
  const outCsv = path.join(dir, 'out.csv');
  assertTemp(logPath);
  assertTemp(outCsv);
  const result = await run(argsOf({ logPath, runs, store, outCsv }));
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(`${result.stderr}\n${result.stdout}`, /Log not found/);
  await assert.rejects(readFile(logPath), err => err.code === 'ENOENT');
  await assert.rejects(readFile(outCsv), err => err.code === 'ENOENT');
});

winTest('twelve-column log is tolerated and left byte-identical', async () => {
  const { dir, runs, store } = await workspace();
  const logPath = path.join(dir, 'task-log.csv');
  const original = Buffer.from('date,repo,task_type,tool,model,effort,input_tokens,output_tokens,duration_s,session_id,result,notes\r\n2026-01-02 03:04,oldrepo,bug,codex,old-model,low,1,2,3,old-sess,ok,old note\r\n', 'utf8');
  await writeFile(logPath, original);
  const result = await run(argsOf({ logPath, runs, store }));
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(await readFile(logPath), original);
  assert.deepEqual(await readdir(runs), []);
  assert.deepEqual(await readdir(store), []);
  assert.deepEqual(promptLines(result.stdout), []);
});
