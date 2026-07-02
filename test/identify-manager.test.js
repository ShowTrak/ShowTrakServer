const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  const logger = {
    debug: () => {},
    error: () => {},
    log: () => {},
    warn: () => {},
    success: () => {},
  };
  return { CreateLogger: () => logger };
}

function loadIdentifyManager({
  exists = async () => false,
  get = async () => [null, null],
  setIdentifying = async () => [null, true],
  pending = [],
  setPendingIdentifying = () => false,
} = {}) {
  const ioEmits = [];
  const ioStub = {
    to: (uuid) => ({
      emit: (event, payload) => {
        ioEmits.push({ uuid, event, payload });
      },
    }),
  };

  const module = loadWithMocks('../src/Modules/IdentifyManager', {
    '../Logger': createLoggerStub(),
    '../Utils': require('../src/Modules/Utils'),
    '../ClientManager': {
      Manager: {
        Exists: exists,
        Get: get,
        SetIdentifying: setIdentifying,
      },
    },
    '../AdoptionManager': {
      Manager: {
        GetClientsPendingAdoption: () => pending,
        SetIdentifying: setPendingIdentifying,
      },
    },
  });

  module.Manager.RegisterIO(ioStub);
  return { Manager: module.Manager, ioEmits };
}

test('Identify starts on an adopted online client and emits Identify with nickname', async () => {
  const setCalls = [];
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async (uuid) => uuid === 'c1',
    get: async () => [
      null,
      {
        UUID: 'c1',
        Online: true,
        Integrated: false,
        OperatingSystem: 'Windows',
        Version: '3.7.0',
        Hostname: 'HOST-1',
        Nickname: 'FrontDesk',
      },
    ],
    setIdentifying: async (uuid, flag) => {
      setCalls.push({ uuid, flag });
      return [null, true];
    },
  });

  const [Err, Ok] = await Manager.Identify('c1');
  assert.equal(Err, null);
  assert.equal(Ok, true);
  assert.deepEqual(setCalls, [{ uuid: 'c1', flag: true }]);
  assert.deepEqual(ioEmits, [{ uuid: 'c1', event: 'Identify', payload: { Nickname: 'FrontDesk' } }]);
});

test('Identify rejects integrated clients', async () => {
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async () => true,
    get: async () => [
      null,
      {
        UUID: 'sdk-1',
        Online: true,
        Integrated: true,
        OperatingSystem: 'Integrated',
        Hostname: 'SDK',
      },
    ],
  });

  const [Err] = await Manager.Identify('sdk-1');
  assert.equal(Err, 'Integrated clients cannot be identified.');
  assert.equal(ioEmits.length, 0);
});

test('Identify allows multiple clients to identify concurrently', async () => {
  const setCalls = [];
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async () => true,
    get: async (uuid) => [
      null,
      {
        UUID: uuid,
        Online: true,
        Integrated: false,
        OperatingSystem: 'macOS',
        Version: '3.7.1',
        Hostname: uuid.toUpperCase(),
        Nickname: uuid.toUpperCase(),
      },
    ],
    setIdentifying: async (uuid, flag) => {
      setCalls.push({ uuid, flag });
      return [null, true];
    },
  });

  let out = await Manager.Identify('a1');
  assert.equal(out[0], null);
  out = await Manager.Identify('a2');
  assert.equal(out[0], null);

  assert.deepEqual(setCalls, [
    { uuid: 'a1', flag: true },
    { uuid: 'a2', flag: true },
  ]);
  assert.deepEqual(ioEmits, [
    { uuid: 'a1', event: 'Identify', payload: { Nickname: null } },
    { uuid: 'a2', event: 'Identify', payload: { Nickname: null } },
  ]);
});

test('Identify works for pending-adoption devices', async () => {
  const pendingCalls = [];
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async () => false,
    pending: [{ UUID: 'p1', Hostname: 'Pending-1', IP: '10.0.0.5', Version: '3.7.2' }],
    setPendingIdentifying: (uuid, flag) => {
      pendingCalls.push({ uuid, flag });
      return true;
    },
  });

  const [Err, Ok] = await Manager.Identify('p1');
  assert.equal(Err, null);
  assert.equal(Ok, true);
  assert.deepEqual(pendingCalls, [{ uuid: 'p1', flag: true }]);
  assert.deepEqual(ioEmits, [{ uuid: 'p1', event: 'Identify', payload: { Nickname: null } }]);
});

test('Identify rejects adopted clients below minimum supported version', async () => {
  const setCalls = [];
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async () => true,
    get: async () => [
      null,
      {
        UUID: 'legacy-1',
        Online: true,
        Integrated: false,
        OperatingSystem: 'Windows',
        Version: '3.6.9',
        Hostname: 'LEGACY-1',
      },
    ],
    setIdentifying: async (uuid, flag) => {
      setCalls.push({ uuid, flag });
      return [null, true];
    },
  });

  const [Err, Ok] = await Manager.Identify('legacy-1');
  assert.equal(Err, 'Identify requires client version 3.7.0 or newer.');
  assert.equal(Ok, null);
  assert.deepEqual(setCalls, []);
  assert.equal(ioEmits.length, 0);
});

test('Identify rejects pending devices below minimum supported version', async () => {
  const pendingCalls = [];
  const { Manager, ioEmits } = loadIdentifyManager({
    exists: async () => false,
    pending: [{ UUID: 'legacy-p', Hostname: 'Legacy Pending', Version: '3.6.5' }],
    setPendingIdentifying: (uuid, flag) => {
      pendingCalls.push({ uuid, flag });
      return true;
    },
  });

  const [Err, Ok] = await Manager.Identify('legacy-p');
  assert.equal(Err, 'Identify requires client version 3.7.0 or newer.');
  assert.equal(Ok, null);
  assert.deepEqual(pendingCalls, []);
  assert.equal(ioEmits.length, 0);
});
