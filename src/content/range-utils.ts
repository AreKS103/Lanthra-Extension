// range-utils.ts — Reflow-safe DOM insertion utilities.
//
// Insertion algorithm:
//   1. Obtain a Range from document.caretRangeFromPoint(x, y).
//   2. If the container is a Text node, split it at startOffset so we have
//      leftText … rightText with a gap between them.
//   3. Insert a <span data-lanthra-anchor> between leftText and rightText.
//   4. The inline host lives inside that anchor span.
//   5. Removal: pull the anchor out of the DOM and call parent.normalize()
//      which merges the two text node fragments back into one.
//
// We never use Range.surroundContents() because that throws if the range
// boundary crosses element boundaries. Instead we do manual text-node splitting
// and direct insertBefore() calls — both reversible with normalize().

export interface AnchorResult {
  anchor:    HTMLSpanElement;
  leftText:  Text;
  rightText: Text;
  parent:    Node;
}

/**
 * Resolves the caret position at (x, y), splits the text node at that offset,
 * and inserts a stable <span data-lanthra-anchor> at the split point.
 *
 * Returns null if:
 *  - caretRangeFromPoint returns nothing
 *  - the resolved container is not a text node and no text child is reachable
 *  - the target element is inside a cross-origin iframe or shadow root
 */
export function insertAnchorAtPoint(x: number, y: number): AnchorResult | null {
  // document.caretRangeFromPoint is available in all Chromium versions.
  const range = document.caretRangeFromPoint(x, y);
  if (!range) return null;

  const { startContainer, startOffset } = range;

  let textNode: Text;
  let offset:   number;

  if (startContainer.nodeType === Node.TEXT_NODE) {
    textNode = startContainer as Text;
    offset   = startOffset;
  } else {
    // Landed on an element boundary — look for the closest text child
    const el     = startContainer as Element;
    const child  = el.childNodes[startOffset] ?? el.childNodes[startOffset - 1];
    if (child?.nodeType === Node.TEXT_NODE) {
      textNode = child as Text;
      offset   = startOffset === 0 ? 0 : (child as Text).length;
    } else if (el.firstChild?.nodeType === Node.TEXT_NODE) {
      textNode = el.firstChild as Text;
      offset   = 0;
    } else {
      return null;
    }
  }

  const parent = textNode.parentNode;
  if (!parent) return null;

  // ── Split text node at offset ─────────────────────────────────────────────
  let leftText:  Text;
  let rightText: Text;

  if (offset <= 0) {
    // Insert before the entire text node — create an empty left sentinel
    leftText  = document.createTextNode('');
    parent.insertBefore(leftText, textNode);
    rightText = textNode;
  } else if (offset >= textNode.length) {
    // Insert after the entire text node — create an empty right sentinel
    leftText  = textNode;
    rightText = document.createTextNode('');
    parent.insertBefore(rightText, textNode.nextSibling);
  } else {
    // Normal case: textNode becomes left, splitText() returns right
    leftText  = textNode;
    rightText = textNode.splitText(offset); // modifies textNode in-place
  }

  // ── Create and insert anchor span ─────────────────────────────────────────
  const anchor = document.createElement('span');
  anchor.setAttribute('data-lanthra-anchor', '');
  // Keep anchor truly inline so it doesn't disturb the text flow
  anchor.style.cssText = 'display:inline;line-height:inherit;';

  parent.insertBefore(anchor, rightText);

  return { anchor, leftText, rightText, parent };
}

/**
 * Removes the anchor span from the DOM and merges the surrounding text nodes
 * back together via normalize(). Fully reverses insertAnchorAtPoint().
 */
export function removeAnchor(result: AnchorResult): void {
  const { anchor, parent } = result;
  if (anchor.parentNode === parent) {
    parent.removeChild(anchor);
  }
  // normalize() merges adjacent text nodes that were split during insertion
  if (parent.nodeType === Node.ELEMENT_NODE) {
    (parent as Element).normalize();
  }
}

/**
 * Converts the anchor from an editing host into a committed inline span that
 * carries the final AI output text. Strips all edit affordances.
 */
export function commitAnchor(anchor: HTMLSpanElement, finalText: string): void {
  // Remove host attributes
  anchor.removeAttribute('data-lanthra-anchor');
  anchor.removeAttribute('contenteditable');
  anchor.removeAttribute('data-lanthra-host');

  // Replace inner DOM with a single clean text node
  while (anchor.firstChild) anchor.removeChild(anchor.firstChild);
  anchor.appendChild(document.createTextNode(finalText));

  anchor.setAttribute('data-lanthra-committed', '');
  anchor.style.cssText = 'display:inline;'; // minimal residual styling
}
