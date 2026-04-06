# Lanthra Extension — Architecture & Logic Context

> Last updated: 2026-04-05

## Product Overview

Lanthra is a Chrome MV3 browser extension that provides two modes of AI interaction:

1. **Inline editing** — Click anywhere on a webpage to insert an invisible contenteditable span that matches surrounding typography. Type a prompt, press Enter, and AI output streams directly into the page. The text reflows naturally as if native.

2. **Side panel chat** — A persistent side panel (Chrome Side Panel API) for conversational AI. Supports multi-turn chat, image analysis, thinking/reasoning dropdowns, and settings management.

Both modes share a single AI streaming backend and tool-calling system.

---

## Architecture

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

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript 5.4+, strict mode | ES2022 target, bundler module resolution |
| Build | esbuild 0.21+ | 4 entry points, sourcemaps in dev |
| Content script | IIFE bundle | Runs in Chrome's ISOLATED world |
| Service worker | ESM bundle | `"type": "module"` in manifest |
| Page bridge | IIFE, MAIN world | For future site adapters |
| AI SDK | Vercel AI SDK (`ai` v6) | `streamText()` for all providers |
| Provider | `@ai-sdk/openai` | Used for OpenRouter and Ollama |
| DOM extraction | `@mozilla/readability` + `turndown` | HTML → clean Markdown |
| Schema | `zod` | Tool parameter schemas |

---

## AI Provider System

All AI requests route through a single `startStream()` function in `ai-client.ts`.

### Providers

All providers use `@ai-sdk/openai` (OpenAI-compatible endpoints):

- **OpenRouter** (default) — Routes to 200+ cloud models including Anthropic, OpenAI, Google, etc. Base URL: `https://openrouter.ai/api/v1`. Requires API key.
- **Ollama** (local) — Connects to local Ollama instance via its OpenAI-compatible `/v1` endpoint. No API key needed. Supports any pulled model.

### Provider Selection

The active provider, model, and API key are stored in `chrome.storage.local` under keys: `lanthra_provider`, `lanthra_model`, `lanthra_api_key`, `lanthra_ollama_url`.

### Streaming Flow

1. `startStream()` reads provider settings from storage
2. `buildModel()` creates a `LanguageModel` via `createOpenAI()` with appropriate base URL
3. `buildSystemPrompt()` generates a system prompt from page context metadata
4. `doStream()` calls Vercel AI SDK's `streamText()` and iterates `result.fullStream`
5. Stream parts are dispatched: `text-delta` → `onToken`, `reasoning-delta` → `onToken` (wrapped in `<think>` tags), `error` → `onError`
6. After stream completes: usage reported via `onUsage`, then `onStreamEnd`

### Ollama-Specific Behavior

- **No tool calling** — Most local models don't support tool calling. Instead, page content is eagerly fetched via the tool executor and injected into the system prompt before streaming.
- **Cold-start retry** — Ollama may need 30+ seconds to load a model into VRAM. The extension retries up to 2 times on fetch errors.
- **Timeout** — 5 minutes (vs 90 seconds for cloud providers).
- **CORS** — Ollama must be started with `OLLAMA_ORIGINS="*"` for browser access.

### Cloud-Specific Behavior

- **Tool calling** — Cloud models receive 5 tools via the Vercel AI SDK. Up to 4 steps (`maxSteps: 4`) allow the model to call tools and receive results.
- **Tool fallback** — If a model returns 404 for tool support, the request is automatically retried without tools.
- **Rate limiting** — 429 errors produce a user-friendly message.

---

## Tool Calling System

The AI can request page context on-demand via tool calls instead of receiving a large context dump upfront. This is the "lazy context" architecture.

### Available Tools

