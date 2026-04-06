// edit-session.ts — Core lifecycle state machine for inline AI editing.
//
// Flow:
//   idle → (toggle) → armed → (click page) → editing → (Enter) → streaming
//     → (AI done) → armed  (host stays as clickable output)
//   armed → (toggle) → idle  (full deactivation)
//   armed → (click elsewhere) → removes old host, places new → editing
//
// Only one inline host can exist at a time. Clicking elsewhere while armed
// removes the previous host and places a new one.

import { log }                                         from '../shared/logger';
import { hitTest }                                     from './hit-test';
import { insertAnchorAtPoint, removeAnchor }           from './range-utils';
import type { AnchorResult }                           from './range-utils';
import { mirrorStylesFrom, nearestBlockAncestor }     from './style-mirror';
import { InlineHost }                                  from './inline-host';
import { MutationGuard }                               from './mutation-guard';
import { saveSelection, restoreSelection, clearSelection } from './selection-store';
import type { SavedSelection }                         from './selection-store';
import type { SWMessage }                              from '../types/messages';
import { PORT_SESSION_PREFIX }                         from '../types/messages';
import { executePageTool }                             from './page-tools';

type SessionState = 'idle' | 'armed' | 'editing' | 'streaming';

// Overlay element shown while armed to change the cursor site-wide
let armOverlay: HTMLDivElement | null = null;
// Hover affordance element
let hoverOutline: HTMLDivElement | null = null;
// Last element the cursor hovered over while armed
let hoverTarget: Element | null = null;
// Insertion caret indicator
let insertionCaret: HTMLDivElement | null = null;
// Image highlight overlay (orange border when hovering images while armed)
let imageHighlight: HTMLDivElement | null = null;
let highlightTargetEl: HTMLElement | null = null;
// Image prompt overlay
let imagePromptOverlay: HTMLDivElement | null = null;
let promptTargetEl: HTMLElement | null = null;
// In-DOM image response — uses InlineHost so it inherits page typography exactly
let imageHost: InlineHost | null = null;
let imageInThinkBlock = false;
let storedImageUrl: string | null = null;
let storedImageAlt = '';
// Scroll tracking for fixed-position overlays
let scrollHandler: (() => void) | null = null;

export class EditSession {
  // ── Singleton ─────────────────────────────────────────────────────────────
  static current: EditSession = new EditSession();

  // ── Instance ──────────────────────────────────────────────────────────────
  readonly id: string = crypto.randomUUID();

  private state:          SessionState    = 'idle';
  private anchorResult:   AnchorResult | null = null;
  private host:           InlineHost | null   = null;
  private guard:          MutationGuard | null = null;
  private savedSelection: SavedSelection | null = null;
  private swPort:         chrome.runtime.Port | null = null;
  private inThinkBlock:   boolean = false;

  // ── Public toggle entry point ─────────────────────────────────────────────

  onToggle(): void {
    if (this.state === 'idle') {
      this.arm();
    } else if (this.state === 'armed') {
      // Already armed — stay armed (don't cycle to idle)
      // This lets the shortcut always produce the "active" state
    } else {
      // editing/streaming — cancel current, stay armed
      this.cleanupCurrentHost();
      this.transition('armed');
    }
  }

  /** Explicit deactivation — called from sidepanel button when already armed. */
  deactivate(): void {
    this.fullDisarm();
  }

  // ── Arm: crosshair mode, listen for clicks ────────────────────────────────

  private arm(): void {
    this.transition('armed');
    this.showArmOverlay();
    this.injectCaretStyles();
    document.addEventListener('click',     this.onPageClick,  { capture: true });
    document.addEventListener('mouseover', this.onMouseOver,  { capture: true });
    document.addEventListener('mouseout',  this.onMouseOut,   { capture: true });
    document.addEventListener('mousemove', this.onMouseMove,  { capture: true });
    document.addEventListener('keydown',   this.onArmedKeyDown, { capture: true });
    this.attachScrollTracker();
    log('info', `session armed`);
  }

  // ── Soft cancel: remove current host but stay armed ───────────────────────

  cancel(): void {
    if (this.state === 'idle') return;
    this.cleanupCurrentHost();
    this.transition('armed');
    log('info', `session ${this.id} canceled (staying armed)`);
  }

  // ── Full disarm: remove everything and go idle ────────────────────────────

  private fullDisarm(): void {
    // If host is in done mode, keep it visible (clickable to re-edit)
    if (this.host?.isDone) {
      // Just remove overlay/listeners but preserve the host
      this.disarm();
      this.transition('idle');
      log('info', `session fully disarmed (done host preserved)`);
      return;
    }
    this.cleanupCurrentHost();
    this.disarm();
    if (this.savedSelection) restoreSelection(this.savedSelection);
    this.savedSelection = null;
    this.transition('idle');
    log('info', `session fully disarmed`);
  }

