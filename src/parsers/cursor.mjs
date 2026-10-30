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

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.length ? parts.join('') : null;
}

function toolName(event) {
  const call = event.tool_call;
  if (typeof event.name === 'string') return event.name;
  if (!call || typeof call !== 'object') return null;
  if (typeof call.name === 'string') return call.name;
  const key = Object.keys(call).find(name => call[name] && typeof call[name] === 'object');
  if (!key) return null;
  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}

export function parseCursorLine(line) {
  const event = parseJson(line);
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'system' && event.subtype === 'init') {
    return {
      agent: 'cursor',
      kind: 'system_init',
      type: event.type,
      subtype: 'init',
      session_id: typeof event.session_id === 'string' ? event.session_id : null,
      model: typeof event.model === 'string' ? event.model : null,
    };
  }
  if (event.type === 'assistant') {
    const partial = event.timestamp_ms != null && event.model_call_id == null;
    return {
      agent: 'cursor',
      kind: partial ? 'assistant_partial' : 'assistant',
      type: event.type,
      partial,
      timestamp_ms: event.timestamp_ms ?? null,
      model_call_id: event.model_call_id ?? null,
      text: messageText(event.message),
    };
  }
  if (event.type === 'tool_call') {
    return {
      agent: 'cursor',
      kind: 'tool_call',
      type: event.type,
      subtype: typeof event.subtype === 'string' ? event.subtype : null,
      name: toolName(event),
      call_id: typeof event.call_id === 'string' ? event.call_id : null,
    };
  }
  if (event.type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    return {
      agent: 'cursor',
      kind: 'result',
      type: event.type,
      subtype,
      is_error: event.is_error === true || (subtype != null && subtype.startsWith('error')),
      raw_is_error: event.is_error,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
      text: typeof event.result === 'string' ? event.result : null,
      session_id: typeof event.session_id === 'string' ? event.session_id : null,
    };
  }
  return { agent: 'cursor', kind: 'other', type: event.type };
}
