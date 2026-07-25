const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/markdown.ts — the Markdown -> safe-HTML renderer used
// for GitHub release notes in the update modal.
//
// This is an HTML sink: the output is injected with jQuery's .html(), so these
// tests lean hard on the escaping guarantees rather than on prettiness of the
// markup. Loaded from dist-test/ (see test/renderer-utils.test.js for why).
//
// NOTE: the third export, sanitizeUpdateNotesHtml, needs DOMParser and is not
// covered here — it is DOM-dependent by design (it deliberately uses the
// browser's own parser to avoid mutation XSS). Covering it needs the WP-1
// strategy decision on jsdom.
const { sanitizeHref, renderMarkdownSafe } = require('../dist-test/UI/js/app/lib/markdown.js');

// --- sanitizeHref -----------------------------------------------------------

test('sanitizeHref passes through http, https and mailto', () => {
  assert.equal(sanitizeHref('https://showtrak.co.uk'), 'https://showtrak.co.uk');
  assert.equal(sanitizeHref('http://example.com/a?b=c#d'), 'http://example.com/a?b=c#d');
  assert.equal(sanitizeHref('mailto:tom@tkw.bz'), 'mailto:tom@tkw.bz');
});

test('sanitizeHref matches the scheme case-insensitively and after trimming', () => {
  assert.equal(sanitizeHref('  https://example.com  '), 'https://example.com');
  assert.equal(sanitizeHref('HTTPS://example.com'), 'HTTPS://example.com');
  assert.equal(sanitizeHref('MailTo:a@b.c'), 'MailTo:a@b.c');
});

test('sanitizeHref collapses every non-allowlisted scheme to #', () => {
  for (const Href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'about:blank',
    // Relative and protocol-relative URLs are not on the allowlist either.
    '/local/path',
    '//evil.example.com',
    '',
  ]) {
    assert.equal(sanitizeHref(Href), '#', `expected # for ${JSON.stringify(Href)}`);
  }
});

test('sanitizeHref coerces non-string input rather than throwing', () => {
  assert.equal(sanitizeHref(null), '#');
  assert.equal(sanitizeHref(undefined), '#');
  assert.equal(sanitizeHref(42), '#');
});

test('sanitizeHref falls back to # when coercing the input itself throws', () => {
  const Warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      sanitizeHref({
        toString() {
          throw new Error('hostile toString');
        },
      }),
      '#'
    );
  } finally {
    console.warn = Warn;
  }
});

// --- renderMarkdownSafe: escaping -------------------------------------------

test('renderMarkdownSafe returns empty string for non-string input', () => {
  assert.equal(renderMarkdownSafe(null), '');
  assert.equal(renderMarkdownSafe(undefined), '');
  assert.equal(renderMarkdownSafe(''), '');
  assert.equal(renderMarkdownSafe(42), '');
  assert.equal(renderMarkdownSafe({}), '');
});

