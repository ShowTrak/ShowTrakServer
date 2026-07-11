// Minimal, self-contained Markdown → safe-HTML renderer for the renderer UI.
//
// Extracted verbatim from init.ts, where it was defined inline inside the app
// update-status handler. Used to render GitHub release notes when they arrive as
// Markdown (not pre-rendered HTML). Everything is escaped through `Safe` before
// any markup is emitted, and link hrefs are restricted to http(s)/mailto — so
// the output is safe to inject with `.html()`.
import { HandleNonFatalError, Safe } from '../04-utils';

// Allow only http(s)/mailto links through; everything else collapses to '#'.
function sanitizeHref(href: string): string {
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

export { renderMarkdownSafe };
