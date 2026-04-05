# Lanthra Extension — Technical Spec

> Last updated: 2026-04-04

## Product Vision

Lanthra is a browser extension that lets users inject an invisible inline text editor anywhere on any webpage. The user toggles "edit mode," clicks a text location, a temporary contenteditable span appears matching the surrounding typography (chameleon mode), the user types a prompt, presses Cmd/Ctrl+Enter, and AI output streams back into that same inline host so the page naturally reflows around it. No sidebar. No popup. The experience is inline and visually native to the page.

---

## Architecture Overview

```
+-----------------------------------------------------+
|                    Browser Tab                       |
|  +----------------------------------------------+   |
|  | Content Script (ISOLATED world, IIFE bundle) |   |
|  |  +- keyboard.ts      shortcut listener       |   |
|  |  +- hit-test.ts      caretRangeFromPoint     |   |
|  |  +- range-utils.ts   text-node split/anchor  |   |
|  |  +- inline-host.ts   contenteditable span    |   |
|  |  +- style-mirror.ts  computed-style clone    |   |
|  |  +- mutation-guard.ts MutationObserver       |   |
|  |  +- selection-store.ts save/restore caret    |   |
|  |  +- edit-session.ts  state machine           |   |
|  |  +- index.ts         bootstrap + msg relay   |   |
|  +----------------------------------------------+   |
|  +----------------------------------------------+   |
|  | Page Script (MAIN world, optional Phase 2)   |   |
|  |  +- bridge.ts  postMessage <-> content script |   |
|  +----------------------------------------------+   |
+-----------------------------------------------------+
           | chrome.runtime.connect (Port)
           v
+-----------------------------------------------------+
| Service Worker (ESM, MV3)                           |
|  +- service-worker.ts   chrome.commands + action    |
|  +- message-router.ts   port per session            |
|  +- native-bridge.ts    chrome.runtime.connectNative|
+-----------------------------------------------------+
           | Native Messaging (length-prefixed JSON)
           v
+-----------------------------------------------------+
| Native Host (macOS Swift binary)                    |
|  +- main.swift          stdin/stdout message loop   |
|  +- MessageCodec.swift  4-byte length framing       |
|  +- GroqClient.swift    Groq API streaming          |
+-----------------------------------------------------+
```

---

## Tech Stack

| Layer | Tech | Notes |
|---|---|---|
| Extension | TypeScript 5.4+, MV3 | Strict mode, bundled with esbuild |
| Content script | IIFE bundle (no ESM in content scripts) | Runs in ISOLATED world by default |
| Service worker | ESM bundle | `"type": "module"` in manifest |
| Page bridge | IIFE, MAIN world | Only for Phase 2 site adapters |
| Native host | Swift 5.9, macOS 13+ | Streams via Groq API, length-prefixed JSON on stdin/stdout |
| Build | esbuild 0.21+ | 3 entry points, sourcemaps in dev |

---

## AI Backend Strategy

### Primary: Native Host via Native Messaging
The extension connects to a macOS Swift binary (`com.lanthra.host`) that calls the Groq API (llama-3.3-70b-versatile) and streams tokens back over stdin/stdout using Chrome's Native Messaging protocol.

### Future: Chrome Built-in AI (Prompt API + Writer/Rewriter APIs)
Chrome 138+ ships the **Prompt API** (`LanguageModel.create()`) powered by Gemini Nano on-device. This enables:
- **Zero-latency local inference** — no network round-trip
- **`promptStreaming()`** — returns a `ReadableStream` of chunks, perfect for our `appendToken()` pattern
- **Writer API** — `ai.writer.create({tone, length})` for structured text generation
- **Rewriter API** — `ai.rewriter.create({tone})` for editing existing text in-place
- **Proofreader API** — grammar/readability checking inline

**Integration plan:** Add an `ai-provider.ts` abstraction in `src/background/` that selects between native-host and built-in AI based on `LanguageModel.availability()`. When built-in AI is available and the task fits (short prompts, single-language), use it for instant response. Fall back to native host for complex/long-form generation.

**Hardware requirements for built-in AI:** 22GB free disk, >4GB VRAM or 16GB RAM + 4 cores. Not all users will qualify — the native host fallback is essential.

### Future: Cloud API Fallback (Firebase AI Logic)
For users without a Mac (no native host) and without Gemini Nano hardware, a cloud fallback via Firebase AI Logic or direct Groq API from the service worker provides universal coverage.

---

## Core Interaction Flow

### 1. Activation
- **Keyboard shortcut:** `Alt+Shift+L` (Windows/Linux) / `Cmd+Shift+L` (Mac) — registered via `chrome.commands`
- **Extension icon click:** `chrome.action.onClicked` forwards `LANTHRA_TOGGLE` to content script
- Both paths call `EditSession.current.onToggle()`

### 2. Armed State
- Full-viewport transparent overlay with `cursor: crosshair` (z-index: 2147483645)
- Text elements get a dashed indigo hover outline on mouseover via `hitTest()`
- Page clicks are intercepted at capture phase, `preventDefault()` + `stopPropagation()`

