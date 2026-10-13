const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Audio at the server's boundaries: what an untrusted client report is reduced
// to, what the renderer may send, what is published to remote surfaces, who on
// those surfaces may change a level, and what the history timeline records.

const { Manager: SocketValidation } = require('../dist/Modules/SocketValidation/index');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');
const { ToPublicClient } = require('../dist/Modules/Server/serializers');
const History = require('../dist/main/monitoring-history');

// --- SocketValidation.AudioDevices --------------------------------------------

test('AudioDevices rebuilds the report field by field, dropping anything unexpected', () => {
  const result = SocketValidation.AudioDevices({
    SampledAt: 5,
    __proto__polluted: true,
    Endpoints: [
      {
        EndpointID: ' wasapi:{x} ',
        Direction: 'output',
        Name: 'Speakers',
        Manufacturer: null,
        Transport: 'usb',
        Channels: 2,
        SampleRate: 48000,
        IsDefault: true,
        Volume: 55,
        Muted: false,
        Evil: '<script>',
      },
      { EndpointID: 'b', IsDefault: 'true', Muted: 'no' },
    ],
    Status: { State: 'ok', Message: 'note', Platform: 'win32', Backend: 'wasapi', Extra: 1 },
    Capabilities: { DefaultDevice: true, Channels: 'yes', InputVolume: 'device', Junk: 1 },
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'Capabilities',
    'Endpoints',
    'SampledAt',
    'Status',
  ]);
  assert.equal(result.Endpoints[0].EndpointID, 'wasapi:{x}');
  assert.equal('Evil' in result.Endpoints[0], false);
  assert.equal(result.Endpoints[1].IsDefault, false, 'only a real true is default');
  assert.equal(result.Endpoints[1].Muted, null);
  assert.equal('Extra' in result.Status, false);
  assert.equal(result.Capabilities.Channels, false);
  assert.equal('Junk' in result.Capabilities, false);
});

test('AudioDevices tolerates a missing status, capabilities and endpoint list', () => {
  const result = SocketValidation.AudioDevices({ SampledAt: null });
  assert.deepEqual(result, { SampledAt: null, Endpoints: [], Status: null, Capabilities: null });
});

test('AudioDevices rejects non-objects, oversized lists and wrongly typed fields', () => {
  assert.throws(() => SocketValidation.AudioDevices(null), /must be an object/);
  assert.throws(() => SocketValidation.AudioDevices([]), /must be an object/);
  assert.throws(
    () => SocketValidation.AudioDevices({ Endpoints: new Array(257).fill({}) }),
    /exceeds the maximum/
  );
  assert.throws(() => SocketValidation.AudioDevices({ Endpoints: ['x'] }), /must be an object/);
  assert.throws(
    () => SocketValidation.AudioDevices({ Endpoints: [{ Channels: 'many' }] }),
    /finite number/
  );
  assert.throws(
    () => SocketValidation.AudioDevices({ Endpoints: [{ Name: 7 }] }),
    /must be a string/
  );
});

test('AudioDevices truncates over-long strings rather than storing them', () => {
  const result = SocketValidation.AudioDevices({
    Endpoints: [{ EndpointID: 'x'.repeat(2000), Name: 'n'.repeat(2000) }],
    Status: { Message: 'm'.repeat(5000) },
  });
  assert.equal(result.Endpoints[0].EndpointID.length, 512);
  assert.equal(result.Endpoints[0].Name.length, 256);
  assert.equal(result.Status.Message.length, 512);
});

// --- IPCValidation -------------------------------------------------------------

test('CriticalAudioDevicePayload keeps only the options that were sent', () => {
  assert.deepEqual(IPCValidation.CriticalAudioDevicePayload({ EndpointID: ' a ' }), {
    EndpointID: 'a',
  });
  assert.deepEqual(
    IPCValidation.CriticalAudioDevicePayload({
      EndpointID: 'a',
      RequireDefault: false,
      RequireUnmuted: true,
      CheckChannels: true,
      CheckSampleRate: false,
      MinVolume: '10',
      MaxVolume: null,
      Extra: 'ignored',
    }),
    {
      EndpointID: 'a',
      RequireDefault: false,
      RequireUnmuted: true,
      CheckChannels: true,
      CheckSampleRate: false,
      MinVolume: 10,
      MaxVolume: null,
    }
  );
  assert.equal(
    IPCValidation.CriticalAudioDevicePayload({ EndpointID: 'a', MinVolume: '' }).MinVolume,
    null
  );
});

