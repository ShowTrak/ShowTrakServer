const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The pure half of audio monitoring (Modules/ClientManager/audio.ts): what a
// report means, when a critical endpoint is at fault, and which transitions an
// alert rule sees. Everything here is a function of its arguments, so it is
// tested directly, with no manager or database behind it.

const Audio = require(path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'audio.js'));

const FULL_CAPS = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: true,
  InputVolume: 'device',
  OutputVolume: 'device',
  InputMute: 'device',
  OutputMute: 'device',
};
const MAC_CAPS = {
  ...FULL_CAPS,
  InputVolume: 'default',
  OutputVolume: 'default',
  InputMute: 'none',
  OutputMute: 'default',
};

function endpoint(overrides = {}) {
  return {
    EndpointID: 'out-1',
    Direction: 'output',
    Name: 'Scarlett 18i20',
    Manufacturer: 'Focusrite',
    Transport: 'usb',
    Channels: 20,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 80,
    Muted: false,
    ...overrides,
  };
}

function critical(overrides = {}) {
  return {
    EndpointID: 'out-1',
    Direction: 'output',
    Name: 'Scarlett 18i20',
    Channels: 20,
    SampleRate: 48000,
    RequireDefault: true,
    RequireUnmuted: true,
    MinVolume: null,
    MaxVolume: null,
    Timestamp: 1,
    ...overrides,
  };
}

function observed(endpoints, overrides = {}) {
  return {
    SampledAt: 10,
    Endpoints: endpoints,
    Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'wasapi' },
    Capabilities: FULL_CAPS,
    ...overrides,
  };
}

// --- normalisation ------------------------------------------------------------

test('normalizeAudioSnapshot keeps well-formed endpoints and drops the unusable ones', () => {
  const result = Audio.normalizeAudioSnapshot({
    SampledAt: 5,
    Endpoints: [
      endpoint(),
      endpoint({ EndpointID: 'out-1', Name: 'Duplicate id' }),
      endpoint({ EndpointID: '', Name: 'No id' }),
      endpoint({ EndpointID: 'x', Direction: 'sideways' }),
      null,
      'junk',
      {
        EndpointID: ' in-1 ',
        Direction: 'input',
        Transport: 'carrier-pigeon',
        Channels: -2,
        SampleRate: '44100',
        Volume: 150.4,
        Muted: 'yes',
      },
    ],
    Status: { State: ' OK ', Message: '  note ', Platform: 'win32', Backend: 'wasapi' },
    Capabilities: { ...FULL_CAPS, InputVolume: 'everything', Channels: 'yes' },
  });
  assert.equal(result.SampledAt, 5);
  assert.deepEqual(
    result.Endpoints.map((e) => e.EndpointID),
    ['out-1', 'in-1']
  );
  assert.equal(result.Endpoints[0].Name, 'Scarlett 18i20', 'the first of a repeated id wins');
  const input = result.Endpoints[1];
  assert.equal(input.Name, 'Audio Input');
  assert.equal(input.Transport, 'unknown');
  assert.equal(input.Channels, null);
  assert.equal(input.SampleRate, 44100);
  assert.equal(input.Volume, 150, 'boost above 100 is kept, not clamped');
  assert.equal(input.Muted, null);
  assert.equal(input.Manufacturer, null);
  assert.deepEqual(result.Status, {
    State: 'ok',
    Message: 'note',
    Platform: 'win32',
    Backend: 'wasapi',
  });
  assert.equal(result.Capabilities.InputVolume, 'none', 'an unknown scope reads as none');
  assert.equal(result.Capabilities.Channels, false, 'only a real boolean true counts');
});

test('normalizeAudioSnapshot defaults everything a malformed report lacks', () => {
  const result = Audio.normalizeAudioSnapshot(null);
  assert.deepEqual(result, {
    SampledAt: null,
    Endpoints: [],
    Status: { State: 'unknown', Message: null, Platform: '', Backend: null },
    Capabilities: null,
  });
  const odd = Audio.normalizeAudioSnapshot({
    SampledAt: 'later',
    Status: { State: 'exploded', Backend: 'jack' },
    Endpoints: [{ EndpointID: 'o', Direction: 'output', Transport: 42 }],
  });
  assert.equal(odd.SampledAt, null);
  assert.equal(odd.Status.State, 'unknown');
  assert.equal(odd.Status.Backend, null);
  assert.equal(odd.Endpoints[0].Name, 'Audio Output');
  assert.equal(odd.Endpoints[0].Transport, null);
});

