const test = require('node:test');
const assert = require('node:assert/strict');

// The Audio Inputs and Audio Outputs sections of the client info modal — one
// section per direction, built by the same code.
//
// lib/audio-devices.ts holds the decisions — which state the section is in,
// what an outdated client sees, and every "not available on <OS>" sentence — and
// is tested directly. client-info-audio.ts builds the markup (a pure string
// function, tested as such) and wires the controls, which is tested through a
// small recording jQuery fake that answers only the call shapes it uses (no
// jsdom, by decision).
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/audio-devices.js');

const MAC_CAPS = {
  DefaultDevice: true,
  Channels: true,
  SampleRate: true,
  Transport: true,
  InputVolume: 'default',
  OutputVolume: 'default',
  InputMute: 'none',
  OutputMute: 'default',
};
const FULL_CAPS = {
  ...MAC_CAPS,
  InputVolume: 'device',
  OutputVolume: 'device',
  InputMute: 'device',
  OutputMute: 'device',
};
const ALSA_CAPS = {
  DefaultDevice: false,
  Channels: false,
  SampleRate: false,
  Transport: false,
  InputVolume: 'none',
  OutputVolume: 'none',
  InputMute: 'none',
  OutputMute: 'none',
};

function endpoint(overrides = {}) {
  return {
    EndpointID: 'coreaudio:output:apple-inc:macbook-pro-speakers',
    Direction: 'output',
    Name: 'MacBook Pro Speakers',
    Manufacturer: 'Apple Inc.',
    Transport: 'builtin',
    Channels: 2,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 31,
    Muted: false,
    IsConnected: true,
    IsCritical: false,
    Missing: false,
    Issues: [],
    Critical: null,
    ...overrides,
  };
}

function client(overrides = {}, audio = {}) {
  return {
    UUID: 'c1',
    Version: '3.21.0',
    Online: true,
    OperatingSystem: 'macOS 15',
    AudioDevices: {
      SampledAt: 1,
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'coreaudio' },
      Capabilities: MAC_CAPS,
      Endpoints: [endpoint()],
      ...audio,
    },
    ...overrides,
  };
}

// --- lib/audio-devices.ts -------------------------------------------------------

test('an outdated client reads as unsupported, whatever else it carries', () => {
  for (const Version of ['3.20.0', '3.20.99', '2.0.0', null, '', 'dev']) {
    assert.equal(Lib.GetAudioSectionState(client({ Version })), 'outdated', String(Version));
  }
  // Even offline: the version is what decides, not whether it is connected.
  assert.equal(Lib.GetAudioSectionState(client({ Version: '3.19.0', Online: false })), 'outdated');
  const message = Lib.AudioSectionMessage('outdated', client({ Version: '3.20.0' }), 'input');
  assert.equal(message.Title, 'Audio Inputs Unsupported');
  assert.match(message.Body, /needs ShowTrak Client 3\.21\.0 or later — this client runs 3\.20\.0/);
  assert.match(message.Body, /control its audio inputs\.$/);
  assert.equal(
    Lib.AudioSectionMessage('outdated', client({ Version: '3.20.0' }), 'output').Title,
    'Audio Outputs Unsupported'
  );
  assert.doesNotMatch(
    Lib.AudioSectionMessage('outdated', client({ Version: null }), 'input').Body,
    /runs/
  );
  assert.equal(Lib.MINIMUM_AUDIO_VERSION_LABEL, '3.21.0');
});

test('the section state follows the client and its last report', () => {
  assert.equal(Lib.GetAudioSectionState(client()), 'ok');
  assert.equal(Lib.GetAudioSectionState(client({ Version: 'v4.0.1' })), 'ok');
  assert.equal(Lib.GetAudioSectionState(client({ Online: false })), 'offline');
  assert.equal(Lib.GetAudioSectionState(client({ AudioDevices: undefined })), 'waiting');
  assert.equal(Lib.GetAudioSectionState(client({}, { SampledAt: null })), 'waiting');
  const state = (State) => Lib.GetAudioSectionState(client({}, { Status: { State } }));
  assert.equal(state('unsupported'), 'unsupported');
  assert.equal(state('error'), 'error');
  assert.equal(state('unknown'), 'waiting');
});

test('every non-ok state has a message, preferring what the client said', () => {
  const said = client(
    {},
    { Status: { State: 'error', Message: 'pactl crashed', Platform: 'linux' } }
  );
  assert.equal(Lib.AudioSectionMessage('error', said, 'input').Body, 'pactl crashed');
  assert.equal(Lib.AudioSectionMessage('unsupported', said, 'output').Body, 'pactl crashed');
  const silent = client(
    { OperatingSystem: 'FreeBSD 14' },
    { Status: { State: 'unsupported', Platform: '' } }
  );
  assert.deepEqual(Lib.AudioSectionMessage('unsupported', silent, 'input'), {
    Title: 'Audio Inputs Not Available',
    Body: 'Audio input monitoring is not available on FreeBSD 14.',
  });
  assert.equal(
    Lib.AudioSectionMessage('unsupported', silent, 'output').Body,
    'Audio output monitoring is not available on FreeBSD 14.'
  );
  assert.deepEqual(Lib.AudioSectionMessage('error', client({}, { Status: {} }), 'output'), {
    Title: 'Audio Outputs Warning',
    Body: 'The client failed to read its audio outputs.',
  });
  assert.deepEqual(Lib.AudioSectionMessage('waiting', client(), 'input'), {
    Title: 'Waiting for Audio Inputs',
    Body: 'This client has not reported its audio inputs yet.',
  });
  assert.deepEqual(Lib.AudioSectionMessage('offline', client(), 'output'), {
    Title: 'Client Offline',
    Body: 'Audio outputs are reported while the client is connected.',
  });
  assert.equal(Lib.AudioDirectionTitle('input'), 'Audio Inputs');
  assert.equal(Lib.AudioDirectionTitle('output'), 'Audio Outputs');
});

test('platform labels', () => {
  assert.equal(Lib.AudioPlatformLabel('darwin'), 'macOS');
  assert.equal(Lib.AudioPlatformLabel('win32'), 'Windows');
  assert.equal(Lib.AudioPlatformLabel('linux'), 'Linux');
  assert.equal(Lib.AudioPlatformLabel('sunos'), 'sunos');
  assert.equal(Lib.AudioPlatformLabel(null, '  '), "this client's operating system");
});

