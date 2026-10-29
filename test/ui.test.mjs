import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
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
      assert.match(body, /Cursor usage/);
      assert.match(body, /Check remaining on Cursor/);
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

const DASH = '\u2013';
const VOID = new Set(['meta', 'link', 'img', 'br', 'input', 'hr', 'source', 'wbr']);

class ClassList {
  constructor(el) { this.el = el; }
  add(...names) {
    const set = new Set(this.el.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.el.className = [...set].join(' ');
  }
  remove(...names) {
    const drop = new Set(names);
    this.el.className = this.el.className.split(/\s+/).filter(name => name && !drop.has(name)).join(' ');
  }
  contains(name) { return this.el.className.split(/\s+/).includes(name); }
}

class DomNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this._className = '';
    this._text = '';
    this.classList = new ClassList(this);
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.listeners = {};
    this.fragment = tag === '#fragment';
    this.dataset = new Proxy(this, {
      get(node, prop) {
        if (typeof prop !== 'string') return undefined;
        return node.attrs[attrName(prop)];
      },
      set(node, prop, value) {
        node.attrs[attrName(prop)] = String(value);
        return true;
      },
      deleteProperty(node, prop) {
        delete node.attrs[attrName(prop)];
        return true;
      },
    });
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value ?? ''); }
  get textContent() {
    if (!this.children.length) return this._text;
    return this.children.map(child => child.textContent ?? '').join('');
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else this.attrs[name] = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  append(...nodes) {
    for (const node of nodes) this.adopt(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const node of nodes) this.adopt(node);
  }
  adopt(node) {
    if (!node) return;
    if (node.fragment) {
      const kids = node.children.splice(0);
      for (const child of kids) {
        child.parent = this;
        this.children.push(child);
      }
      return;
    }
    node.parent = this;
    this.children.push(node);
  }
  querySelector(selector) { return queryAll(this, selector)[0] ?? null; }
  querySelectorAll(selector) { return queryAll(this, selector); }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  matches(selector) { return matchesSelector(this, selector); }
}

function attrName(prop) {
  return `data-${prop.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
}

function matchSimple(node, selector) {
  if (!node || node.fragment || node.tag === '#text' || node.tag === '#document') return false;
  if (selector.startsWith('#')) return node.attrs.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    if (!Object.prototype.hasOwnProperty.call(node.attrs, attr[1])) return false;
    return attr[2] === undefined || node.attrs[attr[1]] === attr[2];
  }
  return node.tag === selector;
}

function matchesSelector(node, selector) {
  const parts = selector.trim().split(/\s+/);
  const last = parts.pop();
  if (!matchSimple(node, last)) return false;
  let ancestor = node.parent;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    while (ancestor && !matchSimple(ancestor, parts[i])) ancestor = ancestor.parent;
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function queryAll(root, selector) {
  const parts = selector.trim().split(/\s+/);
  let current = [root];
  for (const part of parts) {
    const next = [];
    for (const base of current) {
      for (const child of base.children || []) {
        walk(child, node => {
          if (matchSimple(node, part)) next.push(node);
        });
      }
    }
    current = next;
  }
  return current;
}

function parseAttrs(node, raw) {
  const re = /([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name === 'class') node.className = value;
    else node.attrs[name] = value;
    if (name === 'hidden') node.hidden = true;
  }
}

function parseHtml(html) {
  const root = new DomNode('#document');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)>|<([A-Za-z][\w:-]*)([^>]*?)(\/?)>|([^<]+)|</g;
  let match;
  while ((match = re.exec(html))) {
    if (match[0].startsWith('<!--') || match[0] === '<') continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (match[2]) {
      const node = new DomNode(match[2].toLowerCase());
      parseAttrs(node, match[3] || '');
      stack[stack.length - 1].append(node);
      const self = VOID.has(node.tag) || match[4] === '/';
      if (!self) stack.push(node);
      continue;
    }
    if (match[5] && match[5].trim()) {
      const text = new DomNode('#text');
      text._text = match[5].replace(/\s+/g, ' ').trim();
      text.textContent = text._text;
      stack[stack.length - 1].append(text);
    }
  }
  root.getElementById = id => {
    let found = null;
    walk(root, node => {
      if (!found && node.attrs?.id === id) found = node;
    });
    return found;
  };
  root.createElement = tag => new DomNode(String(tag).toLowerCase());
  root.createElementNS = (_ns, tag) => new DomNode(String(tag).toLowerCase());
  root.createDocumentFragment = () => new DomNode('#fragment');
  return root;
}

function fireClick(node) {
  const event = { target: node };
  let current = node;
  while (current) {
    for (const fn of current.listeners?.click || []) fn(event);
    current = current.parent;
  }
}

function cell(document, bucket, field) {
  const row = document.querySelector(`#cursor-usage [data-bucket="${bucket}"]`);
  return row.querySelector(`[data-field="${field}"]`).textContent;
}

function usageSnapshot(runs) {
  return {
    runs,
    cursor_usage: {
      timezone: 'Asia/Kuala_Lumpur',
      today: { run_count: 1, input_tokens: 11, output_tokens: 2, cached_input_tokens: 0, total_tokens: 13 },
      last_7_days: { run_count: 2, input_tokens: 20, output_tokens: 4, cached_input_tokens: null, total_tokens: 24 },
      this_month: { run_count: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 },
    },
  };
}

function runRecord(id, agent, taskId, started, tokens) {
  return {
    run_id: id,
    task_id: taskId,
    attempt: 1,
    agent,
    phase: agent === 'codex' ? 'design' : 'code',
    status: 'completed',
    model: agent === 'codex' ? 'gpt-5' : 'grok',
    timings: { started_at: started, ended_at: started },
    tokens,
    output_tail: [],
    output_seq: [],
  };
}

