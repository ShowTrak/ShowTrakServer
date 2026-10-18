const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');
const Storage = require('../dist/Modules/ClientManager/storage');
const { Manager: SocketValidation } = require('../dist/Modules/SocketValidation');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');
const History = require('../dist/main/monitoring-history');
const { DiffClientStatus } = require('../dist/Modules/AuditLog/status');

// Monitored storage volumes: the pure rules (what a report means, what a
// monitored volume is judged on, what a first Monitor guards), the boundaries
// (socket and IPC validation), and the whole path through the real
// ClientManager and a throwaway SQLite database.

const GB = 1024 ** 3;

function volume(Overrides = {}) {
  return {
    MountPoint: '/Volumes/Media',
    Name: 'Media',
    FileSystem: 'apfs',
    Kind: 'external',
    TotalBytes: 1000 * GB,
    FreeBytes: 400 * GB,
    ReadOnly: false,
    Health: 'ok',
    ...Overrides,
  };
}

function snapshot(Volumes = [volume()], State = 'ok') {
  return {
    SampledAt: 1000,
    Status: { State, Message: null, Platform: 'darwin', Backend: 'df+diskutil' },
    Volumes,
  };
}

function monitored(Overrides = {}) {
  return Storage.normalizeCriticalStorageEntry({
    MountPoint: '/Volumes/Media',
    Name: 'Media',
    MinFreePercent: 10,
    MinFreeGB: null,
    RequireWritable: true,
    RequireHealthy: true,
    ...Overrides,
  });
}

// --- Pure rules -----------------------------------------------------------------

test('a report is normalised: junk dropped, duplicates collapsed, free capped at the size', () => {
  const Observed = Storage.normalizeStorageSnapshot({
    SampledAt: 5,
    Status: { State: 'OK', Platform: 'linux' },
    Volumes: [
      volume({ FreeBytes: 2000 * GB, Kind: 'floppy', Health: 'meh', ReadOnly: 'no' }),
      volume({ Name: 'Duplicate' }),
      { Name: 'No mount point' },
    ],
  });
  assert.equal(Observed.Status.State, 'ok');
  assert.equal(Observed.Volumes.length, 1);
  const [Only] = Observed.Volumes;
  assert.equal(Only.Name, 'Media');
  assert.equal(Only.FreeBytes, Only.TotalBytes);
  assert.equal(Only.Kind, 'unknown');
  assert.equal(Only.Health, null);
  assert.equal(Only.ReadOnly, null);
});

test('a monitored entry always requires the volume to stay mounted, and bounds its limits', () => {
  const Entry = Storage.normalizeCriticalStorageEntry({
    MountPoint: ' /data ',
    RequirePresent: 0,
    MinFreePercent: 250,
    MinFreeGB: '0',
    RequireWritable: 1,
    RequireHealthy: 0,
  });
  assert.equal(Entry.MountPoint, '/data');
  assert.equal(Entry.RequirePresent, true);
  assert.equal(Entry.MinFreePercent, 99);
  assert.equal(Entry.MinFreeGB, 1);
  assert.equal(Entry.RequireWritable, true);
  assert.equal(Entry.RequireHealthy, false);
  assert.equal(Storage.normalizeCriticalStorageEntry({ Name: 'x' }), null);
});

