import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, lstat, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const ps = process.env.LIVE_MONITOR_TEST_POWERSHELL || 'powershell.exe';
const testRoot = windows ? await mkdtemp(path.join(root, '.wrapper-test-')) : null;
after(async () => { if (testRoot) await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
const b64 = text => Buffer.from(text, 'utf16le').toString('base64');
const quotePS = text => `'${text.replaceAll("'", "''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let number = 0;

async function setup(prompt = 'hello', mode = '') {
  const dir = path.join(testRoot, `case ${++number} 中文`);
  await mkdir(dir);
  const promptFile = path.join(dir, 'prompt ü.txt');
  await writeFile(promptFile, prompt);
  return { dir, promptFile, prompt, mode, runs: path.join(dir, 'runs') };
}

function launch(c, { agent = 'codex', executable = path.join(root, 'test/fixtures/fake-agent.ps1'), extra = '', env = {}, workdir = c.dir, phase = 'review', taskId = 'shared-task', attempt = 2 } = {}) {
  const script = path.join(root, 'wrappers', agent === 'codex' ? 'codexrun.ps1' : 'crun.ps1');
  const command = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; & ${quotePS(script)} -PromptFile ${quotePS(c.promptFile)} -WorkDir ${quotePS(workdir)} -Phase ${quotePS(phase)} ${taskId === null ? '' : `-TaskId ${quotePS(taskId)}`} -Attempt ${attempt} -Executable ${quotePS(executable)} ${extra} | ConvertTo-Json -Compress`;
  const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64(command)], {
    cwd: root, windowsHide: true,
    env: { ...process.env, LIVE_MONITOR_RUNS: c.runs, FAKE_AGENT_MODE: c.mode, NODE_COMPILE_CACHE: path.join(c.dir, 'compile-cache'), ...env },
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', s => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0, stderr || stdout);
        resolve(JSON.parse(stdout.replace(/^\uFEFF/, '')));
      } catch (error) { reject(error); }
    });
  });
  done.catch(() => {}); // Polling tests still await and assert the original promise.
  return { child, done };
}

async function evidence(c, result) {
  const dir = path.join(c.runs, result.run_id);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const statusBytes = await readFile(path.join(dir, 'status.jsonl'));
  assert.notDeepEqual([...statusBytes.subarray(0, 3)], [239, 187, 191]);
  assert.equal(statusBytes.at(-1), 10);
  const statuses = statusBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses.map(s => s.seq), [1, 2]);
  assert.equal(statuses[0].status, 'started');
  for (const s of statuses) {
    assert.equal(s.v, 1); assert.equal(s.phase, 'review'); assert.equal(s.run_id, result.run_id);
    assert.match(s.ts, /Z$/);
  }
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.task_id, 'shared-task');
  assert.equal(manifest.attempt, 2);
  assert.equal(manifest.workdir, c.dir);
  assert.match(manifest.started_at, /Z$/); assert.match(manifest.ended_at, /Z$/);
  for (const capture of Object.values(manifest.files)) assert.ok(path.isAbsolute(capture));
  assert.equal(manifest.files.stdout, result.out); assert.equal(manifest.files.stderr, result.err);
  const stdout = await readFile(result.out, 'utf8').catch(() => '');
  return { manifest, statuses, stdout, events: stdout.trim().split('\n').filter(Boolean).map(s => JSON.parse(s.replace(/^\uFEFF/, ''))) };
}

const winTest = (name, fn) => test(name, { skip: !windows, timeout: 45000 }, fn);


async function forwardingShim(c, { local = false } = {}) {
  const shim = path.join(c.dir, 'cursor-agent.ps1');
  await copyFile(path.join(root, 'test/fixtures/fake-forwarding-shim.ps1'), shim);
  const directory = local ? c.dir : path.join(c.dir, 'versions', '2026.10.9-12-34-56-abcdef');
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, path.join(directory, 'node.exe'));
  await copyFile(path.join(root, 'test/fixtures/fake-agent.cjs'), path.join(directory, 'index.js'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"commonjs"}');
  if (!local) {
    const older = path.join(c.dir, 'versions', '2026.9.30-abcdef');
    await mkdir(older);
    await writeFile(path.join(older, 'index.js'), 'throw new Error("wrong version selected")');
    await mkdir(path.join(c.dir, 'versions', 'not-a-version'));
  }
  return { shim, directory };
}

