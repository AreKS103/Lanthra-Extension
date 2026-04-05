// edit-session.ts — Core lifecycle state machine for one editing transaction.
//
// States:
//   idle       — extension loaded, nothing active
//   armed      — user toggled on, cursor changed, waiting for click
//   inserted   — anchor span in DOM, host not yet focused
//   editing    — host focused, user typing prompt
//   streaming  — Cmd/Ctrl+Enter pressed, tokens arriving
//   committed  — streaming done, output is in the DOM, session over
//   canceled   — Escape / error / timeout; DOM fully restored
//   orphaned   — page removed the anchor mid-session; cleaned up
//
// Only one session can be active at a time. Call `EditSession.current` to get
// the singleton; use `arm()` / `cancel()` / `onToggle()` as entry points.

import { log }                                         from '../shared/logger';
import { hitTest }                                     from './hit-test';
import { insertAnchorAtPoint, removeAnchor, commitAnchor } from './range-utils';
import type { AnchorResult }                           from './range-utils';
import { mirrorStylesFrom, nearestBlockAncestor }     from './style-mirror';
import { InlineHost }                                  from './inline-host';
import { MutationGuard }                               from './mutation-guard';
import { saveSelection, restoreSelection, clearSelection } from './selection-store';
import type { SavedSelection }                         from './selection-store';
import type { SWMessage }                              from '../types/messages';
import { PORT_SESSION_PREFIX }                         from '../types/messages';

type SessionState =
  | 'idle'
  | 'armed'
  | 'inserted'
  | 'editing'
  | 'streaming'
  | 'committed'
  | 'canceled'
  | 'orphaned';

// Overlay element shown while armed to change the cursor site-wide
let armOverlay: HTMLDivElement | null = null;
// Hover affordance element
let hoverOutline: HTMLDivElement | null = null;
// Last element the cursor hovered over while armed
let hoverTarget: Element | null = null;

export class EditSession {
  // ── Singleton ─────────────────────────────────────────────────────────────
  static current: EditSession = new EditSession();

  // ── Instance ─────────────────────────────────────────────────────────────────
  readonly id: string = crypto.randomUUID();

  private state:          SessionState    = 'idle';
  private anchorResult:   AnchorResult | null = null;
  private host:           InlineHost | null   = null;
  private guard:          MutationGuard | null = null;
  private savedSelection: SavedSelection | null = null;
  private swPort:         chrome.runtime.Port | null = null;

  // ── Public toggle entry point ─────────────────────────────────────────────

  onToggle(): void {
    if (this.state === 'idle') {
      this.arm();
    } else {
      this.cancel();
    }
  }

  // ── State transitions ────────────────────────────────────────────────────

  private arm(): void {
    this.transition('armed');
    this.showArmOverlay();
    document.addEventListener('click',    this.onPageClick,    { capture: true });
    document.addEventListener('mouseover', this.onMouseOver,   { capture: true });
    document.addEventListener('mouseout',  this.onMouseOut,    { capture: true });
    log('info', `session ${this.id} armed`);
  }

  cancel(): void {
    if (this.state === 'idle' || this.state === 'committed') return;
    this.cleanupDOM();
    this.cleanupListeners();
    this.closePort();
    this.transition('canceled');
    // Restore whatever the user had selected before we grabbed focus
    if (this.savedSelection) restoreSelection(this.savedSelection);
    log('info', `session ${this.id} canceled`);
    // Reset for next use
    this.resetForNextTransaction();
  }

  private disarm(): void {
    this.hideArmOverlay();
    this.hideHoverOutline();
    document.removeEventListener('click',     this.onPageClick, { capture: true });
    document.removeEventListener('mouseover', this.onMouseOver, { capture: true });
    document.removeEventListener('mouseout',  this.onMouseOut,  { capture: true });
  }

