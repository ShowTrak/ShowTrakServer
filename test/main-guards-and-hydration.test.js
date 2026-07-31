const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Exercises three small but load-bearing main-process modules:
//
//   src/main/process-guards.ts  — the last line of defence that keeps a live
//     show running when a NIC flap throws out of native/third-party code.
//   src/main/window-guards.ts   — per-window security: external links go to the
//     OS browser, in-app navigation away from the UI is blocked, both fail
//     CLOSED.
//   src/main/initial-state.ts   — what a freshly (re)loaded renderer hydrates.
//
// The REAL NetworkErrors classifier is used for the guards, so the transient-vs-
// fatal decision is genuinely exercised rather than stubbed away.

const logs = { warns: [], errors: [], logs: [] };
const opened = [];
const state = { hasWindow: true, mode: 'SHOW', openExternalThrows: false };

const loggerStub = {
  CreateLogger: () => ({
    log: (...args) => logs.logs.push(args),
    info: () => {},
    warn: (...args) => logs.warns.push(args),
    error: (...args) => logs.errors.push(args),
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const bridgeCalls = [];
function bridgeStub(name) {
  return async () => bridgeCalls.push(name);
}

const pushes = [];

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: {} },
  {
    match: matchesModule('electron'),
    value: {
      shell: {
        openExternal: (url) => {
          if (state.openExternalThrows) throw new Error('no browser');
          opened.push(url);
        },
      },
    },
  },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  { match: matchesModule('/Modules/ModeManager'), value: { Manager: { Get: () => state.mode } } },
  {
    match: matchesModule('./renderer-bus'),
    value: { PushToRenderers: (...args) => pushes.push(args) },
  },
  { match: matchesModule('./app-window'), value: { hasMainWindow: () => state.hasWindow } },
  {
    match: matchesModule('./broadcast-bridge'),
    value: {
      UpdateSettings: bridgeStub('UpdateSettings'),
      UpdateAdoptionList: bridgeStub('UpdateAdoptionList'),
      UpdateFullClientList: bridgeStub('UpdateFullClientList'),
      UpdateScriptList: bridgeStub('UpdateScriptList'),
      UpdateOSCList: bridgeStub('UpdateOSCList'),
      UpdateMonitoringTargetList: bridgeStub('UpdateMonitoringTargetList'),
      UpdateDummyClientList: bridgeStub('UpdateDummyClientList'),
      UpdateFreeKioskTerminalList: bridgeStub('UpdateFreeKioskTerminalList'),
      UpdateAlertRuleList: bridgeStub('UpdateAlertRuleList'),
      UpdateWorkflowList: bridgeStub('UpdateWorkflowList'),
      UpdateTagList: bridgeStub('UpdateTagList'),
      UpdateFogTaskList: bridgeStub('UpdateFogTaskList'),
      UpdateFogStatus: bridgeStub('UpdateFogStatus'),
    },
  },
]);
test.after(() => restore());

const { installProcessGuards } = require('../dist/main/process-guards');
const { applyWindowSecurityGuards } = require('../dist/main/window-guards');
const { PushInitialDesktopState } = require('../dist/main/initial-state');

// --- process-guards ---------------------------------------------------------
//
// installProcessGuards attaches to the REAL process object, so capture exactly
// what it added, drive those listeners directly, and detach again afterwards.

const captured = { uncaught: [], rejection: [] };
{
  const BeforeUncaught = process.listeners('uncaughtException').slice();
  const BeforeRejection = process.listeners('unhandledRejection').slice();

  installProcessGuards();

  captured.uncaught = process
    .listeners('uncaughtException')
    .filter((L) => !BeforeUncaught.includes(L));
  captured.rejection = process
    .listeners('unhandledRejection')
    .filter((L) => !BeforeRejection.includes(L));

  // Detach immediately: leaving them attached would swallow real failures in
  // every other test in this file.
  for (const L of captured.uncaught) process.removeListener('uncaughtException', L);
  for (const L of captured.rejection) process.removeListener('unhandledRejection', L);
}

