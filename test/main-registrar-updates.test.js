const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/updates.ts — client software updates.
//
// `UpdateManager:DeployRelease` is the most consequential handler in the whole
// registrar layer: it pushes a new build out to real machines over the LAN. It
// carries a stack of guards (a release must be downloaded, the requested tag
// must BE the downloaded one, targets must be valid UUIDs, and clients already
// on that version or currently offline are filtered out) and every one of them
// exists to stop a bad rollout. They are tested individually here.
//
// The real `normalizeVersionToken` from local-scripts is used deliberately —
// the "is this client already on this version" comparison is the logic under
// test, so stubbing it would hollow out the interesting case.

const pushes = [];

const state = {
  status: { Ready: true, ReleaseVersion: 'v3.14.0', FeedPath: '/feed/3.14.0' },
  statusThrows: false,
  releases: [{ Tag: 'v3.14.0' }],
  releasesThrow: false,
  download: { Tag: 'v3.14.0', Ready: true },
  downloadThrows: false,
  clients: [null, []],
  hasWindow: true,
};

const updateMgr = recordingManager({
  GetStatus: async () => {
    if (state.statusThrows) throw new Error('status unavailable');
    return state.status;
  },
  ListReleases: async () => {
    if (state.releasesThrow) throw new Error('github unreachable');
    return state.releases;
  },
  DownloadRelease: async () => {
    if (state.downloadThrows) throw new Error('download failed');
    return state.download;
  },
});
const clientMgr = recordingManager({ GetAll: () => state.clients });
const serverMgr = recordingManager({ ExecuteBulkRequest: () => undefined });
const appUpdater = recordingManager({ Register: () => undefined });

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('../renderer-bus'),
    value: { PushToRenderers: (...args) => pushes.push(args) },
  },
  {
    match: matchesModule('../app-window'),
    value: { getMainWindow: () => ({}), hasMainWindow: () => state.hasWindow },
  },
  { match: matchesModule('../app-updater'), value: { Manager: appUpdater } },
  { match: matchesModule('/Modules/UpdateManager'), value: { Manager: updateMgr } },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/updates');
const { GetHandler } = require('../dist/main/handler-registry');
register();

/** A client record as ClientManager.GetAll would return it. */
function client(UUID, { Online = true, Version = 'v3.13.0' } = {}) {
  return { UUID, Online, Version };
}

test.beforeEach(() => {
  state.status = { Ready: true, ReleaseVersion: 'v3.14.0', FeedPath: '/feed/3.14.0' };
  state.statusThrows = false;
  state.releases = [{ Tag: 'v3.14.0' }];
  state.releasesThrow = false;
  state.download = { Tag: 'v3.14.0', Ready: true };
  state.downloadThrows = false;
  state.clients = [null, []];
  state.hasWindow = true;
  pushes.length = 0;
  for (const M of [updateMgr, clientMgr, serverMgr]) M.__calls.length = 0;
});

