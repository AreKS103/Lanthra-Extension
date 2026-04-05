// service-worker.ts — MV3 service worker entry point.
//
// Responsibilities:
//   1. Listen for chrome.commands 'toggle-edit-mode' and forward to the
//      active tab's content script.
//   2. Delegate all streaming session routing to message-router.ts.

import { log }                  from '../shared/logger';
import { attachMessageRouter }  from './message-router';

// Wire up the content-script port handler
attachMessageRouter();

// ── Command handler ───────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-edit-mode') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    log('warn', 'SW: no active tab for toggle command');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'LANTHRA_TOGGLE' });
  } catch (e) {
    // Content script may not be injected on this page (e.g. chrome:// URLs)
    log('warn', 'SW: could not forward toggle to content script', e);
  }
});

// ── Extension icon click ──────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'LANTHRA_TOGGLE' });
  } catch (e) {
    log('warn', 'SW: could not toggle via icon click', e);
  }
});

log('info', 'service worker started');
