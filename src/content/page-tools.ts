// page-tools.ts — Executes page-context tools requested by the AI via tool calling.
// Runs inside the content script (has full DOM access).
// Uses Readability + Turndown for clean Markdown extraction.

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
// Strip images from markdown output — the get_page_images tool exists for that.
turndown.addRule('removeImages', { filter: 'img', replacement: () => '' });

/**
 * Execute a named page tool and return the result as a plain string.
 * Called when the AI issues a tool_call through the LLM tools API.
 */
export function executePageTool(name: string): string {
  switch (name) {
    case 'get_page_content':   return toolGetPageContent();
    case 'get_selected_text':  return toolGetSelectedText();
    case 'get_editor_content': return toolGetEditorContent();
    case 'get_pdf_text':       return toolGetPdfText();
    case 'get_page_images':    return toolGetPageImages();
    default:                   return `Unknown tool: "${name}"`;
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

function toolGetPageContent(maxLen = 15_000): string {
  const title = document.title ?? '';
  const url   = location.href;

  let mainContent = '';

  // Readability + Turndown pipeline
  try {
    const clone   = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    if (article?.content) {
      mainContent = turndown.turndown(article.content);
    }
  } catch { /* Readability failed, fall through */ }

  // Fallback: basic innerText
  if (!mainContent) {
    mainContent = (document.body.innerText ?? '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Fold in editor content that Readability may miss
  const editorText = extractEditorContent();
  if (editorText && !mainContent.includes(editorText.slice(0, 100))) {
    mainContent += '\n\n---\n\n' + editorText;
  }

  // Enrich with structured sections (metadata, infobox, comments, links, profile)
  const sections: string[] = [];

  const meta = extractCompactMetadata();
  if (meta) sections.push(meta);

  const profile = extractSocialProfile();
  if (profile) sections.push(profile);

  const infobox = extractInfobox();
  if (infobox) sections.push(infobox);

  const comments = extractComments();
  if (comments) sections.push(comments);

  const links = extractTopLinks();
  if (links) sections.push(links);

  // Combine: main content + enrichment sections, within budget
  let result = `Title: ${title}\nURL: ${url}\n\n${mainContent}`;
  for (const section of sections) {
    if (result.length + section.length + 5 > maxLen) break;
    result += '\n\n---\n\n' + section;
  }

  if (result.length > maxLen) result = result.slice(0, maxLen) + '\u2026';
  return result;
}

/**
 * Extract content from web-based text editors (Google Docs, Notion, Word Online, etc.).
 * Uses multiple strategies since each editor renders differently.
 */
function toolGetEditorContent(maxLen = 16_000): string {
  const content = extractEditorContent(maxLen);
  if (content) return content;
  return 'No editor content detected on this page. The page may use a standard layout — try get_page_content instead.';
}

function extractEditorContent(maxLen = 16_000): string {
  const parts: string[] = [];

  // Strategy 1: contenteditable regions (Notion, Medium, Confluence, etc.)
  const editables = document.querySelectorAll(
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
  );
  for (const el of Array.from(editables)) {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length > 20) parts.push(text);
  }

  // Strategy 2: Google Docs — renders text in .kix-lineview spans inside an iframe
  // or directly in the page. Also uses aria labels.
  const gdocPages = document.querySelectorAll('.kix-page, .kix-paginateddocumentplugin');
  if (gdocPages.length > 0) {
    const spans = document.querySelectorAll('.kix-lineview .kix-wordhtmlgenerator-word-node');
    const gdocText = Array.from(spans).map(s => s.textContent ?? '').join('');
    if (gdocText.trim()) parts.push(gdocText);
  }

  // Strategy 3: Google Docs aria-label on pages (backup)
  if (parts.length === 0) {
    const ariaDoc = document.querySelector('[aria-label*="Document content"]');
    if (ariaDoc) {
      const text = (ariaDoc as HTMLElement).innerText?.trim();
      if (text) parts.push(text);
    }
  }

  // Strategy 4: ARIA role="textbox" (many editors: Notion, Slack, Discord)
  const textboxes = document.querySelectorAll('[role="textbox"]');
  for (const tb of Array.from(textboxes)) {
    const text = (tb as HTMLElement).innerText?.trim();
    if (text && text.length > 20 && !parts.some(p => p.includes(text.slice(0, 80)))) {
      parts.push(text);
    }
  }

  // Strategy 5: Common editor selectors
  const editorSelectors = [
    '.ProseMirror',                    // Notion, Tiptap, many modern editors
    '.ql-editor',                      // Quill
    '.CodeMirror-code',                // CodeMirror
    '.cm-content',                     // CodeMirror 6
    '.monaco-editor .view-lines',      // Monaco / VS Code web
    '.tox-edit-area__iframe',          // TinyMCE (iframe)
    '.cke_editable',                   // CKEditor 4
    '.ck-editor__editable',            // CKEditor 5
    '.DraftEditor-root',              // Draft.js (Facebook)
    '.ace_text-layer',                 // Ace editor
    '[data-slate-editor]',             // Slate.js
    '.notion-page-content',            // Notion
    '.roam-body-main',                 // Roam Research
    '.is-editing',                     // Generic editing state
  ];

  for (const sel of editorSelectors) {
    const els = document.querySelectorAll(sel);
    for (const el of Array.from(els)) {
      // Handle iframes (TinyMCE)
      if (el.tagName === 'IFRAME') {
        try {
          const iframeDoc = (el as HTMLIFrameElement).contentDocument;
          const text = iframeDoc?.body?.innerText?.trim();
          if (text && text.length > 10) parts.push(text);
        } catch { /* cross-origin iframe, skip */ }
        continue;
      }
      const text = (el as HTMLElement).innerText?.trim();
      if (text && text.length > 20 && !parts.some(p => p.includes(text.slice(0, 80)))) {
        parts.push(text);
      }
    }
  }

  // Strategy 6: Same-origin iframes (some editors embed in iframes)
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of Array.from(iframes)) {
    try {
      const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
      if (!iframeDoc) continue;
      // Check for editables inside
      const iframeEditables = iframeDoc.querySelectorAll(
        '[contenteditable="true"], body[contenteditable]'
      );
      for (const el of Array.from(iframeEditables)) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 20 && !parts.some(p => p.includes(text.slice(0, 80)))) {
          parts.push(text);
        }
      }
      // Also check body if the whole iframe is an editor
      if (iframeDoc.designMode === 'on' || iframeDoc.body?.isContentEditable) {
        const text = iframeDoc.body?.innerText?.trim();
        if (text && text.length > 20 && !parts.some(p => p.includes(text.slice(0, 80)))) {
          parts.push(text);
        }
      }
    } catch { /* cross-origin, skip */ }
  }

  if (parts.length === 0) return '';
  const combined = parts.join('\n\n---\n\n');
  return combined.length > maxLen ? combined.slice(0, maxLen) + '\u2026' : combined;
}

