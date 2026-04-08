// sidepanel.ts — Lanthra side panel UI logic

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const btnToggle       = document.getElementById('btn-toggle')!;
const toggleText      = document.getElementById('toggle-text')!;
const statusBadge     = document.getElementById('status-badge')!;
const providerWrap    = document.getElementById('provider-select-wrap')!;
const providerTrigger = document.getElementById('provider-trigger')!;
const providerDropdown = document.getElementById('provider-dropdown')!;
const modelWrap       = document.getElementById('model-select-wrap')!;
const modelTrigger    = document.getElementById('model-trigger')!;
const modelDropdown   = document.getElementById('model-dropdown')!;
const modelLoading    = document.getElementById('model-loading')!;
const apiKeyInput     = document.getElementById('api-key') as HTMLInputElement;
const btnSaveKey      = document.getElementById('btn-save-key')!;
const keyStatus       = document.getElementById('key-status')!;
const btnSettings     = document.getElementById('btn-settings-toggle')!;
const btnClose        = document.getElementById('btn-close')!;
const settingsPanel   = document.getElementById('settings-panel')!;
const chatInput       = document.getElementById('chat-input') as HTMLTextAreaElement;
const btnSend         = document.getElementById('btn-send') as HTMLButtonElement;
const sendIcon        = document.getElementById('send-icon')!;
const stopIcon        = document.getElementById('stop-icon')!;
const chatMessages    = document.getElementById('chat-messages')!;
const hintBlock       = document.getElementById('hint-block')!;
const settingsOverlay = document.getElementById('settings-overlay')!;
const btnSettingsClose = document.getElementById('btn-settings-close')!;
const pageStatus      = document.getElementById('page-status')!;
const btnClearChat    = document.getElementById('btn-clear-chat')!;
const btnScrollBottom = document.getElementById('btn-scroll-bottom')!;
const tabContext      = document.getElementById('tab-context')!;
const tabFavicon      = document.getElementById('tab-favicon') as HTMLImageElement;
const tabContextIcon  = document.getElementById('tab-context-icon')!;
const tabContextText  = document.getElementById('tab-context-text')!;
const modelSection    = document.getElementById('model-section')!;
const ollamaSection   = document.getElementById('ollama-section')!;
const ollamaUrlInput  = document.getElementById('ollama-url') as HTMLInputElement;
const btnTestOllama   = document.getElementById('btn-test-ollama')!;
const ollamaStatus    = document.getElementById('ollama-status')!;
const clearConfirmOverlay = document.getElementById('clear-confirm-overlay')!;
const btnClearConfirm = document.getElementById('btn-clear-confirm')!;
const btnClearCancel  = document.getElementById('btn-clear-cancel')!;
const usageTotalReqs  = document.getElementById('usage-total-requests')!;
const usagePromptTok  = document.getElementById('usage-prompt-tokens')!;
const usageCompTok    = document.getElementById('usage-completion-tokens')!;
const usageTotalTok   = document.getElementById('usage-total-tokens')!;
const usageByModel    = document.getElementById('usage-by-model')!;
const btnResetUsage   = document.getElementById('btn-reset-usage')!;
const tabSettings     = document.getElementById('tab-settings')!;
const tabUsage        = document.getElementById('tab-usage')!;
const apiKeySection   = document.getElementById('api-key-section')!;
const apiKeyLink      = document.getElementById('api-key-link') as HTMLAnchorElement;

// Highlight context DOM refs
const highlightCtx       = document.getElementById('highlight-context')!;
const highlightHeader    = document.getElementById('highlight-context-header')!;
const highlightBody      = document.getElementById('highlight-context-body')!;
const highlightClear     = document.getElementById('highlight-context-clear')!;

// ── Custom dropdown helper ───────────────────────────────────────────────────

interface DropdownState {
  wrap: HTMLElement;
  trigger: HTMLElement;
  dropdown: HTMLElement;
  value: string;
  onChange: (value: string) => void;
}

function createDropdown(
  wrap: HTMLElement,
  trigger: HTMLElement,
  dropdown: HTMLElement,
  onChange: (value: string) => void,
): DropdownState {
  const state: DropdownState = { wrap, trigger, dropdown, value: '', onChange };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dropdowns first
    document.querySelectorAll('.custom-select.open').forEach(el => {
      if (el !== wrap) el.classList.remove('open');
    });
    wrap.classList.toggle('open');

    // Toggle overflow on modal panel so dropdown is not clipped
    const modal = wrap.closest('.modal-panel');
    if (modal) {
      if (wrap.classList.contains('open')) {
        modal.classList.add('dropdown-open');
      } else {
        modal.classList.remove('dropdown-open');
      }
    }

    // Focus search box if present
    if (wrap.classList.contains('open')) {
      const search = dropdown.querySelector('.custom-select-search') as HTMLInputElement | null;
      if (search) { search.value = ''; search.focus(); filterDropdownOptions(dropdown, ''); }
    }
  });

  return state;
}

function setDropdownValue(state: DropdownState, value: string, label: string): void {
  state.value = value;
  state.trigger.querySelector('.custom-select-value')!.textContent = label;
  // Update selected state on options
  state.dropdown.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.classList.toggle('selected', opt.getAttribute('data-value') === value);
  });
}

function populateDropdown(
  state: DropdownState,
  items: Array<{ value: string; label: string }>,
  hasSearch: boolean = false,
): void {
  state.dropdown.innerHTML = '';

  if (hasSearch) {
    const search = document.createElement('input');
    search.className = 'custom-select-search';
    search.placeholder = 'Search…';
    search.type = 'text';
    search.addEventListener('input', () => {
      filterDropdownOptions(state.dropdown, search.value);
    });
    search.addEventListener('click', (e) => e.stopPropagation());
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { state.wrap.classList.remove('open'); }
      e.stopPropagation();
    });
    state.dropdown.appendChild(search);
  }

  for (const item of items) {
    const opt = document.createElement('div');
    opt.className = 'custom-select-option';
    opt.setAttribute('data-value', item.value);
    opt.innerHTML =
      `<svg class="check-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="2 7 5.5 10.5 12 4"/></svg>` +
      `<span>${escapeHtml(item.label)}</span>`;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setDropdownValue(state, item.value, item.label);
      state.wrap.classList.remove('open');
      state.onChange(item.value);
    });
    state.dropdown.appendChild(opt);
  }
}

