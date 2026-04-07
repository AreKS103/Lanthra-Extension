// content/index.ts — Content script entry point.
//
// Responsibilities:
//   1. Attach keyboard listener for toggle shortcut.
//   2. Listen for chrome.runtime messages from the service worker
//      (command forwarding for sites where keydown is suppressed).
//   3. Delegate everything else to EditSession.

import { attachKeyboardListener, registerToggleCallback } from './keyboard';
import { EditSession, extractPostText }                    from './edit-session';
import { executePageTool }                                 from './page-tools';
import type { SWMessage }                                  from '../types/messages';
import { log }                                             from '../shared/logger';

// ── Bootstrap ────────────────────────────────────────────────────────────────

const session = EditSession.current;
let panelPromptPort: chrome.runtime.Port | null = null;

registerToggleCallback(() => session.onToggle());
attachKeyboardListener();

// ── Message listener from SW (toggle forwarded via chrome.commands) ──────────

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse) => {
    if (!isObject(msg)) return;

    const m = msg as Record<string, unknown>;
    log('debug', 'CS received message', { type: m['type'] });

    if (m['type'] === 'LANTHRA_TOGGLE') {
      log('info', 'CS: toggling edit mode');
      session.onToggle();
      sendResponse({ ok: true });
      return;
    }

    if (m['type'] === 'LANTHRA_DEACTIVATE') {
      log('info', 'CS: deactivating edit mode');
      session.deactivate();
      sendResponse({ ok: true });
      return;
    }

    if (m['type'] === 'LANTHRA_PING') {
      sendResponse({ ok: true, url: location.href });
      return;
    }

    if (m['type'] === 'LANTHRA_CANCEL_FROM_PANEL') {
      log('info', 'CS: cancel from panel');
      // Cancel panel-initiated prompt if active — send explicit CANCEL
      // before disconnecting so the SW aborts during both thinking and streaming.
      if (panelPromptPort) {
        try { panelPromptPort.postMessage({ type: 'LANTHRA_CANCEL' }); } catch { /* port closed */ }
        try { panelPromptPort.disconnect(); } catch { /* already closed */ }
        panelPromptPort = null;
      }
      session.cancel();
      sendResponse({ ok: true });
      return;
    }

    if (m['type'] === 'LANTHRA_PANEL_PROMPT') {
      log('info', 'CS: panel prompt received, forwarding to SW via port');
      const prompt = m['prompt'] as string;
      if (!prompt) return;

      // Cancel any previous panel prompt
      if (panelPromptPort) {
        try { panelPromptPort.disconnect(); } catch { /* already closed */ }
      }

      // Open a temporary port to the service worker for this panel-initiated chat
      const chatId = crypto.randomUUID();
      const port = chrome.runtime.connect({ name: `lanthra:session:${chatId}` });
      panelPromptPort = port;

      port.postMessage({
        type: 'LANTHRA_PROMPT_SUBMIT',
        sessionId: chatId,
        prompt,
        context: extractPageContent(),
      });

      // Listen for tokens/control messages from the service worker.
      // Tool calls need DOM access so we execute them here and post the result back.
      port.onMessage.addListener((swMsg: Record<string, unknown>) => {
        if (swMsg['type'] === 'LANTHRA_TOOL_CALL') {
          const result = executePageTool(swMsg['name'] as string);
          port.postMessage({ type: 'LANTHRA_TOOL_RESULT', id: swMsg['id'] as string, result });
          return;
        }
        if (swMsg['type'] === 'LANTHRA_STREAM_END' || swMsg['type'] === 'LANTHRA_ERROR') {
          panelPromptPort = null;
          try { port.disconnect(); } catch { /* already closed */ }
        }
      });

      sendResponse({ ok: true, sessionId: chatId });
      return;
    }

    // SW → CS messages that arrive outside the streaming port
    if (typeof m['type'] === 'string' && (m['type'] as string).startsWith('LANTHRA_')) {
      session.handleSWMessage(m as unknown as SWMessage);
    }
  }
);

// ── Image submit: bypass side panel, open port directly to SW ────────────────

session.onImageSubmit = async (imageUrl, alt, userPrompt) => {
  // Cancel any previous panel prompt
  if (panelPromptPort) {
    try { panelPromptPort.disconnect(); } catch { /* already closed */ }
  }

  const wantsContext = needsPostContext(userPrompt);

  const promptText = userPrompt
    ? `${userPrompt}${alt ? ` The image alt text is: "${alt}"` : ''}`
    : `Please describe and analyze this image in detail.${alt ? ` The image alt text is: "${alt}"` : ''}`;

  // Image-only: smaller image for faster analysis; post context: full resolution
  const maxDim  = wantsContext ? 1024 : 512;
  const quality = wantsContext ? 0.85 : 0.75;
  const resized = await resizeImageToBase64(imageUrl, maxDim, quality);

  // Build context: image-only (focused) or full post text
  let context: string;
  if (wantsContext && session.activeImageEl) {
    const postText = extractPostText(session.activeImageEl);
    context = `lanthra:page\nTitle: ${document.title}\nURL: ${location.href}${postText ? `\nPost text:\n${postText}` : ''}`;
  } else {
    context = `lanthra:image\nURL: ${location.href}`;
  }

  const chatId = crypto.randomUUID();
  const port = chrome.runtime.connect({ name: `lanthra:session:${chatId}` });
  panelPromptPort = port;

  port.postMessage({
    type: 'LANTHRA_PROMPT_SUBMIT',
    sessionId: chatId,
    prompt: promptText,
    context,
    imageOnly: true,
    ...(resized
      ? { imageBase64: resized.base64, imageMediaType: resized.mediaType }
      : { imageUrl }),
  });

  port.onMessage.addListener((swMsg: Record<string, unknown>) => {
    if (swMsg['type'] === 'LANTHRA_TOOL_CALL') {
      const result = executePageTool(swMsg['name'] as string);
      port.postMessage({ type: 'LANTHRA_TOOL_RESULT', id: swMsg['id'] as string, result });
      return;
    }
    if (swMsg['type'] === 'LANTHRA_TOKEN') {
      // Route all tokens on this port to the DOM image response (port = image context)
      session.appendImageResponseToken(swMsg['token'] as string);
    }
    if (swMsg['type'] === 'LANTHRA_STREAM_END' || swMsg['type'] === 'LANTHRA_ERROR') {
      session.endImageResponse();
      panelPromptPort = null;
      try { port.disconnect(); } catch { /* already closed */ }
    }
  });
};

log('info', 'content script ready');

// ── Utility ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Lightweight page metadata — full content extraction happens lazily
 * via the get_page_content tool when the AI actually needs it.
 */
function extractPageContent(): string {
  return `lanthra:page\nTitle: ${document.title ?? ''}\nURL: ${location.href}`;
}

/**
 * Resize an image via canvas and return as base64 JPEG.
 * Works for same-origin or CORS-friendly images; returns null otherwise.
 */
async function resizeImageToBase64(
  imageUrl: string,
  maxDim = 1024,
  quality = 0.85,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('load failed'));
      img.src = imageUrl;
    });
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { base64: dataUrl.split(',')[1]!, mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Check if the user's prompt references the surrounding post/article content. */
function needsPostContext(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const postTerms = [
    'this post', 'the post', 'this article', 'the article',
    'this tweet', 'the tweet', 'this thread', 'the thread',
    'this caption', 'the caption', 'this comment', 'the comment',
    'this page', 'the page', 'surrounding text', 'full context',
    'post context',
  ];
  return postTerms.some(term => lower.includes(term));
}