test('CriticalAudioDevicePayload rejects bad ids, types and bounds', () => {
  const bad = [
    [null, /must be an object/],
    [{}, /EndpointID must be a string/],
    [{ EndpointID: '' }, /at least 1/],
    [{ EndpointID: 'x'.repeat(513) }, /at most 512/],
    [{ EndpointID: 'a', RequireDefault: 'yes' }, /true or false/],
    [{ EndpointID: 'a', MinVolume: 101 }, /between 0 and 100/],
    [{ EndpointID: 'a', MaxVolume: -1 }, /between 0 and 100/],
    [{ EndpointID: 'a', MaxVolume: 'loud' }, /must be a number/],
    [{ EndpointID: 'a', MinVolume: true }, /must be a number/],
    [{ EndpointID: 'a', MinVolume: 80, MaxVolume: 20 }, /cannot be above/],
  ];
  for (const [value, pattern] of bad) {
    assert.throws(
      () => IPCValidation.CriticalAudioDevicePayload(value),
      pattern,
      JSON.stringify(value)
    );
  }
});

test('AudioLevelRequest needs a change and keeps levels whole and in range', () => {
  assert.deepEqual(IPCValidation.AudioLevelRequest({ EndpointID: 'a', Volume: 49.6 }), {
    EndpointID: 'a',
    Volume: 50,
  });
  assert.deepEqual(
    IPCValidation.AudioLevelRequest({ EndpointID: 'a', Muted: false, Volume: null }),
    {
      EndpointID: 'a',
      Muted: false,
    }
  );
  assert.throws(() => IPCValidation.AudioLevelRequest('a'), /must be an object/);
  assert.throws(
    () => IPCValidation.AudioLevelRequest({ EndpointID: 'a' }),
    /must set Volume or Muted/
  );
  assert.throws(
    () => IPCValidation.AudioLevelRequest({ EndpointID: 'a', Volume: '' }),
    /must set Volume or Muted/
  );
  assert.throws(
    () => IPCValidation.AudioLevelRequest({ EndpointID: 'a', Volume: 300 }),
    /between 0 and 100/
  );
  assert.throws(
    () => IPCValidation.AudioLevelRequest({ EndpointID: 'a', Muted: 1 }),
    /true or false/
  );
  assert.equal(IPCValidation.AudioEndpointID(' x '), 'x');
});

// --- ToPublicClient -----------------------------------------------------------

test('the public client projection carries the audio view, never the raw report', () => {
  const view = { SampledAt: 1, Status: { State: 'ok' }, Capabilities: null, Endpoints: [] };
  const published = ToPublicClient({
    UUID: 'c1',
    AudioDevices: view,
    CriticalAudioDevices: [{ EndpointID: 'a' }],
    ObservedAudio: { secret: true },
  });
  assert.equal(published.AudioDevices, view);
  assert.deepEqual(published.CriticalAudioDevices, [{ EndpointID: 'a' }]);
  assert.equal('ObservedAudio' in published, false);

  const bare = ToPublicClient({ UUID: 'c2', AudioDevices: 'junk', CriticalAudioDevices: 'junk' });
  assert.equal(bare.AudioDevices.SampledAt, null);
  assert.equal(bare.AudioDevices.Status.State, 'unknown');
  assert.deepEqual(bare.CriticalAudioDevices, []);
});

// --- RemoteAccess ----------------------------------------------------------------

function loadRemote(settings, mode) {
  return loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'RemoteAccess', 'index.js'), {
    '../SettingsManager': { Manager: { GetValue: async (Key) => settings[Key] } },
    '../ModeManager': { Manager: { Get: () => mode } },
  });
}

test('remote surfaces: audio history is a read, marking critical is client management', async () => {
  const remote = loadRemote({}, 'SHOW');
  for (const Prefix of ['WEBUI', 'REMOTE']) {
    assert.deepEqual(await remote.AuthorizeChannel(Prefix, 'GetClientAudioHistory'), {
      allowed: true,
      reason: null,
    });
    for (const Channel of ['MarkClientAudioDeviceCritical', 'RemoveClientAudioDeviceCritical']) {
      assert.deepEqual(await remote.AuthorizeChannel(Prefix, Channel), {
        allowed: false,
        reason: 'edit_mode_required',
      });
    }
  }
  const editing = loadRemote({ WEBUI_ALLOW_CLIENT_MANAGEMENT: 1 }, 'EDIT');
  assert.equal(
    (await editing.AuthorizeChannel('WEBUI', 'MarkClientAudioDeviceCritical')).allowed,
    true
  );
});

