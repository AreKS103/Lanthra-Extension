// ── Shared message type definitions ──────────────────────────────────────────
// Used by: content script ↔ service worker ↔ native host

export type SessionId = string;

// ── Content Script → Service Worker ─────────────────────────────────────────

export type CSMessage =
  | { type: 'LANTHRA_PROMPT_SUBMIT'; sessionId: SessionId; prompt: string; context: string }
  | { type: 'LANTHRA_CANCEL';        sessionId: SessionId }
  | { type: 'LANTHRA_PING' };

// ── Service Worker → Content Script ─────────────────────────────────────────

export type SWMessage =
  | { type: 'LANTHRA_TOKEN';      sessionId: SessionId; token: string }
  | { type: 'LANTHRA_STREAM_END'; sessionId: SessionId }
  | { type: 'LANTHRA_ERROR';      sessionId: SessionId; error: string }
  | { type: 'LANTHRA_TOGGLE_ACK'; armed: boolean };

// ── Service Worker → Background Command (from chrome.commands) ───────────────

export type BGCommand =
  | { type: 'LANTHRA_TOGGLE' };

// ── Native Host protocol (stdin/stdout, length-prefixed JSON) ────────────────

export interface NativePromptRequest {
  id:    string;
  type:  'prompt';
  prompt:  string;
  context: string;
  model:   string;
}

export interface NativeCancelRequest {
  id:   string;
  type: 'cancel';
}

export type NativeOutbound = NativePromptRequest | NativeCancelRequest;

export type NativeInbound =
  | { id: string; type: 'token';      token: string }
  | { id: string; type: 'stream_end' }
  | { id: string; type: 'error';      error: string };

// ── Port names ───────────────────────────────────────────────────────────────

export const PORT_SESSION_PREFIX = 'lanthra:session:';
