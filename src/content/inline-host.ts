// inline-host.ts — The contenteditable span that lives inside the anchor.
//
// Lifecycle phases:
//   'prompt'    — user types their instruction
//   'streaming' — receives AI tokens; contenteditable is disabled
//   'done'      — AI output shown; hoverable/clickable to re-edit

import type { MirroredStyles } from './style-mirror';

export type HostPhase = 'prompt' | 'streaming' | 'done';

export class InlineHost {
  readonly element: HTMLSpanElement;

  private phase:       HostPhase = 'prompt';
  private isComposing: boolean   = false;
  private outputNode:  Text      = document.createTextNode('');
  private promptText:  string    = '';

  private onSubmitCb: ((prompt: string) => void) | null = null;
  private onCancelCb: (() => void) | null               = null;
  private onReEditCb: (() => void) | null               = null;
  private tokenBuffer: string = '';
  private blockDisplay: boolean;

  // Action buttons
  private actionsContainer: HTMLSpanElement;
  private sendBtn: HTMLSpanElement;
  private stopBtn: HTMLSpanElement;

  constructor(styles: MirroredStyles, opts: { blockDisplay?: boolean } = {}) {
    this.blockDisplay = opts.blockDisplay ?? false;
    this.element = document.createElement('span');
    this.element.setAttribute('data-lanthra-host', '');
    this.element.setAttribute('contenteditable', 'true');
    this.element.setAttribute('spellcheck',      'false');
    this.element.setAttribute('autocorrect',     'off');
    this.element.setAttribute('autocomplete',    'off');
    this.element.setAttribute('autocapitalize',  'off');
    this.element.setAttribute('translate',       'no');
    this.element.style.cssText = this.buildStyles(styles);

    // Hover effect — subtle grey tint on hover (prompt phase)
    this.element.addEventListener('mouseenter', () => {
      if (this.phase === 'prompt') {
        this.element.style.background = 'rgba(128,128,128,0.08)';
        this.element.style.borderRadius = '3px';
      }
    });
    this.element.addEventListener('mouseleave', () => {
      if (this.phase === 'prompt') {
        this.element.style.background = 'transparent';
      }
    });

    // Create action buttons (send/stop)
    this.actionsContainer = document.createElement('span');
    this.actionsContainer.setAttribute('contenteditable', 'false');
    this.actionsContainer.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:3px',
      'margin-left:2px',
      'vertical-align:baseline',
      'user-select:none',
    ].join(';');

    this.sendBtn = this.createActionBtn('▶', 'Send (Enter)', () => {
      if (this.phase === 'prompt' && this.promptText.trim().length > 0) {
        this.onSubmitCb?.(this.promptText.trim());
      }
    });

    this.stopBtn = this.createActionBtn('■', 'Stop generation', () => {
      if (this.phase === 'streaming') {
        this.onCancelCb?.();
      }
    });
    this.stopBtn.style.display = 'none';

    this.actionsContainer.appendChild(this.sendBtn);
    this.actionsContainer.appendChild(this.stopBtn);

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

  onReEdit(cb: () => void): this {
    this.onReEditCb = cb;
    return this;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get isDone(): boolean { return this.phase === 'done'; }

  focus(): void {
    if (this.element.parentNode && !this.actionsContainer.parentNode) {
      this.element.parentNode.insertBefore(
        this.actionsContainer,
        this.element.nextSibling
      );
    }
    requestAnimationFrame(() => {
      this.element.focus();
      this.placeCaretAtEnd();
    });
  }

  getPromptText(): string {
    return this.promptText;
  }

  /** Clears the prompt and switches the host to output-only streaming mode. */
  enterStreamingMode(showThinking = true): void {
    this.phase = 'streaming';
    this.tokenBuffer = '';
    this.element.setAttribute('contenteditable', 'false');

    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);

    // Show thinking indicator until first token arrives
    this.outputNode = document.createTextNode('');
    if (showThinking) {
      const thinkingSpan = document.createElement('span');
      thinkingSpan.setAttribute('data-lanthra-thinking', '');
      thinkingSpan.textContent = 'Thinking...';
      thinkingSpan.style.cssText = 'color:rgba(128,128,128,0.6);font-style:italic;';
      this.element.appendChild(thinkingSpan);
    }
    this.element.appendChild(this.outputNode);

    this.element.style.background   = 'rgba(128,128,128,0.06)';
    this.element.style.cursor       = 'default';
    if (this.blockDisplay) {
      this.element.style.padding      = '8px 12px';
      this.element.style.borderRadius = '6px';
      this.element.style.margin       = '6px 0';
      this.element.style.border       = '1px solid rgba(128,128,128,0.2)';
    } else {
      this.element.style.borderBottom = '1px solid rgba(128,128,128,0.2)';
    }

    this.sendBtn.style.display = 'none';
    this.stopBtn.style.display = 'inline-flex';
  }