test('normalizeCriticalAudioEntry reads sqlite 0/1 flags and clamps the level bounds', () => {
  const entry = Audio.normalizeCriticalAudioEntry({
    EndpointID: 'out-1',
    Direction: 'output',
    Name: '',
    Channels: '64',
    SampleRate: 0,
    RequireDefault: 1,
    RequireUnmuted: 0,
    MinVolume: -5,
    MaxVolume: 140,
    Timestamp: '99',
  });
  assert.deepEqual(entry, {
    EndpointID: 'out-1',
    Direction: 'output',
    Name: 'out-1',
    Channels: 64,
    SampleRate: null,
    RequireDefault: true,
    RequireUnmuted: false,
    MinVolume: 0,
    MaxVolume: 100,
    Timestamp: 99,
  });
  assert.equal(Audio.normalizeCriticalAudioEntry({ EndpointID: 'x' }), null);
  assert.equal(Audio.normalizeCriticalAudioEntry({ Direction: 'input' }), null);
  assert.equal(
    Audio.normalizeCriticalAudioEntry({ EndpointID: 'x', Direction: 'input' }).Timestamp,
    null
  );
});

test('FormatSampleRate, AudioPlatformLabel and the empty shapes', () => {
  assert.equal(Audio.FormatSampleRate(48000), '48 kHz');
  assert.equal(Audio.FormatSampleRate(44100), '44.1 kHz');
  assert.equal(Audio.AudioPlatformLabel('darwin'), 'macOS');
  assert.equal(Audio.AudioPlatformLabel('win32'), 'Windows');
  assert.equal(Audio.AudioPlatformLabel('linux'), 'Linux');
  assert.equal(Audio.AudioPlatformLabel('aix'), 'aix');
  assert.equal(Audio.AudioPlatformLabel(''), 'this operating system');
  assert.deepEqual(Audio.EmptyAudioView().Endpoints, []);
  assert.equal(Audio.EmptyObservedAudio().Status.State, 'unknown');
});

test('IsClientVersionAtLeast gates the feature on the client release, failing closed', () => {
  const min = [3, 21, 0];
  assert.equal(Audio.IsClientVersionAtLeast('3.21.0', min), true);
  assert.equal(Audio.IsClientVersionAtLeast('v3.22.4', min), true);
  assert.equal(Audio.IsClientVersionAtLeast('4.0.0', min), true);
  assert.equal(Audio.IsClientVersionAtLeast('3.21.0-beta.1', min), true);
  assert.equal(Audio.IsClientVersionAtLeast('3.20.9', min), false);
  assert.equal(Audio.IsClientVersionAtLeast('2.99.99', min), false);
  for (const junk of [null, undefined, '', 'test', '3.21']) {
    assert.equal(Audio.IsClientVersionAtLeast(junk, min), false, String(junk));
  }
});

// --- evaluation ------------------------------------------------------------

test('evaluateAudioIssues reports a missing endpoint by its baseline name', () => {
  assert.deepEqual(Audio.evaluateAudioIssues(null, critical(), FULL_CAPS), [
    { Kind: 'missing', Message: 'Scarlett 18i20 is not connected' },
  ]);
});

test('evaluateAudioIssues reports every broken condition, worded for an operator', () => {
  const issues = Audio.evaluateAudioIssues(
    endpoint({ IsDefault: false, Channels: 2, SampleRate: 44100, Muted: true, Volume: 12 }),
    critical({ MinVolume: 80, MaxVolume: 100 }),
    FULL_CAPS
  );
  assert.deepEqual(issues, [
    { Kind: 'not_default', Message: 'No longer the default output' },
    { Kind: 'channels', Message: '2 channels (expected 20)' },
    { Kind: 'sample_rate', Message: 'Sample rate is 44.1 kHz (expected 48 kHz)' },
    { Kind: 'muted', Message: 'Muted' },
    { Kind: 'volume', Message: 'Level is 12% (expected 80–100%)' },
  ]);
});