function toolGetSelectedText(): string {
  const sel = window.getSelection()?.toString().trim() ?? '';
  return sel.length > 0 ? sel : 'No text is currently selected on the page.';
}

function toolGetPageImages(max = 20): string {
  const seen  = new Set<string>();
  const lines: string[] = [];

  function addImage(src: string, alt: string = ''): boolean {
    if (!src || src.startsWith('data:') || seen.has(src)) return false;
    try { new URL(src); } catch { return false; }
    seen.add(src);
    lines.push(alt ? `${alt}: ${src}` : src);
    return lines.length >= max;
  }

  // 1. <img> elements — src, data-src, srcset
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const el = img as HTMLImageElement;
    // Skip tiny images (icons, tracking pixels) — only if loaded
    if (el.naturalWidth > 0 && el.naturalWidth < 32) continue;
    // Skip invisible images
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;

    const alt = (el.alt ?? '').trim();
    const src = el.src || el.dataset.src || el.getAttribute('data-lazy-src') || '';
    const srcset = el.srcset || el.dataset.srcset || '';

    // Prefer highest resolution from srcset
    const best = getBestFromSrcset(srcset) || src;
    if (addImage(best, alt)) break;
  }

  // 2. <picture> <source> elements
  for (const source of Array.from(document.querySelectorAll('picture source[srcset]'))) {
    if (lines.length >= max) break;
    const srcset = source.getAttribute('srcset') || '';
    const src = getBestFromSrcset(srcset);
    if (src && addImage(src)) break;
  }

  // 3. <video poster>
  for (const video of Array.from(document.querySelectorAll('video[poster]'))) {
    if (lines.length >= max) break;
    const poster = (video as HTMLVideoElement).poster;
    if (addImage(poster)) break;
  }

  return lines.length > 0
    ? 'IMAGE_URLS\n' + lines.join('\n')
    : 'No images found on this page.';
}