  private disarm(): void {
    this.hideArmOverlay();
    this.hideHoverOutline();
    this.hideInsertionCaret();
    this.hideImageHighlight();
    this.hideImagePrompt();
    this.detachScrollTracker();
    document.removeEventListener('click',     this.onPageClick, { capture: true });
    document.removeEventListener('mouseover', this.onMouseOver, { capture: true });
    document.removeEventListener('mouseout',  this.onMouseOut,  { capture: true });
    document.removeEventListener('mousemove', this.onMouseMove, { capture: true });
    document.removeEventListener('keydown',   this.onArmedKeyDown, { capture: true });
  }

  // ── Clean up the current inline host without disarming ────────────────────

  private cleanupCurrentHost(): void {
    this.guard?.stop();
    this.guard = null;
    this.closePort();

    if (this.host) {
      this.host.destroy();
      this.host = null;
    }

    if (this.anchorResult) {
      removeAnchor(this.anchorResult);
      this.anchorResult = null;
    }

    // Fresh session ID for next placement
    (this as { id: string }).id = crypto.randomUUID();
    this.swPort = null;
  }

  // ── Incoming SW messages (called by content/index.ts) ─────────────────────

  handleSWMessage(msg: SWMessage): void {
    switch (msg.type) {
      case 'LANTHRA_TOKEN':
        if (msg.sessionId === this.id) this.onToken(msg.token);
        break;
      case 'LANTHRA_STREAM_END':
        if (msg.sessionId === this.id) this.onStreamEnd();
        break;
      case 'LANTHRA_ERROR':
        if (msg.sessionId === this.id) this.onError(msg.error);
        break;
      case 'LANTHRA_TOGGLE_ACK':
        break;
    }
  }

  // ── DOM event handlers ────────────────────────────────────────────────────

  private onPageClick = (e: MouseEvent): void => {
    const target = e.target as Element;
    if (!target) return;

    // Block image prompts while an image response is actively streaming
    const imageStreaming = imageHost !== null && !imageHost.isDone;

    // Image click → show prompt overlay for user to type a question
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      const src = resolveImageUrl(img);
      if (src) {
        e.preventDefault();
        e.stopPropagation();
        if (imageStreaming) return;
        this.hideImageHighlight();
        this.showImagePrompt(img, src);
        return;
      }
    }

    // Background-image click — check for CSS background images
    const bgSrc = resolveBackgroundImage(target);
    if (bgSrc) {
      e.preventDefault();
      e.stopPropagation();
      if (imageStreaming) return;
      this.showImagePrompt(target as HTMLElement, bgSrc);
      return;
    }

    // Clicks on the done host → re-edit in place
    if (this.host?.isDone) {
      const anchorEl = this.anchorResult?.anchor;
      if (this.host.element.contains(target) || anchorEl?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        this.reEdit();
        return;
      }
    }

    // Clicks inside active host/anchor (user is typing) → let browser handle
    if (this.host && !this.host.isDone && this.anchorResult) {
      if (this.anchorResult.anchor.contains(target)) return;
    }

    // Standard hit test for new placement
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;

    e.preventDefault();
    e.stopPropagation();

    // Remove previous host (only 1 at a time)
    this.cleanupCurrentHost();

    this.savedSelection = saveSelection();
    clearSelection();
    this.hideHoverOutline();
    this.hideInsertionCaret();

