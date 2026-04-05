// style-mirror.ts — Mirror computed typography from a source element so the
// inline host looks visually native to the surrounding text.

const MIRROR_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'color',
  'whiteSpace',
  'direction',
  'writingMode',
  'textTransform',
  'textDecoration',
  'verticalAlign',
] as const;

type MirrorProp = (typeof MIRROR_PROPS)[number];

export interface MirroredStyles {
  cssText:    string;
  fontSize:   string;
  lineHeight: string;
  color:      string;
}

/** camelCase → kebab-case */
function toKebab(prop: string): string {
  return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/**
 * Reads computed styles from `el` (or its nearest block ancestor if `el` is
 * inline) and returns a CSS string + key values for use on the inline host.
 */
export function mirrorStylesFrom(el: Element): MirroredStyles {
  const source   = nearestStyledAncestor(el);
  const computed = window.getComputedStyle(source);

  const parts: string[] = [];
  for (const prop of MIRROR_PROPS) {
    const value = computed[prop as MirrorProp] as string;
    if (value) parts.push(`${toKebab(prop)}:${value}`);
  }

  return {
    cssText:    parts.join(';'),
    fontSize:   computed.fontSize,
    lineHeight: computed.lineHeight,
    color:      computed.color,
  };
}

/**
 * Walks up the tree to find an element that actually carries typographic
 * styles (i.e. is not just a wrapper with inherited values).
 * Falls back to `el` itself.
 */
function nearestStyledAncestor(el: Element): Element {
  let current: Element | null = el;
  while (current) {
    const cs = window.getComputedStyle(current);
    // Stop at the first element with a non-trivial font-size (not 0 and not
    // just browser default because the parent chain has it naturally).
    if (parseFloat(cs.fontSize) > 0) return current;
    current = current.parentElement;
  }
  return el;
}

/** Returns the nearest block-level ancestor (used to scope MutationObserver). */
export function nearestBlockAncestor(el: Element): Element {
  let current: Element | null = el.parentElement;
  while (current) {
    const display = window.getComputedStyle(current).display;
    if (
      display === 'block'   ||
      display === 'flex'    ||
      display === 'grid'    ||
      display === 'table'   ||
      display === 'list-item'
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return document.body;
}
