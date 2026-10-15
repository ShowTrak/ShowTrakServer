const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// Audio monitoring through the real ClientManager and a real (throwaway) SQLite
// database: what a report does to a client's state, how critical endpoints are
// persisted and re-hydrated, and which transitions reach the alert pipeline.

function loggerStub() {
  const noop = () => {};
  return {
    CreateLogger: () => new Proxy({}, { get: () => noop }),
  };
}

async function loadClientManager() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-audio-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  const events = [];
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: (event, ...args) => events.push([event, ...args]) } },
      '../SettingsManager': { Manager: { GetValue: async () => undefined } },
    }
  );
  return { Manager: clientManager.Manager, DB: dbModule.Manager, events };
}

/** Online, and past its start-up window, so faults publish immediately. */
function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

const CAPS = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: false,
  InputVolume: 'device',
  OutputVolume: 'device',
  InputMute: 'device',
  OutputMute: 'device',
};

function endpoint(overrides = {}) {
  return {
    EndpointID: 'wasapi:{dvs-out}',
    Direction: 'output',
    Name: 'Dante Virtual Soundcard (x64)',
    Manufacturer: 'Audinate',
    Transport: null,
    Channels: 64,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 100,
    Muted: false,
    ...overrides,
  };
}

function snapshot(endpoints, state = 'ok') {
  return {
    SampledAt: Date.now(),
    Endpoints: endpoints,
    Status: {
      State: state,
      Message: state === 'ok' ? null : 'boom',
      Platform: 'win32',
      Backend: 'wasapi',
    },
    Capabilities: CAPS,
  };
}

const changesOf = (events) => events.filter((e) => e[0] === 'AudioDeviceChanged').map((e) => e[2]);

test('the first report of a connection establishes a baseline without announcing anything', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  assert.deepEqual(await Manager.SetAudioDevices('c1', snapshot([endpoint()])), [
    null,
    'Audio devices updated successfully',
  ]);
  assert.equal(client.HasAudioTelemetry, true);
  assert.equal(client.AudioDevices.Endpoints.length, 1);
  assert.equal(client.AudioDevices.Status.Backend, 'wasapi');
  assert.deepEqual(changesOf(events), []);
  assert.ok(events.some((e) => e[0] === 'ClientUpdated'));
});

test('later reports raise transitions, tagged with whether the endpoint is critical', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });

  await Manager.SetAudioDevices(
    'c1',
    snapshot([
      endpoint({ Channels: 2 }),
      endpoint({ EndpointID: 'wasapi:{usb}', Name: 'USB Out', IsDefault: false }),
    ])
  );
  await Manager.SetAudioDevices('c1', snapshot([endpoint({ Channels: 2 })]));

  const changes = changesOf(events).map((c) => [c.Kind, c.Endpoint.EndpointID, c.IsCritical]);
  assert.deepEqual(changes, [
    ['format_changed', 'wasapi:{dvs-out}', true],
    ['connected', 'wasapi:{usb}', false],
    ['disconnected', 'wasapi:{usb}', false],
  ]);
  const raised = events.find((e) => e[0] === 'AudioDeviceChanged');
  assert.equal(raised[1], client, 'the client entity rides with the change');
});

test('a failed sample is held: no faults, no transitions, and none against it afterwards', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });

  // The collector failed: an empty list with an error state is not evidence.
  await Manager.SetAudioDevices('c1', snapshot([], 'error'));
  assert.equal(client.HasAudioTelemetry, false);
  assert.equal(client.Degraded, false);
  assert.deepEqual(client.MissingCriticalAudioDevices, []);

  // Back to normal: diffing against the failed sample would announce a connect.
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  assert.deepEqual(changesOf(events), []);
  assert.equal(client.Degraded, false);
});

test('a missing or misconfigured critical endpoint degrades the client', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  assert.deepEqual(
    await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}', MinVolume: 90 }),
    [null, true]
  );
  assert.equal(client.Degraded, false);

  await Manager.SetAudioDevices(
    'c1',
    snapshot([endpoint({ Volume: 40, Muted: true, IsDefault: false })])
  );
  assert.equal(client.Degraded, true);
  assert.deepEqual(client.DegradedWarnings, [
    'Audio Device Not Default',
    'Audio Device Muted',
    'Audio Level Out Of Range',
  ]);

  await Manager.SetAudioDevices('c1', snapshot([]));
  assert.deepEqual(client.DegradedWarnings, ['Missing Audio Device']);
  assert.deepEqual(
    client.MissingCriticalAudioDevices.map((e) => e.EndpointID),
    ['wasapi:{dvs-out}']
  );
});

