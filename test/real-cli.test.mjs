import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = new Set((process.env.LIVE_MONITOR_REAL_SMOKE || '').split(','));
const ps = process.env.LIVE_MONITOR_TEST_POWERSHELL || 'powershell.exe';
const q = s => `'${s.replaceAll("'", "''")}'`;
const run = (source, env = {}) => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
  cwd: root, windowsHide: true, encoding: 'utf8', timeout: 150000, env: { ...process.env, ...env },
});
for (const agent of ['codex', 'cursor']) {
  test(`opt-in installed ${agent} availability, version and controlled schema smoke`, {
    skip: process.platform !== 'win32' || !enabled.has(agent) ? 'real CLI validation not requested' : false,
    timeout: 170000,
  }, async () => {
    const name = agent === 'codex' ? 'codex' : 'cursor-agent';
    // Availability is a hard gate when opted in. No silent skip if Cursor is absent.
    const check = run(`$ErrorActionPreference='Stop'; $c=Get-Command ${q(name)} -ErrorAction Stop; & $c.Source --version; if ($LASTEXITCODE) { exit $LASTEXITCODE }`);
    assert.equal(check.status, 0, `${name} availability/version check failed: ${check.stderr}`);
    assert.ok(check.stdout.trim(), 'CLI version must be available');
    const dir = await mkdtemp(path.join(root, '.wrapper-test-real-'));
    try {
      const prompt = path.join(dir, 'prompt.txt');
      const marker = 'fixture "quoted" café 中文';
      await writeFile(prompt, `Do not use tools or change files. Reply with exactly this text:\n${marker}`);
      const wrapper = path.join(root, 'wrappers', agent === 'codex' ? 'codexrun.ps1' : 'crun.ps1');
      const execution = run(`[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); & ${q(wrapper)} -PromptFile ${q(prompt)} -WorkDir ${q(dir)} -Phase review -TaskId real-smoke -TimeoutMin 2 | ConvertTo-Json -Compress`, { LIVE_MONITOR_RUNS: path.join(dir, 'runs') });
      assert.equal(execution.status, 0, execution.stderr);
      const result = JSON.parse(execution.stdout.replace(/^\uFEFF/, ''));
      const manifest = JSON.parse(await readFile(path.join(dir, 'runs', result.run_id, 'manifest.json'), 'utf8'));
      const statuses = (await readFile(manifest.files.status, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(statuses.at(-1).status, 'completed', JSON.stringify(statuses));
      assert.ok(manifest.cli_version);
      if (agent === 'codex') assert.ok(manifest.thread_id, 'installed Codex must emit thread.started.thread_id');
      else { assert.ok(manifest.session_id, 'installed Cursor must emit system/init session_id'); assert.ok(manifest.reported_model); }
      const stdout = await readFile(result.out, 'utf8');
      assert.ok(stdout.includes('中文'), 'real CLI must preserve Unicode');
      // Inspect transcript manually too: models may not obey exact echo instructions.
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  });
}