test('installProcessGuards attaches one handler for each fault channel', () => {
  assert.equal(captured.uncaught.length, 1);
  assert.equal(captured.rejection.length, 1);
  assert.ok(logs.logs.some((L) => /guards installed/i.test(String(L[0]))));
});

test('installProcessGuards is idempotent', () => {
  // main.ts calls this first thing; a second call (e.g. after a re-init) must
  // not stack duplicate handlers that log every fault twice.
  const Before = process.listeners('uncaughtException').length;
  installProcessGuards();
  installProcessGuards();
  assert.equal(process.listeners('uncaughtException').length, Before);
});

test('a transient network fault is swallowed with a warning, not treated as fatal', () => {
  // Unplugging Ethernet makes the mDNS responder throw from native code. A live
  // show must survive that.
  logs.warns.length = 0;
  logs.errors.length = 0;

  const Err = Object.assign(new Error('send EADDRNOTAVAIL 224.0.0.251:5353'), {
    code: 'EADDRNOTAVAIL',
  });
  captured.uncaught[0](Err);

  assert.equal(logs.errors.length, 0, 'a NIC flap must not be logged as a fatal error');
  assert.equal(logs.warns.length, 1);
  assert.match(String(logs.warns[0][0]), /Ignored transient network error/);
});

test('a genuine bug is logged loudly but the process is still not killed', () => {
  // Deliberately no process.exit: for show control, staying up and degraded
  // beats dying mid-show. The error stays visible in the logs.
  logs.warns.length = 0;
  logs.errors.length = 0;

  captured.uncaught[0](new TypeError('cannot read properties of undefined'));

  assert.equal(logs.warns.length, 0);
  assert.equal(logs.errors.length, 1);
  assert.match(String(logs.errors[0][0]), /Uncaught exception \(app kept alive\)/);
});

test('unhandled rejections are classified the same way', () => {
  logs.warns.length = 0;
  logs.errors.length = 0;

  captured.rejection[0](Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }));
  assert.equal(logs.warns.length, 1);
  assert.match(String(logs.warns[0][0]), /Ignored transient network rejection/);

  captured.rejection[0](new Error('a real bug'));
  assert.equal(logs.errors.length, 1);
  assert.match(String(logs.errors[0][0]), /Unhandled promise rejection \(app kept alive\)/);
});

test('a non-Error rejection reason does not defeat the guard', () => {
  logs.warns.length = 0;
  logs.errors.length = 0;
  for (const Reason of [null, undefined, 'a string', 42, {}]) {
    assert.doesNotThrow(() => captured.rejection[0](Reason));
  }
  assert.equal(logs.errors.length, 5);
});

// --- window-guards ----------------------------------------------------------

/** Minimal BrowserWindow stand-in exposing just what the guards touch. */
function fakeWindow({ destroyed = false, currentURL = 'file:///app/index.html' } = {}) {
  const Win = {
    isDestroyed: () => destroyed,
    openHandler: null,
    navigationHandler: null,
    webContents: {
      getURL: () => currentURL,
      setWindowOpenHandler: (fn) => {
        Win.openHandler = fn;
      },
      on: (event, fn) => {
        if (event === 'will-navigate') Win.navigationHandler = fn;
      },
    },
  };
  return Win;
}

test('an external http(s) link opens in the OS browser and never in-app', () => {
  opened.length = 0;
  const Win = fakeWindow();
  applyWindowSecurityGuards(Win);

  for (const Url of ['https://showtrak.co.uk', 'http://10.0.0.5:8080/', 'HTTPS://example.com']) {
    assert.deepEqual(Win.openHandler({ url: Url }), { action: 'deny' });
  }
  assert.deepEqual(opened, [
    'https://showtrak.co.uk',
    'http://10.0.0.5:8080/',
    'HTTPS://example.com',
  ]);
});

