import { createServer } from 'node:http';
import { realpathSync, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverRuns, defaultRunsRoot } from './discovery.mjs';
import { createTailer } from './tailer.mjs';
import { parseCodexLine } from './parsers/codex.mjs';
import { parseCursorLine } from './parsers/cursor.mjs';
import {
  applySessionTokenCount,
  applyTurnCompleted,
  createTokenState,
  defaultSessionsRoot,
  findSessionFile,
  projectTokens,
  tokenCountFromLine,
} from './usage.mjs';

const TAIL_LIMIT = 200;
const HOST = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function resolvePort(port) {
  const value = port === undefined ? process.env.PORT : port;
  if (value === undefined || value === '') return 5180;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

export function defaultPublicDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
}

function parseStatus(line) {
  try {
    const record = JSON.parse(line);
    if (!record || typeof record !== 'object' || typeof record.status !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

function allocSeq(state) {
  const seq = state.nextSeq;
  state.nextSeq += 1;
  return seq;
}

function pushChunk(state, text) {
  const seq = allocSeq(state);
  state.tail.push(text);
  state.seqs.push(seq);
  return seq;
}

function pushLines(state, text) {
  state.openPartial = false;
  if (text == null) return null;
  const lines = String(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return null;
  let first = null;
  for (const line of lines) {
    const seq = pushChunk(state, line);
    if (first == null) first = seq;
  }
  trimTail(state);
  return first;
}

function pushPartial(state, text) {
  state.sawPartial = true;
  if (!text) return state.openPartial ? state.seqs[state.seqs.length - 1] ?? null : null;
  let seq;
  if (!state.openPartial) {
    seq = pushChunk(state, '');
    state.openPartial = true;
  } else {
    seq = state.seqs[state.seqs.length - 1];
  }
  state.tail[state.tail.length - 1] += text;
  trimTail(state);
  return seq;
}

function trimTail(state) {
  if (state.tail.length <= TAIL_LIMIT) return;
  const drop = state.tail.length - TAIL_LIMIT;
  state.tail.splice(0, drop);
  state.seqs.splice(0, drop);
}

function codexTailText(state, parsed) {
  if (parsed.kind !== 'item') return null;
  if (parsed.item_type === 'command_execution') {
    const parts = [];
    const seen = parsed.item_id && state.commands.has(parsed.item_id);
    if (parsed.command && !seen && (parsed.phase === 'started' || parsed.phase === 'completed')) {
      parts.push(`$ ${parsed.command}`);
      if (parsed.item_id) state.commands.add(parsed.item_id);
    }
    if ((parsed.phase === 'completed' || parsed.phase === 'updated') && parsed.aggregated_output) {
      parts.push(parsed.aggregated_output.replace(/\s+$/, ''));
    }
    return parts.join('\n') || null;
  }
  if (parsed.phase === 'completed' && parsed.text) return parsed.text;
  return null;
}

function applyOutput(state, parsed, raw) {
  if (!parsed) {
    return { text: null, seq: pushLines(state, raw) };
  }
  if (parsed.agent === 'codex') {
    const text = codexTailText(state, parsed);
    return { text, seq: text ? pushLines(state, text) : null };
  }
  if (parsed.kind === 'assistant_partial') {
    const text = parsed.text ?? '';
    return { text, seq: pushPartial(state, text) };
  }
  if (parsed.kind === 'tool_call' && parsed.subtype === 'started') {
    const text = `tool ${parsed.name ?? 'call'}`;
    return { text, seq: pushLines(state, text) };
  }
  if (parsed.kind === 'result' && parsed.text && !state.sawPartial) {
    const text = parsed.text;
    return { text, seq: pushLines(state, text) };
  }
  if (parsed.kind !== 'assistant_partial') state.openPartial = false;
  return { text: null, seq: null };
}

function blankRun(manifest) {
  return {
    run_id: manifest.run_id,
    task_id: manifest.task_id ?? null,
    attempt: manifest.attempt ?? null,
    agent: manifest.agent,
    requested_model: manifest.requested_model ?? null,
    reported_model: manifest.reported_model ?? null,
    effort: manifest.effort ?? null,
    phase: manifest.phase ?? null,
    status: 'unknown',
    status_reason: null,
    exit_code: manifest.exit_code ?? null,
    thread_id: manifest.thread_id ?? null,
    session_id: manifest.session_id ?? null,
    pid: manifest.pid ?? null,
    native_failure: manifest.native_failure === true,
    started_at: manifest.started_at ?? null,
    ended_at: manifest.ended_at ?? null,
    stdoutPath: manifest.files?.stdout ?? null,
    statusPath: manifest.files?.status ?? null,
    tail: [],
    seqs: [],
    nextSeq: 1,
    openPartial: false,
    sawPartial: false,
    commands: new Set(),
    tokens: createTokenState(manifest.agent),
    stdoutTail: null,
    statusTail: null,
    sessionTail: null,
    sessionStarting: null,
  };
}

function applyManifest(state, manifest) {
  state.task_id = manifest.task_id ?? null;
  state.attempt = manifest.attempt ?? null;
  state.requested_model = manifest.requested_model ?? null;
  if (manifest.reported_model) state.reported_model = manifest.reported_model;
  state.effort = manifest.effort ?? null;
  if (manifest.phase) state.phase = manifest.phase;
  state.pid = manifest.pid ?? null;
  if (manifest.started_at) state.started_at = manifest.started_at;
  if (manifest.thread_id) state.thread_id = manifest.thread_id;
  if (manifest.session_id) state.session_id = manifest.session_id;
  if (manifest.exit_code != null) state.exit_code = manifest.exit_code;
  state.native_failure = manifest.native_failure === true;
  if (manifest.ended_at) state.ended_at = manifest.ended_at;
  state.stdoutPath = manifest.files?.stdout ?? state.stdoutPath;
  state.statusPath = manifest.files?.status ?? state.statusPath;
}

function applyStatus(state, record) {
  state.status = record.status;
  if (record.phase) state.phase = record.phase;
  state.status_reason = record.reason ?? null;
  if (record.exit_code != null) state.exit_code = record.exit_code;
  if ((record.status === 'completed' || record.status === 'failed') && record.ts) {
    state.ended_at = record.ts;
  }
}

function viewRun(state, now) {
  const startedMs = Date.parse(state.started_at ?? '');
  const endedMs = state.ended_at ? Date.parse(state.ended_at) : NaN;
  const duration_ms = Number.isFinite(startedMs)
    ? (Number.isFinite(endedMs) ? endedMs - startedMs : now - startedMs)
    : null;
  return {
    run_id: state.run_id,
    task_id: state.task_id,
    attempt: state.attempt,
    agent: state.agent,
    model: state.reported_model ?? state.requested_model,
    requested_model: state.requested_model,
    reported_model: state.reported_model,
    effort: state.effort,
    phase: state.phase,
    status: state.status,
    status_reason: state.status_reason,
    exit_code: state.exit_code,
    thread_id: state.thread_id,
    session_id: state.session_id,
    pid: state.pid,
    native_failure: state.native_failure,
    timings: {
      started_at: state.started_at,
      ended_at: state.ended_at,
      duration_ms,
    },
    output_tail: state.tail.slice(),
    output_seq: state.seqs.slice(),
    tokens: projectTokens(state.tokens),
  };
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function snapshotBody(ctx) {
  const now = Date.now();
  const runs = [...ctx.runs.values()]
    .map(state => viewRun(state, now))
    .sort((a, b) => String(b.timings.started_at).localeCompare(String(a.timings.started_at)) || String(a.run_id).localeCompare(String(b.run_id)));
  return { runs_root: ctx.runsRoot, generated_at: new Date(now).toISOString(), runs };
}

function resolveStatic(publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^[/\\]+/, '');
  const root = path.resolve(publicDir);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function sendStatic(res, publicDir, urlPath) {
  let filePath = resolveStatic(publicDir, urlPath);
  if (!filePath) {
    writeJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
    if (!info.isFile()) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    const body = await readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    if (err?.code === 'ENOENT') writeJson(res, 404, { error: 'not_found' });
    else throw err;
  }
}

function onStdout(ctx, state, line) {
  if (ctx.closed) return;
  const parsed = state.agent === 'cursor'
    ? parseCursorLine(line)
    : state.agent === 'codex'
      ? parseCodexLine(line)
      : null;
  if (parsed?.kind === 'thread.started' && parsed.thread_id) {
    state.thread_id = parsed.thread_id;
    void ensureSession(ctx, state);
  }
  if (parsed?.kind === 'system_init') {
    if (parsed.session_id) state.session_id = parsed.session_id;
    if (parsed.model) state.reported_model = parsed.model;
  }
  if (parsed?.kind === 'turn.completed') applyTurnCompleted(state.tokens, parsed.usage);
  const produced = applyOutput(state, parsed, line);
  broadcast(ctx, 'stdout', { run_id: state.run_id, line, text: produced.text, seq: produced.seq });
}

function onStatus(ctx, state, line) {
  if (ctx.closed) return;
  const record = parseStatus(line);
  if (!record) return;
  applyStatus(state, record);
  broadcast(ctx, 'status', {
    run_id: state.run_id,
    status: state.status,
    phase: state.phase,
    reason: state.status_reason,
    exit_code: state.exit_code,
  });
}

function onSessionLine(state, line) {
  const snapshot = tokenCountFromLine(line);
  if (snapshot) applySessionTokenCount(state.tokens, snapshot);
}

function attachTail(ctx, state, filePath, onLine) {
  if (!filePath) return null;
  const tail = createTailer(filePath, {
    pollMs: ctx.pollMs,
    onLine,
    onError(err) {
      if (err?.code === 'ENOENT' || err?.retryExhausted) return;
      console.error('tail', err?.code || err?.message);
    },
  });
  return tail;
}

async function ensureSession(ctx, state) {
  if (ctx.closed || state.agent !== 'codex' || !state.thread_id || state.sessionTail) return;
  if (state.sessionStarting) return state.sessionStarting;
  state.sessionStarting = (async () => {
    const file = await findSessionFile(ctx.sessionsRoot, state.thread_id, ctx.sessionIndex);
    if (!file || ctx.closed || state.sessionTail) return;
    const tail = attachTail(ctx, state, file, line => onSessionLine(state, line));
    state.sessionTail = tail;
    await tail.start();
  })().finally(() => {
    state.sessionStarting = null;
  });
  return state.sessionStarting;
}

async function upsert(ctx, found) {
  const { dir, manifest } = found;
  let state = ctx.runs.get(manifest.run_id);
  const created = !state;
  if (!state) {
    state = blankRun(manifest);
    if (!state.stdoutPath) state.stdoutPath = path.join(dir, 'stdout.jsonl');
    if (!state.statusPath) state.statusPath = path.join(dir, 'status.jsonl');
    ctx.runs.set(manifest.run_id, state);
  } else {
    applyManifest(state, manifest);
  }
  if (!state.statusTail && state.statusPath) {
    state.statusTail = attachTail(ctx, state, state.statusPath, line => onStatus(ctx, state, line));
    await state.statusTail.start();
  }
  if (!state.stdoutTail && state.stdoutPath) {
    state.stdoutTail = attachTail(ctx, state, state.stdoutPath, line => onStdout(ctx, state, line));
    await state.stdoutTail.start();
  }
  await ensureSession(ctx, state);
  if (created && !ctx.closed) {
    broadcast(ctx, 'run', { run_id: state.run_id, agent: state.agent, phase: state.phase, status: state.status });
  }
}

async function refresh(ctx) {
  if (ctx.refreshing) {
    ctx.refreshQueued = true;
    return ctx.refreshing;
  }
  ctx.refreshing = (async () => {
    do {
      ctx.refreshQueued = false;
      const found = await discoverRuns(ctx.runsRoot);
      for (const entry of found) await upsert(ctx, entry);
    } while (ctx.refreshQueued && !ctx.closed);
  })().finally(() => {
    ctx.refreshing = null;
  });
  return ctx.refreshing;
}

function broadcast(ctx, event, data) {
  for (const res of ctx.clients) writeSse(res, event, data);
}

function watchRuns(ctx) {
  if (ctx.dirWatch || ctx.closed) return;
  try {
    ctx.dirWatch = watch(ctx.runsRoot, { persistent: false }, () => { void refresh(ctx); });
    ctx.dirWatch.on('error', () => {
      ctx.dirWatch?.close();
      ctx.dirWatch = null;
    });
  } catch {
    ctx.dirWatch = null;
  }
}

async function route(ctx, req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    writeJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const url = new URL(req.url || '/', `http://${HOST}`);
  if (url.pathname === '/api/snapshot') {
    await refresh(ctx);
    for (const state of ctx.runs.values()) {
      await state.stdoutTail?.pump();
      await state.statusTail?.pump();
      await state.sessionTail?.pump();
    }
    writeJson(res, 200, snapshotBody(ctx));
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('\n');
    ctx.clients.add(res);
    writeSse(res, 'heartbeat', { ts: new Date().toISOString() });
    res.on('close', () => ctx.clients.delete(res));
    return;
  }
  let publicExists = false;
  try {
    publicExists = (await stat(ctx.publicDir)).isDirectory();
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (!publicExists) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }
  await sendStatic(res, ctx.publicDir, url.pathname);
}

export function startMonitor({
  runsRoot = defaultRunsRoot(),
  sessionsRoot = defaultSessionsRoot(),
  publicDir = defaultPublicDir(),
  port,
  pollMs = 500,
  heartbeatMs = 15000,
} = {}) {
  const ctx = {
    runsRoot,
    sessionsRoot,
    publicDir,
    pollMs,
    closed: false,
    runs: new Map(),
    clients: new Set(),
    sessionIndex: new Map(),
    refreshing: null,
    refreshQueued: false,
    dirWatch: null,
    pollTimer: null,
    heartTimer: null,
  };
  const server = createServer((req, res) => {
    route(ctx, req, res).catch(err => {
      console.error(err?.code || err?.message || err);
      if (!res.headersSent) writeJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  const listenPort = resolvePort(port);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, HOST, () => {
      server.off('error', reject);
      const address = server.address();
      watchRuns(ctx);
      ctx.pollTimer = setInterval(() => {
        watchRuns(ctx);
        void refresh(ctx);
      }, pollMs);
      ctx.pollTimer.unref?.();
      ctx.heartTimer = setInterval(() => {
        broadcast(ctx, 'heartbeat', { ts: new Date().toISOString() });
      }, heartbeatMs);
      ctx.heartTimer.unref?.();
      void refresh(ctx);
      resolve({
        server,
        host: HOST,
        port: address.port,
        address,
        url: `http://${HOST}:${address.port}`,
        close: () => shutdown(server, ctx),
      });
    });
  });
}

async function shutdown(server, ctx) {
  ctx.closed = true;
  if (ctx.pollTimer) clearInterval(ctx.pollTimer);
  if (ctx.heartTimer) clearInterval(ctx.heartTimer);
  ctx.dirWatch?.close();
  for (const state of ctx.runs.values()) {
    state.stdoutTail?.stop();
    state.statusTail?.stop();
    state.sessionTail?.stop();
  }
  for (const res of ctx.clients) {
    try { res.end(); } catch { /* client already gone */ }
  }
  ctx.clients.clear();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  const monitor = await startMonitor();
  console.log(`live-monitor listening on ${monitor.url}`);
  const stop = () => { monitor.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