  // ── Incoming SW messages (called by content/index.ts) ────────────────────

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
        // Handled by the toggle flow above
        break;
    }
  }

  // ── DOM event handlers ────────────────────────────────────────────────────

  private onPageClick = (e: MouseEvent): void => {
    if (this.state !== 'armed') return;

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;

    // Absorb the click so the page doesn't navigate or toggle things
    e.preventDefault();
    e.stopPropagation();

    this.savedSelection = saveSelection();
    clearSelection();
    this.hideArmOverlay();
    this.hideHoverOutline();
    document.removeEventListener('click',     this.onPageClick, { capture: true });
    document.removeEventListener('mouseover', this.onMouseOver, { capture: true });
    document.removeEventListener('mouseout',  this.onMouseOut,  { capture: true });

    this.insertHost(e.clientX, e.clientY, hit.element);
  };

  private onMouseOver = (e: MouseEvent): void => {
    if (this.state !== 'armed') return;
    const target = e.target as Element | null;
    if (!target || isLanthraElement(target)) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit && hit.element !== hoverTarget) {
      hoverTarget = hit.element;
      this.showHoverOutline(hit.element);
    }
  };

  private onMouseOut = (e: MouseEvent): void => {
    if (this.state !== 'armed') return;
    const related = e.relatedTarget as Element | null;
    // Only hide if we're not entering a child of the same target
    if (!related || !hoverTarget?.contains(related)) {
      this.hideHoverOutline();
      hoverTarget = null;
    }
  };

  // ── Insertion ─────────────────────────────────────────────────────────────

  private insertHost(x: number, y: number, el: Element): void {
    const anchor = insertAnchorAtPoint(x, y);
    if (!anchor) {
      log('warn', 'insertAnchorAtPoint returned null — canceling');
      this.cancel();
      return;
    }

    this.anchorResult = anchor;
    this.transition('inserted');

    const styles = mirrorStylesFrom(el);
    const host   = new InlineHost(styles);
    this.host    = host;

    host.onSubmit((prompt) => this.submitPrompt(prompt));
    host.onCancel(() => this.cancel());

    anchor.anchor.appendChild(host.element);

    // Watch the block container for page-driven mutations
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

    // Capture context text from the surrounding paragraph (up to 500 chars)
    const context = this.buildContext();

    // Open a persistent port to the service worker for this streaming session
    const port = chrome.runtime.connect({ name: `${PORT_SESSION_PREFIX}${this.id}` });
    this.swPort = port;

    port.onMessage.addListener((msg: SWMessage) => this.handleSWMessage(msg));
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
    if (!this.anchorResult) return '';
    const blockEl = this.anchorResult.anchor.closest(
      'p, article, section, li, td, div, blockquote'
    );
    const raw = (blockEl ?? this.anchorResult.anchor.parentElement)?.textContent ?? '';
    return raw.trim().slice(0, 500);
  }

  // ── Token streaming ───────────────────────────────────────────────────────

  private onToken(token: string): void {
    if (this.state !== 'streaming') return;
    this.host?.appendToken(token);
  }

  private onStreamEnd(): void {
    if (this.state !== 'streaming') return;
    this.transition('committed');
    this.commit();
  }

  private onError(error: string): void {
    log('error', `session ${this.id} error: ${error}`);
    this.cancel();
  }

  // ── Commit / cleanup ─────────────────────────────────────────────────────

  private commit(): void {
    if (!this.anchorResult || !this.host) return;

    const finalText = this.host.commit();
    commitAnchor(this.anchorResult.anchor, finalText);

    this.guard?.stop();
    this.closePort();
    this.cleanupListeners();
    this.host.destroy();

    log('info', `session ${this.id} committed`, { chars: finalText.length });
    this.resetForNextTransaction();
  }

  private orphan(): void {
    log('warn', `session ${this.id} orphaned — anchor removed by page`);
    this.cleanupListeners();
    this.closePort();
    this.host?.destroy();
    this.transition('orphaned');
    this.resetForNextTransaction();
  }

  private cleanupDOM(): void {
    this.guard?.stop();
    this.host?.destroy();
    if (this.anchorResult) {
      removeAnchor(this.anchorResult);
      this.anchorResult = null;
    }
    this.host = null;
  }

  private cleanupListeners(): void {
    this.disarm();
  }

  private closePort(): void {
    try { this.swPort?.disconnect(); } catch { /* already closed */ }
    this.swPort = null;
  }

  private resetForNextTransaction(): void {
    // Keep the singleton but reset mutable state for the next transaction
    (this as { id: string }).id = crypto.randomUUID();
    this.anchorResult   = null;
    this.host           = null;
    this.guard          = null;
    this.savedSelection = null;
    this.swPort         = null;
    this.transition('idle');
  }

  // ── Hover affordance ─────────────────────────────────────────────────────

  private showHoverOutline(el: Element): void {
    this.hideHoverOutline();
    const r = el.getBoundingClientRect();
    if (!hoverOutline) {
      hoverOutline = document.createElement('div');
      hoverOutline.setAttribute('data-lanthra-hover', '');
      hoverOutline.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483646',
        'border:1.5px dashed rgba(99,102,241,0.6)',
        'border-radius:3px',
        'background:rgba(99,102,241,0.04)',
        'transition:all 80ms ease',
      ].join(';');
      document.documentElement.appendChild(hoverOutline);
    }
    hoverOutline.style.top    = `${r.top    + window.scrollY}px`;
    hoverOutline.style.left   = `${r.left   + window.scrollX}px`;
    hoverOutline.style.width  = `${r.width}px`;
    hoverOutline.style.height = `${r.height}px`;
    hoverOutline.style.display = 'block';
  }

  private hideHoverOutline(): void {
    if (hoverOutline) hoverOutline.style.display = 'none';
  }

  // ── Arm overlay ──────────────────────────────────────────────────────────

  private showArmOverlay(): void {
    if (armOverlay) return;
    armOverlay = document.createElement('div');
    armOverlay.setAttribute('data-lanthra-overlay', '');
    armOverlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483645',
      'cursor:crosshair',
      'pointer-events:none',  // click events still bubble; overlay is visual only
    ].join(';');
    document.documentElement.appendChild(armOverlay);
    document.documentElement.style.cursor = 'crosshair';
  }

  private hideArmOverlay(): void {
    armOverlay?.remove();
    armOverlay = null;
    document.documentElement.style.cursor = '';
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private transition(to: SessionState): void {
    log('debug', `session ${this.id}: ${this.state} → ${to}`);
    this.state = to;
  }
}

function isLanthraElement(el: Element): boolean {
  return (
    el.hasAttribute('data-lanthra-overlay') ||
    el.hasAttribute('data-lanthra-hover') ||
    el.hasAttribute('data-lanthra-anchor') ||
    el.hasAttribute('data-lanthra-host')
  );
}
