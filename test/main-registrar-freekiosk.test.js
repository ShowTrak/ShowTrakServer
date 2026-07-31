// Exercises src/main/registrars/freekiosk.ts — the FreeKiosk terminal channels.
//
// The real IPCValidation runs (only the managers and Electron are stubbed), so
// this is the validation boundary for untrusted renderer input. The command
// channel is the important one: it is the single place that decides what a
// terminal can be told to do, and the map it validates against is what keeps
// arbitrary JavaScript execution off the device.
//
// It also pins the two handler contracts: readers return a raw value (or its
// empty fallback), mutations return an [Err, Result] tuple. Confusing them
// silently breaks the renderer, which unpacks one or the other without checking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

const state = {
  getAll: [null, [{ UUID: 'kiosk-1' }]],
  // The editor's read, which unlike the broadcast view carries the API key.
  get: [null, { UUID: 'kiosk-1', Slug: 'lobby', HasApiKey: true, ApiKey: 'secret-key' }],
  defaults: { Nickname: 'FreeKiosk 123456', Port: 8080 },
  create: [null, { UUID: 'new-kiosk' }],
  update: [null, true],
  del: [null, true],
  runNow: [null, { Total: 1, Succeeded: 1, Failed: 0, Results: [] }],
  sendCommand: [null, { Total: 1, Succeeded: 1, Failed: 0, Results: [] }],
  capture: [null, { DataUrl: 'data:image/png;base64,AA==', Bytes: 2 }],
  cameras: [null, [{ id: '0', facing: 'back' }]],
};

