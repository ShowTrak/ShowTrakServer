const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Edits in the audit log: the field diff every manager reports through, and
// one manager end to end: that an edit is recorded with its before → after
// once the log is recording, and that nothing is looked up or recorded while
// it is not (which is every other test in the suite).
const { DiffFields, FormatValue, Snapshot } = require('../dist/Modules/AuditLog/diff');

test('a diff reports only the fields that changed, formatted for reading', () => {
  const Specs = [
    { Key: 'Nickname', Label: 'Nickname' },
    { Key: 'Enabled', Label: 'Enabled' },
    {
      Key: 'Delay',
      Label: 'Launch Delay',
      Format: (Value) => (Value == null ? null : `${Value} seconds`),
    },
    { Key: 'ApiKey', Label: 'API Key', Secret: true },
  ];
  assert.deepEqual(
    DiffFields(
      { Nickname: 'CONSOLE-1', Enabled: false, Delay: 5, ApiKey: 'old' },
      { Nickname: 'CONSOLE-01', Enabled: true, Delay: 5, ApiKey: 'new' },
      Specs
    ),
    [
      { Field: 'Nickname', From: 'CONSOLE-1', To: 'CONSOLE-01' },
      { Field: 'Enabled', From: 'Off', To: 'On' },
      // A secret never carries either value into the log.
      { Field: 'API Key', From: null, To: 'Changed' },
    ]
  );
  assert.deepEqual(DiffFields({ Nickname: 'A' }, { Nickname: 'A' }, Specs), []);
  assert.deepEqual(DiffFields(null, { Nickname: 'A' }, Specs), []);
});

test('values read as text, and empty reads as none', () => {
  assert.equal(FormatValue(''), null);
  assert.equal(FormatValue('  x '), 'x');
  assert.equal(FormatValue(['a', '', 'b']), 'a, b');
  assert.equal(FormatValue(Number.NaN), null);
  assert.equal(FormatValue({ a: 1 }), '{"a":1}');
});

test('a snapshot does not follow the entity it was taken from', () => {
  const Entity = { Title: 'A', Tags: ['x'], Other: 1 };
  const Before = Snapshot(Entity, ['Title', 'Tags']);
  Entity.Title = 'B';
  Entity.Tags.push('y');
  assert.deepEqual(Before, { Title: 'A', Tags: ['x'] });
});

function loadGroupManager(Recording) {
  const Recorded = [];
  const Rows = [{ GroupID: 12, Title: 'FOH', Weight: 100, Colour: null }];
  const Edits = {
    RecordEdit: (Entry) => Recorded.push({ ...Entry, Category: 'edit' }),
    RecordUpdate: (Entry) => Entry.Changes.length && Recorded.push({ ...Entry, Category: 'edit' }),
    RecordAction: (Entry) => Recorded.push({ ...Entry, Category: 'action' }),
  };
  const noop = () => {};
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'GroupManager', 'index.js'),
    {
      '../Logger': {
        CreateLogger: () => ({
          log: noop,
          info: noop,
          warn: noop,
          error: noop,
          debug: noop,
          success: noop,
        }),
      },
      '../DB': {
        Manager: {
          Run: async (Sql, Params) => {
            if (Sql.includes('UPDATE Groups SET Title')) Rows[0].Title = Params[0];
            return [null, { changes: 1, lastID: 12 }];
          },
          Get: async () => [null, { ...Rows[0] }],
          All: async () => [null, Rows.map((Row) => ({ ...Row }))],
        },
      },
      '../Broadcast': { Manager: { emit: noop } },
      '../AuditLog': { Manager: { IsStarted: () => Recording } },
      '../AuditLog/edits': Edits,
    },
    { alsoEvict: [path.join(__dirname, '..', 'dist', 'Modules', 'Shared', 'audit-names.js')] }
  );
  return { Manager, Recorded };
}

test('renaming a group is recorded with its before and after', async () => {
  const { Manager, Recorded } = loadGroupManager(true);
  const [Err] = await Manager.Rename(12, 'Front of House');
  assert.equal(Err, null);
  assert.equal(Recorded.length, 1);
  const [Entry] = Recorded;
  assert.equal(Entry.EntityType, 'group');
  assert.equal(Entry.EntityID, 12);
  assert.deepEqual(Entry.Summary, [{ T: 'Edited ' }, { T: 'Front of House', H: 'entity' }]);
  assert.deepEqual(Entry.Changes, [{ Field: 'Group Name', From: 'FOH', To: 'Front of House' }]);
});

test('nothing is recorded while the audit log is not recording', async () => {
  const { Manager, Recorded } = loadGroupManager(false);
  const [Err] = await Manager.Rename(12, 'Front of House');
  assert.equal(Err, null);
  assert.deepEqual(Recorded, []);
});