test('wires the AppUpdater module and registers every updates channel', () => {
  assert.equal(appUpdater.__callsTo('Register').length, 1);
  for (const Channel of [
    'CheckForUpdatesOnClient',
    'UpdateManager:GetStatus',
    'UpdateManager:GetReleases',
    'UpdateManager:DownloadRelease',
    'UpdateManager:DeployRelease',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- CheckForUpdatesOnClient ------------------------------------------------

test('CheckForUpdatesOnClient asks one client to check', async () => {
  assert.deepEqual(await GetHandler('CheckForUpdatesOnClient')(null, 'client-uuid-1'), [
    null,
    true,
  ]);
  assert.deepEqual(serverMgr.__callsTo('ExecuteBulkRequest')[0].args, [
    'UpdateSoftware',
    ['client-uuid-1'],
    'Check For Software Updates',
  ]);
});

test('CheckForUpdatesOnClient rejects an invalid UUID before dispatching', async () => {
  const [Err, Data] = await GetHandler('CheckForUpdatesOnClient')(null, '');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

// --- Status / releases / download -------------------------------------------

test('UpdateManager:GetStatus and GetReleases wrap their values in a tuple', async () => {
  assert.deepEqual(await GetHandler('UpdateManager:GetStatus')(null), [null, state.status]);
  assert.deepEqual(await GetHandler('UpdateManager:GetReleases')(null), [
    null,
    [{ Tag: 'v3.14.0' }],
  ]);
});

test('UpdateManager:GetStatus and GetReleases convert a throw into an error tuple', async () => {
  state.statusThrows = true;
  const [StatusErr] = await GetHandler('UpdateManager:GetStatus')(null);
  assert.match(StatusErr, /status unavailable/);

  state.releasesThrow = true;
  const [ReleasesErr] = await GetHandler('UpdateManager:GetReleases')(null);
  assert.match(ReleasesErr, /github unreachable/);
});

test('UpdateManager:DownloadRelease forwards progress to the renderers', async () => {
  const Result = await GetHandler('UpdateManager:DownloadRelease')(null, 'v3.14.0');
  assert.deepEqual(Result, [null, { Tag: 'v3.14.0', Ready: true }]);

  const Options = updateMgr.__callsTo('DownloadRelease')[0].args[1];
  Options.onProgress({ Percent: 42 });
  assert.deepEqual(pushes, [['UpdateManager:DownloadProgress', { Percent: 42 }]]);
});

test('UpdateManager:DownloadRelease drops progress when there is no window', async () => {
  await GetHandler('UpdateManager:DownloadRelease')(null, 'v3.14.0');
  const Options = updateMgr.__callsTo('DownloadRelease')[0].args[1];
  state.hasWindow = false;
  Options.onProgress({ Percent: 42 });
  assert.deepEqual(pushes, []);
});

test('a failing progress push never aborts the download', async () => {
  // Progress is cosmetic; losing the window mid-download must not kill a
  // long-running transfer.
  await GetHandler('UpdateManager:DownloadRelease')(null, 'v3.14.0');
  const Options = updateMgr.__callsTo('DownloadRelease')[0].args[1];
  state.hasWindow = true;
  const Original = pushes.push;
  pushes.push = () => {
    throw new Error('renderer gone');
  };
  try {
    assert.doesNotThrow(() => Options.onProgress({ Percent: 42 }));
  } finally {
    pushes.push = Original;
  }
});

test('UpdateManager:DownloadRelease converts a throw into an error tuple', async () => {
  state.downloadThrows = true;
  const [Err] = await GetHandler('UpdateManager:DownloadRelease')(null, 'v3.14.0');
  assert.match(Err, /download failed/);
});

// --- UpdateManager:DeployRelease: the guards -------------------------------

test('DeployRelease refuses when no build has been downloaded', async () => {
  const Handler = GetHandler('UpdateManager:DeployRelease');

  for (const Status of [null, { Ready: false, ReleaseVersion: 'v3.14.0' }, { Ready: true }]) {
    state.status = Status;
    assert.deepEqual(await Handler(null, 'v3.14.0', ['client-uuid-1']), [
      'Download a release build before deploying',
      null,
    ]);
  }
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

test('DeployRelease refuses without a selected tag', async () => {
  const Handler = GetHandler('UpdateManager:DeployRelease');
  for (const Tag of ['', '   ', null, undefined]) {
    assert.deepEqual(await Handler(null, Tag, ['client-uuid-1']), [
      'Select a release to deploy',
      null,
    ]);
  }
});

test('DeployRelease refuses to deploy a tag other than the downloaded one', async () => {
  // The build on disk is v3.14.0; asking for v3.15.0 must not silently ship
  // the wrong binary.
  assert.deepEqual(
    await GetHandler('UpdateManager:DeployRelease')(null, 'v3.15.0', ['client-uuid-1']),
    ['Selected release is not downloaded yet', null]
  );
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

test('DeployRelease refuses an empty or non-array target list', async () => {
  const Handler = GetHandler('UpdateManager:DeployRelease');
  for (const Targets of [[], null, undefined, 'client-uuid-1']) {
    assert.deepEqual(await Handler(null, 'v3.14.0', Targets), [
      'Select at least one client for deployment',
      null,
    ]);
  }
});

test('DeployRelease rejects malformed UUIDs in the target list', async () => {
  const [Err, Data] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', ['']);
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

test('DeployRelease surfaces a client-lookup failure', async () => {
  state.clients = ['db exploded', null];
  assert.deepEqual(
    await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', ['client-uuid-1']),
    ['db exploded', null]
  );
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

// --- UpdateManager:DeployRelease: eligibility filtering --------------------

test('DeployRelease skips offline clients', async () => {
  state.clients = [
    null,
    [client('client-uuid-1', { Online: true }), client('client-uuid-2', { Online: false })],
  ];
  const [Err, Result] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
    'client-uuid-1',
    'client-uuid-2',
  ]);

  assert.equal(Err, null);
  assert.equal(Result.TargetCount, 1);
  assert.equal(Result.SelectedCount, 2);
  assert.deepEqual(serverMgr.__callsTo('ExecuteBulkRequest')[0].args[1], ['client-uuid-1']);
});

test('DeployRelease skips clients already running the selected version', async () => {
  // Re-pushing the same build would restart a machine for nothing, mid-show.
  state.clients = [
    null,
    [
      client('client-uuid-1', { Version: 'v3.14.0' }),
      client('client-uuid-2', { Version: 'v3.13.0' }),
    ],
  ];
  const [, Result] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
    'client-uuid-1',
    'client-uuid-2',
  ]);
  assert.deepEqual(serverMgr.__callsTo('ExecuteBulkRequest')[0].args[1], ['client-uuid-2']);
  assert.equal(Result.TargetCount, 1);
});

test('DeployRelease compares versions ignoring the v prefix and case', async () => {
  // The tag is "v3.14.0" but a client may report "3.14.0" or "V3.14.0"; all
  // three are the same build and none should be redeployed.
  state.clients = [
    null,
    [
      client('client-uuid-1', { Version: '3.14.0' }),
      client('client-uuid-2', { Version: 'V3.14.0' }),
      client('client-uuid-3', { Version: ' 3.14.0 ' }),
    ],
  ];
  assert.deepEqual(
    await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
      'client-uuid-1',
      'client-uuid-2',
      'client-uuid-3',
    ]),
    ['No selected clients are eligible for deployment', null]
  );
  assert.equal(serverMgr.__callsTo('ExecuteBulkRequest').length, 0);
});

test('DeployRelease ignores selected UUIDs that are not known clients', async () => {
  state.clients = [null, [client('client-uuid-1')]];
  const [, Result] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
    'client-uuid-1',
    'client-uuid-ghost',
  ]);
  assert.deepEqual(serverMgr.__callsTo('ExecuteBulkRequest')[0].args[1], ['client-uuid-1']);
  assert.equal(Result.SelectedCount, 2);
  assert.equal(Result.TotalClientCount, 1);
});

test('DeployRelease reports when nothing survives the eligibility filter', async () => {
  state.clients = [null, [client('client-uuid-1', { Online: false })]];
  assert.deepEqual(
    await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', ['client-uuid-1']),
    ['No selected clients are eligible for deployment', null]
  );
});

// --- UpdateManager:DeployRelease: the happy path ---------------------------

test('DeployRelease dispatches the LAN update with the feed path and version', async () => {
  state.clients = [
    null,
    [client('client-uuid-1'), client('client-uuid-2'), client('client-uuid-3')],
  ];
  const [Err, Result] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
    'client-uuid-1',
    'client-uuid-2',
  ]);

  assert.equal(Err, null);
  assert.deepEqual(Result, {
    ReleaseVersion: 'v3.14.0',
    TargetCount: 2,
    SelectedCount: 2,
    TotalClientCount: 3,
    FeedPath: '/feed/3.14.0',
  });

  const [Command, Targets, Label, Options] = serverMgr.__callsTo('ExecuteBulkRequest')[0].args;
  assert.equal(Command, 'UpdateSoftwareFromLAN');
  assert.deepEqual(Targets, ['client-uuid-1', 'client-uuid-2']);
  assert.equal(Label, 'Updating Client Software');
  // resetQueue:false — a rollout must not wipe work already queued for these
  // clients. The payload carries the RELATIVE FeedPath (the client resolves it
  // to an absolute FeedURL itself).
  assert.deepEqual(Options, {
    resetQueue: false,
    payload: { FeedPath: '/feed/3.14.0', ReleaseVersion: 'v3.14.0' },
  });
});

test('DeployRelease ignores client records with no UUID', async () => {
  state.clients = [null, [null, { Online: true }, client('client-uuid-1')]];
  const [, Result] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', [
    'client-uuid-1',
  ]);
  assert.equal(Result.TotalClientCount, 1);
});

test('DeployRelease converts an unexpected throw into an error tuple', async () => {
  state.statusThrows = true;
  const [Err] = await GetHandler('UpdateManager:DeployRelease')(null, 'v3.14.0', ['client-uuid-1']);
  assert.match(Err, /status unavailable/);
});
