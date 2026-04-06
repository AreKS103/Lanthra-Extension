// ── Shared message type definitions ──────────────────────────────────────────
// Used by: content script ↔ service worker ↔ side panel

export type SessionId = string;

// ── Content Script → Service Worker ─────────────────────────────────────────

export type CSMessage =
  | { type: 'LANTHRA_PROMPT_SUBMIT'; sessionId: SessionId; prompt: string; context: string;
      imageUrl?: string; imageBase64?: string; imageMediaType?: string; imageOnly?: boolean }
  | { type: 'LANTHRA_CANCEL';        sessionId: SessionId }
  | { type: 'LANTHRA_PING' }
  | { type: 'LANTHRA_TOOL_RESULT';   id: string; result: string };

// ── Service Worker → Content Script ─────────────────────────────────────────

export type SWMessage =
  | { type: 'LANTHRA_TOKEN';      sessionId: SessionId; token: string }
  | { type: 'LANTHRA_STREAM_END'; sessionId: SessionId }
  | { type: 'LANTHRA_ERROR';      sessionId: SessionId; error: string }
  | { type: 'LANTHRA_TOGGLE_ACK'; armed: boolean }
  | { type: 'LANTHRA_TOOL_CALL';  id: string; name: string };

// ── Service Worker → Side Panel (broadcast via chrome.runtime.sendMessage) ───

export type PanelBroadcast =
  | { type: 'LANTHRA_STATE_UPDATE'; state: string }
  | { type: 'LANTHRA_CHAT_USER';   sessionId: SessionId; prompt: string }
  | { type: 'LANTHRA_CHAT_TOKEN';  sessionId: SessionId; token: string }
  | { type: 'LANTHRA_CHAT_END';    sessionId: SessionId }
  | { type: 'LANTHRA_CHAT_ERROR';  sessionId: SessionId; error: string }
  | { type: 'LANTHRA_TAB_CHANGED'; url: string; title: string; tabId: number };

// ── Service Worker → Background Command (from chrome.commands) ───────────────

export type BGCommand =
  | { type: 'LANTHRA_TOGGLE' };

// ── Port names ───────────────────────────────────────────────────────────────

export const PORT_SESSION_PREFIX = 'lanthra:session:';
