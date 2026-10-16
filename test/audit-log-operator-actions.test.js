const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Operator actions reach the audit log whichever surface they come from. A
// script run and a Wake-on-LAN each have exactly one handler on the server
// (ExecuteScript, WakeOnLan): the desktop calls it over IPC, the Web UI and
// ShowTrak Remote through the rpc bridge, and the SDK through ControlService.
// So driving those handlers under each surface's source label, against the
// REAL audit log database, proves the line is written and names who asked.
//
// OSC and the HTTP API are not in the list on purpose: their WOL and script
// routes do not call these handlers, they broadcast OSCBulkAction and the
// desktop window replays it over IPC — so those runs are logged, but as
// "Desktop", and only while the window is open.

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const clients = new Map([
  [
    UUID_A,
    {
      UUID: UUID_A,
      Nickname: 'CONSOLE-01',
      Online: false,
      GetWakeableMacAddresses: () => ['AA:BB:CC:DD:EE:01'],
    },
  ],
  [
    UUID_B,
    {
      UUID: UUID_B,
      Nickname: 'CONSOLE-02',
      Online: false,
      GetWakeableMacAddresses: () => ['AA:BB:CC:DD:EE:02'],
    },
  ],
]);
const state = { dispatch: { failed: [] }, wakeFailures: new Set() };

const clientMgr = recordingManager({
  Get: (UUID) => [null, clients.get(UUID) || null],
});
const serverMgr = recordingManager({
  ExecuteScripts: () => state.dispatch,
  TriggerIntegratedEvent: () => state.dispatch,
  SendMessageByGroup: async () => {},
});
const scriptMgr = recordingManager({
  Get: () => ({ ID: 'restart-qlab', Name: 'Restart QLab' }),
});
const wolMgr = recordingManager({
  Wake: (Mac) => (state.wakeFailures.has(Mac) ? [`no route to ${Mac}`] : [null]),
});
let RequestCounter = 0;
const execMgr = recordingManager({
  ClearSettled: async () => {},
  AddInternalTaskToQueue: async () => `req-${++RequestCounter}`,
  Complete: async () => {},
});
const quiet = () => {};
const loggerStub = {
  CreateLogger: () => ({
    log: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    debug: quiet,
    success: quiet,
    database: quiet,
    databaseError: quiet,
  }),
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('electron'), value: { ipcMain: { handle() {} }, shell: {} } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/AdoptionManager'), value: { Manager: recordingManager() } },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
  { match: matchesModule('/Modules/AlertsManager'), value: { Manager: recordingManager() } },
  { match: matchesModule('/Modules/IdentifyManager'), value: { Manager: recordingManager() } },
  { match: matchesModule('/Modules/WOLManager'), value: { Manager: wolMgr } },
  { match: matchesModule('/Modules/ScriptExecutionManager'), value: { Manager: execMgr } },
  {
    match: matchesModule('/Modules/SettingsManager'),
    value: { Manager: recordingManager({ GetValue: () => false }) },
  },
  { match: matchesModule('/Modules/ScriptManager'), value: { Manager: scriptMgr } },
  {
    match: matchesModule('/Modules/ScriptWhitelistManager'),
    value: { Manager: recordingManager({ GetScope: () => null }) },
  },
  {
    match: matchesModule('/Modules/TagManager'),
    value: { Manager: recordingManager({ GetAllViews: () => [] }) },
  },
  { match: matchesModule('/Modules/SampleScripts'), value: { Manager: recordingManager() } },
  { match: matchesModule('../broadcast-bridge'), value: { UpdateFullClientList: async () => {} } },
  { match: matchesModule('../deployment'), value: { TriggerScriptDeployment: async () => {} } },
]);

const { Manager: AuditLog } = require('../dist/Modules/AuditLog');
const { RunWithAuditSource } = require('../dist/Modules/AuditLog/source');
const { GetHandler } = require('../dist/main/handler-registry');
require('../dist/main/registrars/clients').register();
require('../dist/main/registrars/scripts').register();

