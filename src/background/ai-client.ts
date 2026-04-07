// ai-client.ts — Unified AI streaming client using Vercel AI SDK.
//
// All providers use @ai-sdk/openai (OpenAI-compatible endpoints):
//   - OpenRouter (default for all cloud models including Anthropic)
//   - Ollama local (OpenAI-compatible /v1 endpoint)
//
// Page context is fetched lazily via tool calling — the system prompt
// only contains page metadata (title + URL). When the AI needs page
// content it calls the get_page_content tool, which runs Readability +
// Turndown in the content script.

import { streamText, tool, type LanguageModel } from 'ai';
import { createOpenAI }              from '@ai-sdk/openai';
import { createGroq }                from '@ai-sdk/groq';
import { createAnthropic }           from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI }  from '@ai-sdk/google';
import { z } from 'zod';
import { log } from '../shared/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamCallbacks {
  onToken:     (token: string) => void;
  onStreamEnd: () => void;
  onError:     (error: string) => void;
  onUsage?:    (usage: { promptTokens: number; completionTokens: number }) => void;
}

/** Callback the AI client invokes when the model calls a tool. */
export type ToolExecutor = (name: string) => Promise<string>;

// Active AbortControllers keyed by sessionId so we can cancel mid-stream
const active = new Map<string, AbortController>();

// ── Prompt response cache ─────────────────────────────────────────────────────
// Caches AI responses keyed by hash(prompt + context + model).
// Replays cached tokens immediately instead of hitting the API again.

interface CachedResponse {
  text: string;
  ts: number;
  promptTokens: number;
  completionTokens: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const responseCache = new Map<string, CachedResponse>();

async function cacheKey(prompt: string, context: string): Promise<string> {
  const stored = await chrome.storage.local.get(['lanthra_model']);
  const model = stored.lanthra_model ?? '';
  const raw = `${model}::${context}::${prompt}`;
  // Fast hash using SubtleCrypto (available in service workers)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Guarded callbacks (prevent double onStreamEnd) ────────────────────────────

function guardCallbacks(raw: StreamCallbacks): StreamCallbacks {
  let ended = false;
  const guarded: StreamCallbacks = {
    onToken: (token) => { if (!ended) raw.onToken(token); },
    onStreamEnd: () => {
      if (ended) return;
      ended = true;
      raw.onStreamEnd();
    },
    onError: (error) => {
      if (ended) return;
      ended = true;
      raw.onError(error);
    },
  };
  if (raw.onUsage) {
    const fn = raw.onUsage;
    guarded.onUsage = (usage) => fn(usage);
  }
  return guarded;
}

// ── Provider routing ──────────────────────────────────────────────────────────

const OPENAI_COMPAT_URLS: Record<string, string> = {
  'openai':     'https://api.openai.com/v1',
  'deepseek':   'https://api.deepseek.com/v1',
  'mistralai':  'https://api.mistral.ai/v1',
  'x-ai':       'https://api.x.ai/v1',
  'nvidia':     'https://integrate.api.nvidia.com/v1',
  'perplexity': 'https://api.perplexity.ai',
};

const OPENROUTER_ONLY = new Set([
  'meta-llama', 'qwen', 'microsoft', 'amazon', 'nous', 'openrouter',
]);

function providerKeyName(p: string): string {
  return OPENROUTER_ONLY.has(p) ? 'lanthra_key_openrouter' : `lanthra_key_${p}`;
}

/** Strip OpenRouter prefix (e.g. 'anthropic/claude-sonnet-4' → 'claude-sonnet-4') */
function nativeModelId(model: string): string {
  return model.includes('/') ? model.split('/').slice(1).join('/') : model;
}

// ── Provider model factory ────────────────────────────────────────────────────

function buildModel(
  provider:  string,
  model:     string,
  apiKey:    string,
  ollamaUrl: string,
): LanguageModel {
  if (provider === 'ollama') {
    // Validate Ollama URL is localhost to prevent SSRF
    try {
      const parsed = new URL(ollamaUrl);
      if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        throw new Error('Ollama URL must point to localhost');
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Invalid Ollama URL');
    }
    const ollama = createOpenAI({
      baseURL: `${ollamaUrl.replace(/\/+$/, '')}/v1`,
      apiKey: 'ollama',
    });
    return ollama(model);
  }

  if (provider === 'groq') {
    return createGroq({ apiKey })(model);
  }

  if (provider === 'anthropic') {
    return createAnthropic({ apiKey })(nativeModelId(model));
  }

  if (provider === 'google') {
    return createGoogleGenerativeAI({ apiKey })(nativeModelId(model));
  }

  // Direct OpenAI-compatible providers
  const compatUrl = OPENAI_COMPAT_URLS[provider];
  if (compatUrl) {
    return createOpenAI({ baseURL: compatUrl, apiKey })(nativeModelId(model));
  }

  // OpenRouter — default for all other cloud providers
  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    headers: {
      'HTTP-Referer': 'https://lanthra.app',
      'X-Title':      'Lanthra',
    },
  });
  return openrouter(model);
}