### 3. Click -> Anchor Insertion (The Core Algorithm)
```
1. document.caretRangeFromPoint(x, y) -> Range
2. If startContainer is Text node:
     leftText = textNode (up to offset)
     rightText = textNode.splitText(offset)
3. Create <span data-lanthra-anchor> with display:inline
4. parent.insertBefore(anchor, rightText)
5. Anchor now sits between leftText and rightText -- zero visual disruption
```
**Why this works:** Text node splitting + insertBefore is the smallest possible DOM mutation. `normalize()` on removal merges them back seamlessly. No innerHTML, no surroundContents (which throws on cross-element ranges).

### 4. Inline Host (Chameleon Mode)
- `<span contenteditable="true" data-lanthra-host>` inside the anchor
- Typography cloned from surrounding text via `window.getComputedStyle()`:
  - fontFamily, fontSize, fontWeight, fontStyle, fontVariant
  - lineHeight, letterSpacing, wordSpacing, color
  - whiteSpace, direction, writingMode, textTransform
  - textDecoration, verticalAlign
- Subtle visual cues only: indigo caret color, faint bottom border, 8% opacity background
- IME-safe: handles `compositionstart`/`compositionend`, uses `input` event (not keyup)
- Paste sanitized to plain text via `clipboardData.getData('text/plain')`

### 5. Prompt Submission (Cmd/Ctrl+Enter)
- Content script opens a persistent `chrome.runtime.Port` to the service worker
- Port name: `lanthra:session:<uuid>` — one port per editing transaction
- Service worker routes to native host via `chrome.runtime.connectNative`
- Message format: `{ id, type: "prompt", prompt, context, model }`

### 6. Streaming Response
- Host element switches to `contenteditable="false"` with streaming decorations
- Tokens arrive as `{ id, type: "token", token }` messages
- Each token appended via `Text.appendData()` — single DOM mutation, native browser reflow
- On `stream_end`: host commits, anchor attributes stripped, clean text remains in DOM

### 7. Cleanup / Cancel
- **Escape:** cancels session, `removeAnchor()` pulls span out, `parent.normalize()` rejoins text
- **Orphan detection:** `MutationObserver` on the nearest block ancestor detects if the page removes our anchor (SPA re-render)
- **Selection restore:** user's original selection/caret is saved before insertion and restored on cancel

---

## Session State Machine

```
idle -> armed -> inserted -> editing -> streaming -> committed
  ^       |         |          |          |           |
  |       |         |          |          |           |
  +-------+---------+----------+----------+-----------+
                    | (any state)
              canceled / orphaned -> idle
```

Each `EditSession` is a singleton with a rotating `crypto.randomUUID()` id. Only one session active at a time.

---

## Messaging Protocol

### Content Script <-> Service Worker
| Direction | Type | Payload |
|---|---|---|
| CS -> SW | `LANTHRA_PROMPT_SUBMIT` | `{ sessionId, prompt, context }` |
| CS -> SW | `LANTHRA_CANCEL` | `{ sessionId }` |
| SW -> CS | `LANTHRA_TOKEN` | `{ sessionId, token }` |
| SW -> CS | `LANTHRA_STREAM_END` | `{ sessionId }` |
| SW -> CS | `LANTHRA_ERROR` | `{ sessionId, error }` |
| SW -> CS | `LANTHRA_TOGGLE` | (command forwarding) |

### Service Worker <-> Native Host
| Direction | Type | Payload |
|---|---|---|
| SW -> Host | `prompt` | `{ id, prompt, context, model }` |
| SW -> Host | `cancel` | `{ id }` |
| Host -> SW | `token` | `{ id, token }` |
| Host -> SW | `stream_end` | `{ id }` |
| Host -> SW | `error` | `{ id, error }` |

Native messaging uses Chrome's 4-byte length-prefixed JSON protocol on stdin/stdout.

---

## Known Failure Modes & Mitigations

| Failure | Mitigation |
|---|---|
| Cross-origin iframes | `all_frames: false` in manifest; Phase 2 adds per-frame injection |
| Shadow DOM (closed) | Cannot pierce; detect and skip gracefully |
| Shadow DOM (open) | Phase 2: traverse `shadowRoot` in hit-test |
| SPA re-renders remove anchor | `MutationObserver` detects removal -> orphan state -> cleanup |
| `caretRangeFromPoint` returns null | Skip click, stay armed |
| Page-owned contenteditable | Detected in hit-test -> blocked (avoids conflict with editors like Google Docs) |
| IME composition events | `isComposing` flag prevents premature submit |
| Invisible/zero-size elements | `getBoundingClientRect` + computed style check in hit-test |
| Native host crash | `port.onDisconnect` -> error message -> cancel session; auto-reconnect on next prompt |
| Service worker killed (MV3 lifecycle) | Persistent port keeps it alive during streaming; re-inject on next activation |
| CSP blocks inline styles | We use `element.style.cssText` (not `<style>` tags) — works in isolated world |
| `Range.surroundContents()` throws | Never used — manual text-node split + insertBefore only |
| Paste with rich formatting | Intercepted, stripped to plain text |
| Very long AI responses | Text.appendData reflows natively; no DOM node explosion |