/** Pick the highest resolution URL from a srcset string. */
function getBestFromSrcset(srcset: string): string {
  if (!srcset) return '';
  const candidates = srcset.split(',').map(s => {
    const parts = s.trim().split(/\s+/);
    const url = parts[0] ?? '';
    const desc = parts[1] ?? '';
    const w = desc.endsWith('w') ? parseInt(desc) : 0;
    const x = desc.endsWith('x') ? parseFloat(desc) : 1;
    return { url, weight: w || x * 1000 };
  });
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]?.url ?? '';
}

// ── PDF extraction ────────────────────────────────────────────────────────────

function toolGetPdfText(): string {
  const textLayers = document.querySelectorAll('.textLayer span, [data-page-no] span');
  if (textLayers.length === 0) {
    return 'No PDF text layer found. The page may use a non-pdf.js viewer or the PDF is image-based.';
  }

  const pages = new Map<number, string[]>();
  textLayers.forEach(span => {
    const page = span.closest('[data-page-number], [data-page-no], .page');
    const pageNum = parseInt(page?.getAttribute('data-page-number') || page?.getAttribute('data-page-no') || '0') || 0;
    if (!pages.has(pageNum)) pages.set(pageNum, []);
    const text = span.textContent || '';
    if (text.trim()) pages.get(pageNum)!.push(text);
  });

  const lines: string[] = [];
  const sortedPages = Array.from(pages.entries()).sort((a, b) => a[0] - b[0]);
  for (const [num, texts] of sortedPages) {
    if (num > 0) lines.push(`\n--- Page ${num} ---`);
    lines.push(texts.join(' '));
  }

  const result = lines.join('\n').slice(0, 15000);
  return result.length > 0 ? 'PDF_TEXT\n' + result : 'PDF text layer was empty.';
}

// ── Enrichment helpers (called by toolGetPageContent) ─────────────────────────

/** Compact metadata from OG tags, JSON-LD, and meta elements. */
function extractCompactMetadata(): string {
  const meta: Record<string, string> = {};

  // OG / article tags
  const props = ['og:title', 'og:description', 'og:site_name', 'og:type',
    'article:author', 'article:published_time', 'article:section'];
  for (const prop of props) {
    const el = document.querySelector(`meta[property="${prop}"]`) as HTMLMetaElement | null;
    if (el?.content) meta[prop.replace(/^(og|article):/, '')] = el.content;
  }

  // Standard meta
  for (const name of ['author', 'description', 'keywords']) {
    if (!meta[name]) {
      const el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
      if (el?.content) meta[name] = el.content;
    }
  }

  // JSON-LD: extract key fields only
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.author && !meta.author) meta.author = typeof item.author === 'string' ? item.author : item.author?.name || '';
        if (item.datePublished && !meta.published_time) meta.published_time = item.datePublished;
        if (item.interactionStatistic) {
          const stats = Array.isArray(item.interactionStatistic) ? item.interactionStatistic : [item.interactionStatistic];
          for (const s of stats) {
            const type = (s.interactionType?.['@type'] || s.interactionType || '').replace('http://schema.org/', '');
            if (s.userInteractionCount != null) meta[type || 'interactions'] = String(s.userInteractionCount);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Engagement from aria-labels (social media)
  const engagementPattern = /(\d[\d,.]*[KkMm]?)\s*(likes?|comments?|shares?|retweets?|reposts?|views?|reactions?)/i;
  for (const el of Array.from(document.querySelectorAll('[aria-label]')).slice(0, 150)) {
    const m = engagementPattern.exec(el.getAttribute('aria-label') || '');
    if (m && m[1] && m[2]) meta[m[2].toLowerCase()] = m[1];
  }

  if (Object.keys(meta).length === 0) return '';
  return 'METADATA\n' + Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** Extract Wikipedia infobox if present. */
function extractInfobox(): string {
  const infobox = document.querySelector('table.infobox, table.infobox_v2, .infobox');
  if (!infobox) return '';

  const rows: string[] = [];
  infobox.querySelectorAll('tr').forEach(tr => {
    const th = tr.querySelector('th')?.textContent?.trim();
    const td = tr.querySelector('td')?.textContent?.trim();
    if (th && td) rows.push(`${th}: ${td}`);
    else if (th) rows.push(`## ${th}`);
  });

  const caption = infobox.querySelector('caption, .infobox-title, .fn')?.textContent?.trim();
  if (caption) rows.unshift(`Title: ${caption}`);

  return rows.length > 0 ? 'INFOBOX\n' + rows.join('\n') : '';
}

/** Extract comments / replies if visible. */
function extractComments(): string {
  const comments: string[] = [];
  const max = 25;

  document.querySelectorAll('[role="comment"]').forEach(el => {
    if (comments.length >= max) return;
    const text = el.textContent?.trim().slice(0, 400);
    if (text) comments.push(text);
  });

  if (comments.length === 0) {
    const selectors = ['[data-testid*="comment"]', '[class*="comment-content"]', '[class*="Comment"]',
      '.comment-body', '.reply-content'];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        if (comments.length >= max) return;
        const text = el.textContent?.trim().slice(0, 400);
        if (text && text.length > 5) comments.push(text);
      });
      if (comments.length > 0) break;
    }
  }

  if (comments.length === 0) return '';
  return 'COMMENTS (' + comments.length + ')\n' + comments.map((c, i) => `[${i + 1}] ${c}`).join('\n\n');
}