    this.insertHost(e.clientX, e.clientY, hit.element);
  };

  private onMouseOver = (e: MouseEvent): void => {
    // Don't show element hover outlines during editing/streaming
    if (this.host && !this.host.isDone) return;
    // Don't show when image prompt is open
    if (imagePromptOverlay) return;
    const target = e.target as Element | null;
    if (!target || isLanthraElement(target)) return;
    if (this.anchorResult?.anchor.contains(target)) return;

    // Image hover → show orange highlight
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      if (img.offsetWidth > 0 && img.offsetHeight > 0) {
        this.hideHoverOutline();
        hoverTarget = null;
        this.showImageHighlight(img);
        return;
      }
    }

    // Background-image hover
    if (resolveBackgroundImage(target)) {
      this.hideHoverOutline();
      hoverTarget = null;
      this.showImageHighlightForElement(target as HTMLElement);
      return;
    }

    // Text hover
    this.hideImageHighlight();
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      // Use block-level ancestor so the entire paragraph/block gets one box
      const block = nearestBlockAncestor(hit.element);
      if (block !== hoverTarget) {
        hoverTarget = block;
        this.showHoverOutline(block);
      }
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    // Only show insertion caret while armed and no host is active
    if (this.state !== 'armed' || this.host) {
      this.hideInsertionCaret();
      return;
    }
    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) { this.hideInsertionCaret(); return; }
    const rect = range.getBoundingClientRect();
    if (rect.height > 0) {
      this.showInsertionCaret(rect.left, rect.top, rect.height);
    } else {
      this.hideInsertionCaret();
    }
  };

  private onMouseOut = (e: MouseEvent): void => {
    const related = e.relatedTarget as Element | null;
    // Image highlight
    if (highlightTargetEl && (!related || related !== highlightTargetEl)) {
      this.hideImageHighlight();
    }
    // Text highlight
    if (!related || !hoverTarget?.contains(related)) {
      this.hideHoverOutline();
      hoverTarget = null;
    }
  };

  /** Escape while armed → full disarm (return to idle). */
  private onArmedKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.fullDisarm();
    }
  };

  // ── Insertion ─────────────────────────────────────────────────────────────

  private insertHost(x: number, y: number, el: Element): void {
    const anchor = insertAnchorAtPoint(x, y);
    if (!anchor) {
      log('warn', 'insertAnchorAtPoint returned null');
      return;
    }

    this.anchorResult = anchor;

    const styles = mirrorStylesFrom(el);
    const host   = new InlineHost(styles);
    this.host    = host;

    host.onSubmit((prompt) => this.submitPrompt(prompt));
    host.onCancel(() => this.cancel());
    host.onReEdit(() => this.reEdit());

    anchor.anchor.appendChild(host.element);

    const blockRoot = nearestBlockAncestor(anchor.anchor);
    this.guard = new MutationGuard(anchor.anchor, blockRoot, () => this.orphan());
    this.guard.start();

    this.transition('editing');
    host.focus();
    log('info', `session ${this.id} host inserted`, { x, y });
  }

  // ── Prompt submission ─────────────────────────────────────────────────────

  private submitPrompt(prompt: string): void {
    if (this.state !== 'editing') return;
    this.transition('streaming');

    const context = this.buildContext();
    const port = chrome.runtime.connect({ name: `${PORT_SESSION_PREFIX}${this.id}` });
    this.swPort = port;

    port.onMessage.addListener((msg: SWMessage) => {
      // Handle tool calls from the AI — execute locally and return result
      if (msg.type === 'LANTHRA_TOOL_CALL') {
        const result = executePageTool(msg.name);
        port.postMessage({ type: 'LANTHRA_TOOL_RESULT', id: msg.id, result });
        return;
      }
      this.handleSWMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (this.state === 'streaming') {
        log('warn', `session ${this.id} SW port disconnected unexpectedly`);
        this.onError('Connection to extension background lost.');
      }
    });

    port.postMessage({
      type:      'LANTHRA_PROMPT_SUBMIT',
      sessionId: this.id,
      prompt,
      context,
    });

    this.host?.enterStreamingMode();
    log('info', `session ${this.id} prompt submitted`, { promptLength: prompt.length });
  }

  private buildContext(): string {
    const title = document.title ?? '';
    const url   = location.href;

    // Local context: text near where the user is editing
    let localContext = '';
    if (this.anchorResult) {
      const blockEl = this.anchorResult.anchor.closest(
        'p, article, section, li, td, div, blockquote'
      );
      const raw = (blockEl ?? this.anchorResult.anchor.parentElement)?.textContent ?? '';
      localContext = raw.trim().slice(0, 500);
    }

    // Lightweight metadata — full page content is fetched lazily via
    // the get_page_content tool when the AI actually needs it.
    return `lanthra:inline\nTitle: ${title}\nURL: ${url}\nEditing near: ${localContext}`;
  }

  // ── Token streaming ───────────────────────────────────────────────────────

  private onToken(token: string): void {
    if (this.state !== 'streaming') return;
    // Strip <think>...</think> blocks — only show final response inline
    const filtered = this.filterThinking(token);
    if (filtered) this.host?.appendToken(filtered);
  }

  /** Filter out <think> blocks from token stream for inline display. */
  private filterThinking(token: string): string {
    let out = '';
    let remaining = token;

    while (remaining.length > 0) {
      if (!this.inThinkBlock) {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx !== -1) {
          out += remaining.slice(0, openIdx);
          this.inThinkBlock = true;
          remaining = remaining.slice(openIdx + 7);
        } else {
          out += remaining;
          remaining = '';
        }
      } else {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx !== -1) {
          this.inThinkBlock = false;
          remaining = remaining.slice(closeIdx + 8);
        } else {
          remaining = '';
        }
      }
    }
    return out;
  }

  private onStreamEnd(): void {
    if (this.state !== 'streaming') return;
    this.inThinkBlock = false;

    // If the AI produced no visible output (only thinking), clean up silently
    if (this.host?.isEmpty) {
      log('info', `session ${this.id} stream ended with empty output, cleaning up`);
      this.cleanupCurrentHost();
      this.transition('armed');
      return;
    }

    // Put host into done mode (hoverable/clickable output)
    this.host?.enterDoneMode();

    this.guard?.stop();
    this.guard = null;
    this.closePort();

    // Go back to armed — user can click elsewhere or re-edit
    this.transition('armed');
    log('info', `session ${this.id} stream ended, staying armed`);
  }

  private onError(error: string): void {
    log('error', `session ${this.id} error: ${error}`);
    this.cleanupCurrentHost();
    // Stay armed so user can try again
    this.transition('armed');
  }

  // ── Re-edit: click on done output → clear and type new prompt ─────────────

  private reEdit(): void {
    if (!this.host || !this.anchorResult) return;

    // If we're idle (deactivated), re-arm first so the session is active
    if (this.state === 'idle') {
      this.arm();
    }

    this.host.reEdit();
    (this as { id: string }).id = crypto.randomUUID();

    const blockRoot = nearestBlockAncestor(this.anchorResult.anchor);
    this.guard = new MutationGuard(this.anchorResult.anchor, blockRoot, () => this.orphan());
    this.guard.start();

    this.transition('editing');
    log('info', `session ${this.id} re-editing`);
  }

  // ── Orphan / cleanup ──────────────────────────────────────────────────────

  private orphan(): void {
    log('warn', `session ${this.id} orphaned — anchor removed by page`);
    this.closePort();
    this.host?.destroy();
    this.host = null;
    this.anchorResult = null;
    this.guard = null;
    this.transition('armed');
  }

  private closePort(): void {
    try { this.swPort?.disconnect(); } catch { /* already closed */ }
    this.swPort = null;
  }

  // ── Hover affordance ──────────────────────────────────────────────────────

  private showHoverOutline(el: Element): void {
    this.hideHoverOutline();
    hoverTarget = el as HTMLElement;
    const r = el.getBoundingClientRect();
    if (!hoverOutline) {
      hoverOutline = document.createElement('div');
      hoverOutline.setAttribute('data-lanthra-hover', '');
      hoverOutline.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:1.5px dashed rgba(160,160,160,0.4)',
        'border-radius:3px',
        'background:rgba(128,128,128,0.04)',
        'transition:all 80ms ease',
      ].join(';');
      document.documentElement.appendChild(hoverOutline);
    }
    hoverOutline.style.top    = `${r.top}px`;
    hoverOutline.style.left   = `${r.left}px`;
    hoverOutline.style.width  = `${r.width}px`;
    hoverOutline.style.height = `${r.height}px`;
    hoverOutline.style.display = 'block';
  }

  private hideHoverOutline(): void {
    if (hoverOutline) hoverOutline.style.display = 'none';
  }

  // ── Image highlight ─────────────────────────────────────────────────────

  private showImageHighlight(img: HTMLImageElement): void {
    this.hideImageHighlight();
    highlightTargetEl = img;
    if (!imageHighlight) {
      imageHighlight = document.createElement('div');
      imageHighlight.setAttribute('data-lanthra-img-highlight', '');
      imageHighlight.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:1px solid #e8a44a',
        'border-radius:3px',
        'background:rgba(232,164,74,0.06)',
        'transition:all 80ms ease',
      ].join(';');
      document.documentElement.appendChild(imageHighlight);
    }
    const r = img.getBoundingClientRect();
    imageHighlight.style.top    = `${r.top}px`;
    imageHighlight.style.left   = `${r.left}px`;
    imageHighlight.style.width  = `${r.width}px`;
    imageHighlight.style.height = `${r.height}px`;
    imageHighlight.style.display = 'block';
  }

  private hideImageHighlight(): void {
    if (imageHighlight) imageHighlight.style.display = 'none';
    highlightTargetEl = null;
  }

  private showImageHighlightForElement(el: HTMLElement): void {
    this.hideImageHighlight();
    highlightTargetEl = el;
    if (!imageHighlight) {
      imageHighlight = document.createElement('div');
      imageHighlight.setAttribute('data-lanthra-img-highlight', '');
      imageHighlight.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:1px solid #e8a44a',
        'border-radius:3px',
        'background:rgba(232,164,74,0.06)',
        'transition:all 80ms ease',
      ].join(';');
      document.documentElement.appendChild(imageHighlight);
    }
    const r = el.getBoundingClientRect();
    imageHighlight.style.top    = `${r.top}px`;
    imageHighlight.style.left   = `${r.left}px`;
    imageHighlight.style.width  = `${r.width}px`;
    imageHighlight.style.height = `${r.height}px`;
    imageHighlight.style.display = 'block';
  }

  // ── Image prompt overlay ──────────────────────────────────────────────────

  private showImagePrompt(el: HTMLElement, imageUrl: string): void {
    this.hideImagePrompt();
    promptTargetEl = el;

    imagePromptOverlay = document.createElement('div');
    imagePromptOverlay.setAttribute('data-lanthra-img-prompt', '');
    imagePromptOverlay.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:4px',
      'padding:4px 6px',
      'background:rgba(43,42,39,0.88)',
      'border:1px solid rgba(255,255,255,0.1)',
      'border-radius:6px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.3)',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'font-size:12px',
      'color:#e8e6e1',
      'backdrop-filter:blur(8px)',
      'max-width:300px',
    ].join(';');

    this.positionPromptOverlay();

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask about this image\u2026';
    input.style.cssText = [
      'flex:1',
      'background:rgba(255,255,255,0.06)',
      'border:1px solid rgba(255,255,255,0.1)',
      'border-radius:4px',
      'padding:4px 7px',
      'color:#e8e6e1',
      'font-size:11px',
      'font-family:inherit',
      'outline:none',
      'min-width:160px',
    ].join(';');

    const sendBtn = document.createElement('span');
    sendBtn.textContent = '\u25B6';
    sendBtn.title = 'Send (Enter)';
    sendBtn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:20px',
      'height:20px',
      'font-size:10px',
      'border-radius:4px',
      'cursor:pointer',
      'color:rgba(160,160,160,0.7)',
      'background:transparent',
      'transition:background 100ms,color 100ms',
      'line-height:1',
      'flex-shrink:0',
    ].join(';');
    sendBtn.addEventListener('mouseenter', () => {
      sendBtn.style.background = 'rgba(255,255,255,0.1)';
      sendBtn.style.color = '#e8e6e1';
    });
    sendBtn.addEventListener('mouseleave', () => {
      sendBtn.style.background = 'transparent';
      sendBtn.style.color = 'rgba(160,160,160,0.7)';
    });

    const submit = () => {
      const text = input.value.trim() || 'Describe and analyze this image in detail.';
      const alt = el.tagName === 'IMG' ? ((el as HTMLImageElement).alt || '').trim() : '';
      this.activeImageEl = el;
      storedImageUrl = imageUrl;
      storedImageAlt = alt;
      this.hideImagePrompt();
      this.showImageResponse(el);
      // Go idle so the user can browse while AI responds
      this.disarm();
      this.transition('idle');
      this.onImageSubmit?.(imageUrl, alt, text);
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); this.hideImagePrompt(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    sendBtn.addEventListener('click', (e) => { e.stopPropagation(); submit(); });

    imagePromptOverlay.appendChild(input);
    imagePromptOverlay.appendChild(sendBtn);
    document.documentElement.appendChild(imagePromptOverlay);

    requestAnimationFrame(() => input.focus());
  }

  private positionPromptOverlay(): void {
    if (!imagePromptOverlay || !promptTargetEl) return;
    const r = promptTargetEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top  = r.top;
    let left = r.right + 8;
    if (left + 300 > vw) left = Math.max(8, r.left - 308);
    if (left < 8) { left = Math.max(8, Math.min(r.left, vw - 308)); top = r.bottom + 8; }
    if (top < 8) top = 8;
    if (top + 32 > vh) top = vh - 40;

    imagePromptOverlay.style.top  = `${top}px`;
    imagePromptOverlay.style.left = `${left}px`;
  }

  private hideImagePrompt(): void {
    if (imagePromptOverlay) {
      imagePromptOverlay.remove();
      imagePromptOverlay = null;
    }
    promptTargetEl = null;
  }

  // ── Image response — injected into the post DOM ────────────────────────────

  activeImageEl: HTMLElement | null = null;
  onImageSubmit?: (url: string, alt: string, userPrompt: string) => void;

  /**
   * Find the best insertion point near an image inside a social media post
   * or generic article, and inject a response inline — using InlineHost so
   * it inherits the surrounding page typography exactly.
   */
  private showImageResponse(el: HTMLElement): void {
    this.hideImageResponse();

    const insertionPoint = findPostInsertionPoint(el);

    // Mirror styles from the reference text element (or fall back up the tree)
    const styleRef: Element =
      insertionPoint.before ?? insertionPoint.parent ?? el.parentElement ?? el;
    const styles = mirrorStylesFrom(styleRef);

    const host = new InlineHost(styles, { blockDisplay: true });
    imageHost = host;

    // Clicking done output → re-show prompt for the same image (follow-up question)
    host.onReEdit(() => {
      const imgEl = this.activeImageEl;
      const url = storedImageUrl;
      this.hideImageResponse();
      if (url && imgEl && document.contains(imgEl)) {
        this.showImagePrompt(imgEl, url);
      }
    });

    // Insert the span into the DOM at the found position
    if (insertionPoint.parent) {
      if (insertionPoint.before) {
        insertionPoint.parent.insertBefore(host.element, insertionPoint.before.nextSibling);
      } else {
        insertionPoint.parent.appendChild(host.element);
      }
    } else {
      el.parentElement?.insertBefore(host.element, el.nextSibling);
    }

    // Enter streaming — no "Thinking…" indicator, just show output when done
    host.enterStreamingMode(false);
    host.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  appendImageResponseToken(token: string): void {
    if (!imageHost) return;
    const filtered = this.filterImageThinking(token);
    if (filtered) imageHost.appendToken(filtered);
  }

  /** Same logic as filterThinking but uses module-level imageInThinkBlock. */
  private filterImageThinking(token: string): string {
    let out = '';
    let remaining = token;
    while (remaining.length > 0) {
      if (!imageInThinkBlock) {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx !== -1) {
          out += remaining.slice(0, openIdx);
          imageInThinkBlock = true;
          remaining = remaining.slice(openIdx + 7);
        } else {
          out += remaining;
          remaining = '';
        }
      } else {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx !== -1) {
          imageInThinkBlock = false;
          remaining = remaining.slice(closeIdx + 8);
        } else {
          remaining = '';
        }
      }
    }
    return out;
  }

  endImageResponse(): void {
    imageInThinkBlock = false;
    imageHost?.enterDoneMode();
    // imageHost stays in DOM in done mode; hideImageResponse() removes it if needed
    this.activeImageEl = null;
  }

  hideImageResponse(): void {
    if (imageHost) {
      imageHost.element.remove();
      imageHost.destroy();
      imageHost = null;
    }
    imageInThinkBlock = false;
    this.activeImageEl = null;
  }

  // ── Scroll tracking ──────────────────────────────────────────────────────

  private attachScrollTracker(): void {
    if (scrollHandler) return;
    scrollHandler = () => this.updateOverlayPositions();
    window.addEventListener('scroll', scrollHandler, true);
  }

  private detachScrollTracker(): void {
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler, true);
      scrollHandler = null;
    }
  }

  private updateOverlayPositions(): void {
    if (hoverOutline && hoverTarget) {
      const r = hoverTarget.getBoundingClientRect();
      hoverOutline.style.top    = `${r.top}px`;
      hoverOutline.style.left   = `${r.left}px`;
      hoverOutline.style.width  = `${r.width}px`;
      hoverOutline.style.height = `${r.height}px`;
    }
    if (imageHighlight && highlightTargetEl) {
      const r = highlightTargetEl.getBoundingClientRect();
      imageHighlight.style.top    = `${r.top}px`;
      imageHighlight.style.left   = `${r.left}px`;
      imageHighlight.style.width  = `${r.width}px`;
      imageHighlight.style.height = `${r.height}px`;
    }
    if (imagePromptOverlay && promptTargetEl) {
      this.positionPromptOverlay();
    }
  }

  // ── Insertion caret ───────────────────────────────────────────────────────

  private showInsertionCaret(x: number, y: number, h: number): void {
    if (!insertionCaret) {
      insertionCaret = document.createElement('div');
      insertionCaret.setAttribute('data-lanthra-caret', '');
      insertionCaret.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483647',
        'width:2px',
        'background:#e8a44a',
        'border-radius:1px',
        'transform:translateX(-1px)',
        'transition:left 40ms ease,top 40ms ease,height 40ms ease',
        'animation:lanthra-blink 1s step-end infinite',
      ].join(';');
      document.documentElement.appendChild(insertionCaret);
    }
    insertionCaret.style.left   = `${x}px`;
    insertionCaret.style.top    = `${y}px`;
    insertionCaret.style.height = `${h}px`;
    insertionCaret.style.display = 'block';
  }

  private hideInsertionCaret(): void {
    if (insertionCaret) insertionCaret.style.display = 'none';
  }

  private injectCaretStyles(): void {
    if (document.getElementById('lanthra-caret-style')) return;
    const style = document.createElement('style');
    style.id = 'lanthra-caret-style';
    style.textContent = '@keyframes lanthra-blink { 50% { opacity: 0.3; } }';
    document.head.appendChild(style);
  }

  // ── Arm overlay ───────────────────────────────────────────────────────────

  private showArmOverlay(): void {
    if (armOverlay) return;
    armOverlay = document.createElement('div');
    armOverlay.setAttribute('data-lanthra-overlay', '');
    armOverlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483645',
      'cursor:default',
      'pointer-events:none',
    ].join(';');
    document.documentElement.appendChild(armOverlay);
    // No global cursor change — let the insertion caret serve as the affordance
  }

  private hideArmOverlay(): void {
    armOverlay?.remove();
    armOverlay = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private transition(to: SessionState): void {
    log('debug', `session ${this.id}: ${this.state} → ${to}`);
    this.state = to;
    chrome.runtime.sendMessage({ type: 'LANTHRA_STATE_UPDATE', state: to }).catch(() => {
      // No listener connected (panel closed) — safe to ignore
    });
  }
}

