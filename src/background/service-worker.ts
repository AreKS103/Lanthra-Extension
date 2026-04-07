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

// ── Pre-warm OpenRouter TLS on side panel open ────────────────────────────────
// Shaves 100-300 ms off the first request's TTFT by completing the TLS handshake
// and TCP connection before the user sends their first prompt.

async function prewarmConnection(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(['lanthra_provider']);
    const provider = stored.lanthra_provider ?? 'openrouter';
    if (provider === 'ollama') {
      const ollamaUrl = (await chrome.storage.local.get(['lanthra_ollama_url'])).lanthra_ollama_url || 'http://localhost:11434';
      try {
        const parsed = new URL(ollamaUrl);
        if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
          fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { method: 'GET' }).catch(() => {});
        }
      } catch { /* invalid URL */ }
    } else {
      // Warm the relevant API endpoint (best-effort HEAD)
      const WARM_URLS: Record<string, string> = {
        'groq':       'https://api.groq.com/openai/v1/models',
        'openai':     'https://api.openai.com/v1/models',
        'anthropic':  'https://api.anthropic.com/v1/models',
        'google':     'https://generativelanguage.googleapis.com/v1beta/models',
        'deepseek':   'https://api.deepseek.com/v1/models',
        'mistralai':  'https://api.mistral.ai/v1/models',
        'x-ai':       'https://api.x.ai/v1/models',
        'nvidia':     'https://integrate.api.nvidia.com/v1/models',
        'perplexity': 'https://api.perplexity.ai/models',
      };
      const url = WARM_URLS[provider] ?? 'https://openrouter.ai/api/v1/models';
      fetch(url, { method: 'HEAD' }).catch(() => {});
    }
  } catch { /* best effort */ }
}

// Side panel connects via chrome.runtime — detect it for pre-warming
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'lanthra:sidepanel') {
    log('info', 'SW: side panel connected — pre-warming');
    prewarmConnection();
  }
});

// ── Idle timeout: purge stale chat data on wake ───────────────────────────────

const CHAT_STORAGE_KEY = 'lanthra_active_chat';
const IDLE_TIMEOUT_MS  = 42 * 60 * 60 * 1000; // 42 hours

async function purgeStaleChat(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(CHAT_STORAGE_KEY);
    const data = result[CHAT_STORAGE_KEY] as { lastInteraction?: number } | undefined;
    if (data?.lastInteraction && Date.now() - data.lastInteraction > IDLE_TIMEOUT_MS) {
      await chrome.storage.session.remove(CHAT_STORAGE_KEY);
      log('info', 'SW: purged stale chat data (idle > 42 h)');
    }
  } catch { /* session storage may not have any data */ }
}

purgeStaleChat();

// ── Open side panel on action icon click ──────────────────────────────────────

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => log('warn', 'SW: failed to set panel behavior', error));

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

log('info', 'service worker started');

// ── Active tab tracking → broadcast to side panel ─────────────────────────────

function broadcastTabInfo(tab: chrome.tabs.Tab): void {
  if (!tab.url) return;
  chrome.runtime.sendMessage({
    type: 'LANTHRA_TAB_CHANGED',
    url: tab.url,
    title: tab.title ?? '',
    tabId: tab.id ?? 0,
    favIconUrl: tab.favIconUrl ?? '',
  }).catch(() => { /* panel closed */ });
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    broadcastTabInfo(tab);
  } catch { /* tab may have been removed */ }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === 'complete' || changeInfo.favIconUrl)) {
    broadcastTabInfo(tab);
  }
});

// ── Close panel message from side panel page ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'LANTHRA_CLOSE_PANEL') {
    chrome.windows.getCurrent((win) => {
      if (win?.id != null) {
        (chrome.sidePanel as unknown as { close(o: object): Promise<void> })
          .close({ windowId: win.id })
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
      }
    });
    return true; // async response
  }

  // Programmatic content script injection fallback
  if (msg?.type === 'LANTHRA_INJECT_CS') {
    const tabId = msg.tabId as number | undefined;
    if (!tabId) { sendResponse({ ok: false, error: 'No tab ID' }); return; }
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['dist/content.js'],
    })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});
