const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Exercises src/main/app-updater.ts: what happens when a check is requested
// while an update is already being fetched.
//
// Reopening the Software Update modal (or the periodic automatic check firing)
// mid-download used to restart the updater, which errors because a download is
// already running. A check during checking/available/downloading must instead
// replay the latest status so the modal picks up the run already in flight.
// Progress ticks also carry the release info, so the floating progress bar and
// a reopened modal can name the version being downloaded.

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { app: { isPackaged: false } } },
  { match: (r) => r === 'electron', value: { autoUpdater: new EventEmitter() } },
  {
    match: (r) => r === 'electron-updater',
    value: { autoUpdater: Object.assign(new EventEmitter(), { autoDownload: false }) },
  },
  {
    match: matchesModule('/Logger'),
    value: { CreateLogger: () => ({ log() {}, warn() {}, error() {} }) },
  },
]);
test.after(() => restore());

const { Manager } = require('../dist/main/app-updater');

const handlers = {};
Manager.Register(
  { handle: (channel, fn) => (handlers[channel] = fn) },
  { getMainWindow: () => fakeWindow }
);

const statuses = () => sent.map((s) => s.payload);

test('progress ticks carry the info of the update being downloaded', () => {
  sent.length = 0;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  Manager.sendAppUpdateStatus({ state: 'available', info: { version: '3.30.0' } });
  Manager.sendAppUpdateStatus({ state: 'downloading', percent: 42 });
  assert.deepEqual(statuses()[2], {
    state: 'downloading',
    percent: 42,
    info: { version: '3.30.0' },
  });
});

test('a check while downloading replays the progress instead of restarting', async () => {
  sent.length = 0;
  await handlers['AppUpdate:Check']();
  assert.deepEqual(statuses(), [
    { state: 'downloading', percent: 42, info: { version: '3.30.0' } },
  ]);
});

test('a new check clears the previous run’s info', () => {
  Manager.sendAppUpdateStatus({ state: 'downloaded', info: { version: '3.30.0' } });
  sent.length = 0;
  Manager.sendAppUpdateStatus({ state: 'checking' });
  Manager.sendAppUpdateStatus({ state: 'downloading', percent: 5 });
  assert.deepEqual(statuses()[1], { state: 'downloading', percent: 5 });
});

test('once the download has finished, a check runs again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  Manager.sendAppUpdateStatus({ state: 'downloaded', info: { version: '3.30.0' } });
  sent.length = 0;
  await handlers['AppUpdate:Check']();
  assert.equal(statuses()[0].state, 'checking');
  // Drain the simulated (unpackaged) check so its timers don't outlive the test.
  t.mock.timers.tick(5000);
  assert.equal(statuses().at(-1).state, 'downloaded');
});
