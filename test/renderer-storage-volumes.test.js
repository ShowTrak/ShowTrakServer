const test = require('node:test');
const assert = require('node:assert/strict');

// The Storage tab of the client info modal. lib/storage-volumes.ts holds the
// decisions (section state, card wording, the usage bar, the conditions table
// and turning it back into a request) and is tested directly.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/storage-volumes.js');

const GB = 1024 ** 3;

function view(overrides = {}) {
  return {
    MountPoint: '/Volumes/Media',
    Name: 'Media',
    FileSystem: 'apfs',
    Kind: 'external',
    TotalBytes: 2000 * GB,
    FreeBytes: 500 * GB,
    ReadOnly: false,
    Health: 'ok',
    IsConnected: true,
    IsCritical: false,
    Missing: false,
    Issues: [],
    Critical: null,
    ...overrides,
  };
}

const CRITICAL = {
  MountPoint: '/Volumes/Media',
  Name: 'Media',
  RequirePresent: true,
  MinFreePercent: 10,
  MinFreeGB: null,
  RequireWritable: true,
  RequireHealthy: false,
  Timestamp: 1,
};

function client(overrides = {}) {
  return {
    UUID: 'c1',
    Online: true,
    Version: '3.28.0',
    StorageStatus: {
      SampledAt: 1,
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'df+diskutil' },
      Volumes: [view()],
    },
    ...overrides,
  };
}

test('section state: an old client that never reported is unsupported; one that did is shown', () => {
  assert.equal(Lib.GetStorageSectionState(client()), 'ok');
  assert.equal(
    Lib.GetStorageSectionState(client({ Version: '3.27.1', StorageStatus: undefined })),
    'outdated'
  );
  // A development build reporting an older version number is still believed.
  assert.equal(Lib.GetStorageSectionState(client({ Version: '3.27.1' })), 'ok');
  assert.equal(
    Lib.GetStorageSectionState(
      client({ StorageStatus: { SampledAt: null, Status: null, Volumes: [] } })
    ),
    'waiting'
  );
  assert.equal(Lib.GetStorageSectionState(client({ Online: false })), 'offline');
  const Unsupported = client({
    StorageStatus: {
      SampledAt: 1,
      Status: { State: 'unsupported', Message: 'Nope', Platform: 'aix', Backend: null },
      Volumes: [],
    },
  });
  assert.equal(Lib.GetStorageSectionState(Unsupported), 'unsupported');
  assert.equal(Lib.StorageSectionMessage('unsupported', Unsupported).Body, 'Nope');
  assert.match(
    Lib.StorageSectionMessage('outdated', client({ Version: '3.27.1' })).Body,
    /needs ShowTrak Client 3\.28\.0 or later — this client runs 3\.27\.1/
  );
});

test('card wording: label as title, mount point and details as subtitle, usage as a bar', () => {
  assert.equal(Lib.StorageVolumeTitle(view()), 'Media');
  assert.equal(Lib.StorageVolumeSummary(view()), '/Volumes/Media · apfs · External · 1.9 TB');
  assert.equal(Lib.StorageVolumeTitle(view({ Name: null })), '/Volumes/Media');
  assert.equal(Lib.StorageVolumeSummary(view({ Name: null, Kind: 'unknown' })), 'apfs · 1.9 TB');
  assert.equal(
    Lib.StorageVolumeSummary(
      view({ IsConnected: false, Missing: true, Name: null, Critical: CRITICAL })
    ),
    '/Volumes/Media · Not mounted'
  );
  assert.deepEqual(Lib.StorageUsage(view()), {
    UsedPercent: 75,
    Text: '500 GB free of 1.9 TB',
    Low: false,
  });
  assert.equal(
    Lib.StorageUsage(view({ Issues: [{ Kind: 'free_space', Message: 'x' }] })).Low,
    true
  );
  assert.equal(Lib.StorageUsage(view({ IsConnected: false })), null);
});

test('badge follows the volume: Monitor, Monitored, Alarm, Missing', () => {
  assert.equal(Lib.StorageVolumeBadge(view()).Label, 'Monitor');
  assert.equal(
    Lib.StorageVolumeBadge(view({ IsCritical: true, Critical: CRITICAL })).Label,
    'Monitored'
  );
  assert.equal(
    Lib.StorageVolumeBadge(
      view({ IsCritical: true, Critical: CRITICAL, Issues: [{ Kind: 'read_only', Message: 'x' }] })
    ).Label,
    'Alarm'
  );
  assert.equal(
    Lib.StorageVolumeBadge(
      view({ IsCritical: true, Critical: CRITICAL, IsConnected: false, Missing: true })
    ).State,
    'missing'
  );
});

