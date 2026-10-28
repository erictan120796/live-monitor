import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMonitor } from '../src/server.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const regions = ['header', 'sidebar', 'timeline', 'agent', 'output', 'tokens'];

async function withServer(options, fn) {
  const monitor = await startMonitor({ port: 0, pollMs: 40, heartbeatMs: 1000, ...options });
  try {
    await fn(monitor);
  } finally {
    await monitor.close();
  }
}

test('index.html contains the layout regions and the server serves it', async () => {
  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const js = await readFile(path.join(publicDir, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicDir, 'style.css'), 'utf8');
  for (const region of regions) {
    assert.match(html, new RegExp(`data-region="${region}"`));
  }
  assert.match(html, /Design \(GPT\)/);
  assert.match(html, /Code \(Cursor\)/);
  assert.match(html, /Review \(GPT\)/);
  assert.match(html, />Fix</);
  assert.match(html, /href="\/style\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /id="live-output"/);
  assert.match(js, /textContent/);
  assert.equal(js.includes('innerHTML'), false);
  assert.match(css, /grid-template-areas/);

  const root = await mkdtemp(path.join(tmpdir(), 'live-monitor-ui-'));
  const runs = path.join(root, 'runs');
  await mkdir(runs);
  try {
    await withServer({ runsRoot: runs, sessionsRoot: path.join(root, 'sessions') }, async monitor => {
      const page = await fetch(`${monitor.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const body = await page.text();
      for (const region of regions) assert.match(body, new RegExp(`data-region="${region}"`));
      assert.match(body, /Live output/);
      assert.match(body, /Current agent/);
      const script = await fetch(`${monitor.url}/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      const style = await fetch(`${monitor.url}/style.css`);
      assert.equal(style.status, 200);
      assert.match(style.headers.get('content-type'), /text\/css/);
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