test('audio faults are held during the start-up window like every other inferred fault', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });

  client.SetOnline(false);
  client.SetOnline(true); // freshly connected: inside the window
  await Manager.SetAudioDevices('c1', snapshot([]));
  assert.equal(client.Degraded, false);
  assert.equal(client.Initialising, true);
  client._clearStartupGraceTimer();
});

test('going offline retires the audio evidence', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });
  await Manager.SetAudioDevices('c1', snapshot([]));
  assert.equal(client.MissingCriticalAudioDevices.length, 1);

  client.SetOnline(false);
  assert.equal(client.HasAudioTelemetry, false);
  assert.deepEqual(client.AudioWarnings, []);
  assert.deepEqual(client.MissingCriticalAudioDevices, []);
  const entry = client.AudioDevices.Endpoints.find((e) => e.EndpointID === 'wasapi:{dvs-out}');
  assert.equal(entry.Missing, false, 'offline is not evidence of a missing device');
});

test('critical endpoints persist and re-hydrate with their conditions', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', {
    EndpointID: 'wasapi:{dvs-out}',
    RequireDefault: false,
    MinVolume: 80,
    MaxVolume: 100,
    CheckSampleRate: false,
  });

  const [, row] = await DB.Get('SELECT * FROM CriticalAudioDevices WHERE UUID = ?', ['c1']);
  assert.equal(row.EndpointID, 'wasapi:{dvs-out}');
  assert.equal(row.Direction, 'output');
  assert.equal(row.Name, 'Dante Virtual Soundcard (x64)');
  assert.equal(row.Channels, 64);
  assert.equal(row.SampleRate, null);
  assert.equal(row.RequireDefault, 0);
  assert.equal(row.RequireUnmuted, 1);
  assert.equal(row.MinVolume, 80);
  assert.equal(row.MaxVolume, 100);

  await Manager.ClearCache();
  await Manager.Init();
  const [, reloaded] = await Manager.Get('c1');
  assert.deepEqual(
    reloaded.CriticalAudioDevices.map((e) => [
      e.EndpointID,
      e.Channels,
      e.SampleRate,
      e.RequireDefault,
      e.MinVolume,
    ]),
    [['wasapi:{dvs-out}', 64, null, false, 80]]
  );
  assert.equal(reloaded.IsAudioDeviceCritical('wasapi:{dvs-out}'), true);
  assert.equal(reloaded.IsAudioDeviceCritical(''), false);
});

test('editing a missing endpoint keeps its baseline; a first mark needs the device present', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [refusedErr] = await Manager.MarkAudioDeviceCritical('c1', {
    EndpointID: 'wasapi:{dvs-out}',
  });
  assert.match(refusedErr, /not connected/);

  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });
  await Manager.SetAudioDevices('c1', snapshot([]));
  const [err, isNew] = await Manager.MarkAudioDeviceCritical('c1', {
    EndpointID: 'wasapi:{dvs-out}',
    RequireUnmuted: false,
  });
  assert.equal(err, null);
  assert.equal(isNew, false);
  const [, client] = await Manager.Get('c1');
  assert.equal(client.CriticalAudioDevices[0].Channels, 64);
  assert.equal(client.CriticalAudioDevices[0].RequireUnmuted, false);
});

test('removing a critical endpoint clears its row and its faults', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });
  await Manager.SetAudioDevices('c1', snapshot([]));
  assert.equal(client.Degraded, true);

  assert.deepEqual(await Manager.RemoveAudioDeviceCritical('c1', ' wasapi:{dvs-out} '), [
    null,
    true,
  ]);
  assert.equal(client.Degraded, false);
  assert.equal(client.AudioDevices.Endpoints.length, 0);
  const [, row] = await DB.Get('SELECT 1 AS Found FROM CriticalAudioDevices WHERE UUID = ?', [
    'c1',
  ]);
  assert.equal(row, undefined);
  assert.equal(client.UnmarkCriticalAudioDevice('wasapi:{dvs-out}'), false, 'already gone');
  assert.equal(client.UnmarkCriticalAudioDevice(null), false);
});

