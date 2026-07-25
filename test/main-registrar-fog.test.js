const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/fog.ts — the FOG Project imaging integration.
//
// Two behaviours here are deliberate design decisions worth pinning:
//   1. FOG being unreachable is NOT an error for the readers. The client editor
//      and tasks panel must still open when the FOG server is down, showing the
//      last known state — so the readers hand back whatever the manager has.
//   2. Validation here is shape-only. Whether a task type is permitted, and
//      whether the client is linked to a host, is re-checked inside FogManager —
//      the renderer is never the authority on what may be imaged. Imaging a
//      machine is destructive, so that split matters.
//
// Real IPCValidation runs; only the managers and Electron are stubbed.

const state = {
  status: { Enabled: true, Healthy: false, Message: 'FOG unreachable' },
  testConnection: { Enabled: true, Healthy: true },
  hosts: [{ FogHostID: 3, Name: 'PC-01' }],
  taskTypes: [{ ID: 1, Name: 'Deploy' }],
  tasks: [{ FogTaskRecordID: 11 }],
  getHostLink: [null, { FogHostID: 3, FogHostName: 'PC-01' }],
  setHostLink: [null, undefined],
  scheduleTask: [null, undefined],
  cancelTask: [null, undefined],
  clearFinished: [null, undefined],
};

const fogMgr = recordingManager({
  GetStatus: () => state.status,
  TestConnection: () => state.testConnection,
  GetHosts: () => state.hosts,
  GetPermittedTaskTypes: () => state.taskTypes,
  GetTasks: () => state.tasks,
  GetHostLink: () => state.getHostLink,
  SetHostLink: () => state.setHostLink,
  ScheduleTask: () => state.scheduleTask,
  CancelTask: () => state.cancelTask,
  ClearFinishedTasks: () => state.clearFinished,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/FogManager'), value: { Manager: fogMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/fog');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.getHostLink = [null, { FogHostID: 3, FogHostName: 'PC-01' }];
  state.setHostLink = [null, undefined];
  state.scheduleTask = [null, undefined];
  state.cancelTask = [null, undefined];
  state.clearFinished = [null, undefined];
  fogMgr.__calls.length = 0;
});