// ── System prompt builder ─────────────────────────────────────────────────────

const ADAPTIVE_BLOCK =
  '\n\n' +
  'Before generating your final response, use a <think> block to naturally reason through the user\'s request. ' +
  'In this space, silently evaluate the necessary verbosity, tone, and complexity required to best answer the prompt. ' +
  'Plan your approach in natural language, exploring different angles or tool uses if needed. ' +
  'Pay close attention to explicit cues from the user — words like "detailed", "exhaustive", "in-depth", "explain everything", ' +
  '"be specific", or "thorough" mean you must provide a comprehensive, long-form response. ' +
  'Conversely, brief questions like "what is this?" or "tldr" call for concise answers. ' +
  'Once your reasoning is complete, close the </think> tag and provide your perfectly adapted final response. ' +
  'Never mention the <think> block or your planning process to the user.';

function buildSystemPrompt(context: string, hasTools: boolean): string {
  const toolHint = hasTools
    ? 'Use the get_page_content tool when the user asks about the page or its contents. '
    : '';

  if (context.startsWith('lanthra:page\n')) {
    const lines  = context.slice('lanthra:page\n'.length).split('\n');
    const header = lines.slice(0, 2).join('\n');
    return (
      'You are Lanthra, a Chrome extension AI assistant.\n' +
      `Page: ${header}\n` +
      toolHint +
      'Never use em dashes.' +
      ADAPTIVE_BLOCK
    );
  }

  if (context.startsWith('lanthra:inline\n')) {
    const lines       = context.slice('lanthra:inline\n'.length).split('\n');
    const header      = lines.slice(0, 2).join('\n');
    const editingLine = lines[2] ?? '';
    return (
      'You are Lanthra, an inline AI assistant. You are in inline edit mode.\n' +
      'The user is editing text that already exists on the page.\n\n' +
      'Rules:\n' +
      '- If context contains Selected Text, Target Text, or Editing near, treat that text as the source text to operate on.\n' +
      '- If the user says "translate this", "rewrite this", "fix this", "make this shorter", "improve this", or similar, apply the request directly to the source text.\n' +
      '- Do not explain.\n' +
      '- Do not analyze.\n' +
      '- Do not offer multiple options unless the user explicitly asks for options.\n' +
      '- Do not say "please provide the text" if source text is already present in context.\n' +
      '- Output only the final transformed text.\n' +
      '- Preserve emojis, line breaks, and casual tone unless the user asks otherwise.\n' +
      '- If no usable source text exists at all, ask one short clarification.\n' +
      '- Never use em dashes.\n\n' +
      'Example behavior:\n' +
      'User: translate this to French\n' +
      'Context: Editing near: "I can\'t believe this happened 😂"\n' +
      'Output: "Je n\'arrive pas à croire que c\'est arrivé 😂"\n\n' +
      'Inline edit mode has higher priority than general chat mode.\n' +
      'When inline edit mode is active, perform the requested transformation on the detected source text and return only the result.\n\n' +
      `Page: ${header}\n${editingLine}\n` +
      toolHint +
      ADAPTIVE_BLOCK
    );
  }

  if (context.startsWith('lanthra:image')) {
    return (
      'You are Lanthra, an inline AI assistant. ' +
      'Analyze the provided image directly and respond concisely. ' +
      'Focus only on what is visible in the image unless the user asks about surrounding context. ' +
      'Never use em dashes.' +
      ADAPTIVE_BLOCK
    );
  }

  if (context) {
    return (
      'You are Lanthra, an inline AI assistant. ' +
      `User is editing near: "${context.slice(0, 200)}". Never use em dashes.` +
      ADAPTIVE_BLOCK
    );
  }

  return 'You are Lanthra, a concise AI assistant. Never use em dashes.' + ADAPTIVE_BLOCK;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function buildTools(executor: ToolExecutor) {
  return {
    // 1. The Master DOM Extractor (default)
    get_page_content: tool({
      description:
        'Get the full text, tables, metadata, comments, and links of the current webpage as Markdown. ' +
        'Always use this as the default tool when the user asks about the page, requests a summary, or needs article/post details.',
      inputSchema: z.object({}),
      execute: async () => executor('get_page_content'),
    }),

    // 2. The Context Targeter
    get_selected_text: tool({
      description: 'Get the specific text the user has currently highlighted on the page. Use for rewriting or explaining specific sections.',
      inputSchema: z.object({}),
      execute: async () => executor('get_selected_text'),
    }),

    // 3. The Canvas/Rich Text Fallback
    get_editor_content: tool({
      description: 'Get text from complex web editors (Google Docs, Notion, Word, PowerPoint...) where standard HTML DOM extraction fails.',
      inputSchema: z.object({}),
      execute: async () => executor('get_editor_content'),
    }),

    // 4. The Document Fallback
    get_pdf_text: tool({
      description: 'Extract text from a PDF currently open in the browser tab. Use ONLY if the user is viewing a PDF file.',
      inputSchema: z.object({}),
      execute: async () => executor('get_pdf_text'),
    }),

    // 5. The Vision Handler
    get_page_images: tool({
      description: 'Get image URLs from the page. Use ONLY when the user explicitly asks to analyze pictures or visual elements.',
      inputSchema: z.object({}),
      execute: async () => executor('get_page_images'),
    }),
  };
}

// ── Core streaming function ───────────────────────────────────────────────────

async function doStream(
  aiModel:  LanguageModel,
  system:   string,
  prompt:   string,
  cb:       StreamCallbacks,
  ctrl:     AbortController,
  tools?:   ReturnType<typeof buildTools>,
  imageUrl?: string,
  imageBase64?: string,
  imageMediaType?: string,
): Promise<void> {
  // Build user message — with image content if provided.
  // Many providers reject raw image URLs, so fetch the image and send as
  // base64 data instead.  When the content script already pre-encoded the
  // image (via canvas resize), skip the fetch entirely.
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; image: string; mediaType?: string };

  let userContent: string | ContentPart[] = prompt;

  if (imageBase64) {
    // Pre-encoded by content script — use directly (fastest path)
    userContent = [
      { type: 'text' as const, text: prompt },
      { type: 'image' as const, image: imageBase64, mediaType: imageMediaType || 'image/jpeg' },
    ];
  } else if (imageUrl) {
    try {
      const imgResp = await fetch(imageUrl, { signal: ctrl.signal });
      if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
      const contentLen = parseInt(imgResp.headers.get('content-length') || '0', 10);
      if (contentLen > 10 * 1024 * 1024) throw new Error('Image too large (>10 MB)');
      const buf  = await imgResp.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) throw new Error('Image too large (>10 MB)');
      const b64  = arrayBufferToBase64(buf);
      const mime = imgResp.headers.get('content-type') || 'image/png';
      userContent = [
        { type: 'text' as const, text: prompt },
        { type: 'image' as const, image: b64, mediaType: mime },
      ];
    } catch (e) {
      log('warn', 'ai-client: failed to fetch image for vision, falling back to URL mention', {
        error: e instanceof Error ? e.message : String(e),
      });
      // Fall back to just mentioning the URL in the prompt text.
      userContent = `${prompt}\n\n[Image URL: ${imageUrl}]`;
    }
  }

  const messages: Array<{ role: 'user'; content: string | ContentPart[] }> = [
    { role: 'user', content: userContent },
  ];

  const result = streamText({
    model: aiModel,
    system,
    messages,
    ...(tools ? { tools, maxSteps: 4 } : {}),
    temperature: 0.7,
    maxOutputTokens: 4096,
    abortSignal: ctrl.signal,
  });

  let inReasoning = false;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (inReasoning) {
          cb.onToken('</think>');
          inReasoning = false;
        }
        cb.onToken(part.text);
        break;
      case 'reasoning-delta':
        if (!inReasoning) {
          cb.onToken('<think>');
          inReasoning = true;
        }
        cb.onToken(part.text);
        break;
      case 'reasoning-end':
        if (inReasoning) {
          cb.onToken('</think>');
          inReasoning = false;
        }
        break;
      case 'error':
        log('error', 'ai-client: stream part error', { error: part.error });
        cb.onError(String(part.error));
        return;
      case 'tool-call':
        log('info', `ai-client: tool call → ${part.toolName}`);
        break;
      case 'tool-result':
        log('info', `ai-client: tool result for ${part.toolName}`, {
          len: typeof part.output === 'string' ? part.output.length : 0,
        });
        break;
    }
  }

  if (inReasoning) {
    cb.onToken('</think>');
  }

  // Report aggregated token usage
  try {
    const usage = await result.usage;
    if (usage && cb.onUsage) {
      cb.onUsage({
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
      });
    }
  } catch { /* usage may not be available for all providers */ }

  cb.onStreamEnd();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startStream(
  sessionId: string,
  prompt:    string,
  context:   string,
  callbacks: StreamCallbacks,
  toolExecutor?: ToolExecutor,
  imageUrl?: string,
  imageBase64?: string,
  imageMediaType?: string,
): Promise<void> {
  log('info', `ai-client: startStream for ${sessionId}`);

  // ── Check prompt cache (skip for image prompts) ───────────────────────────
  if (!imageUrl && !imageBase64) {
    const key = await cacheKey(prompt, context);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      log('info', `ai-client: cache hit for ${sessionId}`);
      const safe = guardCallbacks(callbacks);
      // Replay cached response as tokens (small chunks for smooth streaming feel)
      const chunk = 20;
      for (let i = 0; i < cached.text.length; i += chunk) {
        safe.onToken(cached.text.slice(i, i + chunk));
      }
      if (safe.onUsage) {
        safe.onUsage({ promptTokens: cached.promptTokens, completionTokens: cached.completionTokens });
      }
      safe.onStreamEnd();
      return;
    }
  }

  const stored = await chrome.storage.local.get([
    'lanthra_provider',
    'lanthra_model',
    'lanthra_ollama_url',
  ]);

  const provider:  string = stored.lanthra_provider   ?? 'openrouter';
  const model:     string = stored.lanthra_model      ?? 'anthropic/claude-3.5-haiku';
  const ollamaUrl: string = stored.lanthra_ollama_url ?? 'http://localhost:11434';

  // Read the provider-specific API key
  let apiKey = '';
  if (provider !== 'ollama') {
    const keyName = providerKeyName(provider);
    const keyData = await chrome.storage.local.get([keyName]);
    apiKey = (keyData[keyName] as string | undefined) ?? '';
  }

  log('info', `ai-client: provider=${provider}, model=${model}`);

  if (!apiKey && provider !== 'ollama') {
    callbacks.onError(
      'No API key saved. Open Lanthra \u2699 settings and save your key.'
    );
    return;
  }

  const ctrl = new AbortController();
  active.set(sessionId, ctrl);

  const timeoutMs    = provider === 'ollama' ? 300_000 : 90_000;
  const timeoutLabel = provider === 'ollama' ? '5 minutes' : '90 seconds';
  const timeout = setTimeout(() => {
    log('warn', `ai-client: auto-aborting ${sessionId} after ${timeoutLabel} timeout`);
    ctrl.abort();
    safe.onError(
      `Request timed out after ${timeoutLabel}. ` +
      (provider === 'ollama'
        ? 'The model may be too large for your hardware.'
        : 'Try a different model or check your API key.'
      )
    );
  }, timeoutMs);

  const safe  = guardCallbacks(callbacks);
  const tools = toolExecutor ? buildTools(toolExecutor) : undefined;

  // Accumulate response text for prompt caching
  let accumulatedText = '';
  let cachedUsage = { promptTokens: 0, completionTokens: 0 };
  const cachingKey = (!imageUrl && !imageBase64) ? await cacheKey(prompt, context) : '';
  const cachingSafe: StreamCallbacks = {
    onToken: (token) => { accumulatedText += token; safe.onToken(token); },
    onStreamEnd: () => {
      // Store in cache on successful completion
      if (cachingKey && accumulatedText.length > 0) {
        responseCache.set(cachingKey, {
          text: accumulatedText,
          ts: Date.now(),
          promptTokens: cachedUsage.promptTokens,
          completionTokens: cachedUsage.completionTokens,
        });
        // Evict old entries if cache grows too large
        if (responseCache.size > 50) {
          const oldest = [...responseCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) responseCache.delete(oldest[0]);
        }
      }
      safe.onStreamEnd();
    },
    onError: (e) => safe.onError(e),
    onUsage: (usage) => {
      cachedUsage = usage;
      if (safe.onUsage) safe.onUsage(usage);
    },
  };

  try {
    const aiModel = buildModel(provider, model, apiKey, ollamaUrl);
    const system  = buildSystemPrompt(context, !!tools);

    if (provider === 'ollama') {
      // Ollama: don't pass tools — most local models don't support tool calling.
      // Instead, if page content is needed, eagerly fetch it via the executor
      // and inject it into the system prompt.
      let ollamaSystem = buildSystemPrompt(context, false);
      if (toolExecutor && context.startsWith('lanthra:')) {
        try {
          const pageContent = await toolExecutor('get_page_content');
          if (pageContent && pageContent.length > 0) {
            ollamaSystem += '\n\n--- Page Content ---\n' + pageContent;
          }
        } catch (e) {
          log('warn', 'ai-client: failed to pre-fetch page content for ollama', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Ollama may need 30+ seconds to cold-load a model into VRAM.
      // Chrome can kill idle service-worker fetches, so retry up to 2 times.
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          await doStream(aiModel, ollamaSystem, prompt, cachingSafe, ctrl, undefined, imageUrl, imageBase64, imageMediaType);
          return;
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          if (attempt < 2 && isFetchError(e)) {
            log('warn', `ai-client: ollama retry ${attempt + 1}`, {
              error: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
          throw e;
        }
      }
    } else if (provider === 'groq') {
      // Groq: free-tier Llama models have unreliable tool-call round-trips
      // through multi-step flows. Pre-fetch page content like Ollama.
      let groqSystem = buildSystemPrompt(context, false);
      if (toolExecutor && context.startsWith('lanthra:')) {
        try {
          const pageContent = await toolExecutor('get_page_content');
          if (pageContent && pageContent.length > 0) {
            groqSystem += '\n\n--- Page Content ---\n' + pageContent;
          }
        } catch (e) {
          log('warn', 'ai-client: failed to pre-fetch page content for groq', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await doStream(aiModel, groqSystem, prompt, cachingSafe, ctrl, undefined, imageUrl, imageBase64, imageMediaType);
    } else {
      try {
        await doStream(aiModel, system, prompt, cachingSafe, ctrl, tools, imageUrl, imageBase64, imageMediaType);
      } catch (e: unknown) {
        // Auto-retry without tools if the model doesn't support them (404)
        if (tools && isToolNotSupported(e)) {
          log('info', 'ai-client: model lacks tool support, retrying without tools');
          await doStream(aiModel, system, prompt, cachingSafe, ctrl, undefined, imageUrl, imageBase64, imageMediaType);
        } else {
          throw e;
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('abort')) return;

    // Ollama connection error
    if (provider === 'ollama' && (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS'))) {
      safe.onError('Cannot detect Ollama. Make sure it is running.');
    } else if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
      safe.onError('Rate limited — wait a minute or switch to a different model.');
    } else {
      safe.onError(msg);
    }
  } finally {
    clearTimeout(timeout);
    active.delete(sessionId);
  }
}

export function cancelStream(sessionId: string): void {
  active.get(sessionId)?.abort();
  active.delete(sessionId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFetchError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('network') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('socket hang up')
  );
}

function isToolNotSupported(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('404') && /tool/i.test(msg);
}

/** Convert an ArrayBuffer to a base64 string (works in service workers). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