test('audio calls on an unknown client, or without an id, fail cleanly', async () => {
  const { Manager } = await loadClientManager();
  assert.ok((await Manager.SetAudioDevices('nobody', snapshot([])))[0]);
  assert.ok((await Manager.MarkAudioDeviceCritical('nobody', { EndpointID: 'x' }))[0]);
  assert.ok((await Manager.RemoveAudioDeviceCritical('nobody', 'x'))[0]);
  await Manager.Create('c1');
  assert.match(
    (await Manager.MarkAudioDeviceCritical('c1', { EndpointID: '  ' }))[0],
    /identifier is required/
  );
  assert.match((await Manager.RemoveAudioDeviceCritical('c1', ''))[0], /identifier is required/);
});

test('a failed write leaves the in-memory critical list untouched', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await DB.Run('DROP TABLE CriticalAudioDevices');
  const [markErr] = await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });
  assert.match(markErr, /Failed to save monitored audio device/);
  const [, client] = await Manager.Get('c1');
  assert.deepEqual(client.CriticalAudioDevices, []);
  const [removeErr] = await Manager.RemoveAudioDeviceCritical('c1', 'wasapi:{dvs-out}');
  assert.match(removeErr, /Failed to remove monitored audio device/);
});

test('deleting a client deletes its critical audio rows; replacing one moves them', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('gone');
  await Manager.SetAudioDevices('gone', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('gone', { EndpointID: 'wasapi:{dvs-out}' });
  await Manager.Delete('gone');
  const [, deleted] = await DB.Get('SELECT 1 AS Found FROM CriticalAudioDevices WHERE UUID = ?', [
    'gone',
  ]);
  assert.equal(deleted, undefined);

  await Manager.Create('old');
  await Manager.SetAudioDevices('old', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('old', { EndpointID: 'wasapi:{dvs-out}' });
  const [replaceErr] = await Manager.ReplaceClient('old', 'new');
  assert.equal(replaceErr, null);
  const [, moved] = await DB.Get('SELECT UUID FROM CriticalAudioDevices WHERE EndpointID = ?', [
    'wasapi:{dvs-out}',
  ]);
  assert.equal(moved.UUID, 'new');
  const [, replacement] = await Manager.Get('new');
  assert.equal(replacement.IsAudioDeviceCritical('wasapi:{dvs-out}'), true);
});

test('the Client entity stays plain data with audio state on it', async () => {
  // A Client crosses Electron IPC and is JSON-stringified into alert history.
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.SetAudioDevices('c1', snapshot([endpoint()]));
  await Manager.MarkAudioDeviceCritical('c1', { EndpointID: 'wasapi:{dvs-out}' });
  const [, client] = await Manager.Get('c1');
  const roundTripped = JSON.parse(JSON.stringify(client));
  assert.equal(roundTripped.AudioDevices.Endpoints[0].IsCritical, true);
  assert.doesNotThrow(() => structuredClone(client));
});

test('SetCriticalAudioDevices de-duplicates and drops malformed entries', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  client.SetCriticalAudioDevices([
    { EndpointID: 'a', Direction: 'output', Name: 'A' },
    { EndpointID: 'a', Direction: 'input', Name: 'A again' },
    { EndpointID: 'b' },
    null,
  ]);
  assert.deepEqual(
    client.CriticalAudioDevices.map((e) => [e.EndpointID, e.Name]),
    [['a', 'A']]
  );
  client.SetCriticalAudioDevices('not a list');
  assert.deepEqual(client.CriticalAudioDevices, []);
  assert.equal(client.MarkCriticalAudioDevice({ EndpointID: 'x' }), false);
  assert.equal(
    client.MarkCriticalAudioDevice({ EndpointID: 'x', Direction: 'input', Name: 'X' }),
    true
  );
  assert.equal(
    client.MarkCriticalAudioDevice({ EndpointID: 'x', Direction: 'input', Name: 'Y' }),
    false
  );
  assert.equal(client.CriticalAudioDevices[0].Name, 'Y', 'a re-mark replaces the entry');
});
