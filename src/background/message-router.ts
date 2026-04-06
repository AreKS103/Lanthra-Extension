// message-router.ts — Routes content-script port messages to the AI client
// and broadcasts chat events to the side panel for mirroring.
//
// Flow:
//   CS ──(chrome.runtime.connect)──► SW port
//   SW: LANTHRA_PROMPT_SUBMIT → ai-client fetch stream
//   ai-client tokens/end/error  → post back on the CS port + broadcast to panel

import { log }                             from '../shared/logger';
import { startStream, cancelStream }       from './ai-client';
import type { ToolExecutor }               from './ai-client';
import type { CSMessage, SWMessage }       from '../types/messages';
import { PORT_SESSION_PREFIX }             from '../types/messages';

/** Broadcast a message to the side panel (and any other extension pages). */
function broadcast(msg: Record<string, unknown>): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listener (panel closed) — safe to ignore
  });
}

/** Call once from service-worker.ts to wire up the message router. */
export function attachMessageRouter(): void {
  chrome.runtime.onConnect.addListener(onContentScriptConnect);
}

function onContentScriptConnect(port: chrome.runtime.Port): void {
  if (!port.name.startsWith(PORT_SESSION_PREFIX)) return;

  const sessionId = port.name.slice(PORT_SESSION_PREFIX.length);
  log('info', `SW: content port connected for session ${sessionId}`);

  let streamStarted = false;

  // Pending tool results: id → resolve callback
  const pendingToolResults = new Map<string, (result: string) => void>();

  function send(msg: SWMessage): void {
    try { port.postMessage(msg); } catch { /* port already closed */ }
  }

  function createToolExecutor(): ToolExecutor {
    return (name: string) => new Promise<string>((resolve, reject) => {
      const id = crypto.randomUUID();
      // Reject if the content script doesn't return a result within 30 s.
      const timeout = setTimeout(() => {
        if (pendingToolResults.has(id)) {
          pendingToolResults.delete(id);
          reject(new Error(`Tool "${name}" timed out — no result from content script after 30 s`));
        }
      }, 30_000);
      pendingToolResults.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      send({ type: 'LANTHRA_TOOL_CALL', id, name });
    });
  }

  port.onMessage.addListener((msg: CSMessage) => {
    log('debug', `SW: port message from CS`, { type: msg.type, sessionId });

    switch (msg.type) {
      case 'LANTHRA_TOOL_RESULT': {
        const resolve = pendingToolResults.get(msg.id);
        if (resolve) {
          resolve(msg.result);
          pendingToolResults.delete(msg.id);
        }
        break;
      }
      case 'LANTHRA_PROMPT_SUBMIT':
        if (streamStarted) break;
        streamStarted = true;
        log('info', `SW: starting AI stream for session ${sessionId}`, {
          promptLen: msg.prompt?.length,
          contextLen: msg.context?.length,
        });

        {
          const imageUrl = msg.imageUrl;
          const imageBase64 = msg.imageBase64;
          const imageMediaType = msg.imageMediaType;
          const imageOnly = !!msg.imageOnly;
          const isPanelPrompt = (msg.context ?? '').startsWith('lanthra:page\n');

          // Always show user message in panel, even for image-only prompts
          broadcast({ type: 'LANTHRA_CHAT_USER', sessionId, prompt: msg.prompt });

          startStream(sessionId, msg.prompt, msg.context, {
            onToken: (token) => {
              log('debug', `SW: token for ${sessionId}`, { len: token.length });
              send({ type: 'LANTHRA_TOKEN', sessionId, token });
              broadcast({ type: 'LANTHRA_CHAT_TOKEN', sessionId, token });
            },
            onStreamEnd: () => {
              log('info', `SW: stream ended for ${sessionId}`);
              send({ type: 'LANTHRA_STREAM_END', sessionId });
              // imageOnly prompts must not trigger LANTHRA_DEACTIVATE in CS,
              // so force isPanelPrompt=false for them.
              broadcast({ type: 'LANTHRA_CHAT_END', sessionId, isPanelPrompt: imageOnly ? false : isPanelPrompt });
              try { port.disconnect(); } catch { /* already closed */ }
            },
            onError: (error) => {
              log('error', `SW: stream error for ${sessionId}`, { error });
              send({ type: 'LANTHRA_ERROR', sessionId, error });
              broadcast({ type: 'LANTHRA_CHAT_ERROR', sessionId, error });
              try { port.disconnect(); } catch { /* already closed */ }
            },
            onUsage: (usage) => {
              broadcast({
                type: 'LANTHRA_USAGE',
                sessionId,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
              });
            },
          }, createToolExecutor(), imageUrl, imageBase64, imageMediaType);
        }
        break;
      case 'LANTHRA_CANCEL':
        log('info', `SW: cancel request for ${sessionId}`);
        cancelStream(sessionId);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    log('info', `SW: content port disconnected for session ${sessionId}`);
    cancelStream(sessionId);
  });
}