test('conditions: presence locked on, limits as inputs, what the volume cannot report unsupported', () => {
  const Rows = Lib.StorageConditionRows(
    view({
      IsCritical: true,
      Critical: CRITICAL,
      Health: null,
      Issues: [{ Kind: 'free_percent', Message: '6% free' }],
    })
  );
  const By = Object.fromEntries(Rows.map((Row) => [Row.Field, Row]));
  assert.deepEqual(
    Rows.map((Row) => Row.Field),
    ['RequirePresent', 'MinFreePercent', 'MinFreeGB', 'RequireWritable', 'RequireHealthy']
  );
  assert.equal(By.RequirePresent.Locked, true);
  assert.equal(By.MinFreePercent.Input.Value, '10');
  assert.equal(By.MinFreePercent.Failing, '6% free');
  assert.equal(By.MinFreeGB.Checked, false);
  // A tenth of a 2 TB volume, capped at 50 GB.
  assert.equal(By.MinFreeGB.Input.Default, '50');
  assert.equal(By.RequireWritable.Value, 'Yes');
  assert.equal(By.RequireHealthy.Supported, false);
  assert.equal(By.RequireHealthy.Value, 'Unsupported');

  // A condition already set stays clearable even where it cannot be judged.
  const Set = Lib.StorageConditionRows(
    view({ IsCritical: true, Critical: { ...CRITICAL, RequireHealthy: true }, Health: null })
  );
  assert.equal(Set.find((Row) => Row.Field === 'RequireHealthy').Supported, true);
  assert.deepEqual(Lib.StorageConditionRows(view()), []);
  assert.equal(Lib.DefaultMinFreeGB(view({ TotalBytes: 32 * GB })), '3');
  assert.equal(Lib.DefaultMinFreeGB(view({ TotalBytes: 4 * GB })), '1');
});

test('the form becomes a request: blanks stop guarding, bad numbers are refused', () => {
  assert.deepEqual(
    Lib.ParseStorageRuleFields('/', {
      MinFreePercent: '15',
      MinFreeGB: '',
      RequireWritable: true,
    }),
    { Payload: { MountPoint: '/', MinFreePercent: 15, MinFreeGB: null, RequireWritable: true } }
  );
  assert.deepEqual(Lib.ParseStorageRuleFields('/', {}), { Payload: { MountPoint: '/' } });
  assert.match(Lib.ParseStorageRuleFields('/', { MinFreePercent: '100' }).Error, /1 to 99%/);
  assert.match(Lib.ParseStorageRuleFields('/', { MinFreeGB: '1.5' }).Error, /GB/);
});

test('timeline state: idle offline, red missing, orange failing, green with the free space', () => {
  const Monitored = view({ IsCritical: true, Critical: CRITICAL });
  assert.equal(Lib.StorageTimelineLiveState(Monitored, false).State, 'IDLE');
  assert.deepEqual(Lib.StorageTimelineLiveState(Monitored, true), {
    State: 'ONLINE',
    Label: '500 GB free of 1.9 TB',
  });
  assert.equal(
    Lib.StorageTimelineLiveState({ ...Monitored, IsConnected: false, Missing: true }, true).State,
    'OFFLINE'
  );
  assert.deepEqual(
    Lib.StorageTimelineLiveState(
      { ...Monitored, Issues: [{ Kind: 'read_only', Message: 'Mounted read-only' }] },
      true
    ),
    { State: 'DEGRADED', Label: 'Mounted read-only' }
  );
});

test('the render key ignores free space moving within a displayed step', () => {
  const A = Lib.StorageRenderKey(client(), 'ok');
  const Nudged = client();
  Nudged.StorageStatus.Volumes = [view({ FreeBytes: 500 * GB + 1024 })];
  assert.equal(Lib.StorageRenderKey(Nudged, 'ok'), A);
  const Moved = client();
  Moved.StorageStatus.Volumes = [view({ FreeBytes: 498 * GB })];
  assert.notEqual(Lib.StorageRenderKey(Moved, 'ok'), A);
});
