const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadWithMocks(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];

  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, _parent, _isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('SettingsManager waits for DB readiness before reading settings', async () => {
  const deferred = createDeferred();
  let readyCalls = 0;
  let getCalls = 0;

  const dbMock = {
    Manager: {
      Ready: async () => {
        readyCalls += 1;
        await deferred.promise;
      },
      Get: async () => {
        getCalls += 1;
        return [null, null];
      },
      Run: async () => [null, null],
    },
  };

  const loggerMock = {
    CreateLogger: () => ({
      log: () => {},
      error: () => {},
    }),
  };

  const broadcastMock = {
    Manager: {
      emit: () => {},
    },
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'SettingsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../DB': dbMock,
    '../Logger': loggerMock,
    '../Broadcast': broadcastMock,
  });

  await Promise.resolve();
  assert.equal(readyCalls, 1);
  assert.equal(getCalls, 0);

  deferred.resolve();
  const settings = await Manager.GetAll();
  assert.ok(Array.isArray(settings));
  assert.ok(settings.length > 0);
  assert.ok(getCalls > 0);
});