test('evaluateAudioIssues words one-sided level bounds', () => {
  const low = Audio.evaluateAudioIssues(
    endpoint({ Volume: 5 }),
    critical({ MinVolume: 10 }),
    FULL_CAPS
  );
  assert.equal(low[0].Message, 'Level is 5% (expected at least 10%)');
  const high = Audio.evaluateAudioIssues(
    endpoint({ Volume: 95 }),
    critical({ MaxVolume: 90 }),
    FULL_CAPS
  );
  assert.equal(high[0].Message, 'Level is 95% (expected at most 90%)');
  assert.deepEqual(
    Audio.evaluateAudioIssues(
      endpoint({ Volume: 50 }),
      critical({ MinVolume: 10, MaxVolume: 90 }),
      FULL_CAPS
    ),
    []
  );
});

test('evaluateAudioIssues never faults what the platform cannot read', () => {
  // A non-default device on macOS: no level, no mute, so those checks are
  // skipped rather than failed.
  const unknowns = endpoint({
    IsDefault: false,
    Volume: null,
    Muted: null,
    Channels: null,
    SampleRate: null,
  });
  assert.deepEqual(
    Audio.evaluateAudioIssues(
      unknowns,
      critical({ RequireDefault: false, MinVolume: 50 }),
      MAC_CAPS
    ),
    []
  );
  // And ALSA cannot name a default at all.
  assert.deepEqual(
    Audio.evaluateAudioIssues(endpoint({ IsDefault: false }), critical(), {
      ...FULL_CAPS,
      DefaultDevice: false,
    }),
    []
  );
  assert.deepEqual(Audio.evaluateAudioIssues(endpoint({ IsDefault: false }), critical(), null), []);
  // A baseline with nothing guarded faults on nothing.
  assert.deepEqual(
    Audio.evaluateAudioIssues(
      endpoint({ Channels: 2, Muted: true }),
      critical({ Channels: null, SampleRate: null, RequireDefault: false, RequireUnmuted: false }),
      FULL_CAPS
    ),
    []
  );
});

// --- view ------------------------------------------------------------------

test('buildAudioView merges reports with baselines and lists missing criticals', () => {
  const result = Audio.buildAudioView(
    observed([
      endpoint({ Muted: true }),
      endpoint({ EndpointID: 'in-1', Direction: 'input', IsDefault: false }),
    ]),
    [
      critical(),
      critical({ EndpointID: 'gone', Name: 'Dante Virtual Soundcard', Direction: 'output' }),
    ],
    true
  );
  const ids = result.View.Endpoints.map((e) => [
    e.EndpointID,
    e.IsConnected,
    e.IsCritical,
    e.Missing,
  ]);
  assert.deepEqual(ids, [
    ['out-1', true, true, false],
    ['in-1', true, false, false],
    ['gone', false, true, true],
  ]);
  assert.deepEqual(
    result.View.Endpoints[0].Issues.map((i) => i.Kind),
    ['muted']
  );
  assert.deepEqual(result.View.Endpoints[1].Issues, []);
  assert.equal(result.View.Endpoints[1].Critical, null);
  const missing = result.View.Endpoints[2];
  assert.equal(missing.Name, 'Dante Virtual Soundcard');
  assert.equal(missing.Channels, 20, 'a missing endpoint carries its baseline');
  assert.equal(missing.Volume, null);
  assert.deepEqual(
    result.Missing.map((e) => e.EndpointID),
    ['gone']
  );
  assert.deepEqual(result.Warnings, ['Audio Device Muted', 'Missing Audio Device']);
  assert.equal(result.View.SampledAt, 10);
});

test('buildAudioView judges nothing until a sample is trusted', () => {
  const result = Audio.buildAudioView(
    observed([endpoint({ Muted: true })]),
    [critical(), critical({ EndpointID: 'gone' })],
    false
  );
  assert.deepEqual(result.Warnings, []);
  assert.deepEqual(result.Missing, []);
  const gone = result.View.Endpoints.find((e) => e.EndpointID === 'gone');
  assert.equal(gone.Missing, false, 'not reported yet is not missing');
  assert.deepEqual(gone.Issues, []);
  assert.deepEqual(result.View.Endpoints[0].Issues, []);
});