function isLanthraElement(el: Element): boolean {
  return (
    el.hasAttribute('data-lanthra-overlay') ||
    el.hasAttribute('data-lanthra-hover') ||
    el.hasAttribute('data-lanthra-caret') ||
    el.hasAttribute('data-lanthra-anchor') ||
    el.hasAttribute('data-lanthra-host') ||
    el.hasAttribute('data-lanthra-img-highlight') ||
    el.hasAttribute('data-lanthra-img-prompt') ||
    el.hasAttribute('data-lanthra-img-response')
  );
}

// ── Image URL helpers ─────────────────────────────────────────────────────────

function resolveImageUrl(img: HTMLImageElement): string {
  // Prefer currentSrc (handles srcset / picture sources)
  if (img.currentSrc && !img.currentSrc.startsWith('data:')) return img.currentSrc;
  if (img.src && !img.src.startsWith('data:')) return img.src;

  // Lazy-loaded images
  for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'data-lazy']) {
    const v = img.getAttribute(attr);
    if (v) {
      const url = (v.split(/[,\s]/)[0] ?? '').trim();
      if (url && !url.startsWith('data:')) return url;
    }
  }

  // srcset first entry
  if (img.srcset) {
    const first = (img.srcset.split(',')[0] ?? '').trim().split(/\s+/)[0] ?? '';
    if (first && !first.startsWith('data:')) return first;
  }

  // picture > source
  const picture = img.closest('picture');
  if (picture) {
    const source = picture.querySelector('source[srcset]');
    if (source) {
      const first = (source.getAttribute('srcset')!.split(',')[0] ?? '').trim().split(/\s+/)[0] ?? '';
      if (first && !first.startsWith('data:')) return first;
    }
  }

  return img.src || '';
}

