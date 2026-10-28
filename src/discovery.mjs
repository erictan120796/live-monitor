import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function defaultRunsRoot() {
  return process.env.LIVE_MONITOR_RUNS || path.join(homedir(), '.orchestrator', 'runs');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readManifest(file) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const text = await readFile(file, 'utf8');
      const manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
      if (!manifest.run_id || !manifest.agent) return null;
      return manifest;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      if (err instanceof SyntaxError) return null;
      if (RETRYABLE.has(err?.code) && attempt < 5) {
        await delay(25);
        continue;
      }
      if (RETRYABLE.has(err?.code)) return null;
      throw err;
    }
  }
  return null;
}

export async function discoverRuns(runsRoot) {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(runsRoot, entry.name);
    const manifest = await readManifest(path.join(dir, 'manifest.json'));
    if (!manifest) continue;
    runs.push({ dir, manifest });
  }
  return runs;
}
