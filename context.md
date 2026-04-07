# Lanthra Extension — Complete Architecture, Logic & Code Reference

> Last updated: 2025-07-25
> This document serves as a complete technical reference for the entire extension.
> Every file, function, data flow, and known issue is documented below.

---

## 1. Product Overview

Lanthra is a Chrome MV3 browser extension that provides two modes of AI interaction:

1. **Inline editing** — Click anywhere on a webpage to insert an invisible contenteditable span that matches surrounding typography. Type a prompt, press Enter, and AI output streams directly into the page. The text reflows naturally as if native.

2. **Side panel chat** — A persistent side panel (Chrome Side Panel API) for conversational AI. Supports multi-turn chat, image analysis, thinking/reasoning dropdowns, and settings management.

Both modes share a single AI streaming backend and tool-calling system.

---

## 2. Architecture Diagram

```
┌─ Browser Tab ──────────────────────────────────────────┐
│  Content Script (ISOLATED world, IIFE)                 │
│    index.ts         — bootstrap, message relay          │
│    edit-session.ts  — inline editing state machine      │
│    inline-host.ts   — contenteditable span lifecycle    │
│    hit-test.ts      — caretRangeFromPoint targeting     │
│    range-utils.ts   — text-node split/anchor insertion  │
│    style-mirror.ts  — computed-style cloning            │
│    mutation-guard.ts— MutationObserver for orphans      │
│    selection-store.ts— save/restore user selection      │
│    keyboard.ts      — shortcut listener                 │
│    page-tools.ts    — DOM tools (Readability+Turndown)  │
├────────────────────────────────────────────────────────┤
│  Page Script (MAIN world, IIFE)                        │
│    bridge.ts        — postMessage bridge (future use)   │
└────────────────── chrome.runtime.Port ─────────────────┘
                         │
┌─ Service Worker (ESM) ─┼──────────────────────────────┐
│  service-worker.ts     │  chrome.commands + sidePanel  │
│  message-router.ts     │  port routing + tool dispatch │
│  ai-client.ts          │  Vercel AI SDK streaming      │
│  native-bridge.ts      │  native messaging (unused)    │
└────────────────────────┼──────────────────────────────┘
                         │ chrome.runtime.sendMessage
┌─ Side Panel ───────────┼──────────────────────────────┐
│  sidepanel.html        │  panel markup                 │
│  sidepanel.css         │  dark theme + glass effects   │
│  sidepanel.ts          │  chat UI, settings, usage     │
└────────────────────────┘
```

---

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript 5.4+, strict mode | ES2022 target, bundler module resolution |
| Build | esbuild 0.21+ | 4 entry points, sourcemaps in dev |
| Content script | IIFE bundle | Runs in Chrome's ISOLATED world |
| Service worker | ESM bundle | `"type": "module"` in manifest |
| Page bridge | IIFE, MAIN world | For future site adapters |
| AI SDK | Vercel AI SDK (`ai` v6) | `streamText()` for all providers |
| Provider | `@ai-sdk/openai` v3 | Used for OpenRouter and Ollama |
| DOM extraction | `@mozilla/readability` + `turndown` | HTML → clean Markdown |
| Markdown render | `marked` v17 | Streaming markdown in sidepanel |
| Schema | `zod` v4 | Tool parameter schemas |

---

## 4. Complete File-by-File Reference

### 4.1 `src/types/messages.ts` (~42 lines)

Shared type definitions for all cross-context messaging.

**Types:**
- `CSMessage` — Content script → service worker messages:
  - `LANTHRA_PROMPT_SUBMIT` — `{ type, prompt, context, image?, displayPrompt? }` — User submits a prompt. `displayPrompt` is the clean prompt without injected target text (for display in sidepanel).
  - `LANTHRA_CANCEL` — Cancel active stream
  - `LANTHRA_PING` — Health check
  - `LANTHRA_TOOL_RESULT` — `{ type, callId, result }` — DOM tool result
- `SWMessage` — Service worker → content script messages:
  - `LANTHRA_TOKEN` — `{ type, token }` — Streamed text
  - `LANTHRA_STREAM_END` — Stream complete
  - `LANTHRA_ERROR` — `{ type, error }` — Error message
  - `LANTHRA_TOGGLE_ACK` — `{ type, armed }` — Toggle acknowledgement
  - `LANTHRA_TOOL_CALL` — `{ type, callId, toolName }` — AI requests a tool
- `PanelBroadcast` — Service worker → sidepanel broadcasts:
  - `LANTHRA_STATE_UPDATE`, `LANTHRA_CHAT_USER`, `LANTHRA_CHAT_TOKEN`, `LANTHRA_CHAT_END`, `LANTHRA_CHAT_ERROR`, `LANTHRA_TAB_CHANGED`
- `PORT_SESSION_PREFIX = 'lanthra:session:'` — Port name prefix for session ports

### 4.2 `src/shared/logger.ts` (~15 lines)

Simple logging wrapper. Exports `log(level, msg, data?)` which prepends `[Lanthra]` prefix. Used across all contexts.

### 4.3 `src/page-script/bridge.ts` (~40 lines)

Minimal MAIN world bridge script. Only implements PING/PONG via `window.postMessage`. Phase 2 placeholder for future framework-specific hooks (React fiber walking, etc.). Currently not used for any active feature.

---

### 4.4 `src/background/service-worker.ts` (~140 lines)

MV3 service worker entry point (ESM format).

**Key functions and logic:**

- **`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`** — Clicking the extension icon opens the side panel.

- **`chrome.commands.onCommand`** — Listens for `toggle-edit-mode` command (Ctrl+Shift+X). Forwards `LANTHRA_TOGGLE` to the active tab's content script.

- **`prewarmConnection()`** — Called when the sidepanel connects (port name `lanthra:sidepanel`). Pre-warms TLS to OpenRouter (`HEAD` request to base URL) or pings Ollama (`/api/tags` endpoint). This reduces latency on the first real AI request.

- **`purgeStaleChat()`** — On service worker startup, checks `chrome.storage.session` for chat data older than 42 hours and removes it.

- **`broadcastTabInfo()`** — On `tabs.onActivated` and `tabs.onUpdated` (including favIconUrl changes), broadcasts `LANTHRA_TAB_CHANGED` with `{ url, title, favIconUrl }` to the sidepanel.

- **Message handlers:**
  - `LANTHRA_CLOSE_PANEL` → calls `chrome.sidePanel.close()`
  - `LANTHRA_INJECT_CS` → `chrome.scripting.executeScript()` fallback for tabs where the content script wasn't auto-injected

- **Port routing:** All ports whose name starts with `lanthra:session:` are forwarded to `onContentScriptConnect()` in message-router.ts.