test('each condition is judged only when guarded, and an unknown reading is never a fault', () => {
  const Healthy = Storage.evaluateStorageIssues(volume(), monitored({ MinFreeGB: 100 }));
  assert.deepEqual(Healthy, []);

  const Low = Storage.evaluateStorageIssues(
    volume({ FreeBytes: 64 * GB }),
    monitored({ MinFreeGB: 100 })
  );
  assert.deepEqual(
    Low.map((Issue) => [Issue.Kind, Issue.Message]),
    [
      ['free_percent', '6.4% free (minimum 10%)'],
      ['free_space', '64.0 GB free (minimum 100 GB)'],
    ]
  );

  const Broken = Storage.evaluateStorageIssues(
    volume({ ReadOnly: true, Health: 'failing' }),
    monitored()
  );
  assert.deepEqual(
    Broken.map((Issue) => Issue.Kind),
    ['read_only', 'health']
  );

  const Unknown = Storage.evaluateStorageIssues(
    volume({ ReadOnly: null, Health: null }),
    monitored()
  );
  assert.deepEqual(Unknown, []);

  const Unguarded = Storage.evaluateStorageIssues(
    volume({ ReadOnly: true, Health: 'warning', FreeBytes: 0 }),
    monitored({ MinFreePercent: null, RequireWritable: false, RequireHealthy: false })
  );
  assert.deepEqual(Unguarded, []);

  assert.deepEqual(
    Storage.evaluateStorageIssues(null, monitored()).map((Issue) => Issue.Message),
    ['Media is not mounted']
  );
});

test('sizes and shares are rounded down, so a volume under its limit never reads as at it', () => {
  assert.equal(Storage.FormatStorageBytes(49.99 * GB), '49.9 GB');
  assert.equal(Storage.FormatStorageBytes(1.86 * 1024 * GB), '1.8 TB');
  assert.equal(Storage.FormatStorageBytes(512 * 1024 * 1024), '512 MB');
  assert.equal(Storage.FormatFreePercent(9.99), '9.9%');
  assert.equal(Storage.FormatFreePercent(19.9), '19%');
});

test('the view judges nothing until a trusted report, then lists missing volumes', () => {
  const Observed = Storage.normalizeStorageSnapshot(snapshot([volume({ FreeBytes: 10 * GB })]));
  const Criticals = [monitored(), monitored({ MountPoint: '/Volumes/Gone', Name: 'Gone' })];

  const Untrusted = Storage.buildStorageView(Observed, Criticals, false);
  assert.deepEqual(Untrusted.Warnings, []);
  assert.deepEqual(Untrusted.Missing, []);
  const Unreported = Untrusted.View.Volumes.find((Entry) => Entry.MountPoint === '/Volumes/Gone');
  assert.equal(Unreported.IsConnected, false);
  assert.equal(Unreported.Missing, false);

  const Trusted = Storage.buildStorageView(Observed, Criticals, true);
  assert.deepEqual(Trusted.Warnings, ['Low Disk Space', 'Missing Storage Volume']);
  assert.equal(Trusted.Missing.length, 1);
  assert.equal(Trusted.Missing[0].Name, 'Gone');
});

test('a first Monitor guards 10% free, and writability and health only where they hold now', () => {
  const [, Writable] = Storage.resolveCriticalStorageEntry('/', {}, volume(), null, 42);
  assert.equal(Writable.MinFreePercent, 10);
  assert.equal(Writable.MinFreeGB, null);
  assert.equal(Writable.RequireWritable, true);
  assert.equal(Writable.RequireHealthy, true);
  assert.equal(Writable.Timestamp, 42);

  // A read-only card or a drive with no SMART is not held to what it cannot meet.
  const [, Card] = Storage.resolveCriticalStorageEntry(
    '/Volumes/CARD',
    {},
    volume({ ReadOnly: true, Health: null }),
    null,
    42
  );
  assert.equal(Card.RequireWritable, false);
  assert.equal(Card.RequireHealthy, false);

  // An edit keeps what it does not mention; null stops guarding.
  const [, Edited] = Storage.resolveCriticalStorageEntry(
    '/',
    { MinFreeGB: 50, MinFreePercent: null },
    null,
    Writable,
    99
  );
  assert.equal(Edited.MinFreeGB, 50);
  assert.equal(Edited.MinFreePercent, null);
  assert.equal(Edited.RequireWritable, true);
  assert.equal(Edited.Timestamp, 42);

  const [Err] = Storage.resolveCriticalStorageEntry('/nope', {}, null, null, 1);
  assert.match(Err, /not mounted/);
});

// --- Boundaries -----------------------------------------------------------------

