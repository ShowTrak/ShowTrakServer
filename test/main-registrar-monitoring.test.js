const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/monitoring.ts — monitoring targets/methods plus
// the six history readers.
//
// The theme here is the reader contract's EMPTY FALLBACK, and the fact that it
// differs by return type: the history readers fall back to `[]` while the
// single-object readers fall back to `null`. Getting one wrong hands the
// renderer a value of the wrong shape, which it will happily try to iterate or
// dereference. Every reader is checked for both the invalid-input path and the
// manager-error path.
//
// Real IPCValidation runs; only the managers and Electron are stubbed.

const state = {
  methods: [{ Key: 'PING' }],
  getAll: [null, [{ MonitoringTargetID: 1 }]],
  get: [null, { MonitoringTargetID: 1, Nickname: 'Projector' }],
  checkDebug: [null, { LastResult: 'ok' }],
  runCheckNow: [null, { LastResult: 'ok' }],
  runAllChecksNow: [null, { MonitoringTargetID: 1 }],
  create: [null, { MonitoringTargetID: 9 }],
  update: [null, true],
  del: [null, true],
  history: {
    check: [{ At: 1 }],
    dummy: [{ At: 2 }],
    client: [{ At: 3 }],
    application: [{ At: 4 }],
    usb: [{ At: 5 }],
    display: [{ At: 6 }],
  },
};

const historyCalls = [];
const monitoringHistoryStub = {
  getMonitoringCheckHistory: (id) => {
    historyCalls.push(['check', id]);
    return state.history.check;
  },
  getDummyHistorySamples: (id) => {
    historyCalls.push(['dummy', id]);
    return state.history.dummy;
  },
  getClientHistorySamples: (id) => {
    historyCalls.push(['client', id]);
    return state.history.client;
  },
  getClientApplicationHistorySamples: (id) => {
    historyCalls.push(['application', id]);
    return state.history.application;
  },
  getClientUSBHistorySamples: (id) => {
    historyCalls.push(['usb', id]);
    return state.history.usb;
  },
  getClientDisplayHistorySamples: (id) => {
    historyCalls.push(['display', id]);
    return state.history.display;
  },
};