### 4.5 `src/background/message-router.ts` (~145 lines)

Routes messages between content script ports, AI client, and sidepanel.

**Key functions:**

- **`onContentScriptConnect(port)`** — Called when a content script opens a session port. Sets up per-session message handling.

- **`createToolExecutor(port)`** — Returns a `ToolExecutor` function that:
  1. Sends `LANTHRA_TOOL_CALL` to the content script port
  2. Waits for `LANTHRA_TOOL_RESULT` with matching `callId`
  3. Has 30-second timeout per tool call
  4. Returns the tool result string

- **Port message handler for `LANTHRA_PROMPT_SUBMIT`:**
  1. Broadcasts `LANTHRA_CHAT_USER` to sidepanel with `displayPrompt ?? prompt` — this ensures the user bubble in the sidepanel shows the clean prompt without injected target text context
  2. Calls `startStream()` with callbacks:
     - `onToken(token)` → sends `LANTHRA_TOKEN` to CS port + broadcasts `LANTHRA_CHAT_TOKEN` to sidepanel
     - `onStreamEnd()` → sends `LANTHRA_STREAM_END` + broadcasts `LANTHRA_CHAT_END`
     - `onError(error)` → sends `LANTHRA_ERROR` + broadcasts `LANTHRA_CHAT_ERROR`
     - `onUsage(usage)` → broadcasts `LANTHRA_USAGE`

- **Port message handler for `LANTHRA_CANCEL`:** Calls `cancelStream(sessionId)`.

- **Port disconnect handler:** Also calls `cancelStream(sessionId)` to ensure cleanup.

### 4.6 `src/background/ai-client.ts` (~530 lines)

The core AI streaming client. All AI requests go through this file.

**Constants:**
- `CACHE_TTL_MS = 30 * 60 * 1000` — 30-minute prompt response cache
- `ADAPTIVE_BLOCK` — A system prompt suffix appended to ALL context modes

**ADAPTIVE_BLOCK (verbatim):**
```
Before generating your final response, use a <think> block to naturally reason through the user's request.
In this space, silently evaluate the necessary verbosity, tone, and complexity required to best answer the prompt.
Plan your approach in natural language, exploring different angles or tool uses if needed.
Pay close attention to explicit cues from the user — words like "detailed", "exhaustive", "in-depth", "explain everything",
"be specific", or "thorough" mean you must provide a comprehensive, long-form response.
Conversely, brief questions like "what is this?" or "tldr" call for concise answers.
Once your reasoning is complete, close the </think> tag and provide your perfectly adapted final response.
Never mention the <think> block or your planning process to the user.
```

**⚠️ KNOWN ISSUE:** The ADAPTIVE_BLOCK is appended to the inline edit system prompt too. For inline edits that should output ONLY transformed text, this block tells the AI to "naturally reason through the user's request" and consider "verbosity, tone, and complexity" — directly contradicting the inline rules that say "Do not explain, Do not analyze, Output only the final transformed text." This likely causes verbose inline responses (e.g., translation producing paragraphs instead of just the translated text).

**Key functions:**

- **`cacheKey(prompt, context)`** — SHA-256 hash of `model::context::prompt` used for response caching.

- **`guardCallbacks(raw)`** — Wraps `StreamCallbacks` to prevent double `onStreamEnd` or `onError` calls. Sets a `let ended = false` flag checked before each callback invocation.

- **`buildModel(provider, model, apiKey, ollamaUrl)`** — Creates a `LanguageModel` via `createOpenAI()`:
  - Ollama: `baseURL = ollamaUrl/v1`, `apiKey = 'ollama'`
  - Others: `baseURL = 'https://openrouter.ai/api/v1'`, with `HTTP-Referer: https://lanthra.app` and `X-Title: Lanthra` headers

- **`buildSystemPrompt(context, hasTools)`** — Generates system prompt based on context prefix. 4 modes:

  1. **`lanthra:page\n`** (side panel chat):
     ```
     You are Lanthra, a Chrome extension AI assistant.
     Page: Title: ...\nURL: ...
     Use the get_page_content tool when the user asks about the page or its contents.
     Never use em dashes.
     [ADAPTIVE_BLOCK]
     ```

  2. **`lanthra:inline\n`** (inline editing):
     ```
     You are Lanthra, an inline AI assistant. You are in inline edit mode.
     The user is editing text that already exists on the page.

     Rules:
     - If context contains Selected Text, Target Text, or Editing near, treat that text as the source text to operate on.
     - If the user says "translate this", "rewrite this", "fix this", "make this shorter", "improve this", or similar, apply the request directly to the source text.
     - Do not explain.
     - Do not analyze.
     - Do not offer multiple options unless the user explicitly asks for options.
     - Do not say "please provide the text" if source text is already present in context.
     - Output only the final transformed text.
     - Preserve emojis, line breaks, and casual tone unless the user asks otherwise.
     - If no usable source text exists at all, ask one short clarification.
     - Never use em dashes.

     Example behavior:
     User: translate this to French
     Context: Editing near: "I can't believe this happened 😂"
     Output: "Je n'arrive pas à croire que c'est arrivé 😂"

     Inline edit mode has higher priority than general chat mode.
     When inline edit mode is active, perform the requested transformation on the detected source text and return only the result.

     Page: Title: ...\nURL: ...\nEditing near: ...\n
     [ADAPTIVE_BLOCK]   ← ⚠️ THIS CONTRADICTS THE RULES ABOVE
     ```

  3. **`lanthra:image`** (image analysis):
     ```
     You are Lanthra, an inline AI assistant.
     Analyze the provided image directly and respond concisely.
     Focus only on what is visible in the image unless the user asks about surrounding context.
     Never use em dashes.
     [ADAPTIVE_BLOCK]
     ```

  4. **Default/fallback** — Generic concise assistant + `ADAPTIVE_BLOCK`

- **`buildTools(executor)`** — Defines 5 tools using Vercel AI SDK `tool()`:
  1. `get_page_content` — Full page Markdown via Readability + Turndown
  2. `get_selected_text` — Window selection text
  3. `get_editor_content` — Web editor content (6 strategies)
  4. `get_pdf_text` — PDF `.textLayer` extraction
  5. `get_page_images` — Up to 20 image URLs from page

- **`doStream(model, systemPrompt, prompt, image, tools, executor, callbacks, abortSignal)`** — Core streaming function:
  1. Calls `streamText()` from Vercel AI SDK with `{ model, system, prompt/messages, tools, maxSteps: 4, abortSignal }`
  2. If image present, sends as `messages` with `{ type: 'image', image: base64 }` content part
  3. Iterates `result.fullStream`:
     - `text-delta` → `callbacks.onToken(textDelta)`
     - `reasoning-delta` (Anthropic extended thinking) → wraps in `<think>` tags and sends as token
     - `reasoning-end` → sends `</think>` token
     - `error` → `callbacks.onError()`
     - `tool-call` / `tool-result` → logged (auto-handled by SDK)
  4. After stream: reports usage, calls `onStreamEnd()`
  5. On abort: silently swallowed
  6. On other error: `callbacks.onError(errorMessage)`

