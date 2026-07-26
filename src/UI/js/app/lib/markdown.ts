// Minimal, self-contained Markdown → safe-HTML renderer for the renderer UI.
//
// Extracted verbatim from init.ts, where it was defined inline inside the app
// update-status handler. Used to render GitHub release notes when they arrive as
// Markdown (not pre-rendered HTML). Everything is escaped through `Safe` before
// any markup is emitted, and link hrefs are restricted to http(s)/mailto — so
// the output is safe to inject with `.html()`.
import { HandleNonFatalError, Safe } from '../utils';

// Allow only http(s)/mailto links through; everything else collapses to '#'.
export function sanitizeHref(href: string): string {
  try {
    const h = String(href || '').trim();
    if (/^(https?:|mailto:)/i.test(h)) return h;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  return '#';
}

function renderMarkdownSafe(md: unknown): string {
  if (!md || typeof md !== 'string') return '';
  let text = md.replace(/\r\n/g, '\n');
  // Escape HTML first
  text = Safe(text);
  // Extract fenced code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    const idx = codeBlocks.push(code) - 1;
    return `%%CODEBLOCK_${idx}%%`;
  });
  // Headings
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (m) => {
    const hashes = m.match(/^#+/)![0].length;
    const content = m.replace(/^#{1,6}\s+/, '');
    const level = Math.min(6, Math.max(1, hashes));
    return `<h${level} class="h${level + 2}">${content}</h${level}>`;
  });
  // Inline code (after fences are removed)
  text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const url = sanitizeHref(href);
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  // Unordered lists (group contiguous items)
  text = text.replace(/(?:^|\n)((?:[-*+]\s+.*(?:\n|$))+)/g, (_m, block: string) => {
    const items = block
      .trim()
      .split(/\n/)
      .map((line) => line.replace(/^[-*+]\s+/, '').trim())
      .filter((x) => x.length > 0)
      .map((x) => `<li>${x}</li>`)
      .join('');
    return `\n<ul>${items}</ul>`;
  });
  // Bold and italic (do after lists so we don't break bullets)
  text = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
    .replace(/_(?!\s)(.+?)(?<!\s)_/g, '<em>$1</em>');
  // Paragraphs: wrap blocks that are not already block-level tags
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const html = blocks
    .map((b) => {
      if (/^<\/?(h\d|ul|ol|li|pre|blockquote|table|p|code)/i.test(b)) return b;
      return `<p>${b.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');
  // Restore fenced code blocks
  return html.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => {
    const code = codeBlocks[Number(i)] || '';
    return `<pre class="mb-2"><code>${code}</code></pre>`;
  });
}

// --- Release-notes HTML sanitizer -------------------------------------------
//
// GitHub (via electron-updater's GitHub provider) delivers release notes as
// already-rendered HTML. That HTML is vendor-controlled, but injecting it raw
// with `.html()` is still an unguarded sink, so we run it through an allowlist
// sanitizer before it reaches the DOM. Rather than regex-scrubbing the string
// (which misses parser-based mutation XSS), we parse it with the browser's own
// HTML parser into a DETACHED document — nothing loads or executes — then walk
// the tree and rebuild it from a fixed allowlist of formatting tags. Anything
// not on the list is unwrapped (its text kept) or, for known-dangerous
// containers, dropped whole.

// Formatting tags we keep. Everything is rebuilt fresh, so no attributes
// survive except the ones we explicitly re-add below.
const ALLOWED_TAGS = new Set([
  'A',
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'DEL',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'P',
  'BR',
  'HR',
  'SPAN',
  'DIV',
  'BLOCKQUOTE',
  'UL',
  'OL',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'CAPTION',
]);

// Elements whose entire subtree is discarded (script/style carry executable or
// active content; the rest can load resources or nest browsing contexts).
const DROP_SUBTREE = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'NOSCRIPT',
  'SVG',
  'MATH',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'HEAD',
  'TITLE',
  'IMG',
]);

function sanitizeInto(source: Node, target: Node, doc: Document): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.nodeValue || ''));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return; // comments, etc. dropped
    const el = child as Element;
    const tag = el.tagName;
    if (DROP_SUBTREE.has(tag)) return; // discard element AND its children
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown-but-harmless wrapper: keep its (sanitized) contents, drop the tag.
      sanitizeInto(el, target, doc);
      return;
    }
    const clean = doc.createElement(tag.toLowerCase());
    if (tag === 'A') {
      clean.setAttribute('href', sanitizeHref(el.getAttribute('href') || ''));
      clean.setAttribute('target', '_blank');
      clean.setAttribute('rel', 'noopener noreferrer');
    }
    sanitizeInto(el, clean, doc);
    target.appendChild(clean);
  });
}

function sanitizeUpdateNotesHtml(html: unknown): string {
  const input = typeof html === 'string' ? html : '';
  try {
    const doc = new DOMParser().parseFromString(input, 'text/html');
    const container = doc.createElement('div');
    sanitizeInto(doc.body, container, doc);
    return container.innerHTML;
  } catch (err) {
    HandleNonFatalError('UpdateNotes:Sanitize', err);
    // Last resort: show the notes as escaped text rather than nothing at all.
    return Safe(input);
  }
}

export { renderMarkdownSafe, sanitizeUpdateNotesHtml };