winTest('Codex forwarding shim receives no prompt argv; stdin preserves quotes, empty and Unicode', async () => {
  const c = await setup();
  const { shim } = await forwardingShim(c, { local: true });
  for (const prompt of ['say "hello" and "" caf\u00e9 \u4e2d\u6587 \u{1f600}\nline two\\', '', '\u4e2d\u6587 "quote"\n'.repeat(4000)]) {
    await writeFile(c.promptFile, prompt);
    const result = await launch(c, { executable: shim, extra: '-Effort high' }).done;
    const e = await evidence(c, result);
    assert.equal(result.exit, 0, JSON.stringify(e.manifest));
    assert.equal(e.manifest.transport, 'codex_stdin');
    assert.equal(e.events[0].stdin, prompt);
    assert.deepEqual(e.events[0].arguments, ['exec', '--json', '--cd', c.dir, '-c', "model_reasoning_effort='high'", '-']);
    const payload = JSON.parse(await readFile(path.join(c.runs, result.run_id, 'launch.json'), 'utf8'));
    assert.equal(payload.arguments.at(-1), '-');
    assert.ok(!payload.arguments.includes(prompt));
  }
});

for (const local of [false, true]) {
  winTest(`Cursor bypasses forwarding shim via ${local ? 'local' : 'latest version'} node; quotes, empty prompt and Unicode survive`, async () => {
    const c = await setup('', 'cursor');
    const { shim, directory } = await forwardingShim(c, { local });
    const executable = local ? shim : path.join(c.dir, 'cursor-agent.cmd');
    if (!local) await writeFile(executable, '@exit /b 99\r\n');
    for (const prompt of ['say "hello" and "" caf\u00e9 \u4e2d\u6587 \u{1f600}\nnext\r\nend\\', '']) {
      await writeFile(c.promptFile, prompt);
      const result = await launch(c, { agent: 'cursor', executable }).done;
      const e = await evidence(c, result);
      assert.equal(result.exit, 0, JSON.stringify(e.manifest));
      assert.equal(e.manifest.transport, 'cursor_node_direct');
      assert.equal(e.manifest.executable, executable);
      assert.equal(e.manifest.launch_executable, path.join(directory, 'node.exe'));
      assert.equal(e.manifest.launch_entry_script, path.join(directory, 'index.js'));
      assert.equal(e.manifest.pid, e.events[0].pid);
      assert.equal(e.manifest.session_id, 'cursor-session');
      assert.equal(e.events[0].arguments.at(-1), prompt);
      assert.equal(e.events[0].arguments.at(-2), '--');
    }

    // Exercise arbitrary empty argv between nonempty values, not just a prompt.
    const args = ['left', '', '"quoted"', 'caf\u00e9 \u4e2d\u6587 \u{1f600}', '', 'trailing\\'];
    const stdout = path.join(c.dir, 'argv.jsonl');
    const source = `
      $ErrorActionPreference = 'Stop'
      . ${quotePS(path.join(root, 'wrappers/run-common.ps1'))}
      $launch = Resolve-CursorTransport ${quotePS(shim)}
      $p = Start-AgentProcess -Executable $launch.executable -Arguments ($launch.prefix + @(${args.map(quotePS).join(',')})) -PayloadPath ${quotePS(path.join(c.dir, 'payload.json'))} -WorkDir ${quotePS(c.dir)} -Stdout ${quotePS(stdout)} -Stderr ${quotePS(path.join(c.dir, 'argv.err'))}
      $p.WaitForExit(); exit $p.ExitCode
    `;
    const probe = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64(source)], { windowsHide: true, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse((await readFile(stdout, 'utf8')).split('\n')[0]).arguments, args);
  });
}

winTest('Cursor unresolved shim uses powershell -File fallback and records it', async () => {
  const c = await setup('simple fallback', 'cursor');
  const result = await launch(c, { agent: 'cursor' }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0);
  assert.equal(e.manifest.transport, 'cursor_powershell_file_fallback');
  assert.equal(e.manifest.launch_entry_script, null);
});

