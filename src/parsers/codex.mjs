function parseJson(line) {
  const text = String(line).replace(/^\uFEFF/, '').replace(/\r$/, '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseCodexLine(line) {
  const event = parseJson(line);
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'thread.started') {
    return {
      agent: 'codex',
      kind: 'thread.started',
      type: event.type,
      thread_id: typeof event.thread_id === 'string' ? event.thread_id : null,
    };
  }
  if (event.type.startsWith('item.')) {
    const item = event.item && typeof event.item === 'object' ? event.item : {};
    return {
      agent: 'codex',
      kind: 'item',
      type: event.type,
      phase: event.type.slice('item.'.length),
      item_id: item.id ?? null,
      item_type: typeof item.type === 'string' ? item.type : null,
      text: typeof item.text === 'string' ? item.text : null,
      command: typeof item.command === 'string' ? item.command : null,
      aggregated_output: typeof item.aggregated_output === 'string' ? item.aggregated_output : null,
      exit_code: item.exit_code ?? null,
      status: typeof item.status === 'string' ? item.status : null,
    };
  }
  if (event.type === 'turn.completed') {
    return {
      agent: 'codex',
      kind: 'turn.completed',
      type: event.type,
      usage: event.usage && typeof event.usage === 'object' ? event.usage : null,
    };
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    const message = typeof event.message === 'string'
      ? event.message
      : typeof event.error?.message === 'string'
        ? event.error.message
        : null;
    return { agent: 'codex', kind: event.type, type: event.type, message };
  }
  return { agent: 'codex', kind: 'other', type: event.type };
}
