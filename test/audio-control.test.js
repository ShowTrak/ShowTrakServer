const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Server half of remote audio control (Modules/Server/audio-control.ts).
//
// Every refusal the server can decide alone is made before anything is sent.
// The most important of those is an OUTDATED client: it has no audio monitor,
// so it would never answer, and the operator would sit through a timeout to
// learn something the server already knew from the version it reported.

const { SendAudioLevel, MINIMUM_AUDIO_VERSION_LABEL } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'audio-control.js')
);
const { MINIMUM_AUDIO_MONITORING_VERSION } = require('../dist/Modules/Config/constants');

const CAPS = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: true,
  InputVolume: 'default',
  OutputVolume: 'default',
  InputMute: 'none',
  OutputMute: 'default',
};

function client(overrides = {}) {
  return {
    UUID: 'c1',
    Online: true,
    Integrated: false,
    Version: '3.21.0',
    ObservedAudio: {
      SampledAt: 1,
      Endpoints: [
        {
          EndpointID: 'spk',
          Direction: 'output',
          Name: 'Speakers',
          IsDefault: true,
          Volume: 50,
          Muted: false,
        },
        {
          EndpointID: 'dvs',
          Direction: 'output',
          Name: 'DVS',
          IsDefault: false,
          Volume: null,
          Muted: null,
        },
        {
          EndpointID: 'mic',
          Direction: 'input',
          Name: 'Mic',
          IsDefault: true,
          Volume: 70,
          Muted: null,
        },
      ],
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'coreaudio' },
      Capabilities: CAPS,
    },
    ...overrides,
  };
}

/** A fake Socket.IO server whose room broadcast answers however the test says. */
function fakeIO(answer) {
  const sent = [];
  return {
    sent,
    io: {
      to: (room) => ({
        timeout: (ms) => ({
          emit: (event, request, callback) => {
            sent.push({ room, ms, event, request });
            answer(callback);
          },
        }),
      }),
    },
  };
}

function deps(Client, answer = (cb) => cb(null, [{ Success: true, Error: null }])) {
  const io = fakeIO(answer);
  return {
    io,
    deps: {
      io: io.io,
      GetClient: async () => (Client ? [null, Client] : ['Client Not Found', null]),
      TimeoutMs: 25,
    },
  };
}

test('the version gate matches the first client release with audio monitoring', () => {
  assert.equal(MINIMUM_AUDIO_VERSION_LABEL, MINIMUM_AUDIO_MONITORING_VERSION.join('.'));
});

test('a confirmed change is sent to the client room with the request as given', async () => {
  const { io, deps: d } = deps(client());
  assert.deepEqual(await SendAudioLevel(d, 'c1', { EndpointID: 'spk', Volume: 30 }), [null, true]);
  assert.deepEqual(io.sent, [
    { room: 'c1', ms: 25, event: 'SetAudioLevel', request: { EndpointID: 'spk', Volume: 30 } },
  ]);
});

test('an outdated client is refused up front, naming both versions', async () => {
  for (const Version of ['3.20.0', '2.9.1', null, 'test']) {
    const { io, deps: d } = deps(client({ Version }));
    const [error] = await SendAudioLevel(d, 'c1', { EndpointID: 'spk', Volume: 30 });
    assert.match(
      error,
      new RegExp(
        `needs ShowTrak Client ${MINIMUM_AUDIO_VERSION_LABEL.replace(/\./g, '\\.')} or later`
      )
    );
    if (Version) assert.match(error, new RegExp(`runs ${Version}`));
    assert.equal(io.sent.length, 0, `nothing sent to ${Version}`);
  }
});

test('missing, SDK and offline clients are refused before sending', async () => {
  const cases = [
    [null, /Client Not Found/],
    [client({ Integrated: true }), /not available for SDK clients/],
    [client({ Online: false }), /not online/],
  ];
  for (const [Client, pattern] of cases) {
    const { io, deps: d } = deps(Client);
    const [error] = await SendAudioLevel(d, 'c1', { EndpointID: 'spk', Muted: true });
    assert.match(error, pattern);
    assert.equal(io.sent.length, 0);
  }
  const noClient = await SendAudioLevel(
    { io: fakeIO(() => {}).io, GetClient: async () => [null, null] },
    'c1',
    { EndpointID: 'spk', Muted: true }
  );
  assert.match(noClient[0], /Client not found/);
});

test('an endpoint the client never reported, or a control its platform lacks, is refused', async () => {
  const unknown = deps(client());
  assert.match(
    (await SendAudioLevel(unknown.deps, 'c1', { EndpointID: 'nope', Volume: 1 }))[0],
    /not connected/
  );
  const nonDefault = deps(client());
  assert.equal(
    (await SendAudioLevel(nonDefault.deps, 'c1', { EndpointID: 'dvs', Volume: 1 }))[0],
    'macOS can only change the level of the default output'
  );
  const inputMute = deps(client());
  assert.equal(
    (await SendAudioLevel(inputMute.deps, 'c1', { EndpointID: 'mic', Muted: true }))[0],
    'Changing the mute of this device is not available on macOS'
  );
  for (const d of [unknown, nonDefault, inputMute]) assert.equal(d.io.sent.length, 0);
});

test('a client that does not answer in time is reported as such', async () => {
  const timedOut = deps(client(), (cb) => cb(new Error('operation has timed out'), []));
  assert.match(
    (await SendAudioLevel(timedOut.deps, 'c1', { EndpointID: 'spk', Volume: 1 }))[0],
    /did not confirm/
  );
  const emptyRoom = deps(client(), (cb) => cb(null, []));
  assert.match(
    (await SendAudioLevel(emptyRoom.deps, 'c1', { EndpointID: 'spk', Volume: 1 }))[0],
    /did not confirm/
  );
  const garbage = deps(client(), (cb) => cb(null, 'nonsense'));
  assert.match(
    (await SendAudioLevel(garbage.deps, 'c1', { EndpointID: 'spk', Volume: 1 }))[0],
    /did not confirm/
  );
  const throwing = {
    io: {
      to: () => {
        throw new Error('io closed');
      },
    },
    GetClient: async () => [null, client()],
  };
  assert.match(
    (await SendAudioLevel(throwing, 'c1', { EndpointID: 'spk', Volume: 1 }))[0],
    /did not confirm/
  );
});

test("the client's own refusal is passed through; any success in the room wins", async () => {
  const refused = deps(client(), (cb) => cb(null, [{ Success: false, Error: 'Access is denied' }]));
  assert.deepEqual(await SendAudioLevel(refused.deps, 'c1', { EndpointID: 'spk', Volume: 1 }), [
    'Access is denied',
    null,
  ]);
  const silent = deps(client(), (cb) => cb(null, [{ Success: false }, null]));
  assert.match(
    (await SendAudioLevel(silent.deps, 'c1', { EndpointID: 'spk', Volume: 1 }))[0],
    /could not change/
  );
  // Two sockets across a reconnect: one stale, one live.
  const doubled = deps(client(), (cb) =>
    cb(null, [
      { Success: false, Error: 'stale' },
      { Success: true, Error: null },
    ])
  );
  assert.deepEqual(await SendAudioLevel(doubled.deps, 'c1', { EndpointID: 'spk', Volume: 1 }), [
    null,
    true,
  ]);
});