  /** Buffers a streaming token — will be flushed all at once on done. */
  appendToken(token: string): void {
    if (this.phase !== 'streaming') return;
    // Remove thinking indicator on first real token
    if (this.tokenBuffer.length === 0) {
      const thinking = this.element.querySelector('[data-lanthra-thinking]');
      if (thinking) thinking.remove();
    }
    // Buffer tokens — flushed in enterDoneMode for instant display
    this.tokenBuffer += token.replace(/\u2014/g, '-');
  }

  /** Transitions to done mode — output stays visible, hoverable/clickable. */
  enterDoneMode(): void {
    this.phase = 'done';
    this.element.setAttribute('contenteditable', 'false');

    // Flush buffered tokens all at once
    if (this.tokenBuffer) {
      this.outputNode.appendData(this.tokenBuffer);
      this.tokenBuffer = '';
    }

    // Strip markdown formatting — inline text should match page styling
    const raw = this.element.textContent ?? '';
    let clean = raw
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`{3}[\s\S]*?`{3}/g, '')
      .replace(/`(.+?)`/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1');
    // Strip LaTeX inline math: $...$
    clean = clean.replace(/\$([^$]+)\$/g, (_m, expr: string) => {
      return expr
        .replace(/\\[a-zA-Z]+/g, (cmd) => {
          const map: Record<string, string> = {
            '\\rightarrow': '\u2192', '\\leftarrow': '\u2190', '\\times': '\u00D7',
            '\\div': '\u00F7', '\\pm': '\u00B1', '\\leq': '\u2264', '\\geq': '\u2265',
            '\\neq': '\u2260', '\\approx': '\u2248', '\\infty': '\u221E',
            '\\cdot': '\u00B7', '\\ldots': '\u2026', '\\dots': '\u2026',
          };
          return map[cmd] ?? '';
        })
        .replace(/[{}]/g, '')
        .trim();
    });
    if (clean !== raw) {
      while (this.element.firstChild) this.element.removeChild(this.element.firstChild);
      this.element.appendChild(document.createTextNode(clean));
    }

    // Clean styling — text blends with page, subtle on hover
    if (this.blockDisplay) {
      this.element.style.background   = 'rgba(128,128,128,0.04)';
      this.element.style.border       = '1px solid rgba(128,128,128,0.15)';
      this.element.style.padding      = '8px 12px';
      this.element.style.borderRadius = '6px';
      this.element.style.margin       = '6px 0';
    } else {
      this.element.style.background   = 'transparent';
      this.element.style.borderBottom = 'none';
      this.element.style.padding      = '0 2px';
    }
    this.element.style.cursor       = 'pointer';

    // Hide action buttons
    this.sendBtn.style.display = 'none';
    this.stopBtn.style.display = 'none';
    this.actionsContainer.style.display = 'none';

    // Hover affordance: subtle corner-style outline
    this.element.addEventListener('mouseenter', this.onDoneHover);
    this.element.addEventListener('mouseleave', this.onDoneLeave);

    // Direct click → re-edit (works even when session is idle)
    this.element.addEventListener('click', this.onDoneClick);
  }

