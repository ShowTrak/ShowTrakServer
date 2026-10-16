const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { AUDIT_LOG_RETENTION_MS } = require('../dist/Modules/Config/constants');

// The audit log store: its own SQLite file (never the show database), batched
// writes, newest-first paged reads with filters, and the purge that keeps a
// server running for weeks at one day of entries.

function loggerStub() {
  const noop = () => {};
  return {
    CreateLogger: () => ({
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      success: noop,
      database: noop,
      databaseError: noop,
    }),
  };
}

function loadAuditLog() {
  const Bus = new EventEmitter();
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-audit-'));
  const Module = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'AuditLog', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../Broadcast': { Manager: Bus },
      '../AppData': { Manager: { GetStorageDirectory: () => Dir } },
    }
  );
  return { AuditLog: Module.Manager, Bus, FilePath: path.join(Dir, 'AuditLog.sqlite') };
}

const Summary = (Text) => [{ T: Text }];

function entry(Overrides = {}) {
  return {
    EntityType: 'client',
    EntityID: 'uuid-1',
    EntityName: 'CONSOLE-01',
    Category: 'status',
    Summary: [{ T: 'CONSOLE-01', H: 'entity' }, { T: ' Disconnected' }],
    ...Overrides,
  };
}

test('nothing is recorded or read before Start', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  AuditLog.Record(entry());
  await AuditLog.Flush();
  assert.deepEqual(await AuditLog.Query({}), { Entries: [], HasMore: false });
  assert.equal(fs.existsSync(FilePath), false, 'no file is created until the log is started');
});

test('entries are written to their own database file and read back newest first', async () => {
  const { AuditLog, Bus, FilePath } = loadAuditLog();
  const Appended = [];
  Bus.on('AuditLogAppended', (Entries) => Appended.push(...Entries));
  await AuditLog.Start({ FilePath });

  AuditLog.Record(entry({ Summary: Summary('first') }));
  AuditLog.Record(entry({ Summary: Summary('second'), Severity: 'warning', Details: ['why'] }));
  const Page = await AuditLog.Query({});

  assert.equal(fs.existsSync(FilePath), true);
  assert.deepEqual(
    Page.Entries.map((Entry) => Entry.Summary[0].T),
    ['second', 'first']
  );
  assert.equal(Page.HasMore, false);
  const [Newest] = Page.Entries;
  assert.equal(Newest.Severity, 'warning');
  assert.deepEqual(Newest.Details, ['why']);
  assert.deepEqual(Newest.Changes, []);
  assert.equal(Newest.Source, null, 'a status change has no source');
  assert.ok(Newest.ID > Page.Entries[1].ID);
  // The push carries the written rows, IDs included.
  assert.deepEqual(
    Appended.map((Entry) => Entry.ID).sort(),
    Page.Entries.map((Entry) => Entry.ID).sort()
  );
  await AuditLog.Shutdown();
});

test('an edit takes the surface of the request it was made in', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  const { RunWithAuditSource } = require('../dist/Modules/AuditLog/source');
  await AuditLog.Start({ FilePath });
  RunWithAuditSource('Web UI (10.0.0.5)', () =>
    AuditLog.Record(entry({ Category: 'edit', Summary: Summary('Edited') }))
  );
  RunWithAuditSource('Web UI (10.0.0.5)', () =>
    AuditLog.Record(entry({ Category: 'status', Summary: Summary('Observed') }))
  );
  const { Entries } = await AuditLog.Query({});
  const Edit = Entries.find((Entry) => Entry.Category === 'edit');
  const Status = Entries.find((Entry) => Entry.Category === 'status');
  assert.equal(Edit.Source, 'Web UI (10.0.0.5)');
  assert.equal(Status.Source, null);
  await AuditLog.Shutdown();
});

test('reads filter by entity, category and search, and page back by ID', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  await AuditLog.Start({ FilePath });
  AuditLog.Record(
    entry({
      EntityID: 'a',
      Summary: [{ T: 'Logitech Mouse', H: 'device' }, { T: ' Disconnected' }],
    })
  );
  AuditLog.Record(
    entry({
      EntityID: 'b',
      Category: 'edit',
      Summary: Summary('Edited'),
      Changes: [{ Field: 'Nickname', From: 'OLD', To: 'NEW' }],
    })
  );
  AuditLog.Record(
    entry({
      EntityType: 'monitor',
      EntityID: '7',
      EntityName: 'Projector',
      Summary: Summary('Offline'),
    })
  );
  for (let Index = 0; Index < 5; Index++)
    AuditLog.Record(entry({ EntityID: 'a', Summary: Summary(`tick ${Index}`) }));

  const ForA = await AuditLog.Query({ EntityType: 'client', EntityID: 'a' });
  assert.equal(ForA.Entries.length, 6);
  assert.ok(ForA.Entries.every((Entry) => Entry.EntityID === 'a'));

  const Edits = await AuditLog.Query({ Category: 'edit' });
  assert.deepEqual(
    Edits.Entries.map((Entry) => Entry.EntityID),
    ['b']
  );

  // Search covers the summary, the name and the changes, case-insensitively.
  assert.equal((await AuditLog.Query({ Search: 'logitech' })).Entries.length, 1);
  assert.equal((await AuditLog.Query({ Search: 'projector' })).Entries.length, 1);
  assert.equal((await AuditLog.Query({ Search: 'new' })).Entries.length, 1);
  // LIKE wildcards in a search are literal.
  assert.equal((await AuditLog.Query({ Search: '%' })).Entries.length, 0);

  const First = await AuditLog.Query({ EntityID: 'a', Limit: 4 });
  assert.equal(First.Entries.length, 4);
  assert.equal(First.HasMore, true);
  const Second = await AuditLog.Query({ EntityID: 'a', Limit: 4, BeforeID: First.Entries[3].ID });
  assert.equal(Second.Entries.length, 2);
  assert.equal(Second.HasMore, false);
  assert.ok(Second.Entries[0].ID < First.Entries[3].ID);
  await AuditLog.Shutdown();
});

