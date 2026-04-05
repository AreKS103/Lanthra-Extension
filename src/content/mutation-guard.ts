// mutation-guard.ts — Watch an anchor's container for host-page re-renders.
//
// When a SPA or dynamic page removes the anchor span from the DOM (because it
// re-rendered the section), we detect this and call the `onOrphaned` callback
// so the edit session can transition to the 'orphaned' state and clean up.

export class MutationGuard {
  private observer: MutationObserver;
  private anchor:   HTMLSpanElement;
  private root:     Node;

  constructor(
    anchor:     HTMLSpanElement,
    root:       Node,
    onOrphaned: () => void,
  ) {
    this.anchor = anchor;
    this.root   = root;

    this.observer = new MutationObserver((mutations) => {
      // Fast check: is the anchor still in the document?
      if (!document.contains(this.anchor)) {
        this.stop();
        onOrphaned();
        return;
      }

      // Also watch for attribute removal that would break our assumptions
      for (const m of mutations) {
        if (
          m.type === 'attributes' &&
          m.target === this.anchor &&
          m.attributeName === 'data-lanthra-anchor'
        ) {
          this.stop();
          onOrphaned();
          return;
        }
      }
    });
  }

  start(): void {
    this.observer.observe(this.root, {
      childList:  true,
      subtree:    true,
      attributes: true,
      attributeFilter: ['data-lanthra-anchor'],
    });
  }

  stop(): void {
    this.observer.disconnect();
  }
}