test('a non-http(s) window-open request is denied and never handed to the shell', () => {
  opened.length = 0;
  const Win = fakeWindow();
  applyWindowSecurityGuards(Win);

  for (const Url of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'smb://x', '']) {
    assert.deepEqual(Win.openHandler({ url: Url }), { action: 'deny' });
  }
  assert.deepEqual(opened, [], 'a non-http(s) URL reached the shell');
});

test('the window-open handler fails closed when the shell throws', () => {
  const Win = fakeWindow();
  applyWindowSecurityGuards(Win);
  state.openExternalThrows = true;
  try {
    assert.deepEqual(Win.openHandler({ url: 'https://showtrak.co.uk' }), { action: 'deny' });
  } finally {
    state.openExternalThrows = false;
  }
});

test('in-app navigation away from the loaded UI is blocked', () => {
  const Win = fakeWindow({ currentURL: 'file:///app/index.html' });
  applyWindowSecurityGuards(Win);

  let Prevented = 0;
  const Event = { preventDefault: () => (Prevented += 1) };

  Win.navigationHandler(Event, 'https://evil.example');
  assert.equal(Prevented, 1);

  // Navigating to the URL already loaded (a reload) is allowed through.
  Win.navigationHandler(Event, 'file:///app/index.html');
  assert.equal(Prevented, 1);
});

test('navigation with no current or target URL is left alone', () => {
  const Win = fakeWindow({ currentURL: '' });
  applyWindowSecurityGuards(Win);

  let Prevented = 0;
  const Event = { preventDefault: () => (Prevented += 1) };
  Win.navigationHandler(Event, 'https://evil.example');
  assert.equal(Prevented, 0);

  const Win2 = fakeWindow({ currentURL: 'file:///app/index.html' });
  applyWindowSecurityGuards(Win2);
  Win2.navigationHandler(Event, '');
  assert.equal(Prevented, 0);
});

test('applying guards to a missing or destroyed window is a no-op', () => {
  assert.doesNotThrow(() => applyWindowSecurityGuards(null));
  assert.doesNotThrow(() => applyWindowSecurityGuards(undefined));

  const Destroyed = fakeWindow({ destroyed: true });
  applyWindowSecurityGuards(Destroyed);
  assert.equal(Destroyed.openHandler, null, 'a destroyed window must not be touched');
});

// --- initial-state ----------------------------------------------------------

test('a renderer reload re-hydrates every channel, then the current mode', async () => {
  // A hot reload wipes the renderer's caches; anything missing from this list
  // stays empty until the next incremental push happens to arrive.
  bridgeCalls.length = 0;
  pushes.length = 0;

  await PushInitialDesktopState();

  assert.deepEqual(bridgeCalls, [
    'UpdateSettings',
    'UpdateAdoptionList',
    'UpdateFullClientList',
    'UpdateScriptList',
    'UpdateOSCList',
    'UpdateMonitoringTargetList',
    'UpdateDummyClientList',
    'UpdateFreeKioskTerminalList',
    'UpdateAlertRuleList',
    'UpdateWorkflowList',
    // Tile tag badges are derived from this list, so a reloaded renderer needs
    // it before its first paint or every tile renders untagged.
    'UpdateTagList',
    'UpdateFogStatus',
    'UpdateFogTaskList',
  ]);
  assert.deepEqual(pushes, [['ModeUpdated', 'SHOW']]);
});

test('the mode push is skipped when the window went away mid-hydration', async () => {
  bridgeCalls.length = 0;
  pushes.length = 0;
  state.hasWindow = false;
  try {
    await PushInitialDesktopState();
  } finally {
    state.hasWindow = true;
  }
  // The Update* functions guard themselves; only the direct push is gated here.
  assert.equal(bridgeCalls.length, 13);
  assert.deepEqual(pushes, []);
});