test('entries older than 24 hours are purged and never read', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  await AuditLog.Start({ FilePath });
  const Now = Date.now();
  AuditLog.Record(
    entry({ Summary: Summary('ancient'), Timestamp: Now - AUDIT_LOG_RETENTION_MS - 60000 })
  );
  AuditLog.Record(entry({ Summary: Summary('recent'), Timestamp: Now - 60000 }));
  await AuditLog.Flush();

  assert.deepEqual(
    (await AuditLog.Query({})).Entries.map((Entry) => Entry.Summary[0].T),
    ['recent'],
    'an expired entry is never shown, even before the sweep reaches it'
  );
  assert.equal(await AuditLog.Purge(Now), 1);
  assert.equal(await AuditLog.Purge(Now), 0);
  // An hour later the recent one has not expired yet; a day later it has.
  assert.equal(await AuditLog.Purge(Now + 60 * 60 * 1000), 0);
  assert.equal(await AuditLog.Purge(Now + AUDIT_LOG_RETENTION_MS), 1);
  await AuditLog.Shutdown();
});

test('entries survive a restart, and a restart purges what expired while it was down', async () => {
  const First = loadAuditLog();
  await First.AuditLog.Start({ FilePath: First.FilePath });
  First.AuditLog.Record(entry({ Summary: Summary('kept') }));
  First.AuditLog.Record(
    entry({ Summary: Summary('stale'), Timestamp: Date.now() - AUDIT_LOG_RETENTION_MS - 1000 })
  );
  await First.AuditLog.Shutdown();

  const Second = loadAuditLog();
  await Second.AuditLog.Start({ FilePath: First.FilePath });
  const { Entries } = await Second.AuditLog.Query({});
  assert.deepEqual(
    Entries.map((Entry) => Entry.Summary[0].T),
    ['kept']
  );
  assert.equal(await Second.AuditLog.Purge(), 0, 'Start already purged the stale entry');
  await Second.AuditLog.Shutdown();
});

test('Shutdown writes what is still queued', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  await AuditLog.Start({ FilePath });
  AuditLog.Record(entry({ Summary: Summary('queued at exit') }));
  await AuditLog.Shutdown();

  const Reopened = loadAuditLog();
  await Reopened.AuditLog.Start({ FilePath });
  assert.equal((await Reopened.AuditLog.Query({})).Entries.length, 1);
  await Reopened.AuditLog.Shutdown();
});

test('a malformed entry is dropped rather than thrown', async () => {
  const { AuditLog, FilePath } = loadAuditLog();
  await AuditLog.Start({ FilePath });
  assert.doesNotThrow(() => AuditLog.Record(null));
  assert.doesNotThrow(() => AuditLog.Record(entry({ Summary: [] })));
  assert.equal((await AuditLog.Query({})).Entries.length, 0);
  await AuditLog.Shutdown();
});

test('the registrar keeps only the query fields it understands', () => {
  const { ToAuditLogQuery } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'main', 'registrars', 'audit-log.js'),
    {
      '../rpc': { RPC: { handle: () => {} } },
      '../../Modules/AuditLog': { Manager: {} },
    }
  );
  assert.deepEqual(
    ToAuditLogQuery({
      EntityType: 'monitor',
      EntityID: 7,
      Category: 'edit',
      Search: '  mouse ',
      BeforeID: 40,
      Limit: 50,
      Extra: 'ignored',
    }),
    {
      EntityType: 'monitor',
      EntityID: '7',
      Category: 'edit',
      Search: 'mouse',
      BeforeID: 40,
      Limit: 50,
    }
  );
  assert.deepEqual(
    ToAuditLogQuery({
      EntityType: 'nonsense',
      Category: 'DROP TABLE',
      BeforeID: 'x',
      Search: '   ',
    }),
    {}
  );
  assert.deepEqual(ToAuditLogQuery(null), {});
});
