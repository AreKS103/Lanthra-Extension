// content/index.ts — Content script entry point.
//
// Responsibilities:
//   1. Attach keyboard listener for toggle shortcut.
//   2. Listen for chrome.runtime messages from the service worker
//      (command forwarding for sites where keydown is suppressed).
//   3. Delegate everything else to EditSession.

import { attachKeyboardListener, registerToggleCallback } from './keyboard';
import { EditSession }                                     from './edit-session';
import type { SWMessage }                                  from '../types/messages';
import { log }                                             from '../shared/logger';

// ── Bootstrap ────────────────────────────────────────────────────────────────

const session = EditSession.current;

registerToggleCallback(() => session.onToggle());
attachKeyboardListener();

// ── Message listener from SW (toggle forwarded via chrome.commands) ──────────

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse) => {
    if (!isObject(msg)) return;

    const m = msg as Record<string, unknown>;

    if (m['type'] === 'LANTHRA_TOGGLE') {
      session.onToggle();
      sendResponse({ ok: true });
      return;
    }

    // SW → CS messages that arrive outside the streaming port
    if (typeof m['type'] === 'string' && (m['type'] as string).startsWith('LANTHRA_')) {
      session.handleSWMessage(m as unknown as SWMessage);
    }
  }
);

log('info', 'content script ready');

// ── Utility ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