const methodsMgr = recordingManager({ GetAll: () => state.methods });
const targetMgr = recordingManager({
  GetAll: () => state.getAll,
  Get: () => state.get,
  GetCheckDebug: () => state.checkDebug,
  RunCheckNow: () => state.runCheckNow,
  RunAllChecksNow: () => state.runAllChecksNow,
  Create: () => state.create,
  Update: () => state.update,
  Delete: () => state.del,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('../monitoring-history'), value: monitoringHistoryStub },
  { match: matchesModule('/Modules/MonitoringMethods'), value: { Manager: methodsMgr } },
  { match: matchesModule('/Modules/MonitoringTargetManager'), value: { Manager: targetMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/monitoring');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.getAll = [null, [{ MonitoringTargetID: 1 }]];
  state.get = [null, { MonitoringTargetID: 1, Nickname: 'Projector' }];
  state.checkDebug = [null, { LastResult: 'ok' }];
  state.runCheckNow = [null, { LastResult: 'ok' }];
  state.runAllChecksNow = [null, { MonitoringTargetID: 1 }];
  state.create = [null, { MonitoringTargetID: 9 }];
  state.update = [null, true];
  state.del = [null, true];
  historyCalls.length = 0;
  for (const M of [methodsMgr, targetMgr]) M.__calls.length = 0;
});

test('registers a handler for every monitoring channel', () => {
  for (const Channel of [
    'GetMonitoringMethods',
    'GetAllMonitoringTargets',
    'GetMonitoringTarget',
    'GetMonitoringCheckHistory',
    'GetMonitoringCheckDebug',
    'RunMonitoringCheckNow',
    'RunAllMonitoringChecksNow',
    'GetDummyClientHistory',
    'GetClientHistory',
    'GetClientApplicationHistory',
    'GetClientUSBHistory',
    'GetClientDisplayHistory',
    'CreateMonitoringTarget',
    'UpdateMonitoringTarget',
    'DeleteMonitoringTarget',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- List / object readers --------------------------------------------------

test('GetMonitoringMethods passes the method catalogue through', async () => {
  assert.deepEqual(await GetHandler('GetMonitoringMethods')(null), [{ Key: 'PING' }]);
});

test('GetAllMonitoringTargets returns the list, and [] on error or empty', async () => {
  const Handler = GetHandler('GetAllMonitoringTargets');
  assert.deepEqual(await Handler(null), [{ MonitoringTargetID: 1 }]);

  state.getAll = ['db exploded', null];
  assert.deepEqual(await Handler(null), []);

  state.getAll = [null, null];
  assert.deepEqual(await Handler(null), []);
});

test('GetMonitoringTarget returns the target, or null for bad input / a miss', async () => {
  const Handler = GetHandler('GetMonitoringTarget');
  assert.deepEqual(await Handler(null, 1), { MonitoringTargetID: 1, Nickname: 'Projector' });

  for (const Bad of [0, -1, 'abc', null, undefined]) {
    assert.equal(await Handler(null, Bad), null, `expected null for ${JSON.stringify(Bad)}`);
  }
  assert.equal(targetMgr.__callsTo('Get').length, 1);

  state.get = ['not found', null];
  assert.equal(await Handler(null, 1), null);
});

test('GetMonitoringCheckDebug and RunMonitoringCheckNow fall back to null', async () => {
  for (const [Channel, Key] of [
    ['GetMonitoringCheckDebug', 'checkDebug'],
    ['RunMonitoringCheckNow', 'runCheckNow'],
  ]) {
    const Handler = GetHandler(Channel);
    assert.deepEqual(await Handler(null, 1), { LastResult: 'ok' });
    assert.equal(await Handler(null, 'abc'), null);
    state[Key] = ['check no longer exists', null];
    assert.equal(await Handler(null, 1), null);
  }
});

test('RunAllMonitoringChecksNow returns the refreshed target or null', async () => {
  const Handler = GetHandler('RunAllMonitoringChecksNow');
  assert.deepEqual(await Handler(null, 1), { MonitoringTargetID: 1 });
  assert.equal(await Handler(null, null), null);

  state.runAllChecksNow = ['target gone', null];
  assert.equal(await Handler(null, 1), null);
});

// --- History readers: all six fall back to an empty LIST --------------------

test('every history reader returns its samples for valid input', async () => {
  assert.deepEqual(await GetHandler('GetMonitoringCheckHistory')(null, 1), [{ At: 1 }]);
  assert.deepEqual(await GetHandler('GetDummyClientHistory')(null, 'dummy-1'), [{ At: 2 }]);
  assert.deepEqual(await GetHandler('GetClientHistory')(null, 'client-1'), [{ At: 3 }]);
  assert.deepEqual(await GetHandler('GetClientApplicationHistory')(null, 'client-1'), [{ At: 4 }]);
  assert.deepEqual(await GetHandler('GetClientUSBHistory')(null, 'client-1'), [{ At: 5 }]);
  assert.deepEqual(await GetHandler('GetClientDisplayHistory')(null, 'client-1'), [{ At: 6 }]);

  assert.deepEqual(historyCalls, [
    ['check', 1],
    ['dummy', 'dummy-1'],
    ['client', 'client-1'],
    ['application', 'client-1'],
    ['usb', 'client-1'],
    ['display', 'client-1'],
  ]);
});

test('every history reader falls back to [] on invalid input, never null', async () => {
  // The renderer charts these directly; a null would throw where an empty
  // series just draws nothing.
  for (const Channel of [
    'GetMonitoringCheckHistory',
    'GetDummyClientHistory',
    'GetClientHistory',
    'GetClientApplicationHistory',
    'GetClientUSBHistory',
    'GetClientDisplayHistory',
  ]) {
    const Handler = GetHandler(Channel);
    for (const Bad of ['', null, undefined]) {
      assert.deepEqual(
        await Handler(null, Bad),
        [],
        `${Channel} should return [] for ${JSON.stringify(Bad)}`
      );
    }
  }
  assert.deepEqual(historyCalls, [], 'no history lookup should have been attempted');
});

test('the check-history reader labels its field as CheckID, not TargetID', async () => {
  // Shared validator, distinct field name — the message the renderer shows
  // should name the thing the user actually selected.
  await GetHandler('GetMonitoringCheckHistory')(null, 1);
  assert.deepEqual(historyCalls, [['check', 1]]);
});

// --- Mutations --------------------------------------------------------------

/** The minimum payload MonitoringTargetCreatePayload accepts. */
function validTargetPayload(overrides = {}) {
  return { Nickname: 'Projector', Interval: 5000, Checks: [], ...overrides };
}

test('CreateMonitoringTarget normalizes the payload then delegates', async () => {
  const [Err, Data] = await GetHandler('CreateMonitoringTarget')(null, validTargetPayload());
  assert.equal(Err, null);
  assert.deepEqual(Data, { MonitoringTargetID: 9 });

  const Sent = targetMgr.__callsTo('Create')[0].args[0];
  assert.equal(Sent.Nickname, 'Projector');
  assert.equal(Sent.Interval, 5000);
  // GroupID defaults to null (ungrouped) rather than being left absent.
  assert.equal(Sent.GroupID, null);
  assert.deepEqual(Sent.Checks, []);
});

test('CreateMonitoringTarget requires a nickname and an interval', async () => {
  const Handler = GetHandler('CreateMonitoringTarget');

  const [NoNick] = await Handler(null, validTargetPayload({ Nickname: '' }));
  assert.match(NoNick, /Nickname/i);

  const [NoInterval] = await Handler(null, validTargetPayload({ Interval: undefined }));
  assert.match(NoInterval, /Interval is required/i);

  const [BadInterval] = await Handler(null, validTargetPayload({ Interval: 'soon' }));
  assert.match(BadInterval, /Interval must be a number/i);

  const [NotObject] = await Handler(null, 'nope');
  assert.match(NotObject, /must be an object/i);

  assert.equal(targetMgr.__callsTo('Create').length, 0);
});

test('CreateMonitoringTarget reports a manager failure', async () => {
  state.create = ['nickname already used', null];
  assert.deepEqual(await GetHandler('CreateMonitoringTarget')(null, validTargetPayload()), [
    'nickname already used',
    null,
  ]);
});

test('UpdateMonitoringTarget validates the id and applies a partial payload', async () => {
  const Handler = GetHandler('UpdateMonitoringTarget');

  assert.deepEqual(await Handler(null, 1, { Nickname: 'Renamed' }), [null, true]);
  const [SentID, SentPayload] = targetMgr.__callsTo('Update')[0].args;
  assert.equal(SentID, 1);
  assert.deepEqual(Object.keys(SentPayload), ['Nickname']);

  targetMgr.__calls.length = 0;
  const [Err] = await Handler(null, 'nope', { Nickname: 'Renamed' });
  assert.equal(typeof Err, 'string');
  assert.equal(targetMgr.__callsTo('Update').length, 0);
});

test('DeleteMonitoringTarget validates the id and reports failure', async () => {
  const Handler = GetHandler('DeleteMonitoringTarget');
  assert.deepEqual(await Handler(null, 1), [null, true]);

  targetMgr.__calls.length = 0;
  const [Err] = await Handler(null, 0);
  assert.equal(typeof Err, 'string');
  assert.equal(targetMgr.__callsTo('Delete').length, 0);

  state.del = ['referenced by an alert rule', null];
  assert.deepEqual(await Handler(null, 1), ['referenced by an alert rule', null]);
});
