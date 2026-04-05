// inline-host.ts — The contenteditable span that lives inside the anchor.
//
// Lifecycle phases:
//   'prompt'    — user types their instruction
//   'streaming' — receives AI tokens; contenteditable is disabled
//   'committed' — final state; decorations stripped

import type { MirroredStyles } from './style-mirror';

export type HostPhase = 'prompt' | 'streaming' | 'committed';

export class InlineHost {
  readonly element: HTMLSpanElement;

  private phase:       HostPhase = 'prompt';
  private isComposing: boolean   = false;
  private outputNode:  Text      = document.createTextNode('');
  private promptText:  string    = '';

  private onSubmitCb: ((prompt: string) => void) | null = null;
  private onCancelCb: (() => void) | null               = null;

  constructor(styles: MirroredStyles) {
    this.element = document.createElement('span');
    this.element.setAttribute('data-lanthra-host', '');
    this.element.setAttribute('contenteditable', 'true');
    this.element.setAttribute('spellcheck',      'false');
    this.element.setAttribute('autocorrect',     'off');
    this.element.setAttribute('autocomplete',    'off');
    this.element.setAttribute('autocapitalize',  'off');
    this.element.setAttribute('translate',       'no');
    this.element.style.cssText = this.buildStyles(styles);

    this.attachListeners();
  }

  // ── Public callbacks ──────────────────────────────────────────────────────

  onSubmit(cb: (prompt: string) => void): this {
    this.onSubmitCb = cb;
    return this;
  }

  onCancel(cb: () => void): this {
    this.onCancelCb = cb;
    return this;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  focus(): void {
    // Defer one frame so the element is fully laid out before we focus
    requestAnimationFrame(() => {
      this.element.focus();
      this.placeCaretAtEnd();
    });
  }

  getPromptText(): string {
    return this.promptText;
  }

  /** Clears the prompt and switches the host to output-only streaming mode. */
  enterStreamingMode(): void {
    this.phase = 'streaming';
    this.element.setAttribute('contenteditable', 'false');

    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);

    this.outputNode = document.createTextNode('');
    this.element.appendChild(this.outputNode);

    this.element.style.background   = 'rgba(99,102,241,0.04)';
    this.element.style.borderBottom = '1px solid rgba(99,102,241,0.35)';
    this.element.style.cursor       = 'default';
  }

  /**
   * Appends one streaming token to the output node.
   * Uses Text.appendData() — a single DOM mutation that triggers a native
   * browser reflow so surrounding text flows around the growing content.
   */
  appendToken(token: string): void {
    if (this.phase !== 'streaming') return;
    this.outputNode.appendData(token);
  }

  /** Finalises output — removes edit decorations, returns final text. */
  commit(): string {
    this.phase = 'committed';
    const text = this.element.textContent ?? '';

    this.element.removeAttribute('contenteditable');
    this.element.removeAttribute('data-lanthra-host');
    this.element.setAttribute('data-lanthra-committed', '');

    this.element.style.border     = 'none';
    this.element.style.background = 'transparent';
    this.element.style.padding    = '0';
    this.element.style.cursor     = 'auto';

    return text;
  }

  destroy(): void {
    this.onSubmitCb = null;
    this.onCancelCb = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private buildStyles(styles: MirroredStyles): string {
    return [
      styles.cssText,
      'display:inline',
      'position:relative',
      'min-width:120px',
      'border-bottom:1.5px solid rgba(99,102,241,0.7)',
      'padding:1px 3px',
      'border-radius:2px 2px 0 0',
      'background:rgba(99,102,241,0.08)',
      'cursor:text',
      'white-space:pre-wrap',
      'word-break:break-word',
      'outline:none',
      'caret-color:rgb(99,102,241)',
      'box-decoration-break:clone',
      '-webkit-box-decoration-break:clone',
    ].join(';');
  }

  private attachListeners(): void {
    this.element.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });

    this.element.addEventListener('compositionend', () => {
      this.isComposing = false;
      this.syncPromptText();
    });

    // Use 'input' (fires after DOM is updated) rather than 'keyup' so that
    // IME, voice input, and auto-correct all update promptText correctly.
    this.element.addEventListener('input', () => {
      if (!this.isComposing) this.syncPromptText();
    });

    this.element.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Strip rich formatting on paste — keep plain text only
    this.element.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Suppress key handling during IME composition
    if (e.isComposing || this.isComposing) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this.phase === 'prompt' && this.promptText.trim().length > 0) {
        this.onSubmitCb?.(this.promptText.trim());
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.onCancelCb?.();
    }
  }

  private syncPromptText(): void {
    if (this.phase === 'prompt') {
      this.promptText = this.element.textContent ?? '';
    }
  }

  /** Move the text caret to the end of the host content. */
  private placeCaretAtEnd(): void {
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(this.element);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}