winTest('PowerShell launcher preserves quotes, spaces, Unicode, multiline and required Codex flags', async () => {
  const prompt = 'spaces "quoted" café 中文\nsecond line\r\n--not-an-option & | % ! ^ \\ trailing\\';
  const c = await setup(prompt);
  const result = await launch(c, { extra: '-Model "requested-model" -Effort high' }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0);
  assert.equal(e.statuses[1].status, 'completed');
  assert.equal(e.manifest.thread_id, 'fast-thread');
  assert.equal(e.manifest.requested_model, 'requested-model');
  assert.equal(e.manifest.effort, 'high');
  assert.equal(e.manifest.cli_version, 'fake-agent 1.2.3');
  assert.equal(e.manifest.pid, e.events[0].pid);
  assert.equal(e.events[0].cwd, c.dir);
  assert.deepEqual(e.events[0].arguments, ['exec', '--json', '--cd', c.dir, '--model', 'requested-model', '-c', "model_reasoning_effort='high'", '-']);
  assert.equal(e.events[0].stdin, prompt);
  assert.match(await readFile(result.err, 'utf8'), /café 中文/);
});

winTest('Cursor stream flags, metadata and legacy OutFile/return fields', async () => {
  const c = await setup('hello "Cursor"\n中文', 'cursor');
  const out = path.join(c.dir, 'legacy capture.txt');
  const result = await launch(c, { agent: 'cursor', extra: `-OutFile ${quotePS(out)}` }).done;
  const e = await evidence(c, result);
  assert.equal(result.out, out); assert.equal(result.err, `${out}.err`);
  assert.equal(result.exit, 0); assert.equal(typeof result.duration_s, 'number');
  assert.equal(e.manifest.effort, null);
  assert.equal(e.manifest.session_id, 'cursor-session');
  assert.equal(e.manifest.reported_model, 'reported-model');
  assert.deepEqual(e.events[0].arguments, ['--print', '--force', '--trust', '--output-format', 'stream-json', '--stream-partial-output', '--model', 'grok-4.7-medium', '--', c.prompt]);
});

winTest('live output and late thread ID published before exit', async () => {
  const c = await setup('live', 'late');
  const run = launch(c);
  let observed = false;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const dirs = await readdir(c.runs).catch(() => []);
    if (dirs.length) {
      const folder = path.join(c.runs, dirs[0]);
      const manifest = await readFile(path.join(folder, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.thread_id === 'late-thread' && manifest.ended_at === null) {
        const stdout = await readFile(manifest.files.stdout, 'utf8');
        const statuses = await readFile(manifest.files.status, 'utf8');
        assert.ok(stdout.includes('fixture.args')); assert.equal(statuses.trim().split('\n').length, 1);
        observed = true; break;
      }
    }
    await sleep(40);
  }
  const result = await run.done;
  assert.ok(observed, 'metadata and stdout must be readable before completion');
  await evidence(c, result);
});

for (const [mode, exit, reason] of [['nonzero', 7, 'nonzero_exit'], ['timeout', 'timeout', 'timeout'], ['native-failure', 0, 'native_failure'], ['cursor-failure', 0, 'native_failure']]) {
  winTest(`${mode} creates one failed terminal record`, async () => {
    const c = await setup('failure', mode);
    const result = await launch(c, { agent: mode === 'cursor-failure' ? 'cursor' : 'codex', extra: mode === 'timeout' ? '-TimeoutMin 0.04' : '' }).done;
    const e = await evidence(c, result);
    assert.equal(result.exit, exit);
    assert.equal(e.statuses[1].status, 'failed'); assert.equal(e.statuses[1].reason, reason);
    if (mode === 'timeout') {
      const probe = spawnSync(ps, ['-NoProfile', '-Command', `if (Get-Process -Id ${e.manifest.pid} -ErrorAction SilentlyContinue) { exit 1 }`], { windowsHide: true });
      assert.equal(probe.status, 0, 'launched PID must be stopped');
    }
  });
}