- **`startStream(sessionId, prompt, context, image, toolExecutor, rawCallbacks)`** — Main entry point:
  1. **Cache check** — SHA-256 hash of `model::context::prompt`. If cached (within 30 min), replays tokens immediately and returns.
  2. **Guard callbacks** — Wraps in `guardCallbacks()` to prevent double-end.
  3. **Read settings** from `chrome.storage.local`: provider, model, API key, Ollama URL.
  4. **Validate** — Errors if no API key (cloud) or no model.
  5. **AbortController** — Stored in `active` Map by sessionId.
  6. **Build model** via `buildModel()`.
  7. **Ollama path:**
     - No tools (most local models can't use them)
     - Eagerly fetches page content via `toolExecutor('get_page_content')` before streaming
     - Injects content into system prompt as `\n\n--- Page Content ---\n${content}`
     - Retries up to 2 times on fetch errors (cold start handling)
     - 5-minute timeout (`abortSignal` with 300,000ms)
  8. **Cloud path:**
     - Tools enabled, `maxSteps: 4`
     - 90-second timeout
     - On 404 from tool call → auto-retries without tools (model doesn't support them)
  9. **On success** — Caches full response text with usage stats.
  10. **Error handling:**
      - CORS/network errors → Ollama-specific CORS fix instructions
      - 429 → "Rate limited" message
      - AbortError → silently ignored

- **`cancelStream(sessionId)`** — `AbortController.abort()` + remove from `active` map.

### 4.7 `src/content/index.ts` (~245 lines)

Content script entry point (IIFE, ISOLATED world). Bootstrap and message relay.

**Key logic:**

- **Bootstrap:** Creates `EditSession.current` singleton, registers keyboard toggle handler.

- **Message listener (`chrome.runtime.onMessage`):**
  - `LANTHRA_TOGGLE` → `session.toggleArm()`, responds with `{ armed }` state
  - `LANTHRA_DEACTIVATE` → `session.fullDisarm()`
  - `LANTHRA_PING` → responds `{ ok: true }`
  - `LANTHRA_CANCEL_FROM_PANEL` → **sends explicit `LANTHRA_CANCEL` over the port** before `port.disconnect()`, then nulls the port reference. This ensures the AI stream is cancelled even if the disconnect event races.
  - `LANTHRA_PANEL_PROMPT` → Creates a new `chrome.runtime.Port` with `lanthra:session:<uuid>`, wires port messages to session callbacks (`LANTHRA_TOKEN`, `LANTHRA_STREAM_END`, `LANTHRA_ERROR`, `LANTHRA_TOOL_CALL`), calls `extractPageContent()` for context, forwards prompt to service worker. Responds with `{ sessionId }`.

- **`extractPageContent()`** — Lightweight context extraction: returns `"lanthra:page\nTitle: document.title\nURL: location.href"`. This is NOT the full page content — tools fetch that on demand.

- **`session.onImageSubmit`** — Handles image prompts:
  1. Resizes image via `resizeImageToBase64(imageUrl, maxDim=1024, quality=0.85)` using canvas
  2. If `needsPostContext()` matches prompt, adds post context
  3. Opens port, sends `LANTHRA_PROMPT_SUBMIT` with base64 image

- **`resizeImageToBase64(url, maxDim, quality)`** — Loads image into `<img>`, draws onto `<canvas>` at reduced size, calls `canvas.toDataURL('image/jpeg', quality)`. Returns raw base64 (strips `data:...;base64,` prefix).

- **`needsPostContext(text)`** — Regex check: `/\b(this post|the article|the post|the caption|the tweet|this tweet|the comment|this comment)\b/i`

### 4.8 `src/content/edit-session.ts` (~1350 lines)

The core inline editing state machine. This is the largest and most complex file.

**State machine:** `idle → armed → editing → streaming → armed`

**Key exports:** `EditSession` class (singleton via `EditSession.current`), `extractPostText()` function.

**State transitions (`transition(newState)`):**
- Updates internal `state` field
- Broadcasts `LANTHRA_STATE_UPDATE` with new state via `chrome.runtime.sendMessage`
- States: `'idle'`, `'armed'`, `'editing'`, `'streaming'`

**`arm()`:**
- Creates full-viewport transparent overlay (`armOverlay`) with crosshair cursor
- Attaches listeners: click, mouseover, mouseout, mousemove, keydown
- Tracks scroll position to detect page scrolls

**`cancel()`:**
- If streaming: sends `LANTHRA_CANCEL` over port, disconnects port
- Destroys inline host
- Stays in armed state

**`fullDisarm()`:**
- If a host is in "done" mode (showing completed output): preserves it, transitions to idle
- Otherwise: full cleanup (remove host, overlay, listeners), transition to idle

**`onPageClick(e)`:**
- Image click detection: checks for `<img>` or CSS `background-image` → `showImagePrompt()`
- Done host click detection: if clicking on a completed host → `reEdit()`
- Standard text hit: calls `hitTest(x, y)` → `insertHost()`
- The overlay captures clicks and delegates based on what was clicked through

**`insertHost(x, y)`:**
- Calls `insertAnchorAtPoint(x, y)` from range-utils.ts to split text node and insert anchor
- Creates `InlineHost` with `mirrorStylesFrom()` for chameleon typography
- Sets up `MutationGuard` for orphan detection
- Transitions to `editing` state
- Registers callbacks: `host.onSubmit = (prompt) => submitPrompt(prompt)`, `host.onCancel = () => cancel()`

**`submitPrompt(prompt)` — CRITICAL FUNCTION:**
1. Calls `buildContext()` which returns `{ context: string, extractedText: string }`
2. Checks `TARGET_PRONOUNS` regex: `/\b(this|it|that|the\s+text|the\s+post|the\s+caption|the\s+content)\b/i`
3. If the user's prompt matches a pronoun AND `extractedText` exists:
   - `finalPrompt = prompt + "\n\nTarget text to modify:\n\"\"\"\n" + extractedText + "\n\"\"\""`
   - Sets `displayPrompt = prompt` (the original clean prompt for sidepanel display)
4. Opens `chrome.runtime.Port` with session ID
5. Sends `LANTHRA_PROMPT_SUBMIT` with `{ prompt: finalPrompt, context, displayPrompt? }`
6. Host enters streaming mode, state transitions to `streaming`

**`buildContext()` — CRITICAL FUNCTION:**
1. **Priority 1: User selection** — `window.getSelection()?.toString()` if > 5 chars. This OVERRIDES everything else.
2. **Priority 2: Container detection** — 4-tier system:
   - Tier 1: Social media selectors (Instagram `article`, Twitter `[data-testid="tweetText"]`, Facebook `[role="article"]`, LinkedIn `feed-shared-update-v2`, Reddit `shreddit-post`)
   - Tier 2: Semantic elements (`article`, `section`, `main`, `blockquote`)
   - Tier 3: Walk-up divs searching for the "tightest block" ancestor containing meaningful text
   - Tier 4: Fallback to `document.body`
3. **Priority 3: Text extraction** — Calls `extractCleanText(container, 2000)` via TreeWalker (NOT `innerText`)
4. Returns `{ context: "lanthra:inline\nTitle: ...\nURL: ...\nEditing near: \"<extractedText>\"", extractedText }`

**`onToken(token)` (stream callback):**
- Filters `<think>` blocks from inline display using a state machine (`inThinkBlock` flag)
- Passes non-think tokens to `host.appendToken(token)`

**`onStreamEnd()` (stream callback):**
- If empty output: cleanup host, stay armed
- If output exists: `host.enterDoneMode()`, transition back to armed

**`onError(error)` (stream callback):**
- Shows error briefly, cleans up host

**Image analysis subsystem:**
- `showImagePrompt(imageEl, imageUrl)` — Positions a floating prompt overlay near the image
- `showImageResponse(imageEl)` — Creates an InlineHost in block mode inserted near the image via `findPostInsertionPoint()`
- `appendImageResponseToken(token)` — Forwards tokens to the image response host
- `endImageResponse()` — Finalizes the image response
- Image responses include full markdown rendering via `renderImageMarkdown()`

**Visual affordances:**
- `hoverOutline` — Dashed border around hovered elements when armed
- `imageHighlight` — Orange border around images when armed
- `insertionCaret` — Animated blinking caret at mouse position when over text
- `armOverlay` — Full-viewport transparent overlay (pointer-events: none for pass-through)

**Utility functions:**
- `resolveImageUrl(img)` — Tries `currentSrc`, `data-src`, srcset first entry, `<picture><source>` srcset, `img.src`
- `resolveBackgroundImage(el)` — Extracts URL from `getComputedStyle().backgroundImage`
- `findPostInsertionPoint(imageEl)` — Platform-aware: X/Twitter, Facebook, Instagram, Reddit, YouTube, LinkedIn, generic fallback. Finds the best DOM position to inject AI response text near an image.
- `findLastTextBlock(container, imageEl)` — Finds last child element with >5 chars of text (not inside the image)
- `extractPostText(imageEl)` — Extracts visible text from the post container surrounding an image (2000 char cap)
- `renderImageMarkdown(text)` — Full markdown renderer for image responses: strips `<think>` blocks, converts LaTeX inline math to Unicode symbols, escapes HTML (XSS prevention), renders code blocks, bold, italic, headings, lists, line breaks

### 4.9 `src/content/inline-host.ts` (~400 lines)

The contenteditable span lifecycle manager. 3 phases: prompt → streaming → done.

**Constructor:**
- Creates `<span contenteditable data-lanthra-host>` with mirrored styles via `mirrorStylesFrom()`
- Adds hover effects, send/stop action buttons
- Registers event listeners: keydown (Enter/Escape), composition events (IME safety), paste (plain text only)

**Prompt phase:**
- User types into the contenteditable span
- Enter → calls `onSubmit(prompt)` callback
- Escape → calls `onCancel()` callback
- Send button (arrow icon) also triggers submit

**Streaming phase (`enterStreamingMode()`):**
- Disables contenteditable
- Shows "Thinking..." indicator text
- Shows red stop button (■ square icon)
- Attaches document-level Escape handler for cancel during streaming

**`appendToken(token)`:**
- Buffers incoming tokens
- Removes "Thinking..." indicator on first real token
- Appends text directly to the host span

**Done phase (`enterDoneMode()`):**
- Strips markdown formatting from the output: bold (`**`), italic (`*`), code (`` ` ``), headings (`#`), links (`[text](url)` → `text`)
- Strips LaTeX inline math: converts common symbols to Unicode (e.g., `\alpha` → `α`, `\rightarrow` → `→`)
- Hover affordance: subtle outline on hover
- Click → `reEdit()`: resets to prompt phase, clears output, shows send button

**`reEdit()`:**
- Resets to prompt phase
- Clears the current output text
- Shows send button again
- User can type a new prompt

**`destroy()`:**
- Removes all event listeners and DOM elements

### 4.10 `src/content/hit-test.ts` (~90 lines)

Click targeting for inline host insertion.

- **`hitTest(x, y)`** — Uses `document.caretRangeFromPoint(x, y)` to get a Range at the click position. Returns `{ element, isTextHit }`.
- **`BLOCKED_TAGS`** — Set of tags that should never receive inline hosts: `SCRIPT, STYLE, INPUT, TEXTAREA, SELECT, VIDEO, AUDIO, CANVAS, SVG, MATH, IFRAME, NOSCRIPT, TEMPLATE, OBJECT, EMBED, APPLET, MAP, WBR`
- **Filters out:** Lanthra elements (`data-lanthra-*`), page-owned editables (`contenteditable`), invisible elements (zero-size, `display:none`, `visibility:hidden`)

### 4.11 `src/content/range-utils.ts` (~130 lines)

Low-level DOM manipulation for anchor insertion.

- **`insertAnchorAtPoint(x, y)`** — Gets Range via `caretRangeFromPoint`, splits Text node at offset via `textNode.splitText(offset)`, inserts `<span data-lanthra-anchor>` between the two halves.
- **`removeAnchor(anchor)`** — Removes the anchor span, calls `parent.normalize()` to merge split text nodes back together.
- **`commitAnchor(anchor, text)`** — Converts anchor to committed inline span with final text content.

### 4.12 `src/content/style-mirror.ts` (~90 lines)

Typography cloning for chameleon mode.

- **`mirrorStylesFrom(el)`** — Copies 14+ CSS properties from `getComputedStyle()`: `fontFamily, fontSize, fontWeight, fontStyle, fontVariant, letterSpacing, wordSpacing, textTransform, textIndent, lineHeight, color, textAlign, whiteSpace, direction`
- **`nearestBlockAncestor(el)`** — Walks up the DOM tree to find the nearest block/flex/grid parent.

### 4.13 `src/content/mutation-guard.ts` (~55 lines)

Protects against SPA re-renders that remove the anchor from the DOM.

- Creates a `MutationObserver` on the anchor's nearest block root
- Watches for `childList` mutations with `subtree: true`
- If the anchor is no longer in `document.body` → calls `onOrphaned` callback
- The orphaned callback triggers cleanup of the editing session

### 4.14 `src/content/selection-store.ts` (~55 lines)

Saves and restores the user's text selection.

- **`saveSelection()`** — Captures `window.getSelection()` ranges
- **`restoreSelection()`** — Restores previously saved selection
- **`clearSelection()`** — Clears the save

### 4.15 `src/content/keyboard.ts` (~45 lines)

Global keyboard shortcut listener.

- Listens for `Ctrl+Shift+X` (Windows) or `Cmd+Shift+X` (Mac)
- Calls the registered toggle callback

### 4.16 `src/content/page-tools.ts` (~600 lines)

DOM extraction tools executed in the content script context (has full DOM access).

**`executePageTool(toolName)`** — Dispatcher that routes to the correct tool function.

**Tool functions:**

1. **`toolGetPageContent()`** — The master DOM extractor:
   - Clones entire document: `document.cloneNode(true)`
   - Runs `new Readability(clone).parse()` to extract main article content
   - Converts HTML to Markdown via `TurndownService.turndown()`
   - Caps at 15,000 characters
   - Enrichment pipeline:
     - `extractCompactMetadata()` — OG tags, JSON-LD, aria-label engagement stats
     - `extractSocialProfile()` — Platform-specific profile extraction (Instagram, X/Twitter, Facebook, LinkedIn, TikTok, Reddit) — name, bio, stats, avatar, links, verified badge
     - `extractInfobox()` — Wikipedia infobox table data
     - `extractComments()` — `role="comment"` + fallback selectors, max 25 comments
     - `extractTopLinks()` — `<a href>` elements, up to 30 links
   - Fallback: `document.body.innerText` if Readability returns nothing

2. **`toolGetEditorContent()`** — 6 strategies for web editors:
   - Strategy 1: `contenteditable` elements
   - Strategy 2: Google Docs (`kix-lineview` class)
   - Strategy 3: `aria-label` textboxes
   - Strategy 4: `role="textbox"` elements
   - Strategy 5: 14+ editor-specific selectors: ProseMirror, Quill, CodeMirror, Monaco, TinyMCE, CKEditor, Draft.js, Ace, Slate, Notion
   - Strategy 6: Same-origin iframe scanning

3. **`toolGetSelectedText()`** — Returns `window.getSelection().toString()`

4. **`toolGetPageImages()`** — 3 image sources:
   - `<img>` elements (with srcset best resolution)
   - `<picture><source>` elements
   - `<video poster>` attributes
   - Max 20 images returned

5. **`toolGetPdfText()`** — PDF viewer extraction:
   - Finds `.textLayer span` elements
   - Page-number aware extraction

**`extractCleanText(root, maxLen)` — TreeWalker-based text extraction:**
- Creates `document.createTreeWalker(root, NodeFilter.SHOW_ALL)`
- **NodeFilter rejects:** SVG, BUTTON, INPUT, TEXTAREA, SELECT, SCRIPT, STYLE, NAV, HEADER, FOOTER, hidden elements (`display:none`, `visibility:hidden`, `opacity:0`), whitespace-only text nodes
- Extracts up to `maxLen` characters (default 2000)
- This is the function used by inline editing context extraction. It avoids invisible UI elements, navigation, footers, etc. that previously polluted the 2000-char window.

---

### 4.17 `src/sidepanel/sidepanel.ts` (~1480 lines)

The full sidepanel UI logic. The largest file in the project.

**DOM references:** ~50+ element references obtained via `document.getElementById`.

**Custom dropdown system:**
- `createDropdown(wrap, trigger, dropdown, onChange)` — Creates a dropdown state object
- `setDropdownValue(dd, value, label)` — Sets selected value
- `populateDropdown(dd, items, showSearch)` — Populates with options, optional search filter
- Dropdowns are used for provider and model selection

**Model fetching:**
- `fetchAllModels()` — Fetches from OpenRouter API (`https://openrouter.ai/api/v1/models`)
  - 24-hour cache in `chrome.storage.local` (key: `lanthra_model_cache`)
  - Hardcoded fallback model list for offline use
  - Sorts by provider-defined order
- `populateOllamaModels()` — Fetches from Ollama local API (`/api/tags` endpoint)

**Provider system:**
- `PROVIDER_ORDER` — Array of 16 providers in display order
- `PROVIDER_LABELS` — Display names for each provider
- `buildProviderKeys(models)` — Extracts unique providers from fetched models
- `populateProviders()` / `populateModels(providerKey)` — Populate dropdowns
- `toggleProviderUI(provider)` — Shows/hides Ollama-specific or API key-specific settings

**State management:**
- `currentState: PanelState` — idle/armed/editing/streaming (mirrors CS state)
- `panelStreamingActive: boolean` — Whether a panel-initiated stream is active (separate from CS state!)
- `streamingTabId: number | null` — Tab ID where the current stream is running
- `panelStreamSessionId: string | null` — Session ID for filtering stale broadcasts
- `skipNextUserEcho: boolean` — Prevents duplicate user bubble when panel sends a prompt

**`updateUI(state)`:**
- Updates status badge text and CSS class
- Updates toggle button text ("Activate Edit" vs "Activated")
- Updates send/stop button: when `panelStreamingActive` is true, shows red stop icon (■) instead of send arrow
- Updates tab context streaming indicator
- Calls `syncInputState()`

**Chat rendering:**
- `addUserMessage(text)` — Creates user bubble + shows thinking indicator
- `startAIMessage()` — Creates AI bubble with `streaming` class and typing cursor
- `appendAIToken(token)` — Core streaming token handler:
  - Parses `<think>`/`</think>` tags in the token stream
  - Thinking content → routed to a collapsible `<details>` dropdown
  - Normal content → accumulated in `streamingMarkdownBuffer`, re-rendered with `marked.parse()` on each token
- `endAIMessage()` — Finalizes: removes cursor, removes `streaming` class, preserves thinking dropdown, records in history
- `addErrorMessage(error)` — Red error bubble

**Thinking block rendering:**
- When `<think>` is detected in the token stream, a `<details>` element is created with:
  - `<summary>` with "Thinking..." label and arrow icon
  - Content div that accumulates thinking text
- When `</think>` is detected, thinking dropdown is finalized and normal content rendering resumes
- The thinking dropdown is preserved in the final message

**Streaming markdown:**
- `streamingMarkdownBuffer` accumulates all non-thinking tokens
- On each token: full buffer is re-rendered with `marked.parse(processed, { async: false })`
- Before rendering: em dashes stripped, LaTeX inline math converted to Unicode symbols
- `renderMarkdown(text)` — Full markdown pipeline: em-dash strip → LaTeX → `marked.parse()`

**`handleSendOrStop()` — Main send/stop handler:**
- **Stop path:** If `panelStreamingActive`:
  1. Sends `LANTHRA_CANCEL_FROM_PANEL` to the streaming tab
  2. Resets all streaming state
  3. Calls `endAIMessage()` + `hideThinkingIndicator()`
  4. Updates UI to current state
- **Send path:**
  1. Shows user bubble immediately
  2. Sets `panelStreamingActive = true`, `streamingTabId = tab.id`
  3. Updates UI to show stop button
  4. Sends `LANTHRA_PANEL_PROMPT` to content script
  5. Captures `sessionId` from response
  6. On failure: resets state, shows error

**Message listener (`chrome.runtime.onMessage`):**
- `LANTHRA_STATE_UPDATE` — Updates badge/toggle visuals, re-applies send/stop button based on `panelStreamingActive`
- `LANTHRA_TOGGLE_ACK` — Updates armed/idle state
- `LANTHRA_CHAT_USER` — Shows user bubble (skipped if `skipNextUserEcho` is true)
- `LANTHRA_CHAT_TOKEN` — If not already streaming, sets `panelStreamingActive = true`. Tracks session ID. Calls `appendAIToken()`.
- `LANTHRA_CHAT_END` — **Filters stale sessions:** If `panelStreamSessionId` doesn't match `msg.sessionId`, ignores the message. Resets streaming state. If `msg.isPanelPrompt`, deactivates content script.
- `LANTHRA_CHAT_ERROR` — Same stale session filtering. Shows error.
- `LANTHRA_USAGE` — Calls `recordUsage()`
- `LANTHRA_TAB_CHANGED` — Updates tab context display (hostname, title, favicon)

**Settings:**
- API key saved to `chrome.storage.local` (masked with `••••••••••`)
- Provider/model dropdowns with persistence
- Ollama URL with test button and CORS help display

**Ollama helpers:**
- `toggleProviderUI(provider)` — Shows Ollama endpoint section or API key section
- `populateOllamaModels()` — Fetches models from Ollama API, handles CORS errors
- `showOllamaCorsHelp()` — Displays platform-specific CORS fix instructions (PowerShell for Windows, env var for Mac/Linux)

**Usage tracking:**
- `recordUsage(promptTokens, completionTokens)` — Persists per-model usage to `chrome.storage.local`
- `renderUsageTab()` — Shows total requests, prompt/completion/total tokens, per-model breakdown sorted by total tokens

**Chat history persistence:**
- Uses `chrome.storage.session` (survives panel toggles, cleared on browser close)
- `appendToHistory(role, content)` — Adds to in-memory array + persists
- `persistChat()` — Writes `{ messages, lastInteraction }` to storage
- `restoreChatHistory()` — On init, replays cached messages into the UI. Purges if idle >42 hours.
- `clearChatHistory()` — Clear confirmation with glass-blur backdrop overlay

**Page status:**
- `checkPageStatus()` — Pings content script. If not reachable, tries `LANTHRA_INJECT_CS`. Shows "Ready" or "N/A" badge.
- Checks for `chrome://`, `about:`, `file://` URLs that extensions can't access
- Re-checks on `tabs.onActivated`

**Other UI features:**
- Close panel: `chrome.sidePanel.close()` (Chrome 141+), also Ctrl+. shortcut
- Escape while armed → deactivate edit mode
- Chat input auto-resize (max 120px height)
- Scroll-to-bottom button (appears when >100px from bottom)
- Settings modal with tab switching (Settings / Usage)
- Shortcut display: shows `⌘+Shift+X` on Mac, `Ctrl+Shift+X` on Windows

**`init()`:**
1. Connects to service worker to trigger TLS pre-warming
2. Creates provider/model dropdown states
3. Fetches models
4. Populates provider dropdown, loads saved provider
5. Enables chat input
6. Restores chat history
7. Checks page compatibility
8. Seeds tab context badge

---

## 5. Messaging Protocol (Complete)

### 5.1 Content Script ↔ Service Worker (via chrome.runtime.Port)

Each editing session opens a dedicated port named `lanthra:session:<uuid>`.

| Direction | Message Type | Payload | Purpose |
|---|---|---|---|
| CS → SW | `LANTHRA_PROMPT_SUBMIT` | `{ prompt, context, image?, displayPrompt? }` | Submit prompt to AI |
| CS → SW | `LANTHRA_CANCEL` | `{}` | Cancel active stream |
| CS → SW | `LANTHRA_TOOL_RESULT` | `{ callId, result }` | Tool execution result |
| SW → CS | `LANTHRA_TOKEN` | `{ token }` | Streamed text token |
| SW → CS | `LANTHRA_STREAM_END` | `{}` | Stream complete |
| SW → CS | `LANTHRA_ERROR` | `{ error }` | Error message |
| SW → CS | `LANTHRA_TOOL_CALL` | `{ callId, toolName }` | AI requests a tool |

### 5.2 Service Worker → Side Panel (via chrome.runtime.sendMessage)

| Message Type | Payload | Purpose |
|---|---|---|
| `LANTHRA_STATE_UPDATE` | `{ state }` | CS state changed |
| `LANTHRA_CHAT_USER` | `{ prompt, sessionId }` | User prompt (uses `displayPrompt ?? prompt`) |
| `LANTHRA_CHAT_TOKEN` | `{ token, sessionId }` | Mirror streamed token |
| `LANTHRA_CHAT_END` | `{ sessionId, isPanelPrompt }` | Stream complete |
| `LANTHRA_CHAT_ERROR` | `{ error, sessionId }` | Error |
| `LANTHRA_USAGE` | `{ promptTokens, completionTokens }` | Token usage |
| `LANTHRA_TAB_CHANGED` | `{ url, title, favIconUrl }` | Active tab changed |
| `LANTHRA_TOGGLE_ACK` | `{ armed }` | Toggle acknowledgement |

### 5.3 Side Panel → Content Script (via chrome.tabs.sendMessage)

| Message Type | Purpose |
|---|---|
| `LANTHRA_TOGGLE` | Toggle edit mode |
| `LANTHRA_DEACTIVATE` | Deactivate edit mode |
| `LANTHRA_PANEL_PROMPT` | Send chat prompt from panel |
| `LANTHRA_CANCEL_FROM_PANEL` | User clicked stop in panel |
| `LANTHRA_PING` | Health check |

### 5.4 Content Script / Side Panel → Service Worker (via chrome.runtime.sendMessage)

| Message Type | Purpose |
|---|---|
| `LANTHRA_CLOSE_PANEL` | Close the side panel |
| `LANTHRA_INJECT_CS` | Inject content script via scripting API |

---

## 6. Data Flow for Each User Action

### 6.1 Inline Edit Flow (user clicks text, types prompt, gets transformed text)

```
1. User clicks text on page
2. edit-session.ts: onPageClick() → hitTest(x,y) → insertHost()
3. range-utils.ts: insertAnchorAtPoint() — splits text node, inserts anchor
4. inline-host.ts: creates <span contenteditable> with mirrored styles
5. User types prompt, presses Enter
6. edit-session.ts: submitPrompt(prompt)
   a. buildContext() → extractCleanText() via TreeWalker (2000 char max)
   b. Check TARGET_PRONOUNS — if match, inject target text into prompt
   c. Open port "lanthra:session:<uuid>"
   d. Send LANTHRA_PROMPT_SUBMIT { prompt: finalPrompt, context: "lanthra:inline\n...", displayPrompt? }
7. service-worker.ts: routes port to message-router.ts
8. message-router.ts:
   a. Broadcast LANTHRA_CHAT_USER { displayPrompt ?? prompt } to sidepanel
   b. Call ai-client.ts startStream()
9. ai-client.ts:
   a. Cache check (SHA-256 hash of model::context::prompt)
   b. Build system prompt with "lanthra:inline" context mode + ADAPTIVE_BLOCK
   c. Build model via createOpenAI()
   d. Call streamText() — for inline, tools are available (cloud) or content eagerly fetched (Ollama)
   e. Stream tokens back via callbacks
10. Tokens flow: ai-client → message-router → CS port → edit-session.onToken()
11. edit-session.ts: filters <think> blocks, forwards to inline-host.appendToken()
12. inline-host.ts: appends text to contenteditable span
13. On stream end: inline-host.enterDoneMode() — strips markdown, returns to armed state
```

### 6.2 Side Panel Chat Flow

```
1. User types in chat input, presses Enter
2. sidepanel.ts: handleSendOrStop()
   a. Shows user bubble immediately
   b. Sets panelStreamingActive = true
   c. Sends LANTHRA_PANEL_PROMPT to content script
3. index.ts (content script):
   a. Opens port "lanthra:session:<uuid>"
   b. Sends LANTHRA_PROMPT_SUBMIT { prompt, context: "lanthra:page\n..." }
   c. Responds with { sessionId }
4. Same flow as inline: message-router → ai-client → streamText()
5. Tokens broadcast to sidepanel via LANTHRA_CHAT_TOKEN
6. sidepanel.ts: appendAIToken() — parses <think> tags, renders markdown
7. On LANTHRA_CHAT_END: endAIMessage(), reset streaming state
```

### 6.3 Image Analysis Flow

```
1. User clicks image while armed
2. edit-session.ts: showImagePrompt(imageEl, imageUrl)
3. User types prompt in overlay, presses Enter
4. index.ts: onImageSubmit callback
   a. resizeImageToBase64() — canvas resize to 1024px max
   b. Opens port, sends LANTHRA_PROMPT_SUBMIT { prompt, context: "lanthra:image", image: base64 }
5. ai-client.ts: sends as messages with image content part + "lanthra:image" system prompt
6. Tokens flow to edit-session.ts: appendImageResponseToken()
7. Response rendered via renderImageMarkdown() in a block-level InlineHost near the image
```

### 6.4 Cancel/Stop Flow

```
Panel stop button clicked:
1. sidepanel.ts: handleSendOrStop() (stop path)
2. Sends LANTHRA_CANCEL_FROM_PANEL to content script tab
3. index.ts: receives message
   a. Sends explicit LANTHRA_CANCEL over the port (ensures AI cancellation)
   b. port.disconnect()
4. message-router.ts: cancelStream(sessionId) via both LANTHRA_CANCEL and port disconnect
5. ai-client.ts: AbortController.abort()
6. sidepanel.ts: resets panelStreamingActive, calls endAIMessage()

Inline Escape key:
1. keyboard or inline-host Escape handler
2. edit-session.ts: cancel()
3. Sends LANTHRA_CANCEL over port
4. ai-client.ts: AbortController.abort()
```

---

## 7. Inline Editing State Machine (Detailed)

```
idle → armed → editing → streaming → armed (output stays visible)
  ↑      ↓        ↓         ↓          ↓
  └──────┴────────┴─────────┴──────────┘ (cancel/escape → idle)
```

### States

- **idle** — No session. Extension icon shows default. No overlay, no listeners (except keyboard shortcut).
- **armed** — Full-viewport transparent overlay. Crosshair cursor. Hover outlines. Image highlights. Click to insert host.
- **editing** — Host is active. User types prompt. Enter submits. Escape cancels.
- **streaming** — AI tokens streaming into host. Host read-only. "Thinking..." indicator. Stop button visible. `<think>` blocks filtered.
- After streaming: state returns to **armed**. Output stays visible as clickable text. Click output → re-edit.

---

## 8. Context System (Detailed)

### 8.1 Side Panel Context (`lanthra:page`)
- Only page metadata sent: `Title: document.title\nURL: location.href`
- AI uses tools (`get_page_content`, `get_selected_text`, etc.) on-demand
- Ollama: page content eagerly fetched and injected into system prompt

### 8.2 Inline Edit Context (`lanthra:inline`)
- `buildContext()` extracts text via TreeWalker (`extractCleanText(container, 2000)`)
- Selection > Container detection > TreeWalker extraction
- Context sent as: `lanthra:inline\nTitle: ...\nURL: ...\nEditing near: "...extracted text..."`
- If user prompt contains pronouns ("this", "it", "that", etc.), extracted text is also appended to the prompt itself as `Target text to modify: """..."""`

### 8.3 Image Context (`lanthra:image`)
- Image sent as base64 in message content
- Optional post context if prompt mentions "this post", "the article", etc.

---

## 9. Build System

esbuild config in `esbuild.config.mjs`:

| Entry Point | Output | Format | Notes |
|---|---|---|---|
| `src/content/index.ts` | `dist/content.js` | IIFE | Content script, ISOLATED world |
| `src/sidepanel/sidepanel.ts` | `dist/sidepanel.js` | IIFE | Side panel page |
| `src/background/service-worker.ts` | `dist/service-worker.js` | ESM | MV3 service worker |
| `src/page-script/bridge.ts` | `dist/page-bridge.js` | IIFE | MAIN world bridge |

Target: `chrome120`. All dependencies bundled inline. Watch mode available via `--watch` flag.

---

## 10. Chrome Extension Manifest

- **Manifest version:** 3
- **Permissions:** `activeTab`, `tabs`, `scripting`, `storage`, `sidePanel`
- **Host permissions:** `<all_urls>`
- **Commands:** `toggle-edit-mode` → `Ctrl+Shift+X`
- **Content script:** Runs at `document_idle`, main_frame only
- **Side panel:** `sidepanel.html`
- **Service worker:** `dist/service-worker.js` (ESM)

---

## 11. UI Theme (sidepanel.css)

Dark theme with CSS custom properties:
- `--bg: #2b2a27` (background)
- `--surface: #353430` (cards/panels)
- `--surface-2: #3e3d38` (elevated surfaces)
- `--border: #4a4940`
- `--text: #e8e6e1` (primary text)
- `--text-dim: #a8a69f` (secondary text)
- `--accent: #c4956a` (warm gold, used for active states)
- `--success: #7dba6a` (green, streaming indicator)
- `--warning: #d4a84b` (amber, armed state)
- `--danger: #d16054` (red, errors and stop button)

---

## 12. Storage Keys

| Key | Storage | Purpose |
|---|---|---|
| `lanthra_api_key` | local | OpenRouter API key |
| `lanthra_provider` | local | Selected provider ID |
| `lanthra_model` | local | Selected model ID |
| `lanthra_ollama_url` | local | Ollama endpoint URL |
| `lanthra_model_cache` | local | Cached model list from OpenRouter (24h TTL) |
| `lanthra_usage` | local | Per-model usage stats |
| `lanthra_active_chat` | session | Active chat messages (42h TTL) |
| `lanthra_chat_history` | local | Legacy chat history (cleared on clear) |

---

## 13. Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ai` | v6 | Vercel AI SDK core — `streamText()`, `tool()` |
| `@ai-sdk/openai` | v3 | OpenAI-compatible provider for OpenRouter + Ollama |
| `@mozilla/readability` | latest | Mozilla's article extraction algorithm |
| `turndown` | latest | HTML → Markdown converter |
| `marked` | v17 | Markdown → HTML renderer (sidepanel streaming) |
| `zod` | v4 | Schema validation for tool parameters |
| `esbuild` | dev | TypeScript bundler |
| `typescript` | dev | Type checking |
| `@types/chrome` | dev | Chrome extension API types |
| `@types/turndown` | dev | Turndown type definitions |

---

## 14. Known Issues and Broken Logic

### 14.1 ADAPTIVE_BLOCK Contradicts Inline Edit Rules (CRITICAL)

**Problem:** The `ADAPTIVE_BLOCK` is appended to ALL system prompts including `lanthra:inline`. For inline edits, the rules explicitly say:
- "Do not explain"
- "Do not analyze"
- "Output only the final transformed text"

But the `ADAPTIVE_BLOCK` tells the AI:
- "naturally reason through the user's request"
- "evaluate the necessary verbosity, tone, and complexity"
- "Plan your approach in natural language"

**Result:** Translation or rewriting prompts produce verbose paragraphs instead of just the transformed text. The `<think>` content is filtered from inline display, but the ADAPTIVE_BLOCK encourages the model to produce verbose final output too because it says to "evaluate the necessary verbosity" — the model may decide the output needs to be verbose.

**Fix needed:** Either remove ADAPTIVE_BLOCK from the inline prompt, or replace it with a short instruction like "Output only the transformed text, no explanation."

### 14.2 Prompt Injection Approach for Inline Context

**Current approach:** When the user's prompt contains pronouns like "this", "it", "that" (via `TARGET_PRONOUNS` regex), the extracted text is appended to the prompt:
```
translate this to French

Target text to modify:
"""
I can't believe this happened 😂
"""
```

**Potential issues:**
- The pronoun regex is very broad — "it" matches many prompts that don't reference surrounding text
- The `displayPrompt` mechanism hides the injected text from the sidepanel, but the AI sees the full prompt
- If `extractCleanText()` captures irrelevant content (e.g., from a wrong container), the AI gets confused

### 14.3 buildContext() Container Detection

The 4-tier container detection system may select wrong containers on complex pages:
- Tier 1 social selectors are hardcoded and may break on DOM changes
- Tier 3 walk-up-divs may select too large a container
- The 2000-char limit on `extractCleanText()` may truncate important text while including noise

### 14.4 Response Cache May Serve Stale Results

The 30-minute cache uses `SHA-256(model::context::prompt)` as key. If the page content changes (e.g., new comments loaded) but the context string is the same (title+URL for page mode), the cache serves the old response. The cache key for inline edit mode includes the extracted text, so it's more resilient.

### 14.5 No Multi-Turn Conversation for Inline Edits

Inline edits are single-turn only — each prompt creates a fresh session. The AI has no memory of previous inline edits on the same page. The sidepanel chat also appears to be single-turn from the AI's perspective (no message history sent to the API), though the sidepanel UI displays history.

---

## 15. Error Handling Summary

| Scenario | Behavior |
|---|---|
| No API key | "No API key saved" error message |
| Ollama not running / CORS | Platform-specific CORS fix instructions |
| Rate limited (429) | User-friendly message |
| Model doesn't support tools | Auto-retry without tools (cloud only) |
| Ollama cold start timeout | Up to 2 retries on fetch errors |
| Stream timeout | 90s cloud, 5min Ollama |
| Abort / cancel | Clean cancel via AbortController, abort errors silently swallowed |
| Content script not injected | Error on page, tries `scripting.executeScript` fallback |
| SPA re-renders remove anchor | MutationObserver detects → cleanup |
| Double onStreamEnd | `guardCallbacks()` prevents |
| Stale session broadcasts | Session ID filtering in sidepanel |

---

## 16. Key Design Decisions

1. **Vercel AI SDK over manual SSE** — Unified streaming API handles all providers, tool calling, multi-step reasoning.
2. **@ai-sdk/openai for everything** — Both OpenRouter and Ollama speak OpenAI-compatible API.
3. **Lazy context via tools (cloud) vs eager injection (local)** — Saves tokens for cloud, ensures context for local.
4. **Readability + Turndown** — Produces clean Markdown from messy pages.
5. **Port-per-session** — Clean session isolation and per-session cancellation.
6. **Text node splitting** — Smallest possible DOM mutation for anchor insertion.
7. **Thinking dropdown** — `<think>` tags rendered in collapsible `<details>`.
8. **Guard callbacks** — Prevents double `onStreamEnd`/`onError`.
9. **TreeWalker extraction** — `extractCleanText()` uses `NodeFilter` to skip invisible elements, buttons, nav, etc.
10. **displayPrompt** — Separates what the AI sees (with injected target text) from what the sidepanel shows (clean prompt).
11. **Session ID tracking** — Prevents stale broadcasts from previous sessions from corrupting the UI.