function filterDropdownOptions(dropdown: HTMLElement, query: string): void {
  const q = query.toLowerCase();
  dropdown.querySelectorAll('.custom-select-option').forEach(opt => {
    const text = opt.textContent?.toLowerCase() ?? '';
    (opt as HTMLElement).style.display = text.includes(q) ? '' : 'none';
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.modal-panel.dropdown-open').forEach(el => el.classList.remove('dropdown-open'));
});

// ── Providers & models (live from OpenRouter) ────────────────────────────────

interface ModelEntry { id: string; name: string; }

const API_KEY_LINKS: Record<string, { url: string; label: string }> = {
  'openrouter': { url: 'https://openrouter.ai/keys',                   label: 'Get OpenRouter API Key' },
  'anthropic':  { url: 'https://console.anthropic.com/settings/keys', label: 'Get Anthropic API Key' },
  'openai':     { url: 'https://platform.openai.com/api-keys',        label: 'Get OpenAI API Key' },
  'google':     { url: 'https://aistudio.google.com/app/apikey',      label: 'Get Google AI API Key' },
  'deepseek':   { url: 'https://platform.deepseek.com/api_keys',      label: 'Get DeepSeek API Key' },
  'mistralai':  { url: 'https://console.mistral.ai/api-keys',         label: 'Get Mistral API Key' },
  'groq':       { url: 'https://console.groq.com/keys',               label: 'Get Groq API Key' },
  'x-ai':       { url: 'https://console.x.ai/',                       label: 'Get xAI API Key' },
  'perplexity': { url: 'https://www.perplexity.ai/settings/api',      label: 'Get Perplexity API Key' },
  'meta-llama': { url: 'https://openrouter.ai/keys',                  label: 'Get API Key on OpenRouter' },
  'qwen':       { url: 'https://openrouter.ai/keys',                  label: 'Get API Key on OpenRouter' },
  'microsoft':  { url: 'https://openrouter.ai/keys',                  label: 'Get API Key on OpenRouter' },
  'nvidia':     { url: 'https://build.nvidia.com/',                   label: 'Get NVIDIA API Key' },
  'amazon':     { url: 'https://openrouter.ai/keys',                  label: 'Get API Key on OpenRouter' },
  'nous':       { url: 'https://openrouter.ai/keys',                  label: 'Get API Key on OpenRouter' },
};

const PROVIDER_LABELS: Record<string, string> = {
  'anthropic':  'Anthropic',
  'openai':     'OpenAI',
  'google':     'Google',
  'meta-llama': 'Meta',
  'qwen':       'Qwen',
  'deepseek':   'DeepSeek',
  'mistralai':  'Mistral',
  'groq':       'Groq',
  'microsoft':  'Microsoft',
  'nvidia':     'NVIDIA',
  'x-ai':       'xAI',
  'amazon':     'Amazon',
  'perplexity': 'Perplexity',
  'nous':       'Nous Research',
  'openrouter': 'OpenRouter',
  'ollama':     'Ollama',
};

const PROVIDER_ORDER = [
  'anthropic', 'openai', 'google', 'meta-llama', 'qwen', 'deepseek', 'mistralai',
  'groq', 'x-ai', 'microsoft', 'nvidia', 'amazon', 'perplexity', 'nous', 'openrouter', 'ollama',
];

// ── Provider routing helpers ─────────────────────────────────────────────────

const OPENROUTER_ONLY = new Set([
  'meta-llama', 'qwen', 'microsoft', 'amazon', 'nous', 'openrouter',
]);

function providerKeyName(p: string): string {
  return OPENROUTER_ONLY.has(p) ? 'lanthra_key_openrouter' : `lanthra_key_${p}`;
}

const PROVIDER_PLACEHOLDERS: Record<string, string> = {
  'anthropic':  'sk-ant-…',
  'openai':     'sk-…',
  'google':     'AIza…',
  'groq':       'gsk_…',
  'deepseek':   'sk-…',
  'mistralai':  '…',
  'x-ai':       'xai-…',
  'nvidia':     'nvapi-…',
  'perplexity': 'pplx-…',
  'openrouter': 'sk-or-…',
};

let currentProvider = 'anthropic';

let modelsByProvider: Record<string, ModelEntry[]> = {};
let providerKeys: string[] = [];

// Dropdown state objects (initialized after DOM is ready)
let providerDD: DropdownState;
let modelDD: DropdownState;

async function fetchAllModels(): Promise<void> {
  modelLoading.classList.remove('hidden');
  try {
    // Try cache first (24 h TTL)
    const cache = await chrome.storage.local.get(['lanthra_models_cache', 'lanthra_models_ts']);
    const cacheAge = Date.now() - (cache.lanthra_models_ts ?? 0);
    if (cache.lanthra_models_cache && cacheAge < 24 * 60 * 60 * 1000) {
      modelsByProvider = cache.lanthra_models_cache as Record<string, ModelEntry[]>;
      buildProviderKeys();
      return;
    }

    // Fetch with 10 s timeout
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const buckets: Record<string, Array<{ id: string; name: string; ctx: number }>> = {};

    for (const m of data.data ?? []) {
      const slug: string = m.id ?? '';
      const prefix = slug.split('/')[0] ?? '';
      if (!prefix) continue;

      if (!buckets[prefix]) buckets[prefix] = [];
      buckets[prefix].push({
        id:   slug,
        name: m.name ?? slug,
        ctx:  m.context_length ?? 0,
      });
    }

    for (const [prefix, models] of Object.entries(buckets)) {
      models.sort((a, b) => b.ctx - a.ctx);
      modelsByProvider[prefix] = models.slice(0, 30).map(m => ({ id: m.id, name: m.name }));
    }

    buildProviderKeys();

    // Cache the result
    await chrome.storage.local.set({
      lanthra_models_cache: modelsByProvider,
      lanthra_models_ts:    Date.now(),
    });
  } catch (e) {
    console.error('Failed to fetch models from OpenRouter', e);
    // Use hardcoded fallback so the UI is always usable
    modelsByProvider = {
      anthropic:  [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
      ],
      openai: [
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
      ],
      google: [
        { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
        { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5' },
      ],
      'meta-llama': [
        { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
        { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B' },
      ],
      qwen: [
        { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B' },
        { id: 'qwen/qwen3-30b-a3b', name: 'Qwen3 30B' },
        { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B' },
      ],
      deepseek: [
        { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3' },
        { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' },
      ],
      mistralai: [
        { id: 'mistralai/mistral-large', name: 'Mistral Large' },
        { id: 'mistralai/mistral-small', name: 'Mistral Small' },
      ],
      'x-ai': [
        { id: 'x-ai/grok-2-1212', name: 'Grok 2' },
      ],
    };
    buildProviderKeys();
  } finally {
    modelLoading.classList.add('hidden');
  }
}

function buildProviderKeys(): void {
  providerKeys = [];
  for (const p of PROVIDER_ORDER) {
    if (p === 'ollama' || p === 'openrouter' || p === 'groq' || modelsByProvider[p]) {
      providerKeys.push(p);
    }
  }
}

function populateProviders(): void {
  const items = providerKeys.map(key => ({
    value: key,
    label: PROVIDER_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
  }));
  populateDropdown(providerDD, items, false);
}

async function populateModels(providerKey: string): Promise<void> {
  if (providerKey === 'ollama') { await populateOllamaModels(); return; }
  if (providerKey === 'groq')   { await populateGroqModels();   return; }
  const raw = providerKey === 'openrouter'
    ? Object.values(modelsByProvider).flat()
    : (modelsByProvider[providerKey] ?? []);
  const models = raw.filter(m =>
    !/\/(auto|router)$/i.test(m.id) &&
    !/body\s*builder/i.test(m.name)
  );
  const items = models.map(m => ({ value: m.id, label: m.name }));
  populateDropdown(modelDD, items, true);

  // Always add custom model input at the bottom of the dropdown
  appendCustomModelInput();

  const saved = await chrome.storage.local.get(['lanthra_model']);
  if (saved.lanthra_model) {
    const match = models.find(m => m.id === saved.lanthra_model);
    if (match) {
      setDropdownValue(modelDD, match.id, match.name);
    } else if (models.length > 0) {
      // Saved model not in list — could be a custom model, show it
      setDropdownValue(modelDD, saved.lanthra_model, saved.lanthra_model);
    }
  } else if (models.length > 0) {
    setDropdownValue(modelDD, models[0]!.id, models[0]!.name);
  }
}

function appendCustomModelInput(): void {
  const customDiv = document.createElement('div');
  customDiv.className = 'custom-model-input-wrap';
  customDiv.innerHTML =
    '<div class="custom-model-divider"></div>' +
    '<input class="custom-model-input" type="text" placeholder="Or enter model ID\u2026" />';
  const input = customDiv.querySelector('input')!;
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const val = (e.target as HTMLInputElement).value.trim();
      if (val) {
        setDropdownValue(modelDD, val, val);
        modelWrap.classList.remove('open');
        modelDD.onChange(val);
      }
    }
    if (e.key === 'Escape') modelWrap.classList.remove('open');
  });
  modelDropdown.appendChild(customDiv);
}

// ── State ────────────────────────────────────────────────────────────────────

type PanelState = 'idle' | 'armed' | 'editing' | 'streaming';
let currentState: PanelState = 'idle';

function setTabFavicon(url: string | undefined): void {
  if (url) {
    tabFavicon.src = url;
    tabFavicon.style.display = '';
    tabContextIcon.style.display = 'none';
    tabFavicon.onerror = () => {
      tabFavicon.style.display = 'none';
      tabContextIcon.style.display = '';
    };
  } else {
    tabFavicon.style.display = 'none';
    tabContextIcon.style.display = '';
  }
}

// Tracks whether a panel chat stream is currently active.
let panelStreamingActive = false;
// Tracks the tab ID where the current stream was initiated,
// so cancel/stop works even if the user switches tabs mid-stream.
let streamingTabId: number | null = null;
// Session ID of the current panel chat stream — used to ignore stale
// CHAT_END/CHAT_ERROR broadcasts from unrelated (e.g. inline) sessions.
let panelStreamSessionId: string | null = null;

function updateUI(state: PanelState): void {
  currentState = state;
  statusBadge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  statusBadge.className = `badge badge-${state}`;

  if (state === 'armed') {
    toggleText.textContent = 'Activated';
    btnToggle.classList.add('active');
  } else {
    toggleText.textContent = 'Activate Edit';
    btnToggle.classList.remove('active');
  }

  // Send/stop button is controlled by whether a panel stream is active.
  // Deliberately ignores `state === 'streaming'` so that CS inline-editing
  // state broadcasts can never hide the stop button mid-chat.
  if (panelStreamingActive) {
    btnSend.classList.add('stop-mode');
    sendIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    btnSend.disabled = false;
    tabContext.classList.add('streaming');
  } else {
    btnSend.classList.remove('stop-mode');
    sendIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
    tabContext.classList.remove('streaming');
  }

  syncInputState();
}

// ── Chat messages ────────────────────────────────────────────────────────────

// Track the current AI streaming bubble so we can append tokens to it
let activeAIBubble: HTMLDivElement | null = null;
let activeAICursor: HTMLSpanElement | null = null;
let thinkingIndicator: HTMLDivElement | null = null;
// Skip next LANTHRA_CHAT_USER broadcast (already shown by handleSendOrStop)
let skipNextUserEcho = false;

// ── Streaming markdown buffer ──
// Accumulates all normal (non-thinking) tokens. On each new token the entire
// buffer is re-parsed with `marked` and set as innerHTML on the bubble. This
// gives smooth progressive markdown rendering.
let streamingMarkdownBuffer = '';

// ── Auto-scroll state ──
// When the user scrolls up during streaming, stop forcing scroll to bottom.
let userHasScrolledUp = false;

// ── Thinking block state ──
// Models like Qwen3, DeepSeek R1 emit <think>…</think> tags.
// We buffer thinking tokens separately and render them in a collapsible dropdown.
let thinkingBuffer = '';
let isInsideThinkBlock = false;
let thinkingDropdown: HTMLDetailsElement | null = null;
let thinkingContent: HTMLDivElement | null = null;

// ── Marked configuration ──
marked.setOptions({
  breaks: true,
  gfm: true,
});

function addUserMessage(text: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-msg-user';
  wrapper.innerHTML = `<div class="chat-msg-bubble"></div>`;
  wrapper.querySelector('.chat-msg-bubble')!.textContent = text;
  chatMessages.appendChild(wrapper);
  scrollToBottom();
  hintBlock.classList.add('hidden');
  appendToHistory('user', text);

  // Show thinking indicator
  showThinkingIndicator();
}

function startAIMessage(): void {
  hideThinkingIndicator();
  streamingMarkdownBuffer = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-msg-ai';
  wrapper.innerHTML =
    `<span class="chat-msg-label">Lanthra</span>` +
    `<div class="chat-msg-bubble streaming"></div>`;
  chatMessages.appendChild(wrapper);
  activeAIBubble = wrapper.querySelector('.chat-msg-bubble') as HTMLDivElement;
  // Add typing cursor
  activeAICursor = document.createElement('span');
  activeAICursor.className = 'typing-cursor';
  activeAIBubble.appendChild(activeAICursor);
  scrollToBottom();
}

function showThinkingIndicator(): void {
  hideThinkingIndicator();
  thinkingIndicator = document.createElement('div');
  thinkingIndicator.className = 'chat-msg chat-msg-ai';
  thinkingIndicator.innerHTML =
    `<span class="chat-msg-label">Lanthra</span>` +
    `<div class="thinking-indicator">` +
      `<div class="thinking-dots"><span></span><span></span><span></span></div>` +
      `<span>Thinking</span>` +
    `</div>`;
  chatMessages.appendChild(thinkingIndicator);
  scrollToBottom();
}

function hideThinkingIndicator(): void {
  if (thinkingIndicator) {
    thinkingIndicator.remove();
    thinkingIndicator = null;
  }
}

function appendAIToken(token: string): void {
  if (!activeAIBubble) startAIMessage();
  // Strip em dashes from AI output
  const cleaned = token.replace(/\u2014/g, '-');

  // ── Thinking block detection ──
  // Accumulate raw text to detect <think> / </think> tags that may arrive
  // split across multiple token chunks.
  let remaining = cleaned;

  while (remaining.length > 0) {
    if (!isInsideThinkBlock) {
      // Check if <think> starts in this chunk
      const openIdx = remaining.indexOf('<think>');
      if (openIdx !== -1) {
        // Emit text before <think> as normal content
        if (openIdx > 0) {
          appendNormalToken(remaining.slice(0, openIdx));
        }
        isInsideThinkBlock = true;
        thinkingBuffer = '';
        remaining = remaining.slice(openIdx + 7); // skip '<think>'
        ensureThinkingDropdown();
        continue;
      }
      // No <think> tag — could be partial. Check for trailing '<' that might be start of tag
      const trailingLt = remaining.lastIndexOf('<');
      if (trailingLt !== -1 && trailingLt > remaining.length - 7 && remaining.slice(trailingLt).length < 7) {
        // Might be partial <think — emit up to the '<' and hold the rest
        // Actually just emit it all; partial detection is fragile
        appendNormalToken(remaining);
        remaining = '';
      } else {
        appendNormalToken(remaining);
        remaining = '';
      }
    } else {
      // Inside <think> — look for </think>
      const closeIdx = remaining.indexOf('</think>');
      if (closeIdx !== -1) {
        // Add text before </think> to thinking buffer
        const thinkText = remaining.slice(0, closeIdx);
        thinkingBuffer += thinkText;
        appendToThinkingDropdown(thinkText);
        isInsideThinkBlock = false;
        remaining = remaining.slice(closeIdx + 8); // skip '</think>'
        continue;
      }
      // No close tag yet — buffer everything
      thinkingBuffer += remaining;
      appendToThinkingDropdown(remaining);
      remaining = '';
    }
  }
  // Only auto-scroll during streaming if user hasn't scrolled up
  if (!userHasScrolledUp) scrollToBottom();
}

/** Append a normal (non-thinking) token to the AI bubble with live markdown rendering. */
function appendNormalToken(text: string): void {
  if (!text || !activeAIBubble) return;
  streamingMarkdownBuffer += text;

  // Re-render the entire accumulated buffer as markdown.
  // Preserve the thinking dropdown (if it exists) at the top.
  const parsed = renderMarkdown(streamingMarkdownBuffer);

  // Find or create the streaming content container (sits after thinking dropdown, before cursor)
  let streamDiv = activeAIBubble.querySelector('.streaming-content') as HTMLDivElement | null;
  if (!streamDiv) {
    streamDiv = document.createElement('div');
    streamDiv.className = 'streaming-content';
    activeAIBubble.insertBefore(streamDiv, activeAICursor);
  }
  streamDiv.innerHTML = parsed;
}

/** Create the <details> thinking dropdown inside the AI bubble if not already present. */
function ensureThinkingDropdown(): void {
  if (thinkingDropdown || !activeAIBubble) return;
  thinkingDropdown = document.createElement('details');
  thinkingDropdown.className = 'thinking-dropdown';
  const summary = document.createElement('summary');
  summary.className = 'thinking-summary';
  summary.innerHTML = '<span class="thinking-summary-icon">&#9654;</span> Thinking';
  thinkingDropdown.appendChild(summary);
  thinkingContent = document.createElement('div');
  thinkingContent.className = 'thinking-dropdown-content';
  thinkingDropdown.appendChild(thinkingContent);
  // Insert before cursor (before any normal content)
  activeAIBubble.insertBefore(thinkingDropdown, activeAICursor);
  // Toggle arrow direction on open/close
  thinkingDropdown.addEventListener('toggle', () => {
    const icon = summary.querySelector('.thinking-summary-icon');
    if (icon) icon.textContent = thinkingDropdown!.open ? '\u25BE' : '\u25B6';
  });
}

/** Append text to the thinking dropdown content area. */
function appendToThinkingDropdown(text: string): void {
  if (!thinkingContent) return;
  thinkingContent.appendChild(document.createTextNode(text));
}

function endAIMessage(): void {
  hideThinkingIndicator();
  if (activeAIBubble) {
    activeAIBubble.classList.remove('streaming');
    activeAICursor?.remove();

    const thinkText = thinkingBuffer;
    const mainText = streamingMarkdownBuffer;

    if (thinkingDropdown && thinkText) {
      const dd = thinkingDropdown;
      // Re-render thinking content with markdown
      if (thinkingContent) {
        thinkingContent.innerHTML = renderMarkdown(thinkText.trim());
      }

      if (!mainText.trim()) {
        activeAIBubble.closest('.chat-msg')?.remove();
      } else {
        activeAIBubble.innerHTML = '';
        activeAIBubble.appendChild(dd);
        const mainDiv = document.createElement('div');
        mainDiv.className = 'thinking-main-content';
        mainDiv.innerHTML = renderMarkdown(mainText.trim());
        activeAIBubble.appendChild(mainDiv);
      }
    } else if (!mainText.trim()) {
      activeAIBubble.closest('.chat-msg')?.remove();
    } else {
      activeAIBubble.innerHTML = renderMarkdown(mainText.trim());
    }
    if (mainText.trim()) appendToHistory('ai', mainText.trim());
  }
  // Reset all streaming state
  activeAIBubble = null;
  activeAICursor = null;
  thinkingDropdown = null;
  thinkingContent = null;
  thinkingBuffer = '';
  isInsideThinkBlock = false;
  streamingMarkdownBuffer = '';
  scrollToBottom();
}

function addErrorMessage(error: string): void {
  hideThinkingIndicator();
  endAIMessage();
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-msg-ai chat-msg-error';
  wrapper.innerHTML =
    `<span class="chat-msg-label">Error</span>` +
    `<div class="chat-msg-bubble"></div>`;
  wrapper.querySelector('.chat-msg-bubble')!.textContent = error;
  chatMessages.appendChild(wrapper);
  scrollToBottom();
  appendToHistory('error', error);
}

function scrollToBottom(): void {
  const content = chatMessages.closest('.content');
  if (content) {
    content.scrollTop = content.scrollHeight;
    btnScrollBottom.classList.remove('visible');
  }
  userHasScrolledUp = false;
}

// ── Chat input state ─────────────────────────────────────────────────────────

function syncInputState(): void {
  // Input is disabled only while a panel chat stream is in flight.
  chatInput.disabled = panelStreamingActive;
  btnSend.disabled   = panelStreamingActive
    ? false // stop button always enabled during streaming
    : chatInput.value.trim().length === 0;
}

// ── Toggle edit mode ─────────────────────────────────────────────────────────

btnToggle.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    console.warn('[Lanthra] sidepanel: no active tab found');
    return;
  }

  // If currently armed → deactivate; otherwise → toggle (arm)
  const msgType = currentState === 'armed' ? 'LANTHRA_DEACTIVATE' : 'LANTHRA_TOGGLE';
  console.log(`[Lanthra] sidepanel: sending ${msgType} to tab`, tab.id);

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: msgType });
    console.log(`[Lanthra] sidepanel: ${msgType} response`, resp);
  } catch (err) {
    console.error('[Lanthra] sidepanel: toggle failed', err);
    keyStatus.textContent = 'Cannot activate on this page';
    keyStatus.className = 'key-status error';
    setTimeout(() => { keyStatus.textContent = ''; }, 2000);
  }
});