test('remote surfaces: changing a level is a show-time action behind the script permission', async () => {
  // Off by default, like remote script execution.
  const closed = loadRemote({}, 'SHOW');
  assert.deepEqual(await closed.AuthorizeChannel('WEBUI', 'SetClientAudioLevel'), {
    allowed: false,
    reason: 'forbidden',
  });
  // Allowed in SHOW mode once permitted — a level is adjusted during the show.
  const open = loadRemote({ REMOTE_ALLOW_REMOTE_SCRIPT_EXECUTION: 1 }, 'SHOW');
  assert.deepEqual(await open.AuthorizeChannel('REMOTE', 'SetClientAudioLevel'), {
    allowed: true,
    reason: null,
  });
  assert.equal(open.SCRIPT_CHANNELS.has('SetClientAudioLevel'), true);
  assert.equal(open.EDIT_CHANNELS.has('SetClientAudioLevel'), false);
});

// --- History ---------------------------------------------------------------------

function historyClient(overrides = {}) {
  return {
    UUID: 'audio-hist',
    Online: true,
    AudioDevices: {
      Endpoints: [
        {
          EndpointID: 'ok',
          Name: 'Speakers',
          IsCritical: true,
          IsConnected: true,
          Missing: false,
          Issues: [],
        },
        {
          EndpointID: 'muted',
          Name: 'DVS',
          IsCritical: true,
          IsConnected: true,
          Missing: false,
          Issues: [{ Kind: 'muted', Message: 'Muted' }],
        },
        {
          EndpointID: 'gone',
          Name: 'Scarlett',
          IsCritical: true,
          IsConnected: false,
          Missing: true,
          Issues: [],
        },
        {
          EndpointID: 'unjudged',
          Name: 'X',
          IsCritical: true,
          IsConnected: false,
          Missing: false,
          Issues: [],
        },
        {
          EndpointID: 'plain',
          Name: 'Mic',
          IsCritical: false,
          IsConnected: true,
          Missing: false,
          Issues: [],
        },
        { EndpointID: '  ', Name: 'No id', IsCritical: true, IsConnected: true },
        null,
      ],
    },
    ...overrides,
  };
}

test('records one series per judged critical audio endpoint', () => {
  History.recordClientAudioHistorySamples(historyClient());
  const series = History.getClientAudioHistorySamples('audio-hist');
  const byId = new Map(series.map((s) => [s.EndpointID, s.samples.at(-1)]));
  assert.deepEqual([...byId.keys()].sort(), ['gone', 'muted', 'ok']);
  assert.deepEqual([byId.get('ok').online, byId.get('ok').degraded], [true, false]);
  assert.deepEqual([byId.get('muted').online, byId.get('muted').degraded], [true, true]);
  assert.deepEqual([byId.get('gone').online, byId.get('gone').degraded], [false, false]);
  assert.equal(series.find((s) => s.EndpointID === 'ok').Name, 'Speakers');
});

test('records nothing while offline and copes with a client without audio', () => {
  History.recordClientAudioHistorySamples(historyClient({ UUID: 'audio-offline', Online: false }));
  assert.deepEqual(History.getClientAudioHistorySamples('audio-offline'), []);
  History.recordClientAudioHistorySamples({ UUID: 'audio-none', Online: true });
  assert.deepEqual(History.getClientAudioHistorySamples('audio-none'), []);
  History.recordClientAudioHistorySamples(null);
  History.recordClientAudioHistorySamples(
    historyClient({
      UUID: 'audio-nameless',
      AudioDevices: { Endpoints: [{ EndpointID: 'z', IsCritical: true }] },
    })
  );
  assert.equal(History.getClientAudioHistorySamples('audio-nameless')[0].Name, 'Audio Device');
});

test('syncing drops the history of clients that no longer exist', () => {
  History.recordClientAudioHistorySamples(historyClient({ UUID: 'audio-sync' }));
  assert.ok(History.getClientAudioHistorySamples('audio-sync').length > 0);
  History.syncClientAudioHistoryStore([{ UUID: 'someone-else' }]);
  assert.deepEqual(History.getClientAudioHistorySamples('audio-sync'), []);
});