test('the socket validator bounds the report and drops volumes without a mount point', () => {
  const Valid = SocketValidation.StorageVolumes({
    SampledAt: 1,
    Status: { State: 'ok', Platform: 'win32', Backend: 'wmi', Extra: 'x' },
    Volumes: [volume({ MountPoint: 'C:', __proto__: { evil: 1 } }), { Name: 'nameless' }],
    Junk: true,
  });
  assert.equal(Valid.Volumes.length, 1);
  assert.equal(Valid.Volumes[0].MountPoint, 'C:');
  assert.equal('Junk' in Valid, false);
  assert.equal('Extra' in Valid.Status, false);
  assert.throws(() => SocketValidation.StorageVolumes(null), /must be an object/);
  assert.throws(
    () => SocketValidation.StorageVolumes({ Volumes: new Array(129).fill(volume()) }),
    /Volumes/
  );
});

test('the IPC validator accepts limits in range and null, and refuses anything else', () => {
  assert.deepEqual(
    IPCValidation.CriticalStorageVolumePayload({
      MountPoint: '/',
      MinFreePercent: 15,
      MinFreeGB: null,
      RequireWritable: false,
    }),
    { MountPoint: '/', MinFreePercent: 15, MinFreeGB: null, RequireWritable: false }
  );
  assert.deepEqual(IPCValidation.CriticalStorageVolumePayload({ MountPoint: 'D:' }), {
    MountPoint: 'D:',
  });
  for (const Bad of [
    { MountPoint: '' },
    { MountPoint: '/', MinFreePercent: 100 },
    { MountPoint: '/', MinFreePercent: 2.5 },
    { MountPoint: '/', MinFreeGB: 0 },
    { MountPoint: '/', MinFreeGB: '' },
    { MountPoint: '/', RequireHealthy: 'yes' },
  ]) {
    assert.throws(() => IPCValidation.CriticalStorageVolumePayload(Bad));
  }
});

// --- Through the ClientManager ----------------------------------------------------

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-storage-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: () => {} } },
      '../SettingsManager': { Manager: { GetValue: async () => undefined } },
    }
  );
  return { Manager: clientManager.Manager };
}

function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

test('monitoring a volume persists its conditions and survives a restart', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetStorageVolumes('c1', snapshot());

  assert.deepEqual(
    await Manager.MarkStorageVolumeCritical('c1', { MountPoint: '/Volumes/Media' }),
    [null, true]
  );
  assert.equal(client.CriticalStorageVolumes[0].MinFreePercent, 10);
  assert.equal(client.Degraded, false);
  assert.deepEqual(
    await Manager.MarkStorageVolumeCritical('c1', {
      MountPoint: '/Volumes/Media',
      MinFreeGB: 500,
      RequireHealthy: false,
    }),
    [null, false]
  );

  await Manager.ClearCache();
  await Manager.Init();
  const [, again] = await Manager.Get('c1');
  assert.equal(again.CriticalStorageVolumes.length, 1);
  assert.deepEqual(
    {
      MinFreePercent: again.CriticalStorageVolumes[0].MinFreePercent,
      MinFreeGB: again.CriticalStorageVolumes[0].MinFreeGB,
      RequireWritable: again.CriticalStorageVolumes[0].RequireWritable,
      RequireHealthy: again.CriticalStorageVolumes[0].RequireHealthy,
      Name: again.CriticalStorageVolumes[0].Name,
    },
    {
      MinFreePercent: 10,
      MinFreeGB: 500,
      RequireWritable: true,
      RequireHealthy: false,
      Name: 'Media',
    }
  );
});

test('low space, read-only and unmounting degrade the client; recovery clears it', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetStorageVolumes('c1', snapshot());
  await Manager.MarkStorageVolumeCritical('c1', { MountPoint: '/Volumes/Media' });

  await Manager.SetStorageVolumes('c1', snapshot([volume({ FreeBytes: 50 * GB })]));
  assert.deepEqual(client.DegradedWarnings, ['Low Disk Space']);

  await Manager.SetStorageVolumes('c1', snapshot([volume({ ReadOnly: true })]));
  assert.deepEqual(client.DegradedWarnings, ['Storage Volume Read-Only']);

  await Manager.SetStorageVolumes('c1', snapshot([]));
  assert.deepEqual(client.DegradedWarnings, ['Missing Storage Volume']);
  assert.equal(client.MissingCriticalStorageVolumes.length, 1);

  await Manager.SetStorageVolumes('c1', snapshot());
  assert.equal(client.Degraded, false);
});