// ── Settings toggle (lightbox) ───────────────────────────────────────────────

btnSettings.addEventListener('click', () => {
  settingsOverlay.classList.toggle('hidden');
});

btnSettingsClose.addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});

settingsOverlay.addEventListener('click', (e) => {
  if ((e.target as Element).classList.contains('modal-backdrop')) {
    settingsOverlay.classList.add('hidden');
  }
});

// ── Close panel ──────────────────────────────────────────────────────────────

async function closePanel(): Promise<void> {
  // Ask the service worker to call chrome.sidePanel.close (Chrome 141+)
  chrome.runtime.sendMessage({ type: 'LANTHRA_CLOSE_PANEL' });
}

btnClose.addEventListener('click', closePanel);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '.') {
    e.preventDefault();
    closePanel();
    return;
  }
  // Escape while armed → deactivate edit mode (go idle)
  if (e.key === 'Escape' && currentState === 'armed' && !panelStreamingActive) {
    e.preventDefault();
    btnToggle.click();
  }
});

// ── Messaging ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  console.log('[Lanthra] sidepanel: received message', msg?.type);
  switch (msg?.type) {
    case 'LANTHRA_STATE_UPDATE': {
      // Update badge and toggle to reflect the CS inline-editing state.
      // IMPORTANT: do NOT call updateUI() when a panel chat is active because
      // updateUI() still reads `panelStreamingActive` and that is correct —
      // the stop button will remain visible. We simply update the visual
      // CS-state indicators without changing currentState, so that the
      // btnToggle handler and Escape handler see the right CS state.
      const newState = msg.state as PanelState;
      currentState = newState;
      statusBadge.textContent = newState.charAt(0).toUpperCase() + newState.slice(1);
      statusBadge.className   = `badge badge-${newState}`;
      if (newState === 'armed') {
        toggleText.textContent = 'Activated';
        btnToggle.classList.add('active');
      } else {
        toggleText.textContent = 'Activate Edit';
        btnToggle.classList.remove('active');
      }
      // Re-apply send/stop button state (panelStreamingActive is the source of truth).
      if (panelStreamingActive) {
        btnSend.classList.add('stop-mode');
        sendIcon.classList.add('hidden');
        stopIcon.classList.remove('hidden');
        btnSend.disabled = false;
        tabContext.classList.add('streaming');
      } else {
        btnSend.classList.remove('stop-mode');
        sendIcon.classList.remove('hidden');
        stopIcon.classList.add('hidden');
        tabContext.classList.remove('streaming');
      }
      syncInputState();
      break;
    }
    case 'LANTHRA_TOGGLE_ACK':
      console.log('[Lanthra] sidepanel: toggle ACK, armed=', msg.armed);
      updateUI(msg.armed ? 'armed' : 'idle');
      break;
    case 'LANTHRA_CHAT_USER':
      if (skipNextUserEcho) {
        skipNextUserEcho = false;
      } else {
        addUserMessage(msg.prompt);
      }
      break;
    case 'LANTHRA_CHAT_TOKEN':
      // Ensure the stop button is visible and streaming is tracked.
      if (!panelStreamingActive) {
        panelStreamingActive = true;
        updateUI(currentState); // refresh stop/send button from new panelStreamingActive
      }
      // Track session ID from first token if we didn't get it from sendResponse
      if (!panelStreamSessionId && msg.sessionId) {
        panelStreamSessionId = msg.sessionId;
      }
      appendAIToken(msg.token);
      break;
    case 'LANTHRA_CHAT_END':
      // Ignore stale END broadcasts from unrelated sessions (e.g. inline edits)
      if (panelStreamSessionId && msg.sessionId && msg.sessionId !== panelStreamSessionId) break;
      panelStreamingActive = false;
      streamingTabId = null;
      panelStreamSessionId = null;
      endAIMessage();
      updateUI('idle');
      // Only deactivate content script for panel-initiated prompts.
      // Inline prompts stay armed so the host output remains visible.
      if (msg.isPanelPrompt) {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'LANTHRA_DEACTIVATE' }).catch(() => {});
          }
        });
      }
      break;
    case 'LANTHRA_CHAT_ERROR':
      // Ignore stale ERROR broadcasts from unrelated sessions
      if (panelStreamSessionId && msg.sessionId && msg.sessionId !== panelStreamSessionId) break;
      panelStreamingActive = false;
      streamingTabId = null;
      panelStreamSessionId = null;
      addErrorMessage(msg.error);
      updateUI('idle');
      break;
    case 'LANTHRA_USAGE':
      recordUsage(msg.promptTokens ?? 0, msg.completionTokens ?? 0);
      break;
    case 'LANTHRA_TAB_CHANGED': {
      const url = msg.url as string;
      let display: string;
      try {
        const u = new URL(url);
        display = u.hostname.replace(/^www\./, '');
      } catch {
        display = url.slice(0, 40);
      }
      tabContextText.textContent = display;
      tabContext.title = msg.title || url;
      setTabFavicon(msg.favIconUrl as string | undefined);
      // Update streaming visual state
      if (panelStreamingActive) {
        tabContext.classList.add('streaming');
      }
      break;
    }
  }
});

