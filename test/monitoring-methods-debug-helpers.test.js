const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Direct unit tests for the shared debug-panel HTML helpers in debug.ts. The
// method-level Debug() tests in monitoring-methods-debug.test.js exercise these
// indirectly, but the JSON-formatting helpers (JsonCodeBlock /
// JsonCodeBlockWithPath) and Note are only reachable directly. Because their
// output is injected via innerHTML, escaping behaviour is security-relevant and
// asserted explicitly here.

const Debug = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'debug.js')
);

test('Esc escapes all five HTML-sensitive characters and coerces nullish to empty', () => {
  assert.equal(
    Debug.Esc(`<a href="x" data-y='z'>&</a>`),
    '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;'
  );
  assert.equal(Debug.Esc(null), '');
  assert.equal(Debug.Esc(undefined), '');
  assert.equal(Debug.Esc(0), '0');
});

test('Pill applies the mapped class and falls back to muted for unknown kinds', () => {
  assert.match(Debug.Pill('success', 'Up'), /badge bg-success text-light/);
  assert.match(Debug.Pill('danger', 'Down'), /badge bg-danger text-light/);
  // Unknown kind -> muted styling.
  assert.match(Debug.Pill('nonsense', 'Meh'), /badge bg-ghost-light text-light/);
  // Pill text is escaped.
  assert.match(Debug.Pill('warning', '<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(Debug.Pill('warning', '<b>x</b>'), /<b>x<\/b>/);
});

test('Row embeds pre-built value HTML verbatim but escapes the label', () => {
  const row = Debug.Row('<label>', '<span>safe</span>');
  // Label is escaped...
  assert.match(row, /&lt;label&gt;/);
  // ...but the value HTML is trusted and passed through untouched.
  assert.match(row, /<span>safe<\/span>/);
  assert.match(row, /monitoring-debug-row/);
});

test('TextRow escapes the (untrusted) value', () => {
  const row = Debug.TextRow('Server', '<script>evil()</script>');
  assert.match(row, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(row, /<script>evil/);
});

test('Rows filters falsy entries and wraps the survivors', () => {
  const html = Debug.Rows(['<i>a</i>', false, null, undefined, '<i>b</i>']);
  assert.match(html, /d-grid gap-0/);
  assert.match(html, /<i>a<\/i><i>b<\/i>/);
  // No stray "false"/"null" text leaked in.
  assert.doesNotMatch(html, /false|null|undefined/);
  // Null / missing list is treated as empty.
  assert.match(Debug.Rows(null), /<div class="d-grid gap-0"><\/div>/);
  assert.match(Debug.Rows(), /<div class="d-grid gap-0"><\/div>/);
});

test('Note wraps and escapes its text', () => {
  const note = Debug.Note('Nothing <here>');
  assert.match(note, /text-muted small fst-italic/);
  assert.match(note, /Nothing &lt;here&gt;/);
});

test('FormatLatency renders sub-millisecond, rounded, and non-numeric cases', () => {
  assert.equal(Debug.FormatLatency(0.4), '<1 ms');
  assert.equal(Debug.FormatLatency(0), '<1 ms'); // 0 < 1
  assert.equal(Debug.FormatLatency(12.6), '13 ms'); // rounded
  assert.equal(Debug.FormatLatency(200), '200 ms');
  assert.equal(Debug.FormatLatency('not-a-number'), '—');
  assert.equal(Debug.FormatLatency(undefined), '—'); // Number(undefined) === NaN
  assert.equal(Debug.FormatLatency(Infinity), '—');
  // Number(null) === 0, which is finite and < 1, so it renders as sub-ms.
  assert.equal(Debug.FormatLatency(null), '<1 ms');
});

test('JsonCodeBlock beautifies valid JSON inside an escaped <pre> block', () => {
  const html = Debug.JsonCodeBlock('{"a":1,"b":"x"}');
  assert.match(html, /<pre/);
  // Beautified with two-space indentation.
  assert.match(html, /\{\n {2}&quot;a&quot;: 1/);
});

test('JsonCodeBlock escapes HTML embedded in JSON string values', () => {
  const html = Debug.JsonCodeBlock(JSON.stringify({ note: '<img src=x onerror=alert(1)>' }));
  assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('JsonCodeBlock returns a note for empty or invalid JSON', () => {
  assert.match(Debug.JsonCodeBlock(''), /No JSON response/);
  assert.match(Debug.JsonCodeBlock(null), /No JSON response/);
  const bad = Debug.JsonCodeBlock('{ not valid ');
  assert.match(bad, /Invalid JSON:/);
  assert.match(bad, /fst-italic/); // rendered via Note()
});

test('JsonCodeBlockWithPath highlights the line containing the resolved value', () => {
  const json = JSON.stringify({ data: { status: 'ok', other: 'no' } });
  const html = Debug.JsonCodeBlockWithPath(json, 'data.status');
  assert.match(html, /<pre/);
  // The matched value's line is wrapped in a highlight span.
  assert.match(
    html,
    /<span class="bg-success bg-opacity-25">[^<]*&quot;status&quot;: &quot;ok&quot;/
  );
});

test('JsonCodeBlockWithPath falls back to plain JsonCodeBlock when path or json missing', () => {
  // Missing path -> delegate to JsonCodeBlock (no highlight span).
  const noPath = Debug.JsonCodeBlockWithPath('{"a":1}', '');
  assert.match(noPath, /<pre/);
  assert.doesNotMatch(noPath, /bg-opacity-25/);
  // Missing json -> the "No JSON response" note.
  assert.match(Debug.JsonCodeBlockWithPath('', 'a.b'), /No JSON response/);
});

test('JsonCodeBlockWithPath renders beautified JSON without highlight when path does not resolve', () => {
  const json = JSON.stringify({ data: { status: 'ok' } });
  // Path resolves to undefined (missing key) -> no highlight, still a <pre>.
  const html = Debug.JsonCodeBlockWithPath(json, 'data.missing.deep');
  assert.match(html, /<pre/);
  assert.doesNotMatch(html, /bg-opacity-25/);
});

test('JsonCodeBlockWithPath returns an invalid-JSON note when parsing fails', () => {
  const html = Debug.JsonCodeBlockWithPath('{ broken', 'a.b');
  assert.match(html, /Invalid JSON:/);
});
