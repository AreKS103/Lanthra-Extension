// native-bridge.ts — Manages the single persistent chrome.runtime.connectNative port.
//
// Design:
//   - One shared port to 'com.lanthra.host', lazily created on first prompt.
//   - Reconnects automatically if the host crashes between sessions.
//   - Incoming messages are dispatched to registered session listeners via id.
//   - Outgoing messages are queued if the port is momentarily reconnecting.

import type { NativeOutbound, NativeInbound } from '../types/messages';
import { log }                                 from '../shared/logger';

const HOST_NAME = 'com.lanthra.host';

type TokenListener    = (token: string) => void;
type StreamEndListener = () => void;
type ErrorListener    = (error: string) => void;

interface SessionListeners {
  onToken:     TokenListener;
  onStreamEnd: StreamEndListener;
  onError:     ErrorListener;
}

let port:         chrome.runtime.Port | null = null;
let sendQueue:    NativeOutbound[]           = [];
const listeners:  Map<string, SessionListeners> = new Map();

function getPort(): chrome.runtime.Port {
  if (port) return port;

  log('info', 'connecting to native host', { name: HOST_NAME });
  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((msg: NativeInbound) => {
    const listener = listeners.get(msg.id);
    if (!listener) {
      log('warn', `native message for unknown session: ${msg.id}`);
      return;
    }
    switch (msg.type) {
      case 'token':      listener.onToken(msg.token); break;
      case 'stream_end': listener.onStreamEnd();       break;
      case 'error':      listener.onError(msg.error);  break;
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? 'Native host disconnected';
    log('warn', 'native port disconnected', { err });
    port = null;
    // Notify all pending sessions of the disconnect
    for (const [, l] of listeners) l.onError(err);
    listeners.clear();
  });

  // Flush anything that was queued before the port was ready
  for (const msg of sendQueue) sendNative(msg);
  sendQueue = [];

  return port;
}

function sendNative(msg: NativeOutbound): void {
  if (!port) {
    sendQueue.push(msg);
    getPort(); // trigger connection + flush
    return;
  }
  port.postMessage(msg);
}

export function registerSession(
  sessionId: string,
  listeners: SessionListeners,
): void {
  (listeners as SessionListeners & { sessionId: string });
  // Store using module-level map
  registerListeners(sessionId, listeners);
  // Ensure port is alive
  getPort();
}

export function sendPrompt(
  sessionId: string,
  prompt:    string,
  context:   string,
): void {
  sendNative({
    id:      sessionId,
    type:    'prompt',
    prompt,
    context,
    model:   'llama-3.3-70b-versatile',
  });
}

export function sendCancel(sessionId: string): void {
  sendNative({ id: sessionId, type: 'cancel' });
  listeners.delete(sessionId);
}

export function unregisterSession(sessionId: string): void {
  listeners.delete(sessionId);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function registerListeners(id: string, l: SessionListeners): void {
  listeners.set(id, l);
}