function resolveBackgroundImage(el: Element): string | null {
  const r = el.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return null;

  const bg = getComputedStyle(el).backgroundImage;
  if (!bg || bg === 'none') return null;

  const m = bg.match(/url\(["']?(.+?)["']?\)/i);
  if (!m) return null;

  const url = m[1] ?? '';
  if (!url || url.startsWith('data:')) return null;
  return url;
}

// ── Post insertion point detection ────────────────────────────────────────────

interface InsertionPoint {
  parent: HTMLElement | null;
  before: HTMLElement | null;  // insert after this element (null = append)
}

// ── Image response markdown renderer ────────────────────────────────────────

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

function renderImageMarkdown(text: string): string {
  // Strip em dashes
  let html = text.replace(/\u2014/g, '-');

  // Strip <think>...</think> blocks
  html = html.replace(/<think>[\s\S]*?<\/think>/g, '');

  // LaTeX inline math: $...$ → replace known symbols with Unicode
  html = html.replace(/\$([^$]+)\$/g, (_m, expr: string) => {
    let result = expr;
    for (const [cmd, ch] of Object.entries(LATEX_SYMBOLS)) {
      result = result.split(cmd).join(ch);
    }
    // Strip leftover LaTeX commands like \text{...} → content
    result = result.replace(/\\text\{([^}]*)\}/g, '$1');
    // Strip remaining backslash commands
    result = result.replace(/\\[a-zA-Z]+/g, '');
    // Strip braces
    result = result.replace(/[{}]/g, '');
    return result.trim();
  });

  // Escape HTML (XSS prevention)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre style="background:rgba(0,0,0,0.06);padding:6px 8px;border-radius:4px;overflow-x:auto;font-size:12px;"><code>${code}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g,
    '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (single *)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Headings (# to ######) → bold text
  html = html.replace(/^(#{1,6})\s+(.+)$/gm,
    (_m, _hashes, t) => `<strong>${t}</strong>`);

  // Unordered lists (- item or * item at line start)
  html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');

  // Ordered lists (1. item)
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g,
    '<ul style="margin:4px 0;padding-left:18px;">$1</ul>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  // Clean up <br> inside <pre>
  html = html.replace(/<pre([^>]*)><code>([\s\S]*?)<\/code><\/pre>/g, (_m, attr, code) =>
    `<pre${attr}><code>${(code as string).replace(/<br>/g, '\n')}</code></pre>`);

  return html;
}

/**
 * Walk up from an image to find the best place to inject AI response text
 * inside the post's DOM — specifically after the post's text content.
 * Handles X/Twitter, Facebook, Instagram, Reddit, YouTube, LinkedIn,
 * and falls back to the nearest block ancestor's last text-bearing child.
 */
function findPostInsertionPoint(imageEl: HTMLElement): InsertionPoint {
  const host = location.hostname;

  // X / Twitter — tweet is article[data-testid="tweet"]
  if (host.includes('x.com') || host.includes('twitter.com')) {
    const tweet = imageEl.closest('article[data-testid="tweet"], div[data-testid="tweetText"]')?.closest('article') as HTMLElement | null;
    if (tweet) {
      // Look for the tweet text container
      const tweetText = tweet.querySelector('div[data-testid="tweetText"]') as HTMLElement | null;
      if (tweetText) return { parent: tweetText.parentElement, before: tweetText };
      return { parent: tweet, before: null };
    }
  }

  // Facebook — posts live in div[role="article"]
  if (host.includes('facebook.com')) {
    const post = imageEl.closest('div[role="article"], div[data-ad-preview]') as HTMLElement | null;
    if (post) {
      const textBlock = findLastTextBlock(post, imageEl);
      if (textBlock) return { parent: textBlock.parentElement, before: textBlock };
      return { parent: post, before: null };
    }
  }

  // Instagram — article
  if (host.includes('instagram.com')) {
    const post = imageEl.closest('article') as HTMLElement | null;
    if (post) {
      const sections = post.querySelectorAll('section');
      if (sections.length > 0) {
        const lastSection = sections[sections.length - 1] as HTMLElement;
        return { parent: lastSection.parentElement, before: lastSection };
      }
      return { parent: post, before: null };
    }
  }

  // Reddit
  if (host.includes('reddit.com')) {
    const post = imageEl.closest('shreddit-post, div[data-testid="post-container"], article') as HTMLElement | null;
    if (post) {
      const textBlock = findLastTextBlock(post, imageEl);
      if (textBlock) return { parent: textBlock.parentElement, before: textBlock };
      return { parent: post, before: null };
    }
  }

  // YouTube
  if (host.includes('youtube.com')) {
    const renderer = imageEl.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer') as HTMLElement | null;
    if (renderer) return { parent: renderer, before: null };
  }

  // LinkedIn
  if (host.includes('linkedin.com')) {
    const post = imageEl.closest('div.feed-shared-update-v2, article') as HTMLElement | null;
    if (post) {
      const textBlock = findLastTextBlock(post, imageEl);
      if (textBlock) return { parent: textBlock.parentElement, before: textBlock };
      return { parent: post, before: null };
    }
  }

  // Generic fallback: walk up to find a reasonable block container,
  // then look for the last text-bearing element to insert after.
  let node: HTMLElement | null = imageEl.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const tag = node.tagName;
    if (/^(ARTICLE|SECTION|LI|BLOCKQUOTE|FIGURE|MAIN)$/i.test(tag)) {
      const textBlock = findLastTextBlock(node, imageEl);
      if (textBlock) return { parent: textBlock.parentElement, before: textBlock };
      return { parent: node, before: null };
    }
    if (tag === 'DIV' && node.offsetHeight > 100 && node.children.length > 1) {
      const textBlock = findLastTextBlock(node, imageEl);
      if (textBlock) return { parent: textBlock.parentElement, before: textBlock };
      return { parent: node, before: null };
    }
    node = node.parentElement;
  }

  return { parent: imageEl.parentElement, before: imageEl };
}

/**
 * Find the last direct-child element inside a container that has meaningful
 * visible text (not inside the image itself). Returns the element to insert after.
 */
function findLastTextBlock(container: HTMLElement, imageEl: HTMLElement): HTMLElement | null {
  const children = Array.from(container.children) as HTMLElement[];
  let lastText: HTMLElement | null = null;
  for (const child of children) {
    if (child.contains(imageEl)) continue;
    if (child.hasAttribute('data-lanthra-img-response')) continue;
    const text = (child.textContent ?? '').trim();
    if (text.length > 5) lastText = child;
  }
  return lastText;
}

/**
 * Extract visible text from the post container surrounding an image.
 * Used when the user wants the AI to consider the full post context.
 */
export function extractPostText(imageEl: HTMLElement): string {
  const host = location.hostname;
  let container: HTMLElement | null = null;

  if (host.includes('x.com') || host.includes('twitter.com')) {
    container = imageEl.closest('article[data-testid="tweet"]') as HTMLElement;
  } else if (host.includes('facebook.com')) {
    container = imageEl.closest('div[role="article"]') as HTMLElement;
  } else if (host.includes('instagram.com')) {
    container = imageEl.closest('article') as HTMLElement;
  } else if (host.includes('reddit.com')) {
    container = imageEl.closest('shreddit-post, div[data-testid="post-container"], article') as HTMLElement;
  } else if (host.includes('youtube.com')) {
    container = imageEl.closest('ytd-rich-item-renderer, ytd-video-renderer') as HTMLElement;
  } else if (host.includes('linkedin.com')) {
    container = imageEl.closest('div.feed-shared-update-v2, article') as HTMLElement;
  }

  if (!container) {
    let node: HTMLElement | null = imageEl.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const tag = node.tagName;
      if (/^(ARTICLE|SECTION|MAIN)$/i.test(tag) ||
          (tag === 'DIV' && node.offsetHeight > 100 && node.children.length > 1)) {
        container = node;
        break;
      }
      node = node.parentElement;
    }
  }

  if (!container) return '';
  return (container.innerText || container.textContent || '').trim().slice(0, 2000);
}
