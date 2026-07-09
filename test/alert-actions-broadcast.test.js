const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The HTTP/OSC transports are covered in alert-actions-transports.test.js.
// This file covers the three broadcast-only actions (play-sound, showtrak-alert,
// play-custom-audio) that emit onto the process event bus instead of the network.

function actionPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'AlertActions', name);
}

function loggerStub() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, log: noop, debug: noop, success: noop };
}

// Captures BroadcastManager.emit() calls so assertions can inspect the payload.
function broadcastMock() {
  const emitted = [];
  return {
    emitted,
    mock: { Manager: { emit: (Event, Payload) => emitted.push({ Event, Payload }) } },
  };
}

test('play-sound normalizes to an allowed sound and defaults unknown values', () => {
  const { mock } = broadcastMock();
  const action = loadWithMocks(actionPath('play-sound.js'), { '../Broadcast': mock });

  assert.equal(action.ID, 'play-sound');
  // Known values pass through.
  assert.deepEqual(action.NormalizeSettings({ Sound: 'Alert' }), { Sound: 'Alert' });
  // Unknown / missing / wrong-type values fall back to the default.
  assert.deepEqual(action.NormalizeSettings({ Sound: 'Nope' }), { Sound: 'Notification' });
  assert.deepEqual(action.NormalizeSettings({}), { Sound: 'Notification' });
  assert.deepEqual(action.NormalizeSettings(null), { Sound: 'Notification' });
  // ValidateSettings never throws for this action.
  assert.equal(action.ValidateSettings({ Sound: 'anything' }), true);
});

test('play-sound Execute broadcasts the chosen sound and reports success', async () => {
  const { emitted, mock } = broadcastMock();
  const action = loadWithMocks(actionPath('play-sound.js'), { '../Broadcast': mock });

  const result = await action.Execute({ Settings: { Sound: 'Warning' } }, {}, loggerStub());
  assert.deepEqual(result, { Success: true });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { Event: 'PlaySound', Payload: 'Warning' });

  // Missing settings still emit the default sound.
  await action.Execute({}, {}, loggerStub());
  assert.deepEqual(emitted[1], { Event: 'PlaySound', Payload: 'Notification' });
});

test('showtrak-alert normalizes and trims the optional title to 120 chars', () => {
  const { mock } = broadcastMock();
  const action = loadWithMocks(actionPath('showtrak-alert.js'), { '../Broadcast': mock });

  assert.equal(action.ID, 'showtrak-alert');
  assert.deepEqual(action.NormalizeSettings({ Title: '  Hello  ' }), { Title: 'Hello' });
  assert.deepEqual(action.NormalizeSettings({}), { Title: '' });
  assert.deepEqual(action.NormalizeSettings(null), { Title: '' });
  // Non-string titles are coerced.
  assert.deepEqual(action.NormalizeSettings({ Title: 42 }), { Title: '42' });
  // Long titles are clamped to 120 characters.
  const long = 'x'.repeat(200);
  assert.equal(action.NormalizeSettings({ Title: long }).Title.length, 120);
  assert.equal(action.ValidateSettings({ Title: 'ok' }), true);
});

test('showtrak-alert Execute builds a payload from the custom title', async () => {
  const { emitted, mock } = broadcastMock();
  const action = loadWithMocks(actionPath('showtrak-alert.js'), { '../Broadcast': mock });

  const result = await action.Execute(
    { Settings: { Title: 'Stage Down' } },
    {
      Description: 'PC1 went offline',
      Severity: 'critical',
      TriggerType: 'CLIENT_OFFLINE',
      UUID: 'abc-123',
    },
    loggerStub()
  );
  assert.deepEqual(result, { Success: true });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].Event, 'CreateShowTrakAlert');
  assert.deepEqual(emitted[0].Payload, {
    Title: 'Stage Down',
    Message: 'PC1 went offline',
    Severity: 'critical',
    TriggerType: 'CLIENT_OFFLINE',
    UUID: 'abc-123',
  });
});

test('showtrak-alert Execute falls back to the context description and defaults', async () => {
  const { emitted, mock } = broadcastMock();
  const action = loadWithMocks(actionPath('showtrak-alert.js'), { '../Broadcast': mock });

  // No custom title -> Description becomes the Title, Message stays empty.
  await action.Execute({ Settings: {} }, { Description: 'Something happened' }, loggerStub());
  assert.deepEqual(emitted[0].Payload, {
    Title: 'Something happened',
    Message: '',
    Severity: 'info',
    TriggerType: null,
    UUID: null,
  });

  // No title and no description -> generic fallback title.
  await action.Execute({ Settings: {} }, {}, loggerStub());
  assert.equal(emitted[1].Payload.Title, 'ShowTrak Alert');
});

test('play-custom-audio validates that an asset is selected', () => {
  const { mock } = broadcastMock();
  const action = loadWithMocks(actionPath('play-custom-audio.js'), {
    '../Broadcast': mock,
    '../AudioAssetManager': { Manager: { GetDataURL: () => [null, null] } },
  });

  assert.equal(action.ID, 'play-custom-audio');
  assert.deepEqual(action.NormalizeSettings({ AssetID: '  a1  ', AssetLabel: '  My Clip  ' }), {
    AssetID: 'a1',
    AssetLabel: 'My Clip',
  });
  assert.deepEqual(action.NormalizeSettings(null), { AssetID: '', AssetLabel: '' });
  assert.throws(() => action.ValidateSettings({ AssetID: '' }), /choose an audio asset/i);
  assert.equal(action.ValidateSettings({ AssetID: 'a1' }), true);
});

test('play-custom-audio Execute broadcasts the resolved asset payload', async () => {
  const { emitted, mock } = broadcastMock();
  const asset = { ID: 'a1', Label: 'My Clip', Volume: 0.8, DataURL: 'data:audio/wav;base64,AAA' };
  const action = loadWithMocks(actionPath('play-custom-audio.js'), {
    '../Broadcast': mock,
    '../AudioAssetManager': { Manager: { GetDataURL: (id) => [null, id === 'a1' ? asset : null] } },
  });

  const result = await action.Execute({ Settings: { AssetID: 'a1' } }, {}, loggerStub());
  assert.deepEqual(result, { Success: true });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].Event, 'PlayCustomAudio');
  assert.deepEqual(emitted[0].Payload, {
    ID: 'a1',
    Label: 'My Clip',
    Volume: 0.8,
    DataURL: 'data:audio/wav;base64,AAA',
  });
});

test('play-custom-audio Execute falls back to a built-in sound when the asset is missing', async () => {
  const { emitted, mock } = broadcastMock();
  const action = loadWithMocks(actionPath('play-custom-audio.js'), {
    '../Broadcast': mock,
    '../AudioAssetManager': { Manager: { GetDataURL: () => ['Audio asset not found', null] } },
  });

  const result = await action.Execute(
    { Settings: { AssetID: 'gone', AssetLabel: 'Deleted Clip' } },
    {},
    loggerStub()
  );
  assert.equal(result.Success, true);
  assert.match(result.Warning, /fallback sound/i);
  // Emits the built-in Notification sound rather than a custom asset.
  assert.deepEqual(emitted[0], { Event: 'PlaySound', Payload: 'Notification' });
});