const kioskMgr = recordingManager({
  GetAll: () => state.getAll,
  Get: () => state.get,
  GetForEditor: () => state.get,
  GenerateDefaults: () => state.defaults,
  Create: () => state.create,
  Update: () => state.update,
  Delete: () => state.del,
  RunNow: () => state.runNow,
  SendCommand: () => state.sendCommand,
  Capture: () => state.capture,
  GetCameraList: () => state.cameras,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/FreeKioskManager'), value: { Manager: kioskMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/freekiosk');
const { GetHandler } = require('../dist/main/handler-registry');
register();

const call = (channel, ...args) => GetHandler(channel)({}, ...args);

// The recording manager accumulates across the whole file and exposes
// {method, args} records, so assertions look at the most recent call.
const lastArgs = (method) => {
  const calls = kioskMgr.__callsTo(method);
  return calls.length ? calls[calls.length - 1].args : null;
};
const countOf = (method) => kioskMgr.__callsTo(method).length;

// ---- The registry, delivered rather than mirrored --------------------------

test('the metric catalogue ships the registry, its alarm schema and its sections', async () => {
  const catalogue = await call('FreeKiosk:GetMetrics');
  assert.ok(catalogue.Metrics.length > 0);
  assert.ok(catalogue.AlarmFields.length > 0);
  assert.ok(catalogue.Sections.includes('Battery'));
  // The renderer cannot import from src/Modules, so this payload is the only
  // thing keeping it in step with the server's registry.
  const metric = catalogue.Metrics.find((m) => m.Key === 'battery_level');
  assert.equal(metric.Unit, '%');
  assert.equal(metric.Chart, 'line');
  assert.ok(metric.Operators.includes('below'));
});

test('the command catalogue never offers JavaScript execution', async () => {
  const commands = await call('FreeKiosk:GetCommands');
  assert.ok(commands.length > 0);
  assert.equal(
    commands.find((c) => c.ID === 'js' || /\/api\/js\b/.test(c.Path)),
    undefined
  );
});

// ---- Readers return raw values --------------------------------------------

test('list and get return raw values, with empty fallbacks', async () => {
  assert.deepEqual(await call('GetAllFreeKioskTerminals'), [{ UUID: 'kiosk-1' }]);
  assert.deepEqual(await call('GetFreeKioskTerminal', 'kiosk-1'), state.get[1]);

  state.getAll = ['boom', null];
  state.get = ['boom', null];
  assert.deepEqual(await call('GetAllFreeKioskTerminals'), []);
  assert.equal(await call('GetFreeKioskTerminal', 'kiosk-1'), null);
  state.getAll = [null, [{ UUID: 'kiosk-1' }]];
  state.get = [null, { UUID: 'kiosk-1', Slug: 'lobby', HasApiKey: true, ApiKey: 'secret-key' }];
});

test('the single-terminal read carries the API key, and the list does not', async () => {
  // The editor has to show the key it is about to let you change, so this one
  // reader carries it. The list feeds tiles and the Web UI push, which have no
  // use for it — GetAll must keep going through the plain snapshot.
  const one = await call('GetFreeKioskTerminal', 'kiosk-1');
  assert.equal(one.ApiKey, 'secret-key');
  assert.equal(countOf('GetForEditor') > 0, true);

  const list = await call('GetAllFreeKioskTerminals');
  assert.equal('ApiKey' in list[0], false);
});

test('invalid input to a reader yields its empty fallback, not a tuple', async () => {
  assert.equal(await call('GetFreeKioskTerminal', ''), null);
  assert.equal(await call('GetFreeKioskTerminal', null), null);
  assert.deepEqual(await call('FreeKiosk:GetHistory', ''), []);
  assert.deepEqual(await call('FreeKiosk:GetCameraList', 42), []);
});

test('history reads every series for a terminal in one call', async () => {
  // Not per-metric: a terminal has ~60 series and the modal reloads on every
  // push while it is open.
  assert.deepEqual(await call('FreeKiosk:GetHistory', 'kiosk-1'), []);
  assert.deepEqual(await call('FreeKiosk:GetHistory', 'kiosk-1', ['battery_level']), []);
});

// ---- Mutations return tuples ----------------------------------------------

test('create validates the payload and returns a tuple', async () => {
  const [err, created] = await call('CreateFreeKioskTerminal', { Address: '10.0.0.5' });
  assert.equal(err, null);
  assert.deepEqual(created, { UUID: 'new-kiosk' });
  assert.deepEqual(lastArgs('Create')[0], { Address: '10.0.0.5' });
});

test('create without an address is refused before it reaches the manager', async () => {
  const before = countOf('Create');
  const [err] = await call('CreateFreeKioskTerminal', {});
  assert.match(String(err), /address is required/i);
  assert.equal(countOf('Create'), before);
});

test('an address carrying a scheme or a path is refused', async () => {
  // Both would be concatenated straight into the request line.
  const before = countOf('Create');
  for (const address of ['http://10.0.0.5', '10.0.0.5/kiosk', 'https://x/y']) {
    const [err] = await call('CreateFreeKioskTerminal', { Address: address });
    assert.ok(err, address);
  }
  assert.equal(countOf('Create'), before);
});

test('an out-of-range port is refused', async () => {
  for (const port of [0, -1, 65536, 'nope', 1.5]) {
    const [err] = await call('CreateFreeKioskTerminal', { Address: '10.0.0.5', Port: port });
    assert.match(String(err), /between 1 and 65535/i, String(port));
  }
});

test('delete pairs an invalid id with false, matching the other Delete handlers', async () => {
  const [err, ok] = await call('DeleteFreeKioskTerminal', '');
  assert.ok(err);
  assert.equal(ok, false);
});

test('a blank API key means unchanged rather than cleared', async () => {
  // The editor is never given the stored key back, so it cannot resubmit one.
  await call('UpdateFreeKioskTerminal', 'kiosk-1', { ApiKey: '   ' });
  assert.equal('ApiKey' in lastArgs('Update')[1], false);

  await call('UpdateFreeKioskTerminal', 'kiosk-1', { ApiKey: 'real-key' });
  assert.equal(lastArgs('Update')[1].ApiKey, 'real-key');
});

// ---- The command boundary --------------------------------------------------

test('a valid command fans out over the selection', async () => {
  const [err, summary] = await call('FreeKiosk:Command', ['uuid-a', 'uuid-b'], 'wake');
  assert.equal(err, null);
  assert.equal(summary.Succeeded, 1);
  const [uuids, command] = lastArgs('SendCommand');
  assert.deepEqual(uuids, ['uuid-a', 'uuid-b']);
  assert.equal(command, 'wake');
});

test('an unknown command never reaches the manager', async () => {
  const before = countOf('SendCommand');
  for (const command of ['js', 'nope', '', null, '../api/js']) {
    const [err] = await call('FreeKiosk:Command', ['uuid-a'], command);
    assert.ok(err, String(command));
  }
  assert.equal(countOf('SendCommand'), before);
});

test('repeated ids are de-duplicated so one device is not commanded twice', async () => {
  await call('FreeKiosk:Command', ['uuid-a', 'uuid-a', 'uuid-b', 'uuid-a'], 'wake');
  assert.deepEqual(lastArgs('SendCommand')[0], ['uuid-a', 'uuid-b']);
});

test('an empty or oversized selection is refused', async () => {
  const before = countOf('SendCommand');
  assert.ok((await call('FreeKiosk:Command', [], 'wake'))[0]);
  assert.ok((await call('FreeKiosk:Command', 'not-an-array', 'wake'))[0]);
  const huge = Array.from({ length: 501 }, (_, i) => `uuid-${i}`);
  assert.ok((await call('FreeKiosk:Command', huge, 'wake'))[0]);
  assert.equal(countOf('SendCommand'), before);
});

test('brightness and volume are clamped to a whole 0-100', async () => {
  for (const value of [-1, 101, 'nope', NaN]) {
    assert.ok(
      (await call('FreeKiosk:Command', ['uuid-a'], 'brightness', { value }))[0],
      String(value)
    );
  }
  const [err] = await call('FreeKiosk:Command', ['uuid-a'], 'volume', { value: 42.6 });
  assert.equal(err, null);
  assert.deepEqual(lastArgs('SendCommand')[2], { value: 43 });
});

test('the old ad-hoc mode command is gone, not merely hidden', async () => {
  // It let the mode be set to something the terminal was not declared as, which
  // silently desynced what ShowTrak monitors from what the device shows. The map
  // IS the allowlist, so it is unreachable rather than unlisted.
  const [err] = await call('FreeKiosk:Command', ['uuid-a'], 'mode', { mode: 'webview' });
  assert.match(String(err), /Unknown FreeKiosk command/);
});

test('the messaging and audio-playback commands are not offered at all', async () => {
  // Deliberately dropped as useless for this deployment. They are gone from the
  // map, and the map IS the allowlist, so they are unreachable rather than
  // merely hidden — the same property that keeps /api/js out.
  for (const id of ['toast', 'tts', 'audio.play', 'audio.stop']) {
    const [err] = await call('FreeKiosk:Command', ['uuid-a'], id, { text: 'hi' });
    assert.match(String(err), /Unknown FreeKiosk command/, id);
  }
});

test('parameters sent to a bare GET command are dropped, not forwarded', async () => {
  const [err] = await call('FreeKiosk:Command', ['uuid-a'], 'wake', { url: 'file:///etc/passwd' });
  assert.equal(err, null);
  assert.deepEqual(lastArgs('SendCommand')[2], {});
});

// ---- Captures --------------------------------------------------------------

test('a screenshot returns a tuple carrying the data URL', async () => {
  const [err, image] = await call('FreeKiosk:CaptureScreenshot', 'kiosk-1');
  assert.equal(err, null);
  assert.match(image.DataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(lastArgs('Capture'), ['kiosk-1', 'screenshot']);
});

test('camera options default and clamp rather than being refused', async () => {
  await call('FreeKiosk:CaptureCamera', 'kiosk-1', {});
  assert.deepEqual(lastArgs('Capture')[2], { Camera: 'back', Quality: 80 });

  await call('FreeKiosk:CaptureCamera', 'kiosk-1', { Camera: 'front', Quality: 5000 });
  assert.deepEqual(lastArgs('Capture')[2], { Camera: 'front', Quality: 100 });
});

test('an unknown camera facing is refused', async () => {
  const [err] = await call('FreeKiosk:CaptureCamera', 'kiosk-1', { Camera: 'sideways' });
  assert.match(String(err), /front.*back/i);
});

test('polling on demand goes through the same selection validation', async () => {
  assert.ok((await call('FreeKiosk:RunNow', []))[0]);
  const [err] = await call('FreeKiosk:RunNow', ['uuid-a']);
  assert.equal(err, null);
  assert.deepEqual(lastArgs('RunNow')[0], ['uuid-a']);
});