test('summaries, sample rates and the input/output split', () => {
  assert.equal(Lib.AudioEndpointSummary(endpoint()), 'Apple Inc. · Built-in · 2 ch · 48 kHz');
  assert.equal(
    Lib.AudioEndpointSummary(
      endpoint({ Manufacturer: null, Transport: 'unknown', Channels: null, SampleRate: 44100 })
    ),
    '44.1 kHz'
  );
  assert.equal(
    Lib.AudioEndpointSummary(
      endpoint({ Manufacturer: null, Transport: null, Channels: null, SampleRate: null })
    ),
    ''
  );
  assert.equal(Lib.FormatSampleRate(null), null);
  const all = [endpoint(), endpoint({ EndpointID: 'mic', Direction: 'input' })];
  assert.deepEqual(
    Lib.EndpointsFor(all, 'output').map((e) => e.EndpointID),
    ['coreaudio:output:apple-inc:macbook-pro-speakers']
  );
  assert.deepEqual(
    Lib.EndpointsFor(all, 'input').map((e) => e.EndpointID),
    ['mic']
  );
});

test('a control is offered only where the platform can reach it', () => {
  const can = (o, caps, kind) => Lib.CanControlAudio(endpoint(o), caps, kind);
  assert.equal(can({}, MAC_CAPS, 'Volume'), true);
  assert.equal(can({ IsDefault: false }, MAC_CAPS, 'Volume'), false, 'macOS: default only');
  assert.equal(can({ Direction: 'input' }, MAC_CAPS, 'Mute'), false, 'macOS: no input mute');
  assert.equal(can({ IsDefault: false }, FULL_CAPS, 'Mute'), true);
  assert.equal(can({ IsConnected: false }, FULL_CAPS, 'Volume'), false);
  assert.equal(can({}, null, 'Volume'), false);
});

test('the critical badge reflects every endpoint state', () => {
  const badge = (o) => Lib.AudioEndpointBadge(endpoint(o));
  assert.equal(badge({}).State, 'plain');
  assert.deepEqual(
    [badge({ IsCritical: true }).State, badge({ IsCritical: true }).Icon],
    ['healthy', 'bi-check-circle']
  );
  assert.equal(
    badge({ IsCritical: true, Issues: [{ Kind: 'muted', Message: 'Muted' }] }).Label,
    'Changed'
  );
  assert.equal(badge({ IsCritical: true, IsConnected: false, Missing: true }).Label, 'Missing');
  assert.equal(badge({ IsCritical: true, IsConnected: false }).State, 'unreported');
});

test('the render key ignores levels and mute, so a refresh never rebuilds under a drag', () => {
  const key = (c, state = 'ok', direction = 'output') => Lib.AudioRenderKey(c, state, direction);
  const base = key(client());
  assert.equal(key(client({}, { Endpoints: [endpoint({ Volume: 90, Muted: true })] })), base);
  assert.notEqual(key(client({}, { Endpoints: [endpoint({ IsDefault: false })] })), base);
  assert.notEqual(key(client({}, { Endpoints: [endpoint({ Volume: null })] })), base);
  assert.notEqual(
    key(client({}, { Endpoints: [endpoint({ Critical: { EndpointID: 'x' } })] })),
    base
  );
  // Ticking a condition is patched in place: only a row's supportedness counts.
  const ticked = (Critical) =>
    key(client({}, { Endpoints: [endpoint({ IsCritical: true, Critical })] }));
  assert.equal(ticked(critical()), ticked(critical({ RequireDefault: false, MinVolume: 40 })));
  assert.match(key(client({ Version: '3.0.0' }), 'outdated'), /::outdated::/);
  assert.match(key(client({ AudioDevices: undefined }), 'waiting'), /::waiting::$/);
});

test('each section keys only its own direction, so a new input never rebuilds the outputs', () => {
  const mic = endpoint({ EndpointID: 'mic', Direction: 'input', Name: 'Mic' });
  const before = client();
  const after = client({}, { Endpoints: [endpoint(), mic] });
  assert.equal(
    Lib.AudioRenderKey(before, 'ok', 'output'),
    Lib.AudioRenderKey(after, 'ok', 'output')
  );
  assert.notEqual(
    Lib.AudioRenderKey(before, 'ok', 'input'),
    Lib.AudioRenderKey(after, 'ok', 'input')
  );
  // The two sections never share a key, even for a message state.
  assert.notEqual(
    Lib.AudioRenderKey(before, 'waiting', 'input'),
    Lib.AudioRenderKey(before, 'waiting', 'output')
  );
});

test('the conditions form parses into a request, or says what is wrong', () => {
  const fields = {
    RequireDefault: true,
    RequireUnmuted: false,
    CheckChannels: true,
    CheckSampleRate: false,
    MinVolume: ' 80 ',
    MaxVolume: '',
  };
  assert.deepEqual(Lib.ParseAudioRuleFields('e', fields), {
    Payload: {
      EndpointID: 'e',
      RequireDefault: true,
      RequireUnmuted: false,
      CheckChannels: true,
      CheckSampleRate: false,
      MinVolume: 80,
      MaxVolume: null,
    },
  });
  assert.match(
    Lib.ParseAudioRuleFields('e', { ...fields, MinVolume: '120' }).Error,
    /Minimum level/
  );
  assert.match(
    Lib.ParseAudioRuleFields('e', { ...fields, MaxVolume: 'loud' }).Error,
    /Maximum level/
  );
  assert.match(
    Lib.ParseAudioRuleFields('e', { ...fields, MaxVolume: '10' }).Error,
    /cannot be above/
  );
  assert.equal(Lib.ParseLevelInput('49.6'), 50);
  assert.equal(Lib.ParseLevelInput(150), 100);
  assert.equal(Lib.ParseLevelInput(-1), 0);
  assert.equal(Lib.ParseLevelInput('x'), null);
});

function critical(overrides = {}) {
  return {
    EndpointID: 'x',
    Channels: 2,
    SampleRate: 48000,
    RequireDefault: true,
    RequireUnmuted: false,
    MinVolume: null,
    MaxVolume: null,
    ...overrides,
  };
}

test('condition rows read key-value style, with what the device reports now', () => {
  const rows = Lib.AudioConditionRows(
    endpoint({ IsCritical: true, Critical: critical({ MinVolume: 20 }) }),
    MAC_CAPS
  );
  assert.deepEqual(
    rows.map((r) => [r.Field, r.Label, r.Value, r.Supported, r.Checked, r.Bound]),
    [
      ['RequireDefault', 'Is default output', 'Yes', true, true, null],
      ['CheckChannels', 'Channels', '2', true, true, null],
      ['CheckSampleRate', 'Sample rate', '48 kHz', true, true, null],
      ['RequireUnmuted', 'Is muted', 'No', true, false, null],
      ['MinVolume', 'Minimum level', '31%', true, true, 20],
      ['MaxVolume', 'Maximum level', '31%', true, false, null],
    ]
  );
  assert.equal(
    Lib.AudioConditionRows(
      endpoint({ Direction: 'input', IsDefault: false, IsCritical: true, Critical: critical() }),
      MAC_CAPS
    )[0].Label,
    'Is default input'
  );
  assert.deepEqual(Lib.AudioConditionRows(endpoint(), MAC_CAPS), [], 'not critical: no table');
});