test('a failed or unsupported report, or going offline, judges nothing', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetStorageVolumes('c1', snapshot());
  await Manager.MarkStorageVolumeCritical('c1', { MountPoint: '/Volumes/Media' });

  await Manager.SetStorageVolumes('c1', snapshot([], 'error'));
  assert.equal(client.HasStorageTelemetry, false);
  assert.equal(client.Degraded, false);

  await Manager.SetStorageVolumes('c1', snapshot([]));
  assert.equal(client.Degraded, true);
  client.SetOnline(false);
  markStarted(client);
  assert.equal(client.HasStorageTelemetry, false);
  assert.equal(client.Degraded, false);
});

test('a volume never reported cannot be monitored; unmonitoring clears its fault', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetStorageVolumes('c1', snapshot());
  const [Err] = await Manager.MarkStorageVolumeCritical('c1', { MountPoint: '/Volumes/Other' });
  assert.match(Err, /not mounted/);

  await Manager.MarkStorageVolumeCritical('c1', { MountPoint: '/Volumes/Media' });
  await Manager.SetStorageVolumes('c1', snapshot([]));
  assert.equal(client.Degraded, true);
  assert.deepEqual(await Manager.RemoveStorageVolumeCritical('c1', '/Volumes/Media'), [null, true]);
  assert.equal(client.Degraded, false);
  assert.deepEqual(client.CriticalStorageVolumes, []);
});

// --- History and audit ------------------------------------------------------------

function viewOf(Volumes, Criticals, Online = true) {
  const Result = Storage.buildStorageView(
    Storage.normalizeStorageSnapshot(snapshot(Volumes)),
    Criticals,
    true
  );
  return { UUID: 'storage-history', Online, StorageStatus: Result.View };
}

test('each monitored volume gets a timeline: mounted, failing, missing', () => {
  const Now = Date.now();
  History.recordClientStorageHistorySamples(viewOf([volume()], [monitored()]), Now);
  History.recordClientStorageHistorySamples(
    viewOf([volume({ FreeBytes: 1 * GB })], [monitored()]),
    Now + 1000
  );
  History.recordClientStorageHistorySamples(viewOf([], [monitored()]), Now + 2000);
  // Offline leaves a gap rather than painting the volume as gone.
  History.recordClientStorageHistorySamples(viewOf([], [monitored()], false), Now + 3000);

  const [Series] = History.getClientStorageHistorySamples('storage-history').filter(
    (Entry) => Entry.MountPoint === '/Volumes/Media'
  );
  assert.equal(Series.Name, 'Media');
  assert.deepEqual(
    Series.samples.map((Sample) => [Sample.online, Sample.degraded]),
    [
      [true, false],
      [true, true],
      [false, false],
    ]
  );
});

test('the audit log names the broken condition, not the reading, so a filling disk logs once', () => {
  const Snapshots = [40, 9, 8, 7, 40].map((FreeGB) => {
    const View = viewOf([volume({ FreeBytes: FreeGB * 10 * GB })], [monitored()]);
    return {
      UUID: 'c-1',
      Nickname: 'RECORDER',
      Online: true,
      Initialising: false,
      HasStorageTelemetry: true,
      StorageStatus: View.StorageStatus,
      ResourceAlarms: [],
    };
  });
  let State;
  const Lines = Snapshots.map((Snapshot) => {
    const Result = DiffClientStatus(State, Snapshot);
    State = Result.State;
    return Result.Entries.map((Entry) => Entry.Summary.map((Segment) => Segment.T).join(''));
  });
  assert.deepEqual(Lines, [
    ['RECORDER Connected'],
    ['Media: Free space below 10%'],
    [],
    [],
    ['Media back to normal'],
  ]);
});