// ── Provider/model persistence (handled via dropdown onChange callbacks) ──────

// (Provider and model change handlers are set up in init() via createDropdown)

// ── API key (provider-aware) ─────────────────────────────────────────────────

apiKeyInput.addEventListener('focus', () => {
  if (apiKeyInput.dataset.saved === 'true') {
    apiKeyInput.value = '';
    apiKeyInput.dataset.saved = 'false';
  }
});

apiKeyInput.addEventListener('blur', () => {
  if (apiKeyInput.dataset.saved === 'false' && !apiKeyInput.value.trim()) {
    const keyName = providerKeyName(currentProvider);
    chrome.storage.local.get([keyName], (result) => {
      if (result[keyName]) {
        apiKeyInput.value = '••••••••••';
        apiKeyInput.dataset.saved = 'true';
      }
    });
  }
});

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key || key === '••••••••••') return;

  const keyName = providerKeyName(currentProvider);
  chrome.storage.local.set({ [keyName]: key }, () => {
    apiKeyInput.value = '••••••••••';
    apiKeyInput.dataset.saved = 'true';
    keyStatus.textContent = 'Key saved';
    keyStatus.className = 'key-status saved';
    setTimeout(() => { keyStatus.textContent = ''; }, 2000);
  });

  // Re-fetch live models for Groq when key is saved
  if (currentProvider === 'groq') await populateGroqModels();
});

