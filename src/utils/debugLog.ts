type DebugPayload = Record<string, unknown> | undefined;

const CLIENT_ID_KEY = 'uieditor_debug_client_id';

function clientId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = window.localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function safePayload(payload: DebugPayload): DebugPayload {
  if (!payload) return undefined;
  try {
    return JSON.parse(JSON.stringify(payload)) as DebugPayload;
  } catch {
    return { unserializable: true };
  }
}

export function debugLog(channel: string, event: string, payload?: DebugPayload) {
  const item = {
    channel,
    event,
    payload: safePayload(payload),
    clientId: clientId(),
    at: new Date().toISOString(),
    perfMs: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
  };

  console.log(`[uieditor:${channel}] ${event}`, item.payload ?? {});

  if (typeof fetch !== 'function') return;
  void fetch('/api/uieditor-debug/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
    keepalive: true,
  }).catch(() => undefined);
}
