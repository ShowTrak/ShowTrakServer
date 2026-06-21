// Integrated client (Integrated Clients feature) tests.
// Covers:
//  - integrated action (event) payload normalization/sanitization
//  - ClientManager.SetIntegratedActions persisting the catalogue in RAM and
//    flagging the client as integrated
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const {
  NormalizeIntegratedActions,
} = require('../src/Modules/ClientManager/integrated-actions');

test('NormalizeIntegratedActions keeps valid actions and clamps colour index', () => {
  const result = NormalizeIntegratedActions([
    { ID: 'SetBoxRed', Label: 'Set Box Red', ColourIndex: 0, HasFeedback: true },
    { ID: 'SetBoxBlue', Label: 'Set Box Blue', ColourIndex: 99, HasFeedback: false },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    ID: 'SetBoxRed',
    Label: 'Set Box Red',
    ColourIndex: 0,
    HasFeedback: true,
  });
  // Out-of-range colour index is clamped to the neutral dark grey (7).
  assert.equal(result[1].ColourIndex, 7);
  assert.equal(result[1].HasFeedback, false);
});

test('NormalizeIntegratedActions drops invalid entries and deduplicates by ID', () => {
  const result = NormalizeIntegratedActions([
    { ID: 'Good', Label: 'Good' },
    { ID: 'has space', Label: 'Invalid ID' },
    { ID: '', Label: 'Empty ID' },
    null,
    'not-an-object',
    { ID: 'Good', Label: 'Duplicate wins-first' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ID, 'Good');
  // Label falls back to ID when omitted, colour defaults to 7, feedback false.
  assert.equal(result[0].Label, 'Good');
  assert.equal(result[0].ColourIndex, 7);
  assert.equal(result[0].HasFeedback, false);
});

test('NormalizeIntegratedActions returns empty array for non-array input', () => {
  assert.deepEqual(NormalizeIntegratedActions(null), []);
  assert.deepEqual(NormalizeIntegratedActions({}), []);
  assert.deepEqual(NormalizeIntegratedActions(undefined), []);
});

function createLoggerStub() {
  const logger = {
    debug: () => {},
    error: () => {},
    log: () => {},
    warn: () => {},
    success: () => {},
  };
  return { CreateLogger: () => logger };
}

function loadClientManager(clientRows, events) {
  const dbStub = {
    Manager: {
      All: async (sql) => {
        const text = String(sql);
        if (text.includes('FROM Clients')) return [null, clientRows.map((r) => ({ ...r }))];
        // CriticalUSBDevices / CriticalApplications indexes
        return [null, []];
      },
      Get: async (sql, params) => {
        const text = String(sql);
        if (text.includes('FROM Clients')) {
          const row = clientRows.find((r) => r.UUID === params[0]);
          return [null, row ? { ...row } : null];
        }
        return [null, null];
      },
      Run: async () => [null, { changes: 1 }],
    },
  };

  const broadcastStub = {
    Manager: {
      emit: (name, payload) => events.push({ name, payload }),
      on: () => {},
    },
  };

  return loadWithMocks('../src/Modules/ClientManager', {
    '../DB': dbStub,
    '../Broadcast': broadcastStub,
    '../Logger': createLoggerStub(),
    '../Utils': require('../src/Modules/Utils'),
  });
}

test('ClientManager.SetIntegratedActions flags client and stores normalized catalogue', async () => {
  const events = [];
  const { Manager: ClientManager } = loadClientManager(
    [{ UUID: 'integrated-1', Hostname: 'Tablet', OperatingSystem: 'Integrated', Timestamp: 1 }],
    events
  );

  await ClientManager.Init();

  const [Err, Normalized] = await ClientManager.SetIntegratedActions('integrated-1', [
    { ID: 'SetBoxRed', Label: 'Set Box Red', ColourIndex: 0, HasFeedback: true },
    { ID: 'bad id', Label: 'dropped' },
  ]);
  assert.equal(Err, null);
  assert.equal(Normalized.length, 1);
  assert.equal(Normalized[0].ID, 'SetBoxRed');

  const [GetErr, Client] = await ClientManager.Get('integrated-1');
  assert.equal(GetErr, null);
  assert.equal(Client.Integrated, true);
  assert.equal(Client.IntegratedActions.length, 1);
  assert.equal(Client.IntegratedActions[0].Label, 'Set Box Red');

  // A ClientUpdated broadcast should have been emitted for the change.
  assert.ok(events.some((e) => e.name === 'ClientUpdated'));
});

test('ClientManager.SetIntegratedActions fails for an unknown client', async () => {
  const events = [];
  const { Manager: ClientManager } = loadClientManager([], events);
  await ClientManager.Init();
  const [Err] = await ClientManager.SetIntegratedActions('missing', []);
  assert.equal(Err, 'Client Not Found');
});

test('ClientManager.SetIntegratedState toggles a client-driven degraded state', async () => {
  const events = [];
  const { Manager: ClientManager } = loadClientManager(
    [{ UUID: 'integrated-1', Hostname: 'Tablet', OperatingSystem: 'Integrated', Timestamp: 1 }],
    events
  );
  await ClientManager.Init();

  // Bring it online so degraded evaluation applies (degraded requires Online).
  await ClientManager.Heartbeat('integrated-1', { Version: '1.0.0', Vitals: {} }, '10.0.0.5');

  const [DegErr] = await ClientManager.SetIntegratedState(
    'integrated-1',
    'DEGRADED',
    'Battery low'
  );
  assert.equal(DegErr, null);
  let [, Client] = await ClientManager.Get('integrated-1');
  assert.equal(Client.Degraded, true);
  assert.deepEqual(Client.DegradedWarnings, ['Battery low']);

  // Returning to ONLINE clears the degraded reason.
  const [OnErr] = await ClientManager.SetIntegratedState('integrated-1', 'ONLINE');
  assert.equal(OnErr, null);
  [, Client] = await ClientManager.Get('integrated-1');
  assert.equal(Client.Degraded, false);
  assert.deepEqual(Client.DegradedWarnings, []);
});

test('ClientManager.SetIntegratedState rejects OFFLINE and unknown states', async () => {
  const events = [];
  const { Manager: ClientManager } = loadClientManager(
    [{ UUID: 'integrated-1', OperatingSystem: 'Integrated', Timestamp: 1 }],
    events
  );
  await ClientManager.Init();
  const [Err] = await ClientManager.SetIntegratedState('integrated-1', 'OFFLINE');
  assert.equal(Err, 'Invalid integrated state');
});

test('Client.SetVitals normalizes partial vitals to a safe shape', async () => {
  const events = [];
  const { Manager: ClientManager } = loadClientManager(
    [{ UUID: 'integrated-1', OperatingSystem: 'Integrated', Timestamp: 1 }],
    events
  );
  await ClientManager.Init();
  // Integrated client reports only RAM (no CPU available on its platform).
  await ClientManager.Heartbeat(
    'integrated-1',
    { Version: '1.0.0', Vitals: { Ram: { UsagePercentage: 42 } } },
    '10.0.0.5'
  );
  const [, Client] = await ClientManager.Get('integrated-1');
  assert.equal(typeof Client.Vitals.CPU, 'object');
  assert.equal(typeof Client.Vitals.Uptime, 'object');
  assert.equal(Client.Vitals.Ram.UsagePercentage, 42);
});