test('buildAudioView de-duplicates warnings across kinds that share one', () => {
  const result = Audio.buildAudioView(
    observed([endpoint({ Channels: 2, SampleRate: 44100 })]),
    [critical(), critical({ EndpointID: 'out-1' })],
    true
  );
  assert.deepEqual(result.Warnings, ['Audio Format Changed']);
  assert.equal(result.View.Endpoints.length, 1, 'a repeated baseline id is used once');
});

// --- transitions -------------------------------------------------------------

test('diffAudioEndpoints derives every transition kind', () => {
  const before = [
    endpoint(),
    endpoint({ EndpointID: 'in-1', Direction: 'input', IsDefault: true, Muted: false }),
    endpoint({ EndpointID: 'old', IsDefault: false }),
  ];
  const after = [
    endpoint({ IsDefault: false, Channels: 64 }),
    endpoint({ EndpointID: 'in-1', Direction: 'input', IsDefault: true, Muted: true }),
    endpoint({ EndpointID: 'new', IsDefault: true }),
  ];
  const changes = Audio.diffAudioEndpoints(before, after).map((c) => [
    c.Kind,
    c.Endpoint.EndpointID,
    c.Previous ? c.Previous.EndpointID : null,
  ]);
  assert.deepEqual(changes, [
    ['format_changed', 'out-1', 'out-1'],
    ['muted', 'in-1', 'in-1'],
    ['connected', 'new', null],
    ['disconnected', 'old', 'old'],
    ['default_changed', 'new', 'out-1'],
  ]);
});

test('diffAudioEndpoints is quiet when nothing a rule cares about moved', () => {
  const before = [endpoint()];
  assert.deepEqual(Audio.diffAudioEndpoints(before, [endpoint({ Volume: 10 })]), []);
  // Unmuting is not "muted"; an unknown format is not a change.
  assert.deepEqual(
    Audio.diffAudioEndpoints([endpoint({ Muted: true })], [endpoint({ Muted: false })]),
    []
  );
  assert.deepEqual(
    Audio.diffAudioEndpoints([endpoint()], [endpoint({ Channels: null, SampleRate: null })]),
    []
  );
});

test('diffAudioEndpoints reports a sample-rate-only change and a first default', () => {
  const rate = Audio.diffAudioEndpoints([endpoint()], [endpoint({ SampleRate: 96000 })]);
  assert.deepEqual(
    rate.map((c) => c.Kind),
    ['format_changed']
  );
  const firstDefault = Audio.diffAudioEndpoints(
    [endpoint({ IsDefault: false })],
    [endpoint({ IsDefault: true })]
  );
  assert.deepEqual(
    firstDefault.map((c) => [c.Kind, c.Previous]),
    [['default_changed', null]]
  );
  // The default going away with no replacement is covered by the disconnect.
  const goneDefault = Audio.diffAudioEndpoints([endpoint()], []);
  assert.deepEqual(
    goneDefault.map((c) => c.Kind),
    ['disconnected']
  );
});

// --- marking -----------------------------------------------------------------

test('resolveCriticalAudioEntry: a first mark captures the live baseline and sensible defaults', () => {
  const [error, entry] = Audio.resolveCriticalAudioEntry(
    'out-1',
    {},
    endpoint(),
    null,
    FULL_CAPS,
    1234
  );
  assert.equal(error, null);
  assert.deepEqual(entry, {
    EndpointID: 'out-1',
    Direction: 'output',
    Name: 'Scarlett 18i20',
    Channels: 20,
    SampleRate: 48000,
    RequireDefault: true,
    RequireUnmuted: true,
    MinVolume: null,
    MaxVolume: null,
    Timestamp: 1234,
  });
  // A non-default, muted endpoint is not expected to become default/unmuted.
  const [, quiet] = Audio.resolveCriticalAudioEntry(
    'out-1',
    {},
    endpoint({ IsDefault: false, Muted: true }),
    null,
    FULL_CAPS,
    1
  );
  assert.equal(quiet.RequireDefault, false);
  assert.equal(quiet.RequireUnmuted, false);
  // Nor is a default where the platform cannot name one.
  const [, alsa] = Audio.resolveCriticalAudioEntry(
    'out-1',
    {},
    endpoint(),
    null,
    { ...FULL_CAPS, DefaultDevice: false },
    1
  );
  assert.equal(alsa.RequireDefault, false);
});