test('registers a handler for every fog channel', () => {
  for (const Channel of [
    'Fog:GetStatus',
    'Fog:TestConnection',
    'Fog:GetHosts',
    'Fog:GetTaskTypes',
    'Fog:GetTasks',
    'Fog:GetHostLink',
    'Fog:SetHostLink',
    'Fog:ScheduleTask',
    'Fog:CancelTask',
    'Fog:ClearFinishedTasks',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Readers: an unreachable FOG server is not an error --------------------

test('Fog:GetStatus reports an unhealthy server rather than failing', async () => {
  const Result = await GetHandler('Fog:GetStatus')(null);
  assert.deepEqual(Result, { Enabled: true, Healthy: false, Message: 'FOG unreachable' });
});

test('Fog:TestConnection re-probes and returns the fresh status', async () => {
  assert.deepEqual(await GetHandler('Fog:TestConnection')(null), { Enabled: true, Healthy: true });
  assert.equal(fogMgr.__callsTo('TestConnection').length, 1);
});

test('Fog:GetHosts and Fog:GetTasks pass their lists straight through', async () => {
  assert.deepEqual(await GetHandler('Fog:GetHosts')(null), [{ FogHostID: 3, Name: 'PC-01' }]);
  assert.deepEqual(await GetHandler('Fog:GetTasks')(null), [{ FogTaskRecordID: 11 }]);
});

test('Fog:GetTaskTypes treats an empty permitted list as a valid answer', async () => {
  // Empty means "nothing may be scheduled", which is a real configuration, not
  // a failure to load.
  state.taskTypes = [];
  assert.deepEqual(await GetHandler('Fog:GetTaskTypes')(null), []);
  state.taskTypes = [{ ID: 1, Name: 'Deploy' }];
});

// --- Fog:GetHostLink / Fog:SetHostLink -------------------------------------

test('Fog:GetHostLink returns the link for a valid UUID', async () => {
  assert.deepEqual(await GetHandler('Fog:GetHostLink')(null, 'client-uuid-1'), [
    null,
    { FogHostID: 3, FogHostName: 'PC-01' },
  ]);
});

test('Fog:GetHostLink rejects an invalid UUID before the manager', async () => {
  const [Err, Data] = await GetHandler('Fog:GetHostLink')(null, '');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(fogMgr.__callsTo('GetHostLink').length, 0);
});

test('Fog:SetHostLink links a client to a host', async () => {
  const [Err] = await GetHandler('Fog:SetHostLink')(null, 'client-uuid-1', 3);
  assert.equal(Err, null);
  assert.deepEqual(fogMgr.__callsTo('SetHostLink')[0].args, ['client-uuid-1', 3]);
});

test('Fog:SetHostLink treats empty/zero/null as an explicit unlink, not an error', async () => {
  // Unlinking is a legitimate operation, which is why FogHostIDOrNull exists
  // separately from FogHostID.
  for (const Unlink of [null, undefined, '', 0, '0']) {
    fogMgr.__calls.length = 0;
    const [Err] = await GetHandler('Fog:SetHostLink')(null, 'client-uuid-1', Unlink);
    assert.equal(Err, null, `expected unlink to succeed for ${JSON.stringify(Unlink)}`);
    assert.deepEqual(fogMgr.__callsTo('SetHostLink')[0].args, ['client-uuid-1', null]);
  }
});

test('Fog:SetHostLink rejects a malformed host id with the false fallback', async () => {
  const Handler = GetHandler('Fog:SetHostLink');
  for (const Bad of [-1, 1.5, 'abc', {}]) {
    const [Err, Data] = await Handler(null, 'client-uuid-1', Bad);
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
    assert.equal(Data, false);
  }
  assert.equal(fogMgr.__callsTo('SetHostLink').length, 0);
});

// --- Fog:ScheduleTask -------------------------------------------------------

test('Fog:ScheduleTask forwards the validated triple', async () => {
  const [Err] = await GetHandler('Fog:ScheduleTask')(null, 'client-uuid-1', 1, 13);
  assert.equal(Err, null);
  assert.deepEqual(fogMgr.__callsTo('ScheduleTask')[0].args, ['client-uuid-1', 1, 13]);
});

test('Fog:ScheduleTask passes a null snapin for every task type but Single Snapin', async () => {
  for (const Omitted of [null, undefined, '']) {
    fogMgr.__calls.length = 0;
    await GetHandler('Fog:ScheduleTask')(null, 'client-uuid-1', 1, Omitted);
    assert.deepEqual(fogMgr.__callsTo('ScheduleTask')[0].args, ['client-uuid-1', 1, null]);
  }
});

test('Fog:ScheduleTask rejects a malformed task type before the manager', async () => {
  // Shape-only rejection. Permission is re-checked in the manager — this just
  // stops garbage arriving.
  const Handler = GetHandler('Fog:ScheduleTask');
  for (const Bad of [0, -1, 'abc', null, undefined]) {
    const [Err, Data] = await Handler(null, 'client-uuid-1', Bad, null);
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
    assert.equal(Data, false);
  }
  assert.equal(fogMgr.__callsTo('ScheduleTask').length, 0);
});

test('Fog:ScheduleTask surfaces a manager refusal', async () => {
  // The manager is the authority: it re-checks permission and host linkage.
  state.scheduleTask = ['Task type not permitted', null];
  assert.deepEqual(await GetHandler('Fog:ScheduleTask')(null, 'client-uuid-1', 1, null), [
    'Task type not permitted',
    null,
  ]);
});

// --- Fog:CancelTask / Fog:ClearFinishedTasks --------------------------------

test('Fog:CancelTask validates the record id', async () => {
  const Handler = GetHandler('Fog:CancelTask');

  const [Err] = await Handler(null, 11);
  assert.equal(Err, null);
  assert.deepEqual(fogMgr.__callsTo('CancelTask')[0].args, [11]);

  fogMgr.__calls.length = 0;
  const [BadErr, BadData] = await Handler(null, 'nope');
  assert.equal(typeof BadErr, 'string');
  assert.equal(BadData, false);
  assert.equal(fogMgr.__callsTo('CancelTask').length, 0);
});

test('Fog:CancelTask surfaces a manager refusal', async () => {
  state.cancelTask = ['Task already completed', null];
  assert.deepEqual(await GetHandler('Fog:CancelTask')(null, 11), ['Task already completed', null]);
});

test('Fog:ClearFinishedTasks takes no arguments and ignores any that are sent', async () => {
  // Which rows count as finished is decided by the repository, never by the
  // renderer — so there is deliberately nothing to validate.
  const [Err] = await GetHandler('Fog:ClearFinishedTasks')(null, 'ignored', 42);
  assert.equal(Err, null);
  assert.deepEqual(fogMgr.__callsTo('ClearFinishedTasks')[0].args, []);
});

test('Fog:ClearFinishedTasks surfaces a manager error', async () => {
  state.clearFinished = ['db locked', null];
  assert.deepEqual(await GetHandler('Fog:ClearFinishedTasks')(null), ['db locked', null]);
});