test('a condition the device cannot be held to reads Unsupported, unless already set', () => {
  const row = (o, caps, field) =>
    Lib.AudioConditionRows(endpoint({ IsCritical: true, ...o }), caps).find(
      (r) => r.Field === field
    );
  const linux = {
    Critical: critical({ RequireDefault: false, Channels: null }),
    Volume: null,
    Muted: null,
  };
  for (const field of ['RequireDefault', 'CheckChannels', 'RequireUnmuted', 'MinVolume']) {
    assert.deepEqual(
      [row(linux, ALSA_CAPS, field).Value, row(linux, ALSA_CAPS, field).Supported],
      ['Unsupported', false],
      field
    );
  }
  // Set before the platform lost it: still shown, so it can be cleared.
  const set = {
    Critical: critical({ RequireUnmuted: true, MaxVolume: 90 }),
    Volume: null,
    Muted: null,
  };
  assert.equal(row(set, ALSA_CAPS, 'RequireUnmuted').Supported, true);
  assert.equal(row(set, ALSA_CAPS, 'RequireUnmuted').Value, '—');
  assert.equal(row(set, ALSA_CAPS, 'MaxVolume').Bound, 90);
  // Not connected: judged by what the platform promises, values unknown.
  const away = {
    IsConnected: false,
    Missing: true,
    Volume: null,
    Muted: null,
    Critical: critical(),
  };
  assert.equal(row(away, FULL_CAPS, 'RequireDefault').Value, '—');
  assert.equal(row(away, FULL_CAPS, 'MinVolume').Supported, true);
  assert.equal(row(away, MAC_CAPS, 'RequireUnmuted').Supported, true);
  assert.equal(
    row({ ...away, Direction: 'input' }, MAC_CAPS, 'RequireUnmuted').Supported,
    false,
    'macOS has no input mute at all'
  );
  assert.equal(row({ ...away, Channels: null }, MAC_CAPS, 'CheckChannels').Value, '—');
  assert.equal(row({ ...away, SampleRate: null }, MAC_CAPS, 'CheckSampleRate').Value, '—');
});

test('a condition that is not met is flagged on its own row', () => {
  const rows = (o) =>
    Object.fromEntries(
      Lib.AudioConditionRows(endpoint({ IsCritical: true, ...o }), FULL_CAPS).map((r) => [
        r.Field,
        r.Failing,
      ])
    );
  const low = rows({
    Volume: 10,
    Critical: critical({ MinVolume: 50, MaxVolume: 90 }),
    Issues: [{ Kind: 'volume', Message: 'Level is 10% (expected 50–90%)' }],
  });
  assert.equal(low.MinVolume, 'Level is 10% (expected 50–90%)');
  assert.equal(low.MaxVolume, null);
  const high = rows({
    Volume: 95,
    Critical: critical({ MinVolume: 50, MaxVolume: 90 }),
    Issues: [{ Kind: 'volume', Message: 'too loud' }],
  });
  assert.deepEqual([high.MinVolume, high.MaxVolume], [null, 'too loud']);
  const changed = rows({
    IsDefault: false,
    Critical: critical({ RequireUnmuted: true }),
    Issues: [
      { Kind: 'not_default', Message: 'No longer the default output' },
      { Kind: 'channels', Message: '2 channels (expected 64)' },
      { Kind: 'sample_rate', Message: 'rate' },
      { Kind: 'muted', Message: 'Muted' },
    ],
  });
  assert.equal(changed.RequireDefault, 'No longer the default output');
  assert.equal(changed.CheckChannels, '2 channels (expected 64)');
  assert.equal(changed.CheckSampleRate, 'rate');
  assert.equal(changed.RequireUnmuted, 'Muted');
  assert.equal(rows({ Critical: critical() }).RequireDefault, null);
});

test('timeline live state never paints what was not observed', () => {
  const live = (o, online = true) =>
    Lib.AudioTimelineLiveState(endpoint({ IsCritical: true, ...o }), online);
  assert.deepEqual(live({}, false), { State: 'IDLE', Label: 'Idle' });
  assert.deepEqual(live({}), { State: 'ONLINE', Label: 'Connected' });
  assert.deepEqual(live({ IsConnected: false, Missing: true }), {
    State: 'OFFLINE',
    Label: 'Missing',
  });
  assert.deepEqual(live({ IsConnected: false }), { State: 'IDLE', Label: 'Not Reported' });
  assert.deepEqual(
    live({ Issues: [{ Message: 'Muted' }, { Message: '2 channels (expected 64)' }] }),
    { State: 'DEGRADED', Label: 'Muted; 2 channels (expected 64)' }
  );
});

test('IsVersionAtLeast compares numerically and fails closed', () => {
  assert.equal(Lib.IsVersionAtLeast('3.21.0', [3, 21, 0]), true);
  assert.equal(Lib.IsVersionAtLeast('3.100.0', [3, 21, 0]), true);
  assert.equal(Lib.IsVersionAtLeast('3.9.9', [3, 21, 0]), false);
  assert.equal(Lib.IsVersionAtLeast(undefined, [3, 21, 0]), false);
});

// --- client-info-audio.ts: markup ----------------------------------------------

global.$ = () => ({});
const Audio = require('../dist-test/UI/js/app/client-info-audio.js');

test('an outdated client gets one "unsupported" card per section and nothing else', () => {
  const outdated = client({ Version: '3.20.0' });
  const inputs = Audio.BuildAudioSectionHtml(outdated, 'outdated', 'input');
  const outputs = Audio.BuildAudioSectionHtml(outdated, 'outdated', 'output');
  assert.match(inputs, /Audio Inputs Unsupported/);
  assert.match(outputs, /Audio Outputs Unsupported/);
  for (const html of [inputs, outputs]) {
    assert.match(html, /3\.21\.0 or later/);
    assert.doesNotMatch(html, /SHOWTRAK_AUDIO_CARD|SHOWTRAK_AUDIO_LEVEL/);
  }
});

