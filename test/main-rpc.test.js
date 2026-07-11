const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// rpc.ts wraps Electron's ipcMain. Its single invariant: every RPC.handle(...)
// both (a) registers the handler with ipcMain.handle for the desktop surface
// AND (b) mirrors it into the shared handler-registry so the WebUI /ui
// namespace dispatches to the same function. We stub only `electron/main`.
test('RPC.handle mirrors into the handler registry and forwards to ipcMain', () => {
  const ipcCalls = [];
  const electronStub = { ipcMain: { handle: (channel, fn) => ipcCalls.push({ channel, fn }) } };
  const restore = installModuleMocks([
    { match: matchesModule('electron/main'), value: electronStub },
    { match: matchesModule('electron'), value: electronStub },
  ]);
  try {
    const { RPC } = require('../dist/main/rpc');
    const { GetHandler, HasHandler } = require('../dist/main/handler-registry');

    const channel = 'GetAllGroups'; // a real InvokeChannel
    const fn = async () => [null, 'value'];
    RPC.handle(channel, fn);

    // (b) mirrored into the registry for the web surface
    assert.equal(HasHandler(channel), true);
    assert.equal(GetHandler(channel), fn);

    // (a) forwarded to ipcMain for the desktop surface, same channel + fn
    assert.equal(ipcCalls.length, 1);
    assert.equal(ipcCalls[0].channel, channel);
    assert.equal(ipcCalls[0].fn, fn);
  } finally {
    restore();
  }
});