| Tool | Description | Runs In |
|---|---|---|
| `get_page_content` | Full page text via Readability → Turndown (Markdown, capped at 12K chars) | Content script |
| `get_selected_text` | User's highlighted text selection | Content script |
| `get_page_links` | Hyperlinks on the page (text + URL, up to 60) | Content script |
| `get_page_images` | Image URLs on the page | Content script |
| `get_editor_content` | Text from web editors (Google Docs, Notion, Word Online) | Content script |

### Tool Execution Flow

1. AI model emits a `tool-call` part via the stream
2. Vercel AI SDK auto-executes the tool's `execute` function
3. The executor (in `message-router.ts`) sends a `LANTHRA_TOOL_CALL` message over the content script port
4. Content script's `page-tools.ts` runs the tool (has DOM access) and sends `LANTHRA_TOOL_RESULT` back
5. The result resolves the executor's promise, AI SDK sends it back to the model
6. Model generates its text response using the tool result

### DOM Extraction Pipeline (get_page_content)

1. `document.cloneNode(true)` — clone entire document (avoids mutating the live DOM)
2. `new Readability(clone).parse()` — Mozilla's Readability extracts main article content
3. `turndown.turndown(article.content)` — Converts clean HTML to Markdown
4. Cap at 12K characters
5. Fallback: `document.body.innerText` if Readability fails
6. Also captures editor content (contenteditable regions, Google Docs, etc.) that Readability may miss

---

## Messaging Protocol

Communication uses Chrome's messaging APIs: `chrome.runtime.Port` for content script ↔ service worker, and `chrome.runtime.sendMessage` for service worker → side panel broadcasts.

### Content Script ↔ Service Worker (Port)

Each editing session opens a dedicated port named `lanthra:session:<uuid>`.

| Direction | Message Type | Purpose |
|---|---|---|
| CS → SW | `LANTHRA_PROMPT_SUBMIT` | User submits a prompt (with context) |
| CS → SW | `LANTHRA_CANCEL` | User cancels the stream |
| CS → SW | `LANTHRA_TOOL_RESULT` | Response to a tool call |
| SW → CS | `LANTHRA_TOKEN` | Streamed text token |
| SW → CS | `LANTHRA_STREAM_END` | Stream complete |
| SW → CS | `LANTHRA_ERROR` | Error message |
| SW → CS | `LANTHRA_TOOL_CALL` | AI requests a page tool |

### Service Worker → Side Panel (Broadcast)

| Message Type | Purpose |
|---|---|
| `LANTHRA_STATE_UPDATE` | Session state changed (idle/armed/editing/streaming) |
| `LANTHRA_CHAT_USER` | Echo user's prompt to side panel |
| `LANTHRA_CHAT_TOKEN` | Mirror streamed token to side panel |
| `LANTHRA_CHAT_END` | Stream complete |
| `LANTHRA_CHAT_ERROR` | Error message |
| `LANTHRA_USAGE` | Token usage stats (input + output tokens) |

### Side Panel → Content Script (via chrome.tabs.sendMessage)

| Message Type | Purpose |
|---|---|
| `LANTHRA_TOGGLE` | Activate/deactivate edit mode |
| `LANTHRA_DEACTIVATE` | Deactivate after panel prompt completes |
| `LANTHRA_PANEL_PROMPT` | Send a chat prompt from the side panel |
| `LANTHRA_IMAGE_PROMPT` | Send an image analysis prompt |

---

## Inline Editing State Machine

```
idle → armed → editing → streaming → armed (output stays visible)
  ↑      ↓        ↓         ↓          ↓
  └──────┴────────┴─────────┴──────────┘ (cancel/escape → idle)
```

### States

- **idle** — No edit session active. Extension icon shows default state.
- **armed** — Full-viewport transparent overlay with crosshair cursor. Clicking text inserts the inline host.
- **editing** — Contenteditable span is active. User types a prompt. Enter submits.
- **streaming** — AI tokens stream into the inline host. Host is read-only with streaming decorations.
- After streaming completes, state returns to **armed** — the output remains in the page as clickable text.