test('waiting and unsupported states render their message alone, in each section', () => {
  assert.match(
    Audio.BuildAudioSectionHtml(client(), 'waiting', 'input'),
    /Waiting for Audio Inputs/
  );
  assert.match(
    Audio.BuildAudioSectionHtml(client(), 'waiting', 'output'),
    /Waiting for Audio Outputs/
  );
  const unsupported = client(
    {},
    { Status: { State: 'unsupported', Message: 'No audio stack', Platform: 'linux' } }
  );
  for (const direction of ['input', 'output']) {
    const html = Audio.BuildAudioSectionHtml(unsupported, 'unsupported', direction);
    assert.match(html, /Not Available/);
    assert.match(html, /No audio stack/);
    assert.doesNotMatch(html, /SHOWTRAK_AUDIO_CARD/);
  }
});

test('each section lists only its own direction, with no notes about the platform', () => {
  const both = client(
    {},
    {
      Status: {
        State: 'ok',
        Message: 'pactl is not installed',
        Platform: 'darwin',
        Backend: 'coreaudio',
      },
      Endpoints: [
        endpoint(),
        endpoint({
          EndpointID: 'mic',
          Direction: 'input',
          Name: 'Mic',
          IsDefault: false,
          Volume: null,
        }),
      ],
    }
  );
  const outputs = Audio.BuildAudioSectionHtml(both, 'ok', 'output');
  const inputs = Audio.BuildAudioSectionHtml(both, 'ok', 'input');
  for (const html of [outputs, inputs]) {
    assert.doesNotMatch(html, /Read via|pactl is not installed|Not available on|only exposes/);
  }
  // Default output: slider + mute, and only output cards.
  assert.match(outputs, /SHOWTRAK_AUDIO_DEFAULT_BADGE/);
  assert.match(outputs, /MacBook Pro Speakers/);
  assert.doesNotMatch(outputs, />Mic</);
  assert.match(outputs, /class="form-range SHOWTRAK_AUDIO_LEVEL"[^>]*value="31"/);
  assert.match(outputs, /SHOWTRAK_AUDIO_MUTE/);
  // Non-default input on macOS: no controls, and nothing saying why.
  assert.match(inputs, />Mic</);
  assert.doesNotMatch(inputs, /MacBook Pro Speakers/);
  assert.doesNotMatch(
    inputs,
    /SHOWTRAK_AUDIO_LEVEL|SHOWTRAK_AUDIO_MUTE|<small class="d-block text-light/
  );
});

test('a card titles like a display card: no icon, title and subtitle left-aligned', () => {
  const html = Audio.BuildAudioSectionHtml(client(), 'ok', 'output');
  assert.doesNotMatch(html, /bi-(speaker|mic)\b|SHOWTRAK_AUDIO_ICON/);
  assert.match(
    html,
    /<div class="SHOWTRAK_AUDIO_TITLE text-start">\s*<h6 class="mb-0">MacBook Pro Speakers/
  );
  assert.match(
    html,
    /<small class="text-light d-block mb-0 text-start">Apple Inc\. · Built-in · 2 ch · 48 kHz<\/small>/
  );
});

test('an empty direction says so in its own section in the ok state', () => {
  const outputsOnly = client({}, { Endpoints: [endpoint()] });
  const inputs = Audio.BuildAudioSectionHtml(outputsOnly, 'ok', 'input');
  assert.match(inputs, /No Audio Inputs/);
  assert.match(inputs, /reports no audio inputs/);
  assert.doesNotMatch(Audio.BuildAudioSectionHtml(outputsOnly, 'ok', 'output'), /No Audio/);
});

test('names and messages are escaped, ids are URI-encoded', () => {
  const html = Audio.BuildAudioSectionHtml(
    client(
      {},
      {
        Endpoints: [
          endpoint({
            EndpointID: 'pulse:output:"><img src=x>',
            Name: '<script>alert(1)</script>',
            IsCritical: true,
            Issues: [{ Kind: 'muted', Message: '<b>Muted</b>' }],
            Critical: {
              EndpointID: 'x',
              Channels: 2,
              SampleRate: 48000,
              RequireDefault: true,
              RequireUnmuted: true,
              MinVolume: null,
              MaxVolume: null,
            },
          }),
        ],
      }
    ),
    'ok',
    'output'
  );
  assert.doesNotMatch(html, /<script>|<img|<b>Muted/);
  assert.match(html, /data-endpoint="pulse%3Aoutput%3A%22%3E%3Cimg%20src%3Dx%3E"/);
});

test('a critical endpoint gets a conditions table, with unsupported rows saying so', () => {
  const html = Audio.BuildAudioSectionHtml(
    client(
      {},
      {
        Capabilities: ALSA_CAPS,
        Status: { State: 'ok', Platform: 'linux', Backend: 'alsa' },
        Endpoints: [
          endpoint({
            EndpointID: 'dvs',
            Name: 'DVS',
            IsCritical: true,
            Critical: critical({ Channels: 64, RequireDefault: false, MinVolume: 80 }),
            Channels: 64,
            Volume: null,
            Muted: null,
            IsDefault: false,
          }),
        ],
      }
    ),
    'ok',
    'output'
  );
  assert.match(html, /<table class="SHOWTRAK_AUDIO_CONDITIONS" data-endpoint="dvs">/);
  assert.doesNotMatch(html, /<details|Save Conditions|SHOWTRAK_AUDIO_RULES/);
  const row = (field) => new RegExp(`<tr data-cond="${field}"[\\s\\S]*?</tr>`).exec(html)[0];
  // Unsupported: the value says so and there is nothing to tick.
  assert.match(row('RequireDefault'), /Is default output/);
  assert.match(row('RequireDefault'), /is-unsupported/);
  assert.match(row('RequireDefault'), />Unsupported</);
  assert.doesNotMatch(row('RequireDefault'), /type="checkbox"/);
  assert.match(row('RequireUnmuted'), />Unsupported</);
  // Set while the platform could not report it: kept, with its tick, so it can be cleared.
  assert.match(row('CheckChannels'), />64</);
  assert.match(row('CheckChannels'), /type="checkbox"[^>]*data-rule="CheckChannels"\s+checked/);
  assert.match(row('MinVolume'), /type="number"[^>]*data-rule="MinVolume"[^>]*value="80"/);
  assert.match(row('MinVolume'), /data-rule="MinVolume"\s+checked/);
  assert.match(row('MaxVolume'), />Unsupported</);
});

test('a failing condition row is marked and explains itself', () => {
  const html = Audio.BuildAudioSectionHtml(
    client(
      {},
      {
        Endpoints: [
          endpoint({
            IsCritical: true,
            Critical: critical({ MinVolume: 50 }),
            Issues: [{ Kind: 'volume', Message: 'Level is 31% (expected at least 50%)' }],
          }),
        ],
      }
    ),
    'ok',
    'output'
  );
  assert.match(
    html,
    /<tr data-cond="MinVolume" class=" is-failing"\s+title="Level is 31% \(expected at least 50%\)">/
  );
  assert.match(html, /<tr data-cond="MaxVolume" class=" "/);
  // An unset bound offers the current level as its hint.
  assert.match(html, /data-rule="MaxVolume"\s+value="" placeholder="31"\s+data-current="31"/);
});