test('renderMarkdownSafe escapes raw HTML before any markup is emitted', () => {
  const Out = renderMarkdownSafe('<script>alert(1)</script>');
  assert.equal(Out, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(Out, /<script/);
});

test('renderMarkdownSafe escapes an img onerror payload', () => {
  const Out = renderMarkdownSafe('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(Out, /<img/);
  assert.match(Out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- renderMarkdownSafe: links ----------------------------------------------

test('renderMarkdownSafe renders a link with target and rel hardening', () => {
  assert.equal(
    renderMarkdownSafe('[ShowTrak](https://showtrak.co.uk)'),
    '<p><a href="https://showtrak.co.uk" target="_blank" rel="noopener">ShowTrak</a></p>'
  );
});

test('renderMarkdownSafe defuses a javascript: link into #', () => {
  const Out = renderMarkdownSafe('[click me](javascript:alert(1))');
  assert.match(Out, /href="#"/);
  assert.doesNotMatch(Out, /javascript:/);
});

test('renderMarkdownSafe blocks an attribute breakout through the href', () => {
  // This is the reason Safe() runs FIRST, before any markup is generated: the
  // quotes in the href are already entities by the time they are interpolated
  // into href="...", so the attribute cannot be closed early. If the escape
  // order were ever flipped, this becomes an XSS.
  const Out = renderMarkdownSafe('[x](https://evil.example" onmouseover="alert(1))');
  assert.doesNotMatch(Out, /onmouseover="alert/);
  assert.match(Out, /&quot; onmouseover=&quot;alert\(1/);
});

test('renderMarkdownSafe escapes markup inside a link label', () => {
  const Out = renderMarkdownSafe('[<b>bold</b>](https://example.com)');
  assert.doesNotMatch(Out, /<b>/);
  assert.match(Out, /&lt;b&gt;bold&lt;\/b&gt;/);
});

// --- renderMarkdownSafe: block and inline constructs -------------------------

test('renderMarkdownSafe maps heading levels 1-6 onto h1-h6', () => {
  assert.equal(renderMarkdownSafe('# Title'), '<h1 class="h3">Title</h1>');
  assert.equal(renderMarkdownSafe('### Third'), '<h3 class="h5">Third</h3>');
  assert.equal(renderMarkdownSafe('###### Sixth'), '<h6 class="h8">Sixth</h6>');
  // Seven hashes is not a heading; it falls through to a paragraph.
  assert.match(renderMarkdownSafe('####### Seven'), /^<p>/);
});

test('renderMarkdownSafe groups contiguous bullets into a single list', () => {
  const Out = renderMarkdownSafe('- one\n- two\n- three');
  assert.equal(Out, '<ul><li>one</li><li>two</li><li>three</li></ul>');
});

test('renderMarkdownSafe accepts all three bullet markers', () => {
  assert.equal(renderMarkdownSafe('* a\n+ b\n- c'), '<ul><li>a</li><li>b</li><li>c</li></ul>');
});

test('renderMarkdownSafe renders bold and italic', () => {
  assert.equal(renderMarkdownSafe('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdownSafe('__bold__'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdownSafe('*italic*'), '<p><em>italic</em></p>');
  assert.equal(renderMarkdownSafe('_italic_'), '<p><em>italic</em></p>');
});

test('renderMarkdownSafe leaves bare asterisks alone rather than mangling bullets', () => {
  // Bold/italic run after list extraction precisely so that "- item" survives.
  const Out = renderMarkdownSafe('- an * asterisk');
  assert.equal(Out, '<ul><li>an * asterisk</li></ul>');
});

test('renderMarkdownSafe renders inline code', () => {
  assert.equal(renderMarkdownSafe('use `npm test` now'), '<p>use <code>npm test</code> now</p>');
});

test('renderMarkdownSafe preserves fenced code blocks with their content escaped', () => {
  const Out = renderMarkdownSafe('```\n<script>alert(1)</script>\n```');
  assert.match(Out, /<pre class="mb-2"><code>/);
  // The fence content was escaped by the initial Safe() pass, so the tags inside
  // are inert even though they are restored verbatim afterwards.
  assert.match(Out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(Out, /<script>/);
});

test('renderMarkdownSafe does not apply inline formatting inside a fenced block', () => {
  // Fences are pulled out before the inline passes and restored at the end.
  const Out = renderMarkdownSafe('```\n**not bold** and `not code`\n```');
  assert.doesNotMatch(Out, /<strong>/);
  assert.match(Out, /\*\*not bold\*\*/);
});

test('renderMarkdownSafe splits blank-line-separated blocks into paragraphs', () => {
  assert.equal(renderMarkdownSafe('first\n\nsecond'), '<p>first</p>\n<p>second</p>');
});

test('renderMarkdownSafe converts single newlines inside a paragraph to <br/>', () => {
  assert.equal(renderMarkdownSafe('line one\nline two'), '<p>line one<br/>line two</p>');
});

test('renderMarkdownSafe normalises CRLF line endings', () => {
  // Release notes come from GitHub and routinely arrive with CRLF.
  assert.equal(renderMarkdownSafe('- a\r\n- b'), renderMarkdownSafe('- a\n- b'));
  assert.equal(renderMarkdownSafe('x\r\n\r\ny'), '<p>x</p>\n<p>y</p>');
});

test('renderMarkdownSafe does not wrap an already block-level element in a paragraph', () => {
  const Out = renderMarkdownSafe('# Heading\n\n- item');
  assert.equal(Out, '<h1 class="h3">Heading</h1>\n<ul><li>item</li></ul>');
});

test('renderMarkdownSafe renders a realistic release-notes document', () => {
  const Out = renderMarkdownSafe(
    [
      '## What changed',
      '',
      '- Fixed **crash** on launch',
      '- See [notes](https://example.com)',
    ].join('\n')
  );
  assert.match(Out, /<h2 class="h4">What changed<\/h2>/);
  assert.match(Out, /<li>Fixed <strong>crash<\/strong> on launch<\/li>/);
  assert.match(Out, /<a href="https:\/\/example.com" target="_blank" rel="noopener">notes<\/a>/);
});