const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-audit-actions-'));
test.before(() => AuditLog.Start({ FilePath: path.join(Dir, 'AuditLog.sqlite') }));
test.after(async () => {
  await AuditLog.Shutdown();
  restore();
  fs.rmSync(Dir, { recursive: true, force: true });
});
test.beforeEach(() => {
  state.dispatch = { failed: [] };
  state.wakeFailures = new Set();
});

const Text = (Entry) => Entry.Summary.map((Segment) => Segment.T).join('');

async function Actions() {
  const { Entries } = await AuditLog.Query({ Category: 'action', Limit: 500 });
  return Entries;
}

async function NewActions(Before) {
  const Seen = new Set(Before.map((Entry) => Entry.ID));
  return (await Actions()).filter((Entry) => !Seen.has(Entry.ID)).reverse();
}

for (const Source of ['Desktop', 'Web UI (10.0.0.12)', 'ShowTrak Remote (Tom’s iPad)', 'SDK']) {
  test(`a script run from ${Source} is logged once per client, naming who ran it`, async () => {
    const Before = await Actions();
    const [Err] = await RunWithAuditSource(Source, () =>
      GetHandler('ExecuteScript')(null, 'restart-qlab', [UUID_A, UUID_B], true)
    );
    assert.equal(Err, null);
    const Logged = await NewActions(Before);
    assert.deepEqual(
      Logged.map((Entry) => [Entry.EntityName, Text(Entry), Entry.Source]),
      [
        ['CONSOLE-01', 'Ran script Restart QLab', Source],
        ['CONSOLE-02', 'Ran script Restart QLab', Source],
      ]
    );
    assert.ok(Logged.every((Entry) => Entry.EntityType === 'client' && Entry.Severity === 'info'));
  });

  test(`a Wake-on-LAN from ${Source} is logged per client woken, naming who sent it`, async () => {
    const Before = await Actions();
    const [Err] = await RunWithAuditSource(Source, () => GetHandler('WakeOnLan')(null, [UUID_A]));
    assert.equal(Err, null);
    const Logged = await NewActions(Before);
    assert.deepEqual(
      Logged.map((Entry) => [Entry.EntityID, Text(Entry), Entry.Source]),
      [[UUID_A, 'Sent Wake-on-LAN to CONSOLE-01', Source]]
    );
  });
}

test('a script that failed on a client is logged as an error with the reason', async () => {
  state.dispatch = { failed: [{ UUID: UUID_B, message: 'Client is offline' }] };
  const Before = await Actions();
  await RunWithAuditSource('Desktop', () =>
    GetHandler('ExecuteScript')(null, 'restart-qlab', [UUID_A, UUID_B], true)
  );
  const Logged = await NewActions(Before);
  const Failed = Logged.find((Entry) => Entry.EntityID === UUID_B);
  assert.equal(Failed.Severity, 'error');
  assert.deepEqual(Failed.Details, ['Client is offline']);
  assert.equal(Logged.find((Entry) => Entry.EntityID === UUID_A).Severity, 'info');
});

test('a Wake-on-LAN that could not be sent is logged as an error', async () => {
  state.wakeFailures = new Set(['AA:BB:CC:DD:EE:02']);
  const Before = await Actions();
  await RunWithAuditSource('Desktop', () => GetHandler('WakeOnLan')(null, [UUID_B]));
  const [Entry] = await NewActions(Before);
  assert.equal(Entry.Severity, 'error');
  assert.match(Entry.Details[0], /no route/);
});

test('both appear in that client’s Logs tab as well as the Audit Log', async () => {
  const { Entries } = await AuditLog.Query({
    EntityType: 'client',
    EntityID: UUID_A,
    Category: 'action',
  });
  const Kinds = new Set(Entries.map(Text));
  assert.ok(Kinds.has('Ran script Restart QLab'));
  assert.ok(Kinds.has('Sent Wake-on-LAN to CONSOLE-01'));
});