test('a missing critical endpoint shows its baseline and the red badge, without controls', () => {
  const html = Audio.BuildAudioSectionHtml(
    client(
      {},
      {
        Endpoints: [
          endpoint({
            IsConnected: false,
            Missing: true,
            IsCritical: true,
            IsDefault: false,
            Channels: null,
            SampleRate: null,
            Volume: null,
            Muted: null,
            Issues: [{ Kind: 'missing', Message: 'MacBook Pro Speakers is not connected' }],
            Critical: {
              EndpointID: 'x',
              Channels: null,
              SampleRate: null,
              RequireDefault: false,
              RequireUnmuted: false,
              MinVolume: null,
              MaxVolume: null,
            },
          }),
        ],
      }
    ),
    'ok',
    'output'
  );
  assert.match(html, /is-disconnected-critical/);
  assert.match(html, /Not connected/);
  assert.match(html, /SHOWTRAK_AUDIO_CONDITIONS/);
  assert.match(html, /<span class="SHOWTRAK_AUDIO_COND_VALUE">—<\/span>/);
  assert.doesNotMatch(html, /SHOWTRAK_AUDIO_LEVEL"/);
  // Level stays supported: macOS can read the default output's level once it is back.
  assert.match(html, /data-rule="MinVolume"\s+value="" placeholder=""/);
});

test('offline and error states keep the critical baselines visible below the message', () => {
  const missing = endpoint({ IsConnected: false, IsCritical: true, Volume: null, Muted: null });
  const offlineClient = client({ Online: false }, { Endpoints: [missing] });
  const offline = Audio.BuildAudioSectionHtml(offlineClient, 'offline', 'output');
  assert.match(offline, /Client Offline/);
  assert.match(offline, /Not reported yet/);
  // The inputs section has no baselines: just the message, no "no inputs" finding.
  const offlineInputs = Audio.BuildAudioSectionHtml(offlineClient, 'offline', 'input');
  assert.match(offlineInputs, /Audio inputs are reported while the client is connected/);
  assert.doesNotMatch(offlineInputs, /SHOWTRAK_AUDIO_CARD|No Audio Inputs/);
  const error = Audio.BuildAudioSectionHtml(
    client({}, { Status: { State: 'error', Message: 'boom' }, Endpoints: [] }),
    'error',
    'input'
  );
  assert.match(error, /bg-danger/);
  assert.match(error, /boom/);
  assert.doesNotMatch(error, /No Audio Inputs/);
});

test('a device without a software level draws no slider, and no note', () => {
  const html = Audio.BuildAudioSectionHtml(
    client({}, { Capabilities: FULL_CAPS, Endpoints: [endpoint({ Volume: null, Muted: null })] }),
    'ok',
    'output'
  );
  assert.doesNotMatch(html, /SHOWTRAK_AUDIO_LEVEL_ROW|SHOWTRAK_AUDIO_MUTE|software level/);
});

// --- client-info-audio.ts: DOM behaviour (recording jQuery fake) -----------------

/** A tiny element model: attributes, value, text, classes, and child lookups. */
function node(init = {}) {
  const n = {
    attrs: { ...(init.attrs || {}) },
    value: init.value,
    textValue: '',
    htmlValue: null,
    classes: new Set(init.classes || []),
    focused: !!init.focused,
    children: init.children || {},
    closestMap: init.closest || {},
    siblingsMap: init.siblings || {},
    handlers: [],
    triggered: [],
    open: init.open,
    length: init.length === 0 ? 0 : 1,
  };
  Object.assign(n, {
    attr(k, v) {
      if (v === undefined) return n.attrs[k];
      n.attrs[k] = String(v);
      return n;
    },
    removeAttr(k) {
      delete n.attrs[k];
      return n;
    },
    val(v) {
      if (v === undefined) return n.value;
      n.value = v;
      return n;
    },
    text(v) {
      n.textValue = v;
      return n;
    },
    html(v) {
      n.htmlValue = v;
      return n;
    },
    toggleClass(c, on) {
      if (on) n.classes.add(c);
      else n.classes.delete(c);
      return n;
    },
    prop(k, v) {
      if (v === undefined) return n[k];
      n[k] = v;
      return n;
    },
    is(sel) {
      if (sel === ':focus') return n.focused;
      if (sel === ':checked') return !!n.checked;
      return false;
    },
    find(sel) {
      return n.children[sel] || node({ length: 0 });
    },
    closest(sel) {
      return n.closestMap[sel] || node({ length: 0 });
    },
    siblings(sel) {
      return n.siblingsMap[sel] || node({ length: 0 });
    },
    trigger(evt) {
      n.triggered.push(evt);
      return n;
    },
    off() {
      return n;
    },
    on(evt, sel, fn) {
      n.handlers.push({ evt, sel, fn });
      return n;
    },
  });
  return n;
}

function installDom(registry) {
  global.$ = (arg) => (typeof arg === 'string' ? registry[arg] || node({ length: 0 }) : arg);
  global.CSS = { escape: (v) => String(v) };
}

const SPEAKERS = 'coreaudio:output:apple-inc:macbook-pro-speakers';
const enc = encodeURIComponent;

test('RenderClientInfoAudio rebuilds on a structural change and patches levels otherwise', () => {
  const list = node();
  const inputs = node();
  installDom({
    '#SHOWTRAK_CLIENT_INFO_AUDIO_OUTPUTS': list,
    '#SHOWTRAK_CLIENT_INFO_AUDIO_INPUTS': inputs,
  });
  Audio.RenderClientInfoAudio(client());
  assert.match(list.htmlValue, /MacBook Pro Speakers/);
  assert.match(inputs.htmlValue, /No Audio Inputs/);
  const firstKey = list.attrs['data-render-key'];

  // Same structure, new level: patched in place, not rebuilt.
  const slider = node({ value: '31' });
  const label = node();
  const icon = node();
  const mute = node({ children: { i: icon } });
  list.children[`.SHOWTRAK_AUDIO_CARD[data-endpoint="${enc(SPEAKERS)}"]`] = node({
    children: {
      '.SHOWTRAK_AUDIO_LEVEL': slider,
      '.SHOWTRAK_AUDIO_LEVEL_VALUE': label,
      '.SHOWTRAK_AUDIO_MUTE': mute,
    },
  });
  list.htmlValue = null;
  Audio.RenderClientInfoAudio(client({}, { Endpoints: [endpoint({ Volume: 64, Muted: true })] }));
  assert.equal(list.htmlValue, null, 'not rebuilt');
  assert.equal(list.attrs['data-render-key'], firstKey);
  assert.equal(slider.value, '64');
  assert.equal(label.textValue, '64%');
  assert.equal(mute.classes.has('is-muted'), true);
  assert.equal(mute.attrs['data-muted'], '1');
  assert.equal(mute.attrs.title, 'Unmute');
  assert.equal(icon.attrs.class, 'bi bi-volume-mute');

  // Unmuting flips it back.
  Audio.RenderClientInfoAudio(client({}, { Endpoints: [endpoint({ Volume: 64, Muted: false })] }));
  assert.equal(mute.classes.has('is-muted'), false);
  assert.equal(icon.attrs.class, 'bi bi-volume-up');

  // A new input rebuilds the inputs section and leaves the outputs alone.
  inputs.htmlValue = null;
  Audio.RenderClientInfoAudio(
    client({}, { Endpoints: [endpoint(), endpoint({ EndpointID: 'mic', Direction: 'input' })] })
  );
  assert.equal(list.htmlValue, null, 'outputs not rebuilt');
  assert.match(inputs.htmlValue, /SHOWTRAK_AUDIO_CARD/);
});

test('an outdated client shows an unsupported message in both sections', () => {
  const outputs = node();
  const inputs = node();
  installDom({
    '#SHOWTRAK_CLIENT_INFO_AUDIO_OUTPUTS': outputs,
    '#SHOWTRAK_CLIENT_INFO_AUDIO_INPUTS': inputs,
  });
  Audio.RenderClientInfoAudio(client({ Version: '3.20.0' }));
  assert.match(inputs.htmlValue, /Audio Inputs Unsupported/);
  assert.match(outputs.htmlValue, /Audio Outputs Unsupported/);

  Audio.ClearClientInfoAudio();
  for (const list of [inputs, outputs]) {
    assert.equal(list.htmlValue, '');
    assert.equal(list.attrs['data-render-key'], '');
  }
});

test('PatchAudioLevels leaves a slider alone while the operator is holding it', () => {
  const slider = node({ value: '10', focused: true });
  const dragging = node({ value: '20', attrs: { 'data-dragging': '1' } });
  const list = node({
    children: {
      [`.SHOWTRAK_AUDIO_CARD[data-endpoint="${enc('a')}"]`]: node({
        children: { '.SHOWTRAK_AUDIO_LEVEL': slider },
      }),
      [`.SHOWTRAK_AUDIO_CARD[data-endpoint="${enc('b')}"]`]: node({
        children: { '.SHOWTRAK_AUDIO_LEVEL': dragging },
      }),
    },
  });
  installDom({});
  Audio.PatchAudioLevels(
    list,
    client(
      {},
      {
        Endpoints: [
          endpoint({ EndpointID: 'a', Volume: 90 }),
          endpoint({ EndpointID: 'b', Volume: 90 }),
          endpoint({ EndpointID: 'gone' }),
        ],
      }
    )
  );
  assert.equal(slider.value, '10');
  assert.equal(dragging.value, '20');
  // A client without audio patches nothing.
  Audio.PatchAudioLevels(list, { UUID: 'x' });
});

test('PatchAudioLevels patches ticks, readings and bounds, but not a bound being typed', () => {
  const row = (children) => node({ children });
  const check = () => node();
  const value = node();
  const muted = row({ 'input[type="checkbox"]': check(), '.SHOWTRAK_AUDIO_COND_VALUE': value });
  const minNumber = node({ value: '5' });
  const typing = node({ value: '9', focused: true });
  const min = row({ 'input[type="checkbox"]': check(), 'input[type="number"]': minNumber });
  const max = row({ 'input[type="checkbox"]': check(), 'input[type="number"]': typing });
  const card = node({
    children: {
      '[data-cond="RequireUnmuted"]': muted,
      '[data-cond="MinVolume"]': min,
      '[data-cond="MaxVolume"]': max,
      // RequireDefault/Channels/SampleRate rows absent: skipped.
    },
  });
  const list = node({
    children: { [`.SHOWTRAK_AUDIO_CARD[data-endpoint="${enc(SPEAKERS)}"]`]: card },
  });
  installDom({});
  Audio.PatchAudioLevels(
    list,
    client(
      {},
      {
        Endpoints: [
          endpoint({
            Muted: true,
            Volume: 44,
            IsCritical: true,
            Critical: critical({ RequireUnmuted: true, MinVolume: 30, MaxVolume: 80 }),
          }),
        ],
      }
    )
  );
  assert.equal(muted.children['input[type="checkbox"]'].checked, true);
  assert.equal(value.textValue, 'Yes');
  assert.equal(min.children['input[type="checkbox"]'].checked, true);
  assert.equal(minNumber.value, '30');
  assert.equal(minNumber.attrs['data-current'], '44');
  assert.equal(minNumber.attrs.placeholder, '44');
  assert.equal(typing.value, '9', 'the operator is typing here');

  // A bound row without its input (Unsupported) is left alone; cleared bounds empty.
  delete min.children['input[type="number"]'];
  Audio.PatchAudioLevels(
    list,
    client(
      {},
      {
        Endpoints: [
          endpoint({ Volume: null, IsCritical: true, Critical: critical({ MaxVolume: null }) }),
        ],
      }
    )
  );
  assert.equal(max.children['input[type="checkbox"]'].checked, false);
  assert.equal(typing.attrs['data-current'], '');
  typing.focused = false;
  Audio.PatchAudioLevels(
    list,
    client({}, { Endpoints: [endpoint({ IsCritical: true, Critical: critical() })] })
  );
  assert.equal(typing.value, '');
});

function bindHarness({ api = {}, uuid = 'c1' } = {}) {
  const list = node();
  // Both sections share one delegated binding.
  installDom({ ['#SHOWTRAK_CLIENT_INFO_AUDIO_INPUTS, #SHOWTRAK_CLIENT_INFO_AUDIO_OUTPUTS']: list });
  const calls = [];
  const notes = [];
  let refreshes = 0;
  global.window = {
    API: {
      MarkClientAudioDeviceCritical: async (...a) => (
        calls.push(['Mark', ...a]),
        api.mark || [null, true]
      ),
      RemoveClientAudioDeviceCritical: async (...a) => (
        calls.push(['Remove', ...a]),
        api.remove || [null, true]
      ),
      SetClientAudioLevel: async (...a) => (calls.push(['Set', ...a]), api.set || [null, true]),
    },
  };
  Audio.BindClientInfoAudioHandlers(
    () => uuid,
    async () => {
      refreshes += 1;
    },
    (message, type) => notes.push([message, type])
  );
  const handler = (evt, sel) => list.handlers.find((h) => h.evt === evt && h.sel === sel).fn;
  return { list, calls, notes, handler, refreshes: () => refreshes };
}

test('the critical toggle marks or unmarks and refreshes', async () => {
  const H = bindHarness();
  const toggle = H.handler('click.client-audio', '.SHOWTRAK_TOGGLE_CRITICAL_AUDIO');
  await toggle.call(node({ attrs: { 'data-endpoint': enc(SPEAKERS), 'data-critical': '0' } }));
  assert.deepEqual(H.calls[0], ['Mark', 'c1', { EndpointID: SPEAKERS }]);
  await toggle.call(node({ attrs: { 'data-endpoint': enc(SPEAKERS), 'data-critical': '1' } }));
  assert.deepEqual(H.calls[1], ['Remove', 'c1', SPEAKERS]);
  assert.equal(H.refreshes(), 2);
  assert.deepEqual(
    H.notes.map((n) => n[1]),
    ['success', 'success']
  );
});

test('the critical toggle reports a refusal and ignores a click without an id', async () => {
  const H = bindHarness({
    api: { mark: ['That audio device is not connected to this client', null] },
  });
  const toggle = H.handler('click.client-audio', '.SHOWTRAK_TOGGLE_CRITICAL_AUDIO');
  await toggle.call(node({ attrs: { 'data-endpoint': 'x', 'data-critical': '0' } }));
  assert.deepEqual(H.notes, [['That audio device is not connected to this client', 'error']]);
  await toggle.call(node({ attrs: {} }));
  assert.equal(H.calls.length, 1);
  assert.equal(H.refreshes(), 0);
});

/**
 * A conditions table as the change handler sees it. `state` maps each field to
 * a tick (or, for the level bounds, `{ checked, value, current }`); a field left
 * out is an Unsupported row with no inputs.
 */
function conditionsTable(state, endpointId = 'dvs') {
  const table = node({ attrs: { 'data-endpoint': enc(endpointId) } });
  const list = node();
  table.closestMap['[data-render-key]'] = list;
  const inputs = {};
  for (const [field, value] of Object.entries(state)) {
    const bound = typeof value === 'object';
    const row = node();
    const check = node({ attrs: { type: 'checkbox', 'data-rule': field } });
    check.checked = bound ? value.checked : value;
    row.children['input[type="checkbox"]'] = check;
    table.children[`input[type="checkbox"][data-rule="${field}"]`] = check;
    inputs[field] = { check, row };
    if (bound) {
      const number = node({
        attrs: { type: 'number', 'data-rule': field, 'data-current': value.current ?? '' },
        value: value.value,
      });
      row.children['input[type="number"]'] = number;
      table.children[`input[type="number"][data-rule="${field}"]`] = number;
      inputs[field].number = number;
    }
    for (const input of [check, inputs[field].number].filter(Boolean)) {
      input.closestMap['.SHOWTRAK_AUDIO_CONDITIONS'] = table;
      input.closestMap['[data-cond]'] = row;
    }
  }
  return { table, list, inputs };
}

const FULL_FORM = () => ({
  RequireDefault: true,
  CheckChannels: true,
  CheckSampleRate: false,
  RequireUnmuted: false,
  MinVolume: { checked: true, value: '20', current: '31' },
  MaxVolume: { checked: false, value: '', current: '31' },
});

test('ticking a condition saves the whole table at once', async () => {
  const H = bindHarness();
  const change = H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input');
  const T = conditionsTable(FULL_FORM());
  await change.call(T.inputs.RequireDefault.check);
  assert.deepEqual(H.calls, [
    [
      'Mark',
      'c1',
      {
        EndpointID: 'dvs',
        RequireDefault: true,
        RequireUnmuted: false,
        CheckChannels: true,
        CheckSampleRate: false,
        MinVolume: 20,
        MaxVolume: null,
      },
    ],
  ]);
  assert.equal(H.refreshes(), 1);
  assert.deepEqual(H.notes, [], 'no toast for a routine save');
});

test('an Unsupported row (no tick) saves as not monitored', async () => {
  const H = bindHarness();
  const T = conditionsTable({ CheckChannels: true });
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input').call(
    T.inputs.CheckChannels.check
  );
  assert.deepEqual(H.calls[0][2], {
    EndpointID: 'dvs',
    RequireDefault: false,
    RequireUnmuted: false,
    CheckChannels: true,
    CheckSampleRate: false,
    MinVolume: null,
    MaxVolume: null,
  });
});

