import { watch } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const CHUNK = 64 * 1024;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withFileRetry(fn) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!RETRYABLE.has(err?.code)) throw err;
      await delay(25);
    }
  }
  const error = last ?? new Error('file retry exhausted');
  error.retryExhausted = true;
  throw error;
}

function sameName(filePath, filename) {
  if (!filename) return true;
  const base = path.basename(filePath);
  const seen = String(filename);
  return process.platform === 'win32' ? seen.toLowerCase() === base.toLowerCase() : seen === base;
}

export function createTailer(filePath, { onLine = () => {}, onError = () => {}, pollMs = 500, useWatch = true, openFile = file => open(file, 'r') } = {}) {
  const state = {
    offset: 0,
    pending: '',
    decoder: new StringDecoder('utf8'),
    checkedBom: false,
    stopped: false,
    pumping: false,
    queued: false,
    dirWatcher: null,
    fileWatcher: null,
    timer: null,
  };

  function reset() {
    state.offset = 0;
    state.pending = '';
    state.decoder = new StringDecoder('utf8');
    state.checkedBom = false;
  }

  function consume(text) {
    if (!text) return;
    if (!state.checkedBom) {
      state.checkedBom = true;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    }
    state.pending += text;
    let newline = state.pending.indexOf('\n');
    while (newline !== -1) {
      let line = state.pending.slice(0, newline);
      state.pending = state.pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      if (line.length) onLine(line);
      newline = state.pending.indexOf('\n');
    }
  }

  async function readNew() {
    let info;
    try {
      info = await withFileRetry(() => stat(filePath));
    } catch (err) {
      if (err?.code === 'ENOENT') return 'missing';
      if (err?.retryExhausted) return 'locked';
      throw err;
    }
    if (info.size < state.offset) reset();
    if (info.size === state.offset) return 'ok';

    let handle;
    try {
      handle = await withFileRetry(() => openFile(filePath));
    } catch (err) {
      if (err?.code === 'ENOENT') return 'missing';
      if (err?.retryExhausted) return 'locked';
      throw err;
    }
    try {
      const buf = Buffer.alloc(CHUNK);
      while (!state.stopped && state.offset < info.size) {
        const length = Math.min(CHUNK, info.size - state.offset);
        let bytesRead = 0;
        try {
          ({ bytesRead } = await withFileRetry(() => handle.read(buf, 0, length, state.offset)));
        } catch (err) {
          if (err?.retryExhausted) return 'locked';
          throw err;
        }
        if (bytesRead === 0) {
          try {
            info = await withFileRetry(() => stat(filePath));
          } catch (err) {
            if (err?.code === 'ENOENT') return 'missing';
            if (err?.retryExhausted) return 'locked';
            throw err;
          }
          if (info.size < state.offset) {
            reset();
            continue;
          }
          return 'ok';
        }
        state.offset += bytesRead;
        consume(state.decoder.write(buf.subarray(0, bytesRead)));
        if (state.offset >= info.size) {
          try {
            info = await withFileRetry(() => stat(filePath));
          } catch (err) {
            if (err?.code === 'ENOENT') return 'missing';
            if (err?.retryExhausted) return 'locked';
            throw err;
          }
          if (info.size < state.offset) reset();
        }
      }
    } finally {
      await handle.close();
    }
    return 'ok';
  }

  async function pump() {
    if (state.stopped) return;
    if (state.pumping) {
      state.queued = true;
      return;
    }
    state.pumping = true;
    try {
      do {
        state.queued = false;
        const result = await readNew();
        if (result === 'locked') break;
      } while (state.queued && !state.stopped);
    } catch (err) {
      onError(err);
    } finally {
      state.pumping = false;
    }
  }

  function openWatch(current, target, listener) {
    if (current || state.stopped || !useWatch) return current ?? null;
    try {
      const watcher = watch(target, { persistent: false }, listener);
      watcher.on('error', () => {
        watcher.close();
        if (state.dirWatcher === watcher) state.dirWatcher = null;
        if (state.fileWatcher === watcher) state.fileWatcher = null;
      });
      return watcher;
    } catch {
      return null;
    }
  }

  function ensureWatch() {
    if (state.stopped || !useWatch) return;
    state.dirWatcher = openWatch(state.dirWatcher, path.dirname(filePath), (_event, filename) => {
      if (sameName(filePath, filename)) void pump();
    });
    state.fileWatcher = openWatch(state.fileWatcher, filePath, () => { void pump(); });
  }

  function start() {
    ensureWatch();
    if (pollMs > 0 && !state.timer) {
      state.timer = setInterval(() => {
        ensureWatch();
        void pump();
      }, pollMs);
      state.timer.unref?.();
    }
    return pump();
  }

  function stop() {
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.dirWatcher?.close();
    state.fileWatcher?.close();
    state.dirWatcher = null;
    state.fileWatcher = null;
  }

  return { start, stop, pump };
}