  /** Returns true if the output is empty (only whitespace / thinking). */
  get isEmpty(): boolean {
    return this.tokenBuffer.trim().length === 0;
  }

  /** Clears output, re-enables editing for a new prompt. */
  reEdit(): void {
    // Remove done listeners
    this.element.removeEventListener('mouseenter', this.onDoneHover);
    this.element.removeEventListener('mouseleave', this.onDoneLeave);
    this.element.removeEventListener('click', this.onDoneClick);

    this.phase = 'prompt';
    this.element.setAttribute('contenteditable', 'true');
    this.element.style.cursor       = 'text';
    this.element.style.outline      = 'none';
    this.element.style.outlineOffset = '0';
    this.element.style.background   = 'transparent';

    // Clear AI output
    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);
    this.promptText = '';
    this.tokenBuffer = '';
    this.outputNode = document.createTextNode('');

    // Show send button again
    this.sendBtn.style.display = 'inline-flex';
    this.stopBtn.style.display = 'none';
    this.actionsContainer.style.display = 'inline-flex';

    // Re-add action buttons if needed
    if (this.element.parentNode && !this.actionsContainer.parentNode) {
      this.element.parentNode.insertBefore(this.actionsContainer, this.element.nextSibling);
    }

    this.focus();
  }

  destroy(): void {
    this.onSubmitCb = null;
    this.onCancelCb = null;
    this.onReEditCb = null;
    this.tokenBuffer = '';
    this.actionsContainer.remove();
    this.element.removeEventListener('mouseenter', this.onDoneHover);
    this.element.removeEventListener('mouseleave', this.onDoneLeave);
    this.element.removeEventListener('click', this.onDoneClick);
  }

  // ── Done-mode hover handlers ──────────────────────────────────────────────

  private onDoneHover = (): void => {
    if (this.blockDisplay) {
      this.element.style.border     = '1px solid rgba(160,160,160,0.35)';
      this.element.style.background = 'rgba(128,128,128,0.08)';
    } else {
      this.element.style.outline       = '1.5px solid rgba(160,160,160,0.25)';
      this.element.style.outlineOffset = '2px';
      this.element.style.borderRadius  = '4px';
    }
  };

  private onDoneLeave = (): void => {
    if (this.blockDisplay) {
      this.element.style.border     = '1px solid rgba(128,128,128,0.15)';
      this.element.style.background = 'rgba(128,128,128,0.04)';
    } else {
      this.element.style.outline       = 'none';
      this.element.style.outlineOffset = '0';
    }
  };

  private onDoneClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.onReEditCb?.();
  };

  // ── Private ───────────────────────────────────────────────────────────────

  private createActionBtn(
    symbol: string,
    title: string,
    onClick: () => void
  ): HTMLSpanElement {
    const btn = document.createElement('span');
    btn.textContent = symbol;
    btn.title = title;
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:18px',
      'height:18px',
      'font-size:10px',
      'border-radius:3px',
      'cursor:pointer',
      'color:rgba(160,160,160,0.7)',
      'background:transparent',
      'transition:background 100ms,color 100ms',
      'line-height:1',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(128,128,128,0.15)';
      btn.style.color = 'rgba(200,200,200,0.9)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
      btn.style.color = 'rgba(160,160,160,0.7)';
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private buildStyles(styles: MirroredStyles): string {
    return [
      styles.cssText,
      this.blockDisplay ? 'display:block' : 'display:inline',
      'min-width:2px',
      'border:none',
      'padding:0 2px',
      'border-radius:3px',
      'background:transparent',
      'cursor:text',
      'vertical-align:baseline',
      'white-space:pre-wrap',
      'word-break:break-word',
      'outline:none',
      'caret-color:currentColor',
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

    this.element.addEventListener('input', () => {
      if (!this.isComposing) this.syncPromptText();
    });

    this.element.addEventListener('keydown', (e) => this.handleKeyDown(e));

    this.element.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || this.isComposing) return;

    // Detect platform modifier (Cmd on Mac, Ctrl everywhere else)
    const mod = e.metaKey || e.ctrlKey;

    // Enter = submit
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      e.stopPropagation();
      if (this.phase === 'prompt' && this.promptText.trim().length > 0) {
        this.onSubmitCb?.(this.promptText.trim());
      }
      return;
    }

    // Ctrl/Cmd+Enter also submits
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this.phase === 'prompt' && this.promptText.trim().length > 0) {
        this.onSubmitCb?.(this.promptText.trim());
      }
      return;
    }

    // ── Standard editing shortcuts — stop propagation so page handlers ──
    // ── don't swallow them, but let the browser's native behavior run. ──

    // Ctrl/Cmd + letter shortcuts: select-all, undo, redo, cut, copy, paste
    if (mod && !e.altKey && ['a', 'z', 'y', 'x', 'c', 'v'].includes(e.key.toLowerCase())) {
      e.stopPropagation();
      return;
    }

    // Ctrl/Cmd + Delete/Backspace — word deletion
    // Chrome's native contenteditable word-delete is unreliable at element
    // boundaries (first/last word often left behind), so handle it manually.
    if (mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      this.deleteWord(e.key === 'Backspace' ? 'backward' : 'forward');
      return;
    }

    // Arrow keys: plain, +Shift (selection), +Ctrl/Cmd (word jump), +Ctrl+Shift (word select)
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.stopPropagation();
      return;
    }

    // Home/End: plain + with Shift and/or Ctrl/Cmd
    if (e.key === 'Home' || e.key === 'End') {
      e.stopPropagation();
      return;
    }

    // Tab — insert two spaces instead of moving focus
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertText', false, '  ');
      return;
    }

    // Delete and Backspace (without modifier) — normal single char deletion
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.stopPropagation();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.onCancelCb?.();
    }
  }

  /** Manually delete one word forward or backward from the caret. */
  private deleteWord(direction: 'forward' | 'backward'): void {
    const text = this.element.textContent ?? '';
    const sel  = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range  = sel.getRangeAt(0);
    // Compute a flat character offset into the text node content.
    const offset = this.flatOffset(range.startContainer, range.startOffset);
    if (offset < 0) return;

    let start: number;
    let end: number;

    if (direction === 'backward') {
      // Walk backwards: skip whitespace, then skip word chars.
      let i = offset;
      while (i > 0 && /\s/.test(text[i - 1]!)) i--;
      while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
      start = i;
      end   = offset;
    } else {
      // Walk forwards: skip whitespace, then skip word chars.
      let i = offset;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      while (i < text.length && !/\s/.test(text[i]!)) i++;
      start = offset;
      end   = i;
    }

    if (start === end) return;

    const before = text.slice(0, start);
    const after  = text.slice(end);
    this.element.textContent = before + after;
    this.promptText = before + after;

    // Restore caret at the deletion point.
    const newOffset = start;
    const newRange  = document.createRange();
    const child     = this.element.firstChild;
    if (child && child.nodeType === Node.TEXT_NODE) {
      newRange.setStart(child, Math.min(newOffset, child.textContent!.length));
      newRange.collapse(true);
    } else {
      newRange.selectNodeContents(this.element);
      newRange.collapse(direction === 'backward');
    }
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  /** Compute flat character offset from a Range container + offset. */
  private flatOffset(container: Node, offset: number): number {
    if (container === this.element) {
      // offset is a child index
      let flat = 0;
      for (let i = 0; i < offset && i < this.element.childNodes.length; i++) {
        flat += this.element.childNodes[i]!.textContent?.length ?? 0;
      }
      return flat;
    }
    // container is a text node inside the element
    let flat = 0;
    for (const child of this.element.childNodes) {
      if (child === container || child.contains(container)) {
        return flat + offset;
      }
      flat += child.textContent?.length ?? 0;
    }
    return offset; // fallback
  }

  private syncPromptText(): void {
    if (this.phase === 'prompt') {
      this.promptText = this.element.textContent ?? '';
    }
  }

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