test('ticking a level bound starts it at the current level; unticking clears it', async () => {
  const H = bindHarness();
  const change = H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input');
  const T = conditionsTable(FULL_FORM());
  T.inputs.MaxVolume.check.checked = true;
  await change.call(T.inputs.MaxVolume.check);
  assert.equal(T.inputs.MaxVolume.number.value, '31');
  assert.equal(H.calls.at(-1)[2].MaxVolume, 31);

  // No level reported: the widest bound, so ticking alone never raises an alert.
  T.inputs.MaxVolume.number.value = '';
  T.inputs.MaxVolume.number.attrs['data-current'] = '';
  await change.call(T.inputs.MaxVolume.check);
  assert.equal(H.calls.at(-1)[2].MaxVolume, 100);
  T.inputs.MinVolume.number.value = '';
  T.inputs.MinVolume.number.attrs['data-current'] = '';
  await change.call(T.inputs.MinVolume.check);
  assert.equal(H.calls.at(-1)[2].MinVolume, 0);

  T.inputs.MinVolume.check.checked = false;
  await change.call(T.inputs.MinVolume.check);
  assert.equal(T.inputs.MinVolume.number.value, '');
  assert.equal(H.calls.at(-1)[2].MinVolume, null);
});

test('typing a level bound ticks it; clearing it unticks', async () => {
  const H = bindHarness();
  const change = H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input');
  const T = conditionsTable(FULL_FORM());
  T.inputs.MaxVolume.number.value = '90';
  await change.call(T.inputs.MaxVolume.number);
  assert.equal(T.inputs.MaxVolume.check.checked, true);
  assert.equal(H.calls.at(-1)[2].MaxVolume, 90);
  T.inputs.MaxVolume.number.value = ' ';
  await change.call(T.inputs.MaxVolume.number);
  assert.equal(T.inputs.MaxVolume.check.checked, false);
  assert.equal(H.calls.at(-1)[2].MaxVolume, null);
});