/** Top links on the page (compact). */
function extractTopLinks(max = 30): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const el = a as HTMLAnchorElement;
    const href = el.href;
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!href || seen.has(href) || href.startsWith('javascript:')) continue;
    seen.add(href);
    lines.push(`${text || '(no label)'}: ${href}`);
    if (lines.length >= max) break;
  }
  return lines.length > 0 ? 'LINKS\n' + lines.join('\n') : '';
}

/** Extract social media profile info (Instagram, X/Twitter, Facebook, LinkedIn, etc.). */
function extractSocialProfile(): string {
  const url = location.href;
  const isSocial = /instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.com|linkedin\.com|tiktok\.com|threads\.net|reddit\.com\/u(ser)?\//.test(url);
  if (!isSocial) return '';

  const info: Record<string, string> = {};

  // Profile name / display name
  const nameSelectors = [
    'header h1', 'header h2', '[data-testid="UserName"]', '[data-testid="UserDescription"]',
    'h1.x-profile-headline', '.profile-name', '.user-name',
    '[role="heading"][aria-level="1"]', 'h1',
  ];
  for (const sel of nameSelectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && text.length < 200) { info.name = text; break; }
  }

  // Bio / description
  const bioSelectors = [
    '[data-testid="UserDescription"]', '.-vDIg span', 'header section > div:last-child',
    '.profile-bio', '[class*="biography"]', '[class*="bio"]',
    'section header + div', '.pv-about__summary-text',
  ];
  for (const sel of bioSelectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text && text.length > 5 && text.length < 1000 && text !== info.name) { info.bio = text; break; }
  }

  // Stats from aria-labels (followers, following, posts)
  const statPattern = /(\d[\d,.]*[KkMm]?)\s*(followers?|following|posts?|tweets?|connections?|subscribers?)/i;
  for (const el of Array.from(document.querySelectorAll('[aria-label], [title]')).slice(0, 200)) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const m = statPattern.exec(label);
    if (m && m[1] && m[2]) info[m[2].toLowerCase()] = m[1];
  }

  // Stats from visible text (e.g. "1,234 followers")
  if (!info.followers) {
    const visibleStatPattern = /([\d,.]+[KkMm]?)\s*(followers?|following|posts?)/gi;
    const headerText = document.querySelector('header')?.textContent || '';
    let match: RegExpExecArray | null;
    while ((match = visibleStatPattern.exec(headerText)) !== null) {
      if (match[1] && match[2]) info[match[2].toLowerCase()] = match[1];
    }
  }

  // Profile picture
  const avatarSelectors = [
    'header img[alt*="profile" i]', 'header img[alt*="avatar" i]', 'header img',
    '[data-testid="UserAvatar"] img', 'img[class*="avatar"]', 'img[class*="profile"]',
  ];
  for (const sel of avatarSelectors) {
    const img = document.querySelector(sel) as HTMLImageElement | null;
    if (img?.src && !img.src.startsWith('data:')) { info.avatar = img.src; break; }
  }

  // External links in profile
  const externalLinks: string[] = [];
  document.querySelectorAll('header a[href], [class*="profile"] a[href]').forEach(a => {
    const href = (a as HTMLAnchorElement).href;
    if (href && !href.includes(location.hostname) && externalLinks.length < 5) {
      externalLinks.push(href);
    }
  });
  if (externalLinks.length > 0) info.links = externalLinks.join(', ');

  // Verified badge
  const verified = document.querySelector('[data-testid="icon-verified"], [aria-label*="Verified"], [title*="Verified"], .verified-badge');
  if (verified) info.verified = 'true';

  if (Object.keys(info).length === 0) return '';
  return 'SOCIAL_PROFILE\n' + Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n');
}
