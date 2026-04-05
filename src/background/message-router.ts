// message-router.ts — Routes messages between content script ports and
// the native host bridge.
//
// Flow:
//   CS ──(chrome.runtime.connect)──► SW port
//   SW port.onMessage                → sends to native bridge
//   native bridge onToken/End/Error  → post back on the CS port
//
// Each streaming session has its own chrome.runtime.Port opened by the
// content script using the name: "lanthra:session:<sessionId>"

import { log }                from '../shared/logger';
import {
  registerSession,
  sendPrompt,
  sendCancel,
  unregisterSession,
}                              from './native-bridge';
import type { CSMessage, SWMessage } from '../types/messages';
import { PORT_SESSION_PREFIX } from '../types/messages';

/** Call once from service-worker.ts to wire up the message router. */
export function attachMessageRouter(): void {
  chrome.runtime.onConnect.addListener(onContentScriptConnect);
}

function onContentScriptConnect(port: chrome.runtime.Port): void {
  if (!port.name.startsWith(PORT_SESSION_PREFIX)) return;

  const sessionId = port.name.slice(PORT_SESSION_PREFIX.length);
  log('info', `SW: content port connected for session ${sessionId}`);

  function send(msg: SWMessage): void {
    try {
      port.postMessage(msg);
    } catch (e) {
      log('warn', 'SW: failed to post to content port', e);
    }
  }

  registerSession(sessionId, {
    onToken:     (token) => send({ type: 'LANTHRA_TOKEN',      sessionId, token }),
    onStreamEnd: ()      => {
      send({ type: 'LANTHRA_STREAM_END', sessionId });
      port.disconnect();
    },
    onError:     (error) => {
      send({ type: 'LANTHRA_ERROR', sessionId, error });
      port.disconnect();
    },
  });

  port.onMessage.addListener((msg: CSMessage) => {
    switch (msg.type) {
      case 'LANTHRA_PROMPT_SUBMIT':
        sendPrompt(sessionId, msg.prompt, msg.context);
        break;
      case 'LANTHRA_CANCEL':
        sendCancel(sessionId);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    log('info', `SW: content port disconnected for session ${sessionId}`);
    sendCancel(sessionId);
    unregisterSession(sessionId);
  });
}