winTest('missing CLI, invalid workdir and missing prompt preserve failed evidence', async () => {
  for (const kind of ['cli', 'workdir', 'prompt']) {
    const c = await setup();
    if (kind === 'prompt') c.promptFile += '.missing';
    const result = await launch(c, {
      executable: kind === 'cli' ? 'live-monitor-no-such-agent-72836' : undefined,
      workdir: kind === 'workdir' ? path.join(c.dir, 'missing') : c.dir,
    }).done;
    const dir = path.join(c.runs, result.run_id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const statuses = (await readFile(manifest.files.status, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(result.exit, 'launch_failure'); assert.equal(manifest.pid, null);
    assert.equal(statuses[1].reason, 'launch_failure'); assert.equal(statuses.length, 2);
  }
});

winTest('split emoji across 8192-byte reads still publishes metadata', async () => {
  const c = await setup('split', 'split-utf8');
  const result = await launch(c).done;
  const dir = path.join(c.runs, result.run_id);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const statuses = (await readFile(manifest.files.status, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result.exit, 0);
  assert.equal(statuses.at(-1).status, 'completed');
  assert.equal(manifest.thread_id, 'fast-thread');
  const stdout = await readFile(result.out);
  assert.equal(stdout[8189], 0xF0);
  assert.equal(stdout[8192], 0x80);
  assert.ok(stdout.includes(Buffer.from('fast-thread')));
});

winTest('final drain captures fast and unterminated events', async () => {
  const c = await setup('fast', 'unterminated');
  const result = await launch(c).done;
  const e = await evidence(c, result);
  assert.equal(e.manifest.thread_id, 'final-thread');
});

winTest('manifest and flushed started status exist before even the version process launches', async () => {
  const c = await setup('before launch', 'prelaunch-contract');
  const result = await launch(c).done;
  const e = await evidence(c, result);
  assert.equal(e.manifest.cli_version, 'prelaunch-evidence-ok');
  assert.equal(e.statuses[1].status, 'completed');
});

winTest('stalled version probe exhausts timeout without launching the agent', async () => {
  const c = await setup('version budget', 'version-timeout');
  const result = await launch(c, { extra: '-TimeoutMin 0.02' }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 'timeout');
  assert.equal(e.manifest.pid, null);
  assert.equal(e.manifest.cli_version, null);
  assert.equal(e.manifest.cli_version_error, 'Version probe timed out');
  assert.equal(e.statuses[1].status, 'failed');
  assert.equal(e.statuses[1].reason, 'timeout');
  assert.equal(e.stdout, '');
});

winTest('malformed, oversized and unknown stdout stays intact without losing final metadata', async () => {
  const c = await setup('noisy metadata', 'metadata-noise');
  const result = await launch(c).done;
  const manifest = JSON.parse(await readFile(path.join(c.runs, result.run_id, 'manifest.json'), 'utf8'));
  const statuses = (await readFile(manifest.files.status, 'utf8')).trim().split('\n').map(JSON.parse);
  const stdout = await readFile(result.out, 'utf8');
  assert.equal(result.exit, 0);
  assert.equal(manifest.thread_id, 'after-noise');
  assert.equal(statuses.at(-1).status, 'completed');
  assert.ok(stdout.replaceAll('\r\n', '\n').includes(`not JSON\n${'x'.repeat(1100000)}\n`));
  assert.ok(stdout.includes('future.unknown'));
});

winTest('concurrent runs share task_id but never capture paths or run_id', async () => {
  const c = await setup('parallel');
  const results = await Promise.all([launch(c).done, launch(c).done, launch(c, { agent: 'cursor' }).done]);
  assert.equal(new Set(results.map(r => r.run_id)).size, 3);
  assert.equal(new Set(results.map(r => r.out)).size, 3);
  for (const r of results) { assert.equal(r.exit, 0); await evidence(c, r); }
});

winTest('all phases and retries retain one shared task_id; standalone task_id stays null', async () => {
  const c = await setup('handoff');
  const phases = ['design', 'code', 'review', 'fix'];
  const results = await Promise.all(phases.map((phase, i) => launch(c, { phase, attempt: i + 1 }).done));
  for (const [i, result] of results.entries()) {
    const manifest = JSON.parse(await readFile(path.join(c.runs, result.run_id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.phase, phases[i]); assert.equal(manifest.task_id, 'shared-task'); assert.equal(manifest.attempt, i + 1);
  }
  const standalone = await launch(c, { taskId: null }).done;
  const manifest = JSON.parse(await readFile(path.join(c.runs, standalone.run_id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.task_id, null); assert.equal(manifest.requested_model, null); assert.equal(manifest.effort, null);
});

winTest('empty and long PowerShell prompts survive stdin transport', async () => {
  for (const prompt of ['', 'long 中文 "quote"\n'.repeat(1600)]) {
    const c = await setup(prompt);
    const result = await launch(c).done;
    const e = await evidence(c, result);
    assert.equal(result.exit, 0); assert.equal(e.events[0].stdin, prompt);
  }
});

winTest('concurrent legacy OutFile callers fail safely without truncating active capture', async () => {
  const c = await setup('first active run', 'late');
  const out = path.join(c.dir, 'shared legacy.jsonl');
  const options = { agent: 'cursor', extra: `-OutFile ${quotePS(out)}` };
  const first = launch(c, options);
  const deadline = Date.now() + 15000;
  let captured = '';
  while (Date.now() < deadline) {
    captured = await readFile(out, 'utf8').catch(() => '');
    if (captured.includes('fixture.args')) break;
    await sleep(40);
  }
  assert.ok(captured.includes('fixture.args'));
  const second = await launch(c, options).done;
  assert.equal(second.exit, 'launch_failure');
  const secondManifest = JSON.parse(await readFile(path.join(c.runs, second.run_id, 'manifest.json'), 'utf8'));
  assert.equal(secondManifest.pid, null);
  assert.ok((await readFile(out, 'utf8')).startsWith(captured));
  const result = await first.done;
  assert.equal(result.exit, 0);
  assert.ok(!(await readdir(c.dir)).some(name => name.endsWith('.live-monitor.lock')));
});

winTest('.cmd launchers explicitly supported, paths and quotes survive', async () => {
  const c = await setup('quoted "hello" café 中文 & | % ! ^ trailing\\');
  const cmd = path.join(c.dir, 'fake launcher.cmd');
  const js = path.join(root, 'test/fixtures/fake-agent.cjs');
  await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  const result = await launch(c, { executable: cmd }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0);
  assert.equal(e.events[0].stdin, c.prompt);
});

winTest('.cmd prefers sibling .ps1 for arbitrary multiline arguments', async () => {
  const c = await setup('line one "quotes"\nline two 中文');
  const cmd = path.join(c.dir, 'paired.cmd');
  await writeFile(cmd, '@exit /b 99\r\n');
  await copyFile(path.join(root, 'test/fixtures/fake-agent.ps1'), path.join(c.dir, 'paired.ps1'));
  const result = await launch(c, { executable: cmd }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0); assert.equal(e.events[0].stdin, c.prompt);
});

winTest('unpaired .cmd rejects multiline prompts instead of silently truncating', async () => {
  const c = await setup('line one\nline two');
  const cmd = path.join(c.dir, 'single-line.cmd');
  await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${path.join(root, 'test/fixtures/fake-agent.cjs')}" %*\r\n`);
  const result = await launch(c, { agent: 'cursor', executable: cmd }).done;
  const e = await evidence(c, result);
  assert.equal(e.statuses[1].reason, 'launch_failure');
  assert.match(e.manifest.error, /Multiline arguments require/);
});

winTest('.cmd shell metacharacters stay data, not executable commands', async () => {
  const c = await setup('" & echo INJECTED > injected.txt & rem " %PATH% !VAR! ^ & | < > ( )');
  const cmd = path.join(c.dir, 'safe.cmd');
  await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${path.join(root, 'test/fixtures/fake-agent.cjs')}" %*\r\n`);
  const result = await launch(c, { executable: cmd }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0); assert.equal(e.events[0].stdin, c.prompt);
  assert.ok(!(await readdir(c.dir)).includes('injected.txt'));
});

winTest('native launcher uses CRT quoting, PID, UTF-8 and direct file redirection', async () => {
  const c = await setup('"quotes" \\"backslashes\\" 中文\nmultiline\r\n& | % ! ^ trailing\\');
  const executable = path.join(c.dir, 'native fixture.exe');
  const compile = `Add-Type -Path ${quotePS(path.join(root, 'test/fixtures/fake-agent.cs'))} -OutputAssembly ${quotePS(executable)} -OutputType ConsoleApplication`;
  const compilation = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64(compile)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compilation.status, 0, compilation.stderr);
  const result = await launch(c, { executable }).done;
  const e = await evidence(c, result);
  assert.equal(result.exit, 0); assert.equal(e.manifest.thread_id, 'native-thread');
  assert.equal(e.manifest.pid, e.events[1].pid);
  assert.equal(Buffer.from(e.events[0].stdin_b64, 'base64').toString('utf8'), c.prompt);
  assert.match(await readFile(result.err, 'utf8'), /café 中文/);
});

winTest('graceful PowerShell pipeline cancellation produces failed/cancelled evidence', async () => {
  const c = await setup('cancel', 'timeout');
  const wrapper = path.join(root, 'wrappers/codexrun.ps1');
  const source = `
    $ErrorActionPreference = 'Stop'
    $invocation = ${quotePS(`& ${quotePS(wrapper)} -PromptFile ${quotePS(c.promptFile)} -WorkDir ${quotePS(c.dir)} -Phase review -TaskId shared-task -Attempt 2 -Executable ${quotePS(path.join(root, 'test/fixtures/fake-agent.ps1'))}`)}
    $pipeline = [PowerShell]::Create()
    [void]$pipeline.AddScript($invocation)
    $async = $pipeline.BeginInvoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $manifest = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $files = @(Get-ChildItem -LiteralPath ${quotePS(c.runs)} -Filter manifest.json -Recurse -ErrorAction SilentlyContinue)
      if ($files.Count) {
        try {
          $file = [IO.File]::Open($files[0].FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
          $reader = New-Object IO.StreamReader($file)
          try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
          if ($manifest.pid) { break }
        } catch { }
      }
      Start-Sleep -Milliseconds 50
    }
    if (-not $manifest.pid) { $pipeline.Stop(); throw 'Fixture did not launch before cancellation' }
    $pipeline.Stop()
    $pipeline.Dispose()
    [Console]::WriteLine($manifest.run_id)
  `;
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64(source)], {
    windowsHide: true, env: { ...process.env, LIVE_MONITOR_RUNS: c.runs, FAKE_AGENT_MODE: c.mode },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', s => { stdout += s; }); child.stderr.on('data', s => { stderr += s; });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
  const manifest = JSON.parse(await readFile(path.join(c.runs, stdout.trim(), 'manifest.json'), 'utf8'));
  const statuses = (await readFile(manifest.files.status, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(statuses.length, 2); assert.equal(statuses[1].status, 'failed'); assert.equal(statuses[1].reason, 'cancelled');
  const probe = spawnSync(ps, ['-NoProfile', '-Command', `if (Get-Process -Id ${manifest.pid} -ErrorAction SilentlyContinue) { exit 1 }`], { windowsHide: true });
  assert.equal(probe.status, 0);
});

test('wrapper sources use Start-Process file redirection, no output pipeline or policy escalation', async () => {
  const source = await readFile(path.join(root, 'wrappers/run-common.ps1'), 'utf8');
  assert.match(source, /Start-Process @startInfo[^\n]+-RedirectStandardOutput \$stdout -RedirectStandardError \$stderr -WindowStyle Hidden -PassThru/);
  assert.match(source, /\$startInfo.RedirectStandardInput = \$Stdin/);
  assert.match(source, /\$arguments \+= @\('-'\)/);
  assert.doesNotMatch(source, /Start-Process[^\n]+\|/);
  assert.doesNotMatch(source, /ExecutionPolicy\s+Bypass|dangerously-bypass|--yolo/);
  assert.doesNotMatch(source, /prune-runs/);
  const codex = await readFile(path.join(root, 'wrappers/codexrun.ps1'), 'utf8');
  const cursor = await readFile(path.join(root, 'wrappers/crun.ps1'), 'utf8');
  assert.doesNotMatch(codex, /prune-runs|resume/);
  assert.doesNotMatch(cursor, /prune-runs/);
  const prune = await readFile(path.join(root, 'wrappers/prune-runs.ps1'), 'utf8');
  assert.match(prune, /RetentionDays = 30/);
  assert.match(prune, /\.codex\\sessions/);
  assert.match(prune, /ReparsePoint/);
  assert.match(prune, /Refusing to prune/);
  assert.doesNotMatch(prune, /Start-Process|Remove-Item/);
});

function decodePipe(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
  let nulls = 0;
  const sample = Math.min(buffer.length, 80);
  for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) nulls++;
  if (nulls > 8) return buffer.toString('utf16le');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function runPrune(runsRoot, sessionsRoot, { whatIf = false, days = null, cwd = root } = {}) {
  const script = path.join(root, 'wrappers/prune-runs.ps1');
  let extra = `-RunsRoot ${quotePS(runsRoot)} -SessionsRoot ${quotePS(sessionsRoot)}`;
  if (days != null) extra += ` -RetentionDays ${days}`;
  if (whatIf) extra += ' -WhatIf';
  const command = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference = 'Stop'; & ${quotePS(script)} ${extra}`;
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64(command)], {
    cwd, windowsHide: true, timeout: 30000,
  });
  return { status: result.status, stdout: decodePipe(result.stdout), stderr: decodePipe(result.stderr), error: result.error };
}

winTest('optional prune helper deletes only expired terminal runs inside the runs root', async () => {
  const c = await setup('prune');
  const runs = c.runs;
  const outside = path.join(c.dir, 'outside');
  const sessions = path.join(c.dir, 'sessions');
  const target = path.join(outside, 'junction-target');
  await mkdir(runs);
  await mkdir(target, { recursive: true });
  await mkdir(sessions);
  const secret = path.join(outside, 'secret.txt');
  const marker = path.join(target, 'marker.txt');
  const sessionFile = path.join(sessions, 'session.jsonl');
  await writeFile(secret, 'keep-secret');
  await writeFile(marker, 'keep-marker');
  await writeFile(sessionFile, 'keep-session');
  await writeFile(path.join(runs, 'loose.txt'), 'keep-loose');
  const iso = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  async function makeRun(id, { ended, status = '{"v":1,"status":"started"}\n{"v":1,"status":"completed"}\n', runId = id, stdout } = {}) {
    const dir = path.join(runs, id);
    await mkdir(dir, { recursive: true });
    const statusPath = path.join(dir, 'status.jsonl');
    const manifest = {
      schema_version: 1,
      run_id: runId,
      ended_at: ended,
      files: {
        stdout: stdout || path.join(dir, 'stdout.jsonl'),
        stderr: path.join(dir, 'stderr.log'),
        status: statusPath,
      },
    };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(statusPath, status);
    await writeFile(path.join(dir, 'stdout.jsonl'), '{"type":"fixture"}\n');
    await writeFile(path.join(dir, 'note.txt'), 'evidence');
    return dir;
  }
  await makeRun('old-ok', { ended: iso(40) });
  await makeRun('old-failed', { ended: iso(40), status: '{"v":1,"status":"started"}\n{"v":1,"status":"failed","reason":"nonzero_exit"}\n' });
  await makeRun('mid-ok', { ended: iso(10) });
  await makeRun('recent-ok', { ended: iso(1) });
  await makeRun('old-unknown', { ended: iso(40), status: '{"v":1,"status":"started"}\n' });
  await makeRun('old-external', { ended: iso(40), stdout: secret });
  await makeRun('mismatch', { ended: iso(40), runId: 'other-id' });
  const nested = await makeRun('old-nested-link', { ended: iso(40) });
  await symlink(target, path.join(nested, 'sub'), 'junction');
  await symlink(target, path.join(runs, 'root-link'), 'junction');
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify({
    schema_version: 1, run_id: 'root-link', ended_at: iso(40),
  }));
  await writeFile(path.join(target, 'status.jsonl'), '{"status":"completed"}\n');

  const dry = runPrune(runs, sessions, { whatIf: true });
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.match(dry.stdout, /would-delete:old-ok/);
  assert.match(dry.stdout, /would-delete:old-failed/);
  assert.match(dry.stdout, /would-delete:old-external/);
  assert.doesNotMatch(dry.stdout, /would-delete:mid-ok|would-delete:recent-ok|would-delete:old-unknown|would-delete:mismatch|would-delete:old-nested-link|would-delete:root-link/);
  assert.equal(await readFile(path.join(runs, 'old-ok', 'note.txt'), 'utf8'), 'evidence');

  const live = runPrune(runs, sessions);
  assert.equal(live.status, 0, live.stderr || live.stdout);
  assert.match(live.stdout, /deleted:old-ok/);
  assert.match(live.stdout, /deleted:old-failed/);
  assert.match(live.stdout, /deleted:old-external/);
  assert.match(live.stdout, /skipped-reparse:old-nested-link/);
  assert.match(live.stdout, /skipped-reparse:root-link/);
  const names = await readdir(runs);
  for (const gone of ['old-ok', 'old-failed', 'old-external']) assert.ok(!names.includes(gone));
  for (const kept of ['mid-ok', 'recent-ok', 'old-unknown', 'mismatch', 'old-nested-link', 'root-link', 'loose.txt']) assert.ok(names.includes(kept), names.join(','));
  assert.equal(await readFile(secret, 'utf8'), 'keep-secret');
  assert.equal(await readFile(marker, 'utf8'), 'keep-marker');
  assert.equal(await readFile(sessionFile, 'utf8'), 'keep-session');
  assert.equal(await readFile(path.join(runs, 'loose.txt'), 'utf8'), 'keep-loose');
  const linkStat = await lstat(path.join(runs, 'root-link'));
  assert.ok(linkStat.isSymbolicLink() || linkStat.isDirectory());
  assert.ok((await lstat(runs)).isDirectory());

  const refusedSessions = runPrune(sessions, sessions);
  assert.notEqual(refusedSessions.status, 0);
  assert.match(refusedSessions.stderr, /Refusing to prune/);
  assert.equal(await readFile(sessionFile, 'utf8'), 'keep-session');

  const linkRoot = path.join(c.dir, 'link-root');
  const realRoot = path.join(c.dir, 'real-root');
  await mkdir(realRoot);
  await writeFile(path.join(realRoot, 'marker.txt'), 'keep-root');
  await symlink(realRoot, linkRoot, 'junction');
  const refusedLink = runPrune(linkRoot, sessions);
  assert.notEqual(refusedLink.status, 0);
  assert.match(refusedLink.stderr, /reparse-point/);
  assert.equal(await readFile(path.join(realRoot, 'marker.txt'), 'utf8'), 'keep-root');

  await makeRun('two-days', { ended: iso(2) });
  const young = await makeRun('hours', { ended: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const custom = runPrune(runs, sessions, { days: 1 });
  assert.equal(custom.status, 0, custom.stderr || custom.stdout);
  assert.match(custom.stdout, /deleted:two-days/);
  assert.doesNotMatch(custom.stdout, /deleted:hours/);
  assert.ok(!(await readdir(runs)).includes('two-days'));
  assert.equal(await readFile(path.join(young, 'note.txt'), 'utf8'), 'evidence');
  assert.equal(await readFile(secret, 'utf8'), 'keep-secret');
});

winTest('prune refuses a drive root instead of the current directory', async () => {
  const c = await setup('drive-root');
  const cwd = path.join(c.dir, 'current');
  const sessions = path.join(c.dir, 'sessions');
  await mkdir(path.join(cwd, 'old-ok'), { recursive: true });
  await mkdir(sessions);
  const ended = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  await writeFile(path.join(cwd, 'old-ok', 'manifest.json'), JSON.stringify({
    schema_version: 1, run_id: 'old-ok', ended_at: ended,
  }));
  await writeFile(path.join(cwd, 'old-ok', 'status.jsonl'), '{"v":1,"status":"started"}\n{"v":1,"status":"completed"}\n');
  await writeFile(path.join(cwd, 'old-ok', 'note.txt'), 'keep-me');
  const drive = path.parse(cwd).root;
  const refused = runPrune(drive, sessions, { cwd });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to prune a filesystem root/);
  assert.doesNotMatch(refused.stdout, /deleted:old-ok/);
  assert.equal(await readFile(path.join(cwd, 'old-ok', 'note.txt'), 'utf8'), 'keep-me');
});

winTest('prune refuses runs roots beneath junction ancestors without touching the target', async () => {
  const c = await setup('ancestor-junction');
  const outside = path.join(c.dir, 'outside');
  const sessions = path.join(c.dir, 'sessions');
  const targetRun = path.join(outside, 'nested', 'runs', 'old-run');
  await mkdir(targetRun, { recursive: true });
  await mkdir(sessions);
  await writeFile(path.join(targetRun, 'manifest.json'), JSON.stringify({
    schema_version: 1, run_id: 'old-run',
    ended_at: new Date(Date.now() - 40 * 86400000).toISOString(),
  }));
  await writeFile(path.join(targetRun, 'status.jsonl'), '{"status":"completed"}\n');
  await writeFile(path.join(targetRun, 'marker.txt'), 'must survive');
  const junction = path.join(c.dir, 'alias');
  await symlink(outside, junction, 'junction');
  const refused = runPrune(path.join(junction, 'nested', 'runs'), sessions);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /reparse-point runs root or ancestor/);
  assert.doesNotMatch(refused.stdout, /deleted:/);
  assert.equal(await readFile(path.join(targetRun, 'marker.txt'), 'utf8'), 'must survive');
});
