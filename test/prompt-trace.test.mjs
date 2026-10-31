import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const ps = process.env.LIVE_MONITOR_TEST_POWERSHELL || 'powershell.exe';
const lib = path.join(root, 'wrappers', 'prompt-trace.ps1');
const testRoot = windows ? await mkdtemp(path.join(os.tmpdir(), 'prompt-trace-')) : null;
after(async () => { if (testRoot) await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const b64 = text => Buffer.from(text, 'utf16le').toString('base64');
const quotePS = text => `'${text.replaceAll("'", "''")}'`;
const winTest = (name, fn) => test(name, { skip: !windows, timeout: 45000 }, fn);

function decodePipe(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
  let nulls = 0;
  const sample = Math.min(buffer.length, 80);
  for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) nulls++;
  if (nulls > 8) return buffer.toString('utf16le');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function runPS(body) {
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. ${quotePS(lib)}
${body}`;
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64(script)], {
    cwd: root, windowsHide: true, timeout: 30000,
  });
  return { status: result.status, stdout: decodePipe(result.stdout).trim(), stderr: decodePipe(result.stderr).trim(), error: result.error };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function underTemp(target) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const resolved = path.resolve(target).toLowerCase();
  assert.ok(resolved.startsWith(tmp), resolved);
  assert.equal(resolved.includes(`${path.sep}.orchestrator${path.sep}`), false);
}

const positives = [
  'postgres://user:secret@localhost/db',
  'postgresql://user:secret@localhost/db',
  'prefix postgres://user:secret@localhost/db tail',
  'mysql://root:pw@localhost/db',
  `sk-${'a'.repeat(20)}`,
  `sk-${'A'.repeat(20)}-_${'b'.repeat(5)}`,
  `ghp_${'a'.repeat(30)}`,
  `ghr_${'b'.repeat(30)}`,
  `github_pat_${'a'.repeat(20)}`,
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'AKIAIOSFODNN7EXAMPLE',
  ' token AKIAIOSFODNN7EXAMPLE ',
  'xoxb-1234567890',
  'xoxp-AbCdEfGhIj',
];

const negatives = [
  'hello world',
  'use postgres locally',
  'postgres://user@localhost/db',
  'mysql://root@localhost/db',
  'sk-short',
  `SK-${'a'.repeat(20)}`,
  `xsk-${'a'.repeat(20)}`,
  'ghp_short',
  `xxghp_${'a'.repeat(30)}`,
  'github_pat_short',
  '-----BEGIN PUBLIC KEY-----',
  'AKIA1234',
  'prefixAKIAIOSFODNN7EXAMPLE',
  'xoxb-short',
  'xoxc-1234567890',
];

winTest('Test-PromptSecret and ConvertTo-TagString', async () => {
  const dir = await mkdtemp(path.join(testRoot, 'rules-'));
  underTemp(dir);
  const cases = path.join(dir, 'cases.json');
  await writeFile(cases, JSON.stringify({ positives, negatives }));
  const long = 'a'.repeat(64);
  const result = runPS(`
    $cases = [IO.File]::ReadAllText(${quotePS(cases)}, (New-Object Text.UTF8Encoding $false)) | ConvertFrom-Json
    $pos = @(); foreach ($item in @($cases.positives)) { $pos += [bool](Test-PromptSecret ([string]$item)) }
    $neg = @(); foreach ($item in @($cases.negatives)) { $neg += [bool](Test-PromptSecret ([string]$item)) }
    $sorted = ConvertTo-TagString @{ template = 'review'; issue_count = '3'; flow_step = 'implement'; scope_style = 'a/b.c_d-e'; task_type = 'bugfix' }
    $long = ConvertTo-TagString @{ template = '${long}' }
    $unknownThrew = $false; try { ConvertTo-TagString @{ nope = 'x' } | Out-Null } catch { $unknownThrew = $true }
    $caseThrew = $false; try { ConvertTo-TagString @{ Task_Type = 'bugfix' } | Out-Null } catch { $caseThrew = $true }
    $badThrew = $false; try { ConvertTo-TagString @{ task_type = 'has space' } | Out-Null } catch { $badThrew = $true }
    $emptyThrew = $false; try { ConvertTo-TagString @{ task_type = '' } | Out-Null } catch { $emptyThrew = $true }
    $semiThrew = $false; try { ConvertTo-TagString @{ task_type = 'a;b' } | Out-Null } catch { $semiThrew = $true }
    $hugeThrew = $false; try { ConvertTo-TagString @{ template = '${'a'.repeat(65)}' } | Out-Null } catch { $hugeThrew = $true }
    $nlThrew = $false; try { ConvertTo-TagString @{ task_type = "bugfix\`n" } | Out-Null } catch { $nlThrew = $true }
    ConvertTo-Json -InputObject ([ordered]@{
      positives = $pos; negatives = $neg; sorted = $sorted; long = $long
      nullTags = (ConvertTo-TagString $null); emptyTags = (ConvertTo-TagString @{})
      unknownThrew = $unknownThrew; caseThrew = $caseThrew; badThrew = $badThrew
      emptyThrew = $emptyThrew; semiThrew = $semiThrew; hugeThrew = $hugeThrew; nlThrew = $nlThrew
    }) -Compress -Depth 4
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.deepEqual(parsed.positives, positives.map(() => true));
  assert.deepEqual(parsed.negatives, negatives.map(() => false));
  assert.equal(parsed.sorted, 'flow_step=implement;issue_count=3;scope_style=a/b.c_d-e;task_type=bugfix;template=review');
  assert.equal(parsed.long, `template=${long}`);
  assert.equal(parsed.nullTags, '');
  assert.equal(parsed.emptyTags, '');
  assert.equal(parsed.unknownThrew, true);
  assert.equal(parsed.caseThrew, true);
  assert.equal(parsed.badThrew, true);
  assert.equal(parsed.emptyThrew, true);
  assert.equal(parsed.semiThrew, true);
  assert.equal(parsed.hugeThrew, true);
  assert.equal(parsed.nlThrew, true);
});

async function save(prompt, promptPath, runDir, store) {
  const encoded = Buffer.from(prompt, 'utf8').toString('base64');
  return runPS(`
    $prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
    $saved = Save-PromptTrace -Prompt $prompt -PromptPath ${quotePS(promptPath)} -RunDir ${quotePS(runDir)} -StoreRoot ${quotePS(store)}
    ConvertTo-Json -InputObject $saved -Compress
  `);
}

winTest('Save-PromptTrace writes prompt.md and a content-addressed store once', async () => {
  const dir = await mkdtemp(path.join(testRoot, 'save-'));
  const runDir = path.join(dir, 'run');
  const runDir2 = path.join(dir, 'run-2');
  const store = path.join(dir, 'prompts');
  const promptPath = path.join(dir, 'prompt ü.txt');
  const prompt = 'café 中文 😀\nline "two"\r\n';
  underTemp(store);
  await mkdir(runDir);
  await mkdir(runDir2);
  const first = await save(prompt, promptPath, runDir, store);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const parsed = JSON.parse(first.stdout.replace(/^\uFEFF/, ''));
  const sha = sha256(prompt);
  assert.equal(parsed.prompt_sha256, sha);
  assert.equal(parsed.prompt_chars, prompt.length);
  assert.notEqual(parsed.prompt_chars, Buffer.byteLength(prompt));
  assert.equal(parsed.prompt_source, promptPath);
  assert.equal(parsed.prompt_redacted, false);
  const promptFile = path.join(runDir, 'prompt.md');
  const storeFile = path.join(store, `${sha}.md`);
  const written = await readFile(promptFile);
  const stored = await readFile(storeFile);
  assert.notDeepEqual([...written.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.notDeepEqual([...stored.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.equal(written.toString('utf8'), prompt);
  assert.equal(stored.toString('utf8'), prompt);
  assert.deepEqual(await readdir(store), [`${sha}.md`]);
  const stamped = new Date('2020-01-15T00:00:00.000Z');
  await utimes(storeFile, stamped, stamped);
  const before = await stat(storeFile);
  const second = await save(prompt, promptPath, runDir2, store);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const again = JSON.parse(second.stdout.replace(/^\uFEFF/, ''));
  assert.equal(again.prompt_sha256, sha);
  assert.equal(again.prompt_redacted, false);
  const after = await stat(storeFile);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal((await readFile(storeFile)).toString('utf8'), prompt);
  assert.equal((await readFile(path.join(runDir2, 'prompt.md'))).toString('utf8'), prompt);
  assert.deepEqual(await readdir(store), [`${sha}.md`]);
});

winTest('Save-PromptTrace tolerates an existing store file but propagates other IO failures', async () => {
  const dir = await mkdtemp(path.join(testRoot, 'io-'));
  underTemp(dir);
  const runDir = path.join(dir, 'run');
  const store = path.join(dir, 'prompts');
  const prompt = 'ordinary prompt';
  const storeFile = path.join(store, `${sha256(prompt)}.md`);
  await mkdir(runDir);
  await mkdir(store);
  await writeFile(storeFile, 'existing content');
  const result = runPS(`
    $tempFile = [IO.Path]::GetTempFileName()
    try {
      $collision = $null
      try {
        $unexpected = [IO.File]::Open($tempFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $unexpected.Dispose()
      } catch [System.IO.IOException] {
        $collision = Test-PromptStoreCollision -Exception $_.Exception
      }
      $sharingCollision = $null
      $lock = [IO.File]::Open($tempFile, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        try {
          $unexpected = [IO.File]::Open($tempFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
          $unexpected.Dispose()
        } catch [System.IO.IOException] {
          $sharingCollision = Test-PromptStoreCollision -Exception $_.Exception
        }
      } finally { $lock.Dispose() }
      $syntheticCollision = Test-PromptStoreCollision -Exception ([System.IO.IOException]::new('x', [int]-2147024713))
    } finally { [IO.File]::Delete($tempFile) }
    Save-PromptTrace -Prompt ${quotePS(prompt)} -PromptPath '' -RunDir ${quotePS(runDir)} -StoreRoot ${quotePS(store)} | Out-Null
    ConvertTo-Json -InputObject ([ordered]@{
      collision = $collision; sharingCollision = $sharingCollision; syntheticCollision = $syntheticCollision
    }) -Compress
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(parsed.collision, true);
  assert.equal(parsed.sharingCollision, false);
  assert.equal(parsed.syntheticCollision, true);
  assert.equal(await readFile(storeFile, 'utf8'), 'existing content');
});

winTest('Save-PromptTrace redacts secrets and writes nothing', async () => {
  const dir = await mkdtemp(path.join(testRoot, 'secret-'));
  const runDir = path.join(dir, 'run');
  const store = path.join(dir, 'prompts');
  const promptPath = path.join(dir, 'secret-prompt.txt');
  const prompt = `notes\npostgres://user:s3cret@localhost/db\n`;
  underTemp(store);
  await mkdir(runDir);
  await mkdir(store);
  await writeFile(path.join(store, 'keep.txt'), 'keep');
  const result = await save(prompt, promptPath, runDir, store);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(parsed.prompt_sha256, sha256(prompt));
  assert.equal(parsed.prompt_chars, prompt.length);
  assert.equal(parsed.prompt_source, promptPath);
  assert.equal(parsed.prompt_redacted, true);
  assert.equal(await readFile(path.join(store, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(store), ['keep.txt']);
  assert.deepEqual(await readdir(runDir), []);
});

test('prune-runs never references the prompts store', async () => {
  const source = await readFile(path.join(root, 'wrappers', 'prune-runs.ps1'), 'utf8');
  assert.doesNotMatch(source, /prompts/);
});
