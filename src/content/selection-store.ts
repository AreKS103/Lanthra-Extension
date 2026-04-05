// selection-store.ts — Save and restore window.getSelection() across DOM mutations.
// Used to preserve user's caret/selection before we mutate the DOM, and
// to restore it if we cancel the edit session.

export interface SavedSelection {
  ranges: SerializedRange[];
}

interface SerializedRange {
  startContainer: Node;
  startOffset:    number;
  endContainer:   Node;
  endOffset:      number;
}

export function saveSelection(): SavedSelection {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { ranges: [] };

  const ranges: SerializedRange[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    ranges.push({
      startContainer: r.startContainer,
      startOffset:    r.startOffset,
      endContainer:   r.endContainer,
      endOffset:      r.endOffset,
    });
  }
  return { ranges };
}

export function restoreSelection(saved: SavedSelection): void {
  const sel = window.getSelection();
  if (!sel) return;

  sel.removeAllRanges();
  for (const s of saved.ranges) {
    try {
      const r = document.createRange();
      r.setStart(s.startContainer, s.startOffset);
      r.setEnd(s.endContainer, s.endOffset);
      sel.addRange(r);
    } catch {
      // Node may have been removed — silently skip
    }
  }
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}