// ── Chat input auto-resize ──────────────────────────────────────────────────

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
  syncInputState();
});

// ── Send / Stop ──────────────────────────────────────────────────────────────

async function handleSendOrStop(): Promise<void> {
  if (panelStreamingActive) {
    // Stop generation — send cancel to the tab that started the stream
    const cancelTabId = streamingTabId;
    if (cancelTabId) {
      chrome.tabs.sendMessage(cancelTabId, { type: 'LANTHRA_CANCEL_FROM_PANEL' }).catch(() => {});
    }
    panelStreamingActive = false;
    streamingTabId = null;
    panelStreamSessionId = null;
    endAIMessage();
    hideThinkingIndicator();
    updateUI(currentState);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const text = chatInput.value.trim();
  if (!text) return;

  // Show user bubble immediately (don't wait for broadcast echo)
  addUserMessage(text);
  skipNextUserEcho = true;

  // Mark panel streaming active BEFORE updateUI so the stop button appears.
  panelStreamingActive = true;
  streamingTabId = tab.id;
  panelStreamSessionId = null; // will be set when CS responds
  updateUI('streaming');

  // Forward prompt to content script which will trigger the AI flow.
  // If the user has highlighted text, attach it so the CS can build
  // a constrained context for the AI.
  const highlightPayload = currentHighlight || undefined;

  // Build conversation history for multi-turn context (exclude the message we just added)
  const historyForAI = sessionHistory
    .slice(0, -1) // exclude the just-added user message (it's sent as `prompt`)
    .filter(m => m.role !== 'error')
    .map(m => ({ role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }));

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'LANTHRA_PANEL_PROMPT',
      prompt: text,
      highlightedText: highlightPayload,
      history: historyForAI.length > 0 ? historyForAI : undefined,
    });
    if (resp?.sessionId) panelStreamSessionId = resp.sessionId;
  } catch {
    // Content script not reachable on this tab.
    panelStreamingActive = false;
    streamingTabId = null;
    panelStreamSessionId = null;
    hideThinkingIndicator();
    addErrorMessage('Cannot connect to the page. Try refreshing or re-activating Lanthra on this tab.');
    updateUI('idle');
    skipNextUserEcho = false;
    return;
  }

  chatInput.value = '';
  chatInput.style.height = 'auto';
  syncInputState();

  // Consume the highlight — clear it after sending
  if (highlightPayload) {
    setHighlightText('');
  }
}

btnSend.addEventListener('click', handleSendOrStop);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendOrStop();
  }
});

// ── Shortcut display ─────────────────────────────────────────────────────────

const shortcutDisplay = document.getElementById('shortcut-display')!;
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
shortcutDisplay.textContent = isMac ? '⌘+Shift+X' : 'Ctrl+Shift+X';

// ── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Signal to service worker that the panel is open (triggers TLS pre-warming)
  chrome.runtime.connect({ name: 'lanthra:sidepanel' });

  // Create dropdown states with change handlers
  // ── Migrate legacy key names ──────────────────────────────────────────────
  const legacy = await chrome.storage.local.get([
    'lanthra_api_key', 'lanthra_groq_key', 'lanthra_key_openrouter', 'lanthra_key_groq',
  ]);
  if (legacy.lanthra_api_key && !legacy.lanthra_key_openrouter) {
    await chrome.storage.local.set({ lanthra_key_openrouter: legacy.lanthra_api_key });
  }
  if (legacy.lanthra_groq_key && !legacy.lanthra_key_groq) {
    await chrome.storage.local.set({ lanthra_key_groq: legacy.lanthra_groq_key });
  }

  providerDD = createDropdown(providerWrap, providerTrigger, providerDropdown, async (key) => {
    chrome.storage.local.set({ lanthra_provider: key });
    currentProvider = key;
    toggleProviderUI(key);
    if (key === 'ollama') {
      await populateOllamaModels();
    } else {
      await populateModels(key);
    }
  });

  modelDD = createDropdown(modelWrap, modelTrigger, modelDropdown, (modelId) => {
    chrome.storage.local.set({ lanthra_model: modelId });
  });

  // Fetch live models first, then populate UI
  await fetchAllModels();
  populateProviders();

  const saved = await chrome.storage.local.get(['lanthra_provider']);
  const provider = saved.lanthra_provider ?? 'anthropic';
  currentProvider = provider;
  const providerLabel = PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  setDropdownValue(providerDD, provider, providerLabel);
  toggleProviderUI(provider);
  if (provider === 'ollama') {
    await populateOllamaModels();
  } else {
    await populateModels(provider);
  }

  // Enable input
  chatInput.disabled = false;
  syncInputState();

  // Restore cached chat history
  await restoreChatHistory();

  // Check page compatibility
  await checkPageStatus();

  // Seed tab context badge with current tab info
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      try {
        const u = new URL(tab.url);
        tabContextText.textContent = u.hostname.replace(/^www\./, '');
      } catch {
        tabContextText.textContent = tab.url.slice(0, 40);
      }
      tabContext.title = tab.title || tab.url;
      setTabFavicon(tab.favIconUrl);
    }
  } catch { /* no tab */ }
}

// ── Markdown renderer (using marked) ─────────────────────────────────────────

const LATEX_SYMBOLS: Record<string, string> = {
  '\\rightarrow': '\u2192', '\\leftarrow': '\u2190', '\\leftrightarrow': '\u2194',
  '\\Rightarrow': '\u21D2', '\\Leftarrow': '\u21D0', '\\Leftrightarrow': '\u21D4',
  '\\times': '\u00D7', '\\div': '\u00F7', '\\pm': '\u00B1', '\\mp': '\u2213',
  '\\leq': '\u2264', '\\geq': '\u2265', '\\neq': '\u2260', '\\approx': '\u2248',
  '\\infty': '\u221E', '\\sum': '\u2211', '\\prod': '\u220F', '\\int': '\u222B',
  '\\partial': '\u2202', '\\nabla': '\u2207', '\\sqrt': '\u221A',
  '\\alpha': '\u03B1', '\\beta': '\u03B2', '\\gamma': '\u03B3', '\\delta': '\u03B4',
  '\\epsilon': '\u03B5', '\\theta': '\u03B8', '\\lambda': '\u03BB', '\\mu': '\u03BC',
  '\\pi': '\u03C0', '\\sigma': '\u03C3', '\\phi': '\u03C6', '\\omega': '\u03C9',
  '\\Delta': '\u0394', '\\Sigma': '\u03A3', '\\Omega': '\u03A9',
  '\\cdot': '\u00B7', '\\ldots': '\u2026', '\\dots': '\u2026',
  '\\in': '\u2208', '\\notin': '\u2209', '\\subset': '\u2282', '\\supset': '\u2283',
  '\\cup': '\u222A', '\\cap': '\u2229', '\\forall': '\u2200', '\\exists': '\u2203',
  '\\neg': '\u00AC', '\\land': '\u2227', '\\lor': '\u2228',
  '\\langle': '\u27E8', '\\rangle': '\u27E9',
};

function renderMarkdown(text: string): string {
  // Strip em dashes
  let processed = text.replace(/\u2014/g, '-');

  // LaTeX inline math: $...$ → replace known symbols with Unicode
  processed = processed.replace(/\$([^$]+)\$/g, (_m, expr: string) => {
    let result = expr;
    for (const [cmd, ch] of Object.entries(LATEX_SYMBOLS)) {
      result = result.split(cmd).join(ch);
    }
    result = result.replace(/\\text\{([^}]*)\}/g, '$1');
    result = result.replace(/\\[a-zA-Z]+/g, '');
    result = result.replace(/[{}]/g, '');
    return result.trim();
  });

  // Use marked for full markdown parsing (synchronous), then sanitize
  const raw = marked.parse(processed, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'hr', 'sup', 'sub', 'span', 'div', 'details', 'summary',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title', 'class', 'id'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
  });
}

// ── Chat session caching (chrome.storage.session — survives panel toggles, clears on browser close) ──

const CHAT_STORAGE_KEY  = 'lanthra_active_chat';
const IDLE_TIMEOUT_MS   = 42 * 60 * 60 * 1000; // 42 hours

interface CachedMsg { role: 'user' | 'ai' | 'error'; content: string; ts: number; }
interface ChatData  { messages: CachedMsg[]; lastInteraction: number; }
const sessionHistory: CachedMsg[] = [];

function appendToHistory(role: CachedMsg['role'], content: string): void {
  sessionHistory.push({ role, content, ts: Date.now() });
  persistChat();
}

/** Persist current chat to chrome.storage.session. */
function persistChat(): void {
  const data: ChatData = {
    messages: sessionHistory,
    lastInteraction: Date.now(),
  };
  chrome.storage.session.set({ [CHAT_STORAGE_KEY]: data }).catch(() => {});
}

async function restoreChatHistory(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(CHAT_STORAGE_KEY);
    const data = result[CHAT_STORAGE_KEY] as ChatData | undefined;
    if (!data?.messages?.length) return;

    // Check idle timeout — purge if stale
    if (Date.now() - data.lastInteraction > IDLE_TIMEOUT_MS) {
      await chrome.storage.session.remove(CHAT_STORAGE_KEY);
      return;
    }

    // Replay messages into the UI
    for (const msg of data.messages) {
      sessionHistory.push(msg);
      if (msg.role === 'user') {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-msg chat-msg-user';
        wrapper.innerHTML = `<div class="chat-msg-bubble"></div>`;
        wrapper.querySelector('.chat-msg-bubble')!.textContent = msg.content;
        chatMessages.appendChild(wrapper);
      } else if (msg.role === 'ai') {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-msg chat-msg-ai';
        wrapper.innerHTML =
          `<span class="chat-msg-label">Lanthra</span>` +
          `<div class="chat-msg-bubble">${renderMarkdown(msg.content)}</div>`;
        chatMessages.appendChild(wrapper);
      } else if (msg.role === 'error') {
        const wrapper = document.createElement('div');
        wrapper.className = 'chat-msg chat-msg-ai chat-msg-error';
        wrapper.innerHTML =
          `<span class="chat-msg-label">Error</span>` +
          `<div class="chat-msg-bubble"></div>`;
        wrapper.querySelector('.chat-msg-bubble')!.textContent = msg.content;
        chatMessages.appendChild(wrapper);
      }
    }
    hintBlock.classList.add('hidden');
    scrollToBottom();
  } catch { /* storage may not be available */ }
}