test('a bad bound never leaves the renderer and the saved state is put back', async () => {
  const H = bindHarness();
  const T = conditionsTable(FULL_FORM());
  T.list.attrs['data-render-key'] = 'k';
  T.inputs.MaxVolume.number.value = '10';
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input').call(
    T.inputs.MaxVolume.number
  );
  assert.equal(H.calls.length, 0, 'crossed bounds never leave the renderer');
  assert.match(H.notes.at(-1)[0], /cannot be above/);
  assert.equal(T.list.attrs['data-render-key'], '', 'forces a rebuild from what is saved');
  assert.equal(H.refreshes(), 1);
});

test('a refused save is reported and the saved state is put back', async () => {
  const H = bindHarness({ api: { mark: ['Failed to save critical audio device', null] } });
  const T = conditionsTable(FULL_FORM());
  T.list.attrs['data-render-key'] = 'k';
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input').call(
    T.inputs.CheckChannels.check
  );
  assert.deepEqual(H.notes.at(-1), ['Failed to save critical audio device', 'error']);
  assert.equal(T.list.attrs['data-render-key'], '');
  assert.equal(H.refreshes(), 1);
});

test('quick ticks save in order, and only the last one refreshes', async () => {
  const order = [];
  const releases = [];
  const H = bindHarness();
  window.API.MarkClientAudioDeviceCritical = (UUID, Payload) => {
    order.push(Payload.RequireDefault);
    return new Promise((resolve) => releases.push(() => resolve([null, true])));
  };
  const change = H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input');
  const T = conditionsTable(FULL_FORM());
  const first = change.call(T.inputs.RequireDefault.check);
  T.inputs.RequireDefault.check.checked = false;
  const second = change.call(T.inputs.RequireDefault.check);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [true], 'the second waits for the first');
  releases.shift()();
  await first;
  assert.equal(H.refreshes(), 0, 'the in-between state is not shown');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [true, false]);
  releases.shift()();
  await second;
  assert.equal(H.refreshes(), 1);
  assert.equal(Audio._internal.SaveChains.size, 0, 'nothing left queued');
});

