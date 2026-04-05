// page-script/bridge.ts — Injected into the page world via scripting.executeScript
// when access to page-global variables is needed (e.g. reaching into framework
// internals, reading React fiber state, or calling page-defined APIs).
//
// Communication path:
//   Content Script  ──postMessage──►  Page Script  ──postMessage──►  Content Script
//
// This file is intentionally minimal. Phase 1 does not require it — the generic
// DOM insertion path works entirely in the content-script world. Wire it up in
// Phase 2 when site-specific adapters are needed.
//
// Usage from content script:
//   chrome.scripting.executeScript({ files: ['dist/page-bridge.js'], ... });
//   then use window.postMessage / window.addEventListener to communicate.

const ORIGIN = window.location.origin;
const FROM_CS = 'lanthra:cs→page';
const FROM_PAGE = 'lanthra:page→cs';

// Listen for messages from the content script (relayed from extension messaging)
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  if (!e.data || e.data.__lanthra !== FROM_CS) return;

  const payload = e.data.payload as Record<string, unknown>;

  // Site-specific hooks go here. At minimum, expose a no-op so the bridge
  // can be detected from the content script.
  switch (payload['action']) {
    case 'PING':
      window.postMessage({ __lanthra: FROM_PAGE, payload: { action: 'PONG' } }, ORIGIN);
      break;

    // Phase 2: add cases for framework-specific hooks here
    // e.g. case 'GET_REACT_ROOT': ...
  }
});

// Signal that the bridge loaded successfully
window.postMessage({ __lanthra: FROM_PAGE, payload: { action: 'READY' } }, ORIGIN);