test('cursor usage section stays visible, independent of selection, and links to the dashboard', async () => {
  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicDir, 'style.css'), 'utf8');
  const js = await readFile(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /<h3>Cursor usage<\/h3>/);
  assert.match(html, /MYT \(UTC\+8\)/);
  assert.match(html, /<th scope="row">Today<\/th>/);
  assert.match(html, /<th scope="row">Last 7 days<\/th>/);
  assert.match(html, /<th scope="row">This month<\/th>/);
  assert.match(html, /<th scope="col">Input<\/th>/);
  assert.match(html, /<th scope="col">Output<\/th>/);
  assert.match(html, /<th scope="col">Cached<\/th>/);
  assert.match(html, /<th scope="col">Total<\/th>/);
  assert.match(html, /id="cursor-dashboard" href="https:\/\/cursor.com\/dashboard" target="_blank" rel="noopener"/);
  assert.equal(html.includes('allowance'), false);
  assert.match(css, /#token-panel\[data-state="empty"\] #cursor-usage/);
  assert.match(css, /#token-panel\[data-state="unavailable"\] #cursor-usage/);
  assert.match(js, /addEventListener\('cursor_usage'/);
  assert.match(js, /requestSnapshot\(\)/);
  assert.equal(js.includes('innerHTML'), false);

  const document = parseHtml(html);
  const link = document.getElementById('cursor-dashboard');
  assert.equal(link.getAttribute('href'), 'https://cursor.com/dashboard');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener');
  assert.equal(link.textContent, 'Check remaining on Cursor');
  assert.equal(document.querySelector('#cursor-usage input'), null);
  assert.equal(document.getElementById('cursor-usage').hidden, false);

  const state = {
    body: { runs: [], cursor_usage: null },
    fetches: 0,
  };
  let releaseFetch;
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const bridge = { source: null };
  class EventSource {
    static OPEN = 1;
    static CLOSED = 2;
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      bridge.source = this;
      queueMicrotask(() => {
        this.readyState = EventSource.OPEN;
        this.onopen?.();
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
  }
  const context = vm.createContext({
    document,
    EventSource,
    fetch: async () => {
      state.fetches += 1;
      await gate;
      return { ok: true, status: 200, json: async () => state.body };
    },
    setTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    console,
    URL,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    Promise,
  });
  vm.runInContext(js, context, { filename: 'app.js' });
  assert.equal(cell(document, 'today', 'total'), DASH);
  assert.equal(cell(document, 'last_7_days', 'cached'), DASH);
  assert.equal(cell(document, 'this_month', 'input'), DASH);
  assert.equal(document.getElementById('token-panel').dataset.state, 'empty');
  assert.equal(document.getElementById('cursor-usage').hidden, false);

  state.body = {
    runs: [],
    cursor_usage: {
      timezone: 'Asia/Kuala_Lumpur',
      today: { run_count: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 },
      last_7_days: { run_count: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 },
      this_month: { run_count: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 },
    },
  };
  releaseFetch();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cell(document, 'today', 'input'), '0');
  assert.equal(cell(document, 'today', 'cached'), '0');
  assert.equal(cell(document, 'this_month', 'total'), '0');
  assert.equal(document.getElementById('cursor-usage').textContent.includes('Cursor usage'), true);
  assert.equal(document.getElementById('cursor-usage').textContent.includes('MYT (UTC+8)'), true);

  const codex = runRecord('codex-1', 'codex', 'task-codex', '2026-11-15T01:00:00.000Z', {
    available: true,
    input_tokens: 5,
    output_tokens: 1,
    cached_input_tokens: 0,
    total_tokens: 6,
    rate_limits: { primary: { used_percent: 1 }, secondary: { used_percent: 2 } },
  });
  const cursor = runRecord('cursor-1', 'cursor', 'task-cursor', '2026-11-15T02:00:00.000Z', {
    available: false,
    reason: 'unavailable',
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    total_tokens: null,
    rate_limits: null,
  });
  state.body = usageSnapshot([codex, cursor]);
  const fetches = state.fetches;
  bridge.source.emit('cursor_usage', { ts: '2026-11-15T04:00:00.000Z' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(state.fetches > fetches);
  assert.equal(document.getElementById('token-panel').dataset.state, 'unavailable');
  assert.equal(cell(document, 'today', 'input'), '11');
  assert.equal(cell(document, 'today', 'cached'), '0');
  assert.equal(cell(document, 'last_7_days', 'cached'), DASH);
  assert.equal(cell(document, 'last_7_days', 'total'), '24');
  assert.equal(cell(document, 'this_month', 'input'), '0');
  const beforeSelect = ['today', 'last_7_days', 'this_month'].map(bucket => ['input', 'output', 'cached', 'total'].map(field => cell(document, bucket, field)));
  const codexButton = [...document.getElementById('task-list').children].find(node => node.dataset.taskKey === 'task:task-codex');
  fireClick(codexButton);
  assert.equal(document.getElementById('token-panel').dataset.state, 'available');
  assert.equal(document.getElementById('token-input').textContent.includes('5'), true);
  const cursorButton = [...document.getElementById('task-list').children].find(node => node.dataset.taskKey === 'task:task-cursor');
  fireClick(cursorButton);
  assert.equal(document.getElementById('token-panel').dataset.state, 'unavailable');
  assert.equal(document.getElementById('token-input').textContent, DASH);
  const afterSelect = ['today', 'last_7_days', 'this_month'].map(bucket => ['input', 'output', 'cached', 'total'].map(field => cell(document, bucket, field)));
  assert.deepEqual(afterSelect, beforeSelect);
  assert.equal(document.getElementById('cursor-usage').hidden, false);
  assert.equal(document.getElementById('cursor-usage').parent.attrs.id, 'token-panel');
});