### The Anchor Insertion Algorithm

1. `document.caretRangeFromPoint(x, y)` returns a Range at the click position
2. If the Range's startContainer is a Text node, split it at the offset: `textNode.splitText(offset)`
3. Create a `<span data-lanthra-anchor>` and `insertBefore` it between the two text halves
4. This produces the smallest possible DOM mutation — zero visual disruption
5. On removal: `parent.normalize()` merges the split text nodes back

### Inline Host (Chameleon Mode)

- `<span contenteditable="true" data-lanthra-host>` inside the anchor
- Typography cloned from surrounding text via `getComputedStyle()` (14 properties)
- Subtle visual cues only: indigo caret, faint border, 8% opacity background
- IME-safe: handles composition events properly
- Paste stripped to plain text

---

## Side Panel

### UI Structure

- **Header** — Extension name, status badge (IDLE/ARMED/EDITING/STREAMING/READY), settings gear, close button
- **Toggle button** — "Activate Edit" / "Deactivate" based on state
- **Chat area** — Scrollable message list with user/AI/error bubbles
- **Input area** — Textarea with send/stop button
- **Settings lightbox** — Tabs for Settings (provider, model, API key, Ollama URL) and Usage stats

### Chat Features

- Messages rendered with Markdown (code blocks, bold, italic, lists)
- AI thinking/reasoning content shown in a collapsible `<details>` dropdown with arrow toggle
- Thinking blocks detected via `<think>`/`</think>` tags in the token stream — works with both:
  - Local models that natively emit `<think>` tags (DeepSeek, QwQ, etc.)
  - API models that use structured reasoning (forwarded as `<think>` tags by the AI client)
- Chat history persisted in `chrome.storage.local`
- Clear chat with confirmation lightbox (glass blur backdrop)
- Auto-scroll with manual scroll-to-bottom button
- Stop button cancels active stream
- Image analysis: click images while armed → prompt overlay → response injected in-DOM near the image

### Settings

- **Provider dropdown** — OpenRouter, Anthropic (via OpenRouter), Ollama
- **Model dropdown** — Fetched from provider API, cached 24 hours
- **API key** — Stored in `chrome.storage.local`
- **Ollama URL** — Default `http://localhost:11434`, with connection test button
- **Usage tab** — Total requests, prompt/completion tokens, per-model breakdown

---

## Context System

The extension uses a "lazy context" architecture:

### For Cloud Models (OpenRouter)
1. System prompt contains only page metadata: `Title: ... \n URL: ...`
2. The AI is given tool definitions and told to use `get_page_content` when needed
3. Only when the AI calls the tool does the full page content get extracted and sent
4. This saves tokens when the user's question doesn't require page content