test('resolveCriticalAudioEntry applies requested options and keeps the rest', () => {
  const existing = critical({ MinVolume: 70, MaxVolume: 90, Timestamp: 5 });
  const [, entry] = Audio.resolveCriticalAudioEntry(
    'out-1',
    { RequireDefault: false, MaxVolume: null, CheckSampleRate: false },
    endpoint({ Channels: 64 }),
    existing,
    FULL_CAPS,
    999
  );
  assert.equal(entry.RequireDefault, false);
  assert.equal(entry.RequireUnmuted, true, 'unspecified: kept');
  assert.equal(entry.MinVolume, 70);
  assert.equal(entry.MaxVolume, null, 'explicit null clears the bound');
  assert.equal(entry.SampleRate, null);
  assert.equal(entry.Channels, 64, 're-saving recaptures the live baseline');
  assert.equal(entry.Timestamp, 5, 'the original mark time is kept');
});

test('resolveCriticalAudioEntry lets a missing endpoint keep its baseline', () => {
  const existing = critical({ Channels: 64, SampleRate: 96000 });
  const [error, entry] = Audio.resolveCriticalAudioEntry(
    'out-1',
    { RequireUnmuted: false },
    null,
    existing,
    FULL_CAPS,
    1
  );
  assert.equal(error, null);
  assert.equal(entry.Channels, 64);
  assert.equal(entry.SampleRate, 96000);
  assert.equal(entry.Name, 'Scarlett 18i20');
  assert.equal(entry.Direction, 'output');
  assert.equal(entry.RequireUnmuted, false);
  // Unguarded stays unguarded on a later edit.
  const [, unguarded] = Audio.resolveCriticalAudioEntry(
    'out-1',
    {},
    endpoint(),
    critical({ Channels: null, SampleRate: null }),
    FULL_CAPS,
    1
  );
  assert.equal(unguarded.Channels, null);
  assert.equal(unguarded.SampleRate, null);
});

test('resolveCriticalAudioEntry refuses an unknown endpoint and crossed bounds', () => {
  assert.match(
    Audio.resolveCriticalAudioEntry('x', {}, null, null, FULL_CAPS, 1)[0],
    /not connected/
  );
  assert.match(
    Audio.resolveCriticalAudioEntry(
      'out-1',
      { MinVolume: 90, MaxVolume: 10 },
      endpoint(),
      null,
      FULL_CAPS,
      1
    )[0],
    /minimum level cannot be above/
  );
  // Crossing with a kept bound is caught as well.
  assert.ok(
    Audio.resolveCriticalAudioEntry(
      'out-1',
      { MinVolume: 95 },
      endpoint(),
      critical({ MaxVolume: 90 }),
      FULL_CAPS,
      1
    )[0]
  );
});

// --- control -------------------------------------------------------------------

test("audioControlRefusal reasons from the client's own scopes", () => {
  assert.equal(
    Audio.audioControlRefusal(endpoint(), FULL_CAPS, { Volume: 1, Muted: true }, 'Windows'),
    null
  );
  assert.match(
    Audio.audioControlRefusal(endpoint(), null, { Volume: 1 }, 'Windows'),
    /not reported/
  );
  assert.equal(
    Audio.audioControlRefusal(endpoint(), MAC_CAPS, { Volume: 1, Muted: true }, 'macOS'),
    null
  );
  assert.equal(
    Audio.audioControlRefusal(endpoint({ IsDefault: false }), MAC_CAPS, { Volume: 1 }, 'macOS'),
    'macOS can only change the level of the default output'
  );
  assert.equal(
    Audio.audioControlRefusal(endpoint({ Direction: 'input' }), MAC_CAPS, { Muted: true }, 'macOS'),
    'Changing the mute of this device is not available on macOS'
  );
  assert.equal(
    Audio.audioControlRefusal(endpoint({ Direction: 'input' }), MAC_CAPS, { Volume: 3 }, 'macOS'),
    null
  );
});