---

## Techniques Used by Modern Extensions (Research)

### How Grammarly, Wordtune, and Similar Tools Work
- **Grammarly** uses a combination of overlay divs positioned absolutely over text fields and a shadow DOM container for its inline suggestions. It observes `input`/`textarea`/`contenteditable` elements and mirrors their position.
- **Wordtune** injects next to cursor position using `getSelection().getRangeAt(0).getBoundingClientRect()` for positioning.
- **Key difference for Lanthra:** We don't observe existing editable fields — we *create* one at any arbitrary text position in read-only content. This is more akin to annotation tools than grammar checkers.

### Chrome Built-in AI APIs (2025-2026)
- **Prompt API** (`LanguageModel.create()` / `promptStreaming()`): On-device Gemini Nano, streaming output, multi-modal (text/image/audio). Available in Chrome 138+ origin trial.
- **Writer API**: Generate content with tone/length constraints. Ideal for "write me a paragraph" prompts.
- **Rewriter API**: Rewrite existing text with tone shifts. Ideal for "make this more formal" prompts.
- **Proofreader API**: Grammar and readability fixes. Could power a "fix this text" mode.
- **Summarizer API**: Condense content. Could enhance the `context` field sent with prompts.
- **`LanguageModel.availability()`**: Check device hardware before attempting local inference.
- **`promptStreaming()` returns `ReadableStream`**: Maps directly to our `appendToken()` pattern.

### WebMCP (2026)
Chrome is introducing **WebMCP** — a standard for exposing structured tools to AI agents via web pages. This could let Lanthra's AI backend call page-specific tools (e.g., "add to cart", "submit form") as part of the inline editing flow.

### Shadow DOM Isolation
- Modern extensions (Claude, Grammarly) use **closed shadow DOM** (`attachShadow({ mode: 'closed' })`) for injected UI to prevent page CSS from leaking in.
- **Lanthra's approach is deliberately different:** We want page CSS to leak in (chameleon mode). The host span inherits and mirrors surrounding typography.
- However, for any future floating UI (settings panel, model picker), shadow DOM isolation should be used.

### Selection/Range Best Practices (2025+)
- `document.caretRangeFromPoint()` remains the most reliable hit-test in Chromium. The newer `document.caretPositionFromPoint()` (CSS spec, Chrome 128+) returns `CaretPosition` — functionally equivalent.
- `Text.splitText()` + `Node.insertBefore()` is still the gold-standard minimal-mutation insertion.
- `parent.normalize()` to merge text nodes on removal is universally supported.

---

## Build & Development

```bash
npm install
npm run build        # One-shot production build
npm run watch        # Dev mode with file watching
npm run typecheck    # tsc --noEmit
```

Load unpacked from the project root in `chrome://extensions`. The `dist/` folder contains:
- `service-worker.js` (ESM)
- `content.js` (IIFE)
- `page-bridge.js` (IIFE, web-accessible)

---

## Roadmap

### Phase 1 (Current) — Static/Article Pages
- [x] MV3 manifest with chrome.commands shortcut
- [x] Content script: hit-test, range-utils, style-mirror, inline-host
- [x] EditSession state machine (idle -> armed -> editing -> streaming -> committed)
- [x] Service worker with port-per-session message routing
- [x] Native host bridge (lazy connect, auto-reconnect, queue)
- [x] MutationObserver orphan detection
- [x] Selection save/restore
- [x] Hover affordance while armed
- [ ] End-to-end streaming with native host
- [ ] Error feedback UI (toast or inline error state)
- [ ] Extension popup/options page for API key configuration

### Phase 2 — Site Adapters & Rich Content
- [ ] Page-world bridge for framework introspection (React fiber, Vue reactivity)
- [ ] Shadow DOM traversal in hit-test (open shadow roots)
- [ ] Per-frame injection for cross-origin iframes
- [ ] Site-specific adapters (Google Docs, Notion, Medium)
- [ ] Multi-model support (model picker in prompt phase)
- [ ] Chrome Built-in AI integration (`LanguageModel.create()` / Writer / Rewriter)

### Phase 3 — Safari Web Extension & Distribution
- [ ] Safari Web Extension packaging (`xcrun safari-web-extension-converter`)
- [ ] Safari native messaging to macOS Lanthra app
- [ ] Chrome Web Store submission
- [ ] Signed .dmg for native host installation

### Phase 4 — Advanced Features
- [ ] Undo/redo for committed insertions
- [ ] Multi-cursor: multiple simultaneous inline hosts
- [ ] Context-aware prompting (summarize page -> inject into system prompt)
- [ ] WebMCP integration for agentic page actions
- [ ] Firefox MV3 port (WebExtensions API differences)
