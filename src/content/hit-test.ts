// hit-test.ts — Resolve a click (x, y) to the best insertion target.
//
// Priority order:
//   1. Exact text node hit via document.caretRangeFromPoint
//   2. Nearest visible text-containing element under the pointer
//   3. null — caller should ignore the click
//
// We skip elements inside our own injected UI to prevent re-entry.

export interface HitTestResult {
  /** The element at the click point that carries readable text. */
  element:   Element;
  /** Whether the hit was directly on a text node (vs. an element edge). */
  isTextHit: boolean;
}

/** Elements we never want to insert into (replaced/void elements). */
const BLOCKED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'INPUT', 'TEXTAREA', 'SELECT',
  'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'MATH',
  'IFRAME', 'FRAME', 'EMBED', 'OBJECT',
]);

/**
 * Returns the best insertion target for a click at (x, y), or null if the
 * click should be ignored (e.g. on our own UI, a form element, or void area).
 */
export function hitTest(x: number, y: number): HitTestResult | null {
  const range = document.caretRangeFromPoint(x, y);
  if (!range) return null;

  const container = range.startContainer;

  // Unwrap text node to its parent element
  const el = container.nodeType === Node.TEXT_NODE
    ? container.parentElement
    : (container as Element);

  if (!el) return null;

  // Block our own injected elements
  if (isLanthraElement(el)) return null;

  // Block non-content tags
  if (BLOCKED_TAGS.has(el.tagName)) return null;

  // Block contenteditable regions the page itself owns
  if (isPageEditable(el)) return null;

  // Block invisible elements
  if (!isVisible(el)) return null;

  return {
    element:   el,
    isTextHit: container.nodeType === Node.TEXT_NODE,
  };
}

function isLanthraElement(el: Element): boolean {
  return (
    el.hasAttribute('data-lanthra-anchor') ||
    el.hasAttribute('data-lanthra-host') ||
    el.hasAttribute('data-lanthra-committed') ||
    el.closest('[data-lanthra-anchor]') !== null
  );
}

/** True if the element or any ancestor is a page-owned editable zone (not just ce=false). */
function isPageEditable(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const ce = current.getAttribute('contenteditable');
    // 'false' = explicitly non-editable → fine to target
    // 'true', '', 'plaintext-only' = editable → skip
    if (ce !== null && ce !== 'false' && ce !== 'inherit') return true;
    current = current.parentElement;
  }
  return false;
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
}
