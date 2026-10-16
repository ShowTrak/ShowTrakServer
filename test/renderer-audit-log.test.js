const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/audit-log.ts: the rows the Logs tab and the Audit
// Log modal draw (an HTML sink, so escaping is checked first), the day
// dividers, and the filter a live entry passes before joining an open list.
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  AuditEntriesHtml,
  AuditEntryHtml,
  AuditEntryMatches,
  AuditSummaryHtml,
  FormatAuditDay,
  FormatAuditTime,
  MergeAuditEntries,
} = require('../dist-test/UI/js/app/lib/audit-log.js');

function entry(Overrides = {}) {
  return {
    ID: 1,
    Timestamp: new Date(2026, 9, 16, 14, 3, 9).getTime(),
    EntityType: 'client',
    EntityID: 'c-1',
    EntityName: 'CONSOLE-01',
    Category: 'status',
    Severity: 'warning',
    Summary: [{ T: 'Logitech Mouse', H: 'device' }, { T: ' Disconnected' }],
    Changes: [],
    Details: [],
    Source: null,
    ...Overrides,
  };
}

test('names are highlighted and everything is escaped', () => {
  assert.equal(
    AuditSummaryHtml([
      { T: '<b>Mouse</b>', H: 'device' },
      { T: ' moved & ' },
      { T: 'Port 1', H: 'value' },
    ]),
    '<span class="audit-hl audit-hl-device">&lt;b&gt;Mouse&lt;/b&gt;</span> moved &amp; <span class="audit-hl audit-hl-value">Port 1</span>'
  );
  const Html = AuditEntryHtml(
    entry({
      EntityName: '"><script>',
      Changes: [{ Field: 'Nickname', From: '<old>', To: null }],
      Details: ['<img src=x>'],
      Source: 'Web UI (<x>)',
    }),
    { ShowEntity: true }
  );
  assert.ok(!Html.includes('<script>'));
  assert.ok(!Html.includes('<img'));
  assert.ok(!Html.includes('<old>'));
  assert.ok(Html.includes('&lt;old&gt;'));
  assert.ok(Html.includes('None'), 'a cleared value reads as None');
});

test('a row shows its time, and its entity only where asked', () => {
  const Row = AuditEntryHtml(entry(), { ShowEntity: true });
  assert.ok(Row.includes('>14:03:09</time>'));
  assert.ok(Row.includes('data-audit-entity-type="client"'), 'a client can be opened from its row');
  assert.ok(!AuditEntryHtml(entry(), { ShowEntity: false }).includes('audit-entity'));
  // Groups have no view modal, so their name is plain text.
  assert.ok(
    !AuditEntryHtml(entry({ EntityType: 'group', EntityID: '3' }), { ShowEntity: true }).includes(
      '<button'
    )
  );
});

test('beside its chip, a summary does not repeat the entity name', () => {
  const Own = entry({ Summary: [{ T: 'CONSOLE-01', H: 'entity' }, { T: ' Disconnected' }] });
  assert.ok(
    AuditEntryHtml(Own, { ShowEntity: true }).includes(
      '<span class="audit-summary">Disconnected</span>'
    )
  );
  assert.ok(
    AuditEntryHtml(Own, { ShowEntity: false }).includes(
      'audit-hl-entity">CONSOLE-01</span> Disconnected'
    )
  );
});

test('only edits and actions carry a category and source line', () => {
  assert.ok(!AuditEntryHtml(entry(), { ShowEntity: false }).includes('audit-meta'));
  const Edit = AuditEntryHtml(entry({ Category: 'edit', Source: 'Desktop' }), {
    ShowEntity: false,
  });
  assert.ok(Edit.includes('<div class="audit-meta">Edit · Desktop</div>'));
});

test('a secret change reads as Changed, without either value', () => {
  const Row = AuditEntryHtml(
    entry({ Changes: [{ Field: 'API Key', From: null, To: 'Changed' }] }),
    { ShowEntity: false }
  );
  assert.ok(Row.includes('API Key'));
  assert.ok(!Row.includes('None'));
});

test('times and day dividers', () => {
  assert.equal(FormatAuditTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05');
  const Now = new Date(2026, 9, 16, 9, 0, 0).getTime();
  assert.equal(FormatAuditDay(new Date(2026, 9, 16, 0, 1).getTime(), Now), 'Today');
  assert.equal(FormatAuditDay(new Date(2026, 9, 15, 23, 59).getTime(), Now), 'Yesterday');
  const Html = AuditEntriesHtml(
    [
      entry({ ID: 3, Timestamp: new Date(2026, 9, 16, 8, 0).getTime() }),
      entry({ ID: 2, Timestamp: new Date(2026, 9, 16, 1, 0).getTime() }),
      entry({ ID: 1, Timestamp: new Date(2026, 9, 15, 22, 0).getTime() }),
    ],
    { ShowEntity: false },
    Now
  );
  assert.equal((Html.match(/class="audit-day"/g) || []).length, 2);
  assert.ok(Html.indexOf('Today') < Html.indexOf('Yesterday'));
});

test('a live entry joins a list only when it matches its filters', () => {
  const Mouse = entry();
  assert.equal(AuditEntryMatches(Mouse, {}), true);
  assert.equal(AuditEntryMatches(Mouse, { EntityType: 'client', EntityID: 'c-1' }), true);
  assert.equal(AuditEntryMatches(Mouse, { EntityType: 'client', EntityID: 'c-2' }), false);
  assert.equal(AuditEntryMatches(Mouse, { EntityType: 'monitor' }), false);
  assert.equal(AuditEntryMatches(Mouse, { Category: 'edit' }), false);
  assert.equal(AuditEntryMatches(Mouse, { Search: 'LOGITECH' }), true);
  assert.equal(
    AuditEntryMatches(Mouse, { Search: 'console' }),
    true,
    'the entity name is searched'
  );
  assert.equal(AuditEntryMatches(Mouse, { Search: 'keyboard' }), false);
  assert.equal(
    AuditEntryMatches(entry({ Changes: [{ Field: 'Nickname', From: 'A', To: 'STAGE-LEFT' }] }), {
      Search: 'stage',
    }),
    true
  );
});

test('merging keeps newest first and drops duplicates', () => {
  const Merged = MergeAuditEntries(
    [entry({ ID: 5 }), entry({ ID: 3 })],
    [entry({ ID: 6 }), entry({ ID: 5 })]
  );
  assert.deepEqual(
    Merged.map((Entry) => Entry.ID),
    [6, 5, 3]
  );
});