test('a conditions change without an open client or a table id does nothing', async () => {
  const none = bindHarness({ uuid: null });
  const T = conditionsTable(FULL_FORM());
  await none
    .handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input')
    .call(T.inputs.RequireDefault.check);
  const H = bindHarness();
  const orphan = conditionsTable(FULL_FORM(), '');
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_CONDITIONS input').call(
    orphan.inputs.RequireDefault.check
  );
  assert.deepEqual([none.calls, H.calls], [[], []]);
});

test('the slider shows its value while dragging and sends one change on release', async () => {
  const H = bindHarness();
  const label = node();
  const slider = node({
    value: '42.4',
    attrs: { 'data-endpoint': enc(SPEAKERS) },
    siblings: { '.SHOWTRAK_AUDIO_LEVEL_VALUE': label },
  });
  H.handler('pointerdown.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  assert.equal(slider.attrs['data-dragging'], '1');
  H.handler('input.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  assert.equal(label.textValue, '42%');
  assert.equal(H.calls.length, 0, 'dragging alone sends nothing');
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  assert.equal(slider.attrs['data-dragging'], undefined);
  assert.deepEqual(H.calls, [['Set', 'c1', { EndpointID: SPEAKERS, Volume: 42 }]]);
  assert.equal(H.refreshes(), 0, 'success: the client reports the new level itself');

  slider.value = 'junk';
  H.handler('input.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  assert.equal(H.calls.length, 1);
});

test('a refused level change is reported and the real level restored', async () => {
  const H = bindHarness({
    api: { set: ['macOS can only change the level of the default output', null] },
  });
  const slider = node({ value: '5', attrs: { 'data-endpoint': enc('dvs') } });
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(slider);
  assert.deepEqual(H.notes, [['macOS can only change the level of the default output', 'error']]);
  assert.deepEqual(slider.triggered, ['blur']);
  assert.equal(H.refreshes(), 1);
});

test('the mute button toggles from the state it shows', async () => {
  const H = bindHarness();
  const mute = H.handler('click.client-audio', '.SHOWTRAK_AUDIO_MUTE');
  await mute.call(node({ attrs: { 'data-endpoint': enc(SPEAKERS), 'data-muted': '0' } }));
  await mute.call(node({ attrs: { 'data-endpoint': enc(SPEAKERS), 'data-muted': '1' } }));
  assert.deepEqual(H.calls, [
    ['Set', 'c1', { EndpointID: SPEAKERS, Muted: true }],
    ['Set', 'c1', { EndpointID: SPEAKERS, Muted: false }],
  ]);
  assert.equal(H.refreshes(), 2);

  const refused = bindHarness({ api: { set: ['Client is not online', null] } });
  await refused
    .handler('click.client-audio', '.SHOWTRAK_AUDIO_MUTE')
    .call(node({ attrs: { 'data-endpoint': 'x' } }));
  assert.deepEqual(refused.notes, [['Client is not online', 'error']]);
});

test('no control acts without an open client', async () => {
  const H = bindHarness({ uuid: null });
  const el = node({
    attrs: { 'data-endpoint': 'x', 'data-critical': '0', 'data-muted': '0' },
    value: '5',
  });
  await H.handler('click.client-audio', '.SHOWTRAK_TOGGLE_CRITICAL_AUDIO').call(el);
  await H.handler('change.client-audio', '.SHOWTRAK_AUDIO_LEVEL').call(el);
  await H.handler('click.client-audio', '.SHOWTRAK_AUDIO_MUTE').call(el);
  assert.deepEqual(H.calls, []);
});

test('a thrown API error is contained rather than escaping the handler', async () => {
  const list = node();
  installDom({ ['#SHOWTRAK_CLIENT_INFO_AUDIO_INPUTS, #SHOWTRAK_CLIENT_INFO_AUDIO_OUTPUTS']: list });
  global.window = {
    API: new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('IPC down');
        },
      }
    ),
  };
  Audio.BindClientInfoAudioHandlers(
    () => 'c1',
    async () => {},
    () => {}
  );
  const el = node({
    attrs: { 'data-endpoint': 'x', 'data-critical': '0' },
    value: '5',
    closest: { '.SHOWTRAK_AUDIO_CONDITIONS': node({ attrs: { 'data-endpoint': 'x' } }) },
  });
  for (const { fn } of list.handlers) {
    await fn.call(el);
  }
});

test('both section lists exist in the modal markup, each under its own heading', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'UI', 'index.html'),
    'utf8'
  );
  for (const [direction, selector] of Object.entries(Audio.AUDIO_LISTS)) {
    assert.match(html, new RegExp(`id="${selector.slice(1)}"`), direction);
  }
  assert.match(html, /<h6 class="mb-0">Audio Inputs<\/h6>/);
  assert.match(html, /<h6 class="mb-0">Audio Outputs<\/h6>/);
  assert.doesNotMatch(html, /Audio Devices<\/h6>/);
});