async function clearChatHistory(): Promise<void> {
  sessionHistory.length = 0;
  // Clear session storage
  await chrome.storage.session.remove(CHAT_STORAGE_KEY).catch(() => {});
  // Also clear any legacy persisted cache
  await chrome.storage.local.remove('lanthra_chat_history').catch(() => {});
  chatMessages.innerHTML = '';
  hintBlock.classList.remove('hidden');
  activeAIBubble = null;
  activeAICursor = null;
  hideThinkingIndicator();
}

// ── Page status ──────────────────────────────────────────────────────────────

async function checkPageStatus(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      setPageStatus('unavailable', 'No active tab');
      return;
    }

    const url = tab.url;
    // Pages that extensions fundamentally cannot access
    if (/^(chrome|chrome-extension|about|edge|brave|devtools):/.test(url)) {
      setPageStatus('unavailable', 'Browser internal pages cannot be edited by extensions');
      return;
    }

    if (url.startsWith('file://')) {
      setPageStatus('unavailable', 'Enable "Allow access to file URLs" in extension settings');
      return;
    }

    // Try pinging the content script
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'LANTHRA_PING' });
      setPageStatus('ready', 'Extension active on this page');
    } catch {
      // Content script not injected — try programmatic injection
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'LANTHRA_INJECT_CS', tabId: tab.id
        });
        if (resp?.ok) {
          setPageStatus('ready', 'Extension injected and ready');
        } else {
          setPageStatus('unavailable', resp?.error ?? 'Cannot run on this page');
        }
      } catch {
        setPageStatus('unavailable', 'Cannot run on this page');
      }
    }
  } catch {
    setPageStatus('unavailable', 'Error checking page');
  }
}

function setPageStatus(status: 'ready' | 'unavailable', tooltip: string): void {
  pageStatus.title = tooltip;
  if (status === 'ready') {
    pageStatus.textContent = '✓ Ready';
    pageStatus.className = 'badge badge-ready';
  } else {
    pageStatus.textContent = '✗ N/A';
    pageStatus.className = 'badge badge-unavailable';
  }
}

// Re-check page status when the user switches tabs
chrome.tabs.onActivated?.addListener(() => checkPageStatus());

// ── Clear conversation ──────────────────────────────────────────────────────

btnClearChat.addEventListener('click', () => {
  clearConfirmOverlay.classList.remove('hidden');
});

btnClearConfirm.addEventListener('click', async () => {
  clearConfirmOverlay.classList.add('hidden');
  await clearChatHistory();
  settingsOverlay.classList.add('hidden');
});

btnClearCancel.addEventListener('click', () => {
  clearConfirmOverlay.classList.add('hidden');
});

clearConfirmOverlay.addEventListener('click', (e) => {
  if ((e.target as Element).classList.contains('modal-backdrop')) {
    clearConfirmOverlay.classList.add('hidden');
  }
});

// ── Scroll-to-bottom button ─────────────────────────────────────────────────

btnScrollBottom.addEventListener('click', () => {
  const content = chatMessages.closest('.content');
  if (content) {
    content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
    btnScrollBottom.classList.remove('visible');
  }
  userHasScrolledUp = false;
});

const contentArea = chatMessages.closest('.content');
if (contentArea) {
  contentArea.addEventListener('scroll', () => {
    const distFromBottom = contentArea.scrollHeight - contentArea.scrollTop - contentArea.clientHeight;
    if (distFromBottom > 100) {
      btnScrollBottom.classList.add('visible');
      userHasScrolledUp = true;
    } else {
      btnScrollBottom.classList.remove('visible');
      userHasScrolledUp = false;
    }
  });
}

// ── Highlight context (selection tracking) ──────────────────────────────────

let currentHighlight = '';
let highlightDismissed = false;

function setHighlightText(text: string): void {
  if (highlightDismissed && text) return; // user dismissed; don't re-show same selection
  currentHighlight = text;
  if (text) {
    highlightBody.textContent = text;
    highlightCtx.classList.remove('hidden');
  } else {
    highlightCtx.classList.add('hidden');
    highlightCtx.classList.remove('open');
    highlightDismissed = false; // reset dismiss on clear
  }
}

highlightHeader.addEventListener('click', () => {
  highlightCtx.classList.toggle('open');
});

highlightClear.addEventListener('click', (e) => {
  e.stopPropagation();
  highlightDismissed = true;
  currentHighlight = '';
  highlightCtx.classList.add('hidden');
  highlightCtx.classList.remove('open');
});

// Listen for selection changes from the active tab's content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'LANTHRA_SELECTION_CHANGED') {
    if (typeof msg.text === 'string') {
      highlightDismissed = false;
      setHighlightText(msg.text);
    }
  }
});

// Poll current selection when sidepanel opens or active tab changes
async function fetchCurrentSelection(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'LANTHRA_GET_SELECTION' });
    if (resp?.text && typeof resp.text === 'string') {
      highlightDismissed = false;
      setHighlightText(resp.text);
    } else {
      setHighlightText('');
    }
  } catch {
    setHighlightText('');
  }
}

// Fetch on load
fetchCurrentSelection();

// Clear highlight when switching tabs (new tab has no selection)
chrome.tabs.onActivated?.addListener(() => {
  setHighlightText('');
  // Then query the new tab for its selection
  setTimeout(fetchCurrentSelection, 150);
});

// ── Settings modal tab switching ────────────────────────────────────────────

document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = (tab as HTMLElement).dataset.tab;
    if (target === 'usage') {
      tabSettings.classList.add('hidden');
      tabUsage.classList.remove('hidden');
      renderUsageTab();
    } else {
      tabSettings.classList.remove('hidden');
      tabUsage.classList.add('hidden');
    }
  });
});

// ── Usage tracking ──────────────────────────────────────────────────────────

interface UsageEntry {
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

async function recordUsage(promptTokens: number, completionTokens: number): Promise<void> {
  const stored = await chrome.storage.local.get(['lanthra_provider', 'lanthra_model', 'lanthra_usage']);
  const provider = stored.lanthra_provider ?? 'unknown';
  const model    = stored.lanthra_model ?? 'unknown';
  const usage: Record<string, UsageEntry> = stored.lanthra_usage ?? {};

  const key = `${provider}::${model}`;
  if (!usage[key]) {
    usage[key] = { provider, model, requests: 0, promptTokens: 0, completionTokens: 0 };
  }
  usage[key]!.requests += 1;
  usage[key]!.promptTokens += promptTokens;
  usage[key]!.completionTokens += completionTokens;

  await chrome.storage.local.set({ lanthra_usage: usage });
}

function renderUsageTab(): void {
  chrome.storage.local.get(['lanthra_usage'], (result) => {
    const usage: Record<string, UsageEntry> = result.lanthra_usage ?? {};
    const entries = Object.values(usage);

    let totalReqs = 0, totalPrompt = 0, totalComp = 0;
    for (const e of entries) {
      totalReqs    += e.requests;
      totalPrompt  += e.promptTokens;
      totalComp    += e.completionTokens;
    }

    usageTotalReqs.textContent = totalReqs.toLocaleString();
    usagePromptTok.textContent = totalPrompt.toLocaleString();
    usageCompTok.textContent   = totalComp.toLocaleString();
    usageTotalTok.textContent  = (totalPrompt + totalComp).toLocaleString();

    // Per-model breakdown
    usageByModel.innerHTML = '';
    const sorted = entries.sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens));
    for (const e of sorted) {
      const row = document.createElement('div');
      row.className = 'usage-model-row';
      const name = document.createElement('span');
      name.className = 'usage-model-name';
      name.textContent = e.model;
      name.title = `${e.provider} / ${e.model}`;
      const tokens = document.createElement('span');
      tokens.className = 'usage-model-tokens';
      tokens.textContent = `${(e.promptTokens + e.completionTokens).toLocaleString()} tok · ${e.requests} req`;
      row.appendChild(name);
      row.appendChild(tokens);
      usageByModel.appendChild(row);
    }
    if (sorted.length === 0) {
      usageByModel.innerHTML = '<div style="font-size:11px;color:var(--text-dim);text-align:center;padding:12px 0">No usage data yet</div>';
    }
  });
}