### For Local Models (Ollama)
1. Page content is eagerly fetched before streaming (since most local models don't support tool calling)
2. Content injected into the system prompt: metadata + `--- Page Content ---` + Markdown text
3. This ensures local models always have page context available

### For Inline Prompts
1. System prompt includes: `Title: ... \n URL: ... \n Editing near: <local context>`
2. The "editing near" context is the text surrounding the inline host position
3. Tools are available for both panel and inline prompts (for cloud models)

---

## Build System

esbuild produces 4 bundles from the TypeScript source:

| Entry Point | Output | Format | Notes |
|---|---|---|---|
| `src/content/index.ts` | `dist/content.js` | IIFE | Content script, runs in ISOLATED world |
| `src/sidepanel/sidepanel.ts` | `dist/sidepanel.js` | IIFE | Side panel page script |
| `src/background/service-worker.ts` | `dist/service-worker.js` | ESM | MV3 service worker |
| `src/page-script/bridge.ts` | `dist/page-bridge.js` | IIFE | MAIN world bridge (future use) |

All bundles target Chrome 120+. Dependencies are bundled inline (no external imports at runtime).

---

## File Structure

```
src/
├── background/           # Service worker context
│   ├── service-worker.ts # Entry: commands, sidePanel, message handler
│   ├── message-router.ts # Port routing, tool call dispatch
│   ├── ai-client.ts      # Vercel AI SDK streaming (all providers)
│   └── native-bridge.ts  # Native messaging (legacy, unused)
├── content/              # Content script context (DOM access)
│   ├── index.ts          # Entry: bootstrap EditSession, message relay
│   ├── edit-session.ts   # Inline editing state machine
│   ├── inline-host.ts    # Contenteditable span lifecycle
│   ├── hit-test.ts       # caretRangeFromPoint + element targeting
│   ├── range-utils.ts    # Text-node split + anchor insertion
│   ├── style-mirror.ts   # Computed style cloning for chameleon mode
│   ├── mutation-guard.ts # MutationObserver for orphan detection
│   ├── selection-store.ts# Save/restore user selection
│   ├── keyboard.ts       # Shortcut listener
│   └── page-tools.ts     # Readability + Turndown DOM extraction
├── page-script/
│   └── bridge.ts         # MAIN world postMessage bridge
├── shared/
│   └── logger.ts         # Shared logging utility
├── sidepanel/
│   └── sidepanel.ts      # Side panel UI logic
└── types/
    └── messages.ts       # Shared message type definitions
```

---

## Key Design Decisions

1. **Vercel AI SDK over manual SSE** — Unified streaming API handles all providers, tool calling, multi-step reasoning, and different response formats automatically.

2. **@ai-sdk/openai for everything** — Both OpenRouter and Ollama speak the OpenAI-compatible API. No need for separate provider SDKs.

3. **Lazy context via tools (cloud) vs eager injection (local)** — Cloud models support tool calling and benefit from reduced token usage. Local models need the context upfront since they typically can't call tools.

4. **Readability + Turndown** — Produces clean Markdown from messy web pages. Better than raw `innerText` for structured content (headings, lists, code blocks preserved).

5. **Port-per-session** — Each inline editing session gets its own `chrome.runtime.Port`. This cleanly separates concurrent sessions and allows per-session cancellation.

6. **Text node splitting** — The anchor insertion algorithm splits text nodes and uses `insertBefore` — the smallest possible DOM mutation that doesn't break existing page structure.

7. **Thinking dropdown** — `<think>`/`</think>` tags (from local models or the `reasoning-delta` stream) are captured and rendered in a collapsible `<details>` element, keeping the main response clean.

8. **Guard callbacks** — `guardCallbacks()` wraps stream callbacks to prevent double `onStreamEnd` / `onError` calls, which can happen with retries or aborts.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No API key | "No API key saved" message displayed |
| Ollama not running / CORS | Specific error with `OLLAMA_ORIGINS` fix instructions |
| Rate limited (429) | User-friendly message suggesting wait or model switch |
| Model doesn't support tools | Auto-retry without tools (cloud only) |
| Ollama cold start timeout | Up to 2 retries on fetch errors |
| Stream timeout | 90s for cloud, 5min for Ollama |
| Abort / cancel | Clean cancel via AbortController, abort errors silently swallowed |
| Content script not injected | Graceful error on toggle attempt |
| SPA re-renders remove anchor | MutationObserver detects removal → cleanup |

---

## Dependencies

| Package | Purpose |
|---|---|
| `ai` (v6) | Vercel AI SDK core — `streamText()`, `tool()` |
| `@ai-sdk/openai` (v3) | OpenAI-compatible provider for OpenRouter + Ollama |
| `@mozilla/readability` | Mozilla's article extraction algorithm |
| `turndown` | HTML → Markdown converter |
| `zod` (v4) | Schema validation for tool parameters |
| `esbuild` (dev) | TypeScript bundler |
| `typescript` (dev) | Type checking |
| `@types/chrome` (dev) | Chrome extension API types |
| `@types/turndown` (dev) | Turndown type definitions |
