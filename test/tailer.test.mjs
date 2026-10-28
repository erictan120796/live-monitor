import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, appendFile, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTailer } from '../src/tailer.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  return null;
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-monitor-tail-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('keeps a partial line until newline, strips CR and BOM', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a\r\n')]));
    const lines = [];
    const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 40, useWatch: false });
    await tail.start();
    assert.deepEqual(lines, ['a']);
    await appendFile(file, 'par');
    await tail.pump();
    assert.deepEqual(lines, ['a']);
    await appendFile(file, 'tial\r\n');
    await tail.pump();
    assert.deepEqual(lines, ['a', 'partial']);
    tail.stop();
  });
});

test('joins a UTF-8 character split across reads', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, Buffer.from([0xE4, 0xBD]));
    const lines = [];
    const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 0, useWatch: false });
    await tail.start();
    assert.deepEqual(lines, []);
    await appendFile(file, Buffer.from([0xA0, 0x0A]));
    await tail.pump();
    assert.deepEqual(lines, ['你']);
    tail.stop();
  });
});

test('resets when the file shrinks', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, 'hello world\n');
    const lines = [];
    const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 40, useWatch: false });
    await tail.start();
    assert.deepEqual(lines, ['hello world']);
    await writeFile(file, 'x\n');
    await tail.pump();
    assert.deepEqual(lines, ['hello world', 'x']);
    tail.stop();
  });
});

test('poll sees an append without fs.watch', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, '');
    const lines = [];
    const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 40, useWatch: false });
    await tail.start();
    await appendFile(file, 'polled\n');
    const seen = await waitFor(() => lines.includes('polled'));
    tail.stop();
    assert.equal(seen, true);
  });
});

test('fs.watch sees an append without polling', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, '');
    const lines = [];
    const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 0, useWatch: true });
    await tail.start();
    await appendFile(file, 'watched\n');
    const seen = await waitFor(() => lines.includes('watched'), 2000);
    tail.stop();
    assert.equal(seen, true);
  });
});

test('retries EBUSY, EPERM and EACCES before reading', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'out.txt');
    await writeFile(file, 'secret\n');
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let attempts = 0;
      const lines = [];
      const tail = createTailer(file, {
        onLine: line => lines.push(line),
        pollMs: 0,
        useWatch: false,
        async openFile(target) {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error(code);
            error.code = code;
            throw error;
          }
          return open(target, 'r');
        },
      });
      await tail.start();
      tail.stop();
      assert.equal(attempts, 3, code);
      assert.deepEqual(lines, ['secret']);
    }
  });
});

test('retries a real exclusive lock and reads after it clears', async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'locked.txt');
    const ready = path.join(dir, 'ready.txt');
    await writeFile(file, 'secret\n');
    const command = `$fs = [System.IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'None'); Set-Content -LiteralPath '${ready.replaceAll("'", "''")}' -Value 1; Start-Sleep -Milliseconds 500; $fs.Dispose()`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    try {
      const locked = await waitFor(async () => {
        try {
          await readFile(ready);
          return true;
        } catch {
          return false;
        }
      }, 2000);
      assert.equal(locked, true);
      const lines = [];
      const tail = createTailer(file, { onLine: line => lines.push(line), pollMs: 0, useWatch: false });
      await tail.start();
      assert.deepEqual(lines, []);
      await sleep(700);
      await tail.pump();
      tail.stop();
      assert.deepEqual(lines, ['secret']);
    } finally {
      ps.kill();
      await new Promise(resolve => {
        if (ps.exitCode != null || ps.signalCode != null) resolve();
        else ps.once('exit', resolve);
      });
    }
  });
});