btnResetUsage.addEventListener('click', async () => {
  await chrome.storage.local.remove('lanthra_usage');
  renderUsageTab();
});

init();

// ── Ollama helpers ──────────────────────────────────────────────────────────

function toggleProviderUI(provider: string): void {
  currentProvider = provider;
  const isOllama = provider === 'ollama';

  ollamaSection.style.display   = isOllama  ? '' : 'none';
  apiKeySection.style.display   = isOllama  ? 'none' : '';
  modelSection.style.display    = '';

  if (isOllama) {
    chrome.storage.local.get(['lanthra_ollama_url'], (result) => {
      ollamaUrlInput.value = result.lanthra_ollama_url || 'http://localhost:11434';
    });
    return;
  }

  // Set provider-specific placeholder
  apiKeyInput.placeholder = PROVIDER_PLACEHOLDERS[provider] ?? 'API key…';

  // Update API key link
  const link = API_KEY_LINKS[provider];
  if (link) {
    apiKeyLink.href        = link.url;
    apiKeyLink.textContent = link.label + ' →';
    apiKeyLink.style.display = '';
  } else {
    apiKeyLink.style.display = 'none';
  }

  // Load stored key for this provider
  const keyName = providerKeyName(provider);
  keyStatus.textContent = '';
  chrome.storage.local.get([keyName], (result) => {
    if (result[keyName]) {
      apiKeyInput.value = '••••••••••';
      apiKeyInput.dataset.saved = 'true';
    } else {
      apiKeyInput.value = '';
      delete apiKeyInput.dataset.saved;
    }
  });
}

// ── Groq live models ─────────────────────────────────────────────────────────

const GROQ_FALLBACK: ModelEntry[] = [
  { id: 'llama-3.3-70b-versatile',         name: 'Llama 3.3 70B Versatile' },
  { id: 'llama-3.1-70b-versatile',          name: 'Llama 3.1 70B Versatile' },
  { id: 'llama-3.1-8b-instant',             name: 'Llama 3.1 8B Instant' },
  { id: 'llama3-70b-8192',                   name: 'Llama 3 70B' },
  { id: 'llama3-8b-8192',                    name: 'Llama 3 8B' },
  { id: 'deepseek-r1-distill-llama-70b',    name: 'DeepSeek R1 Distill Llama 70B' },
  { id: 'qwen-qwq-32b',                      name: 'Qwen QwQ 32B' },
  { id: 'gemma2-9b-it',                      name: 'Gemma 2 9B IT' },
  { id: 'mixtral-8x7b-32768',               name: 'Mixtral 8x7B' },
];

function groqModelDisplayName(id: string): string {
  return id
    .replace(/-(\.?\d)/g, ' $1')
    .replace(/-/g, ' ')
    .replace(/\b(\w)/g, c => c.toUpperCase())
    .trim();
}

async function populateGroqModels(): Promise<void> {
  const stored = await chrome.storage.local.get(['lanthra_key_groq', 'lanthra_model']);
  const groqKey = (stored.lanthra_key_groq as string | undefined) ?? '';

  let models = GROQ_FALLBACK.slice();

  if (groqKey) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const resp  = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ id: string }> };
        const live = (data.data ?? [])
          .filter(m => !m.id.includes('whisper') && !m.id.includes('-tool-use') && !m.id.includes('guard'))
          .map(m => ({ id: m.id, name: groqModelDisplayName(m.id) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (live.length > 0) models = live;
      }
    } catch (_) {
      // fall through to hardcoded fallback
    }
  }

  const items = models.map(m => ({ value: m.id, label: m.name }));
  populateDropdown(modelDD, items, true);
  appendCustomModelInput();

  const savedModel = stored.lanthra_model as string | undefined;
  if (savedModel) {
    const match = models.find(m => m.id === savedModel);
    setDropdownValue(modelDD, savedModel, match ? match.name : savedModel);
  } else if (models.length > 0) {
    setDropdownValue(modelDD, models[0]!.id, models[0]!.name);
  }
}

async function populateOllamaModels(): Promise<void> {
  const stored = await chrome.storage.local.get(['lanthra_ollama_url']);
  const baseUrl = stored.lanthra_ollama_url || 'http://localhost:11434';

  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models: ModelEntry[] = (data.models || []).map((m: Record<string, unknown>) => ({
      id:   (m.name as string) || (m.model as string) || '',
      name: (m.name as string) || (m.model as string) || '',
    }));

    // Populate model dropdown with Ollama models
    const items = models.map(m => ({ value: m.id, label: m.name }));
    populateDropdown(modelDD, items, models.length > 5);

    if (models.length > 0) {
      const saved = await chrome.storage.local.get(['lanthra_model']);
      const match = models.find(m => m.id === saved.lanthra_model);
      const selected = match || models[0]!;
      setDropdownValue(modelDD, selected.id, selected.name);
      chrome.storage.local.set({ lanthra_model: selected.id });
    }
    ollamaStatus.textContent = `\u2713 Connected - ${models.length} model${models.length !== 1 ? 's' : ''}`;
    ollamaStatus.className = 'key-status saved';
  } catch {
    showOllamaError();
  }
}

function showOllamaError(): void {
  ollamaStatus.textContent = '\u2717 Cannot detect Ollama. Make sure it is running.';
  ollamaStatus.className = 'key-status error';
}

// Connection test
btnTestOllama.addEventListener('click', async () => {
  const url = ollamaUrlInput.value.trim() || 'http://localhost:11434';
  if (!isLocalUrl(url)) {
    ollamaStatus.textContent = '✗ Ollama URL must be localhost (127.0.0.1, ::1, or localhost).';
    ollamaStatus.className = 'key-status error';
    return;
  }
  ollamaStatus.textContent = 'Testing…';
  ollamaStatus.className = 'key-status';

  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/api/tags`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const count = data.models?.length ?? 0;
    ollamaStatus.textContent = `\u2713 Connected - ${count} model${count !== 1 ? 's' : ''} available`;
    ollamaStatus.className = 'key-status saved';
    // Save URL and refresh models
    chrome.storage.local.set({ lanthra_ollama_url: url });
    await populateOllamaModels();
  } catch {
    showOllamaError();
  }
});

// Auto-save Ollama URL on blur
ollamaUrlInput.addEventListener('blur', () => {
  const url = ollamaUrlInput.value.trim();
  if (url && isLocalUrl(url)) chrome.storage.local.set({ lanthra_ollama_url: url });
});

/** Only allow localhost Ollama URLs to prevent SSRF. */
function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch { return false; }
}
