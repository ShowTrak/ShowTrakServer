const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The probes' shared caching `lookup` (src/Modules/MonitoringMethods/_dns-cache.ts).
// A check addressed by name used to resolve it on every probe, on libuv's small
// thread pool; a name that does not resolve (.local, LLMNR) can hold a pool
// thread for seconds each time.

const MODULE = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '_dns-cache.js');

function load(answer) {
  const calls = [];
  const dns = {
    lookup: (name, options, callback) => {
      calls.push([name, options]);
      setTimeout(() => answer(name, options, callback), 5);
    },
  };
  const mod = loadWithMocks(MODULE, { dns });
  return { ...mod, calls };
}

const lookup = (fn, name, options) =>
  new Promise((resolve) =>
    fn(name, options, (err, address, family) => resolve({ err, address, family }))
  );

const ADDRESSES = [
  { address: '10.0.0.5', family: 4 },
  { address: 'fe80::5', family: 6 },
];

test('a name is resolved once and then served from the cache', async () => {
  const { CachedLookup, calls } = load((_n, _o, cb) => cb(null, ADDRESSES));
  const first = await lookup(CachedLookup, 'projector.local', {});
  const second = await lookup(CachedLookup, 'PROJECTOR.local', {});
  assert.deepEqual(first, { err: null, address: '10.0.0.5', family: 4 });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  // Asked the resolver for every address, whatever the caller wanted.
  assert.equal(calls[0][1].all, true);
});

test('callers asking for all addresses get the list (net autoSelectFamily does)', async () => {
  const { CachedLookup } = load((_n, _o, cb) => cb(null, ADDRESSES));
  const { err, address } = await lookup(CachedLookup, 'mixer', { all: true });
  assert.equal(err, null);
  assert.deepEqual(address, ADDRESSES);
});

test('concurrent lookups of one name share a single query', async () => {
  const { CachedLookup, calls } = load((_n, _o, cb) => cb(null, ADDRESSES));
  const results = await Promise.all(
    Array.from({ length: 10 }, () => lookup(CachedLookup, 'shared', {}))
  );
  assert.equal(calls.length, 1);
  assert.ok(results.every((r) => r.address === '10.0.0.5'));
});

test('a failure is cached too, briefly, and reported as the error it was', async (t) => {
  const { CachedLookup, calls } = load((name, _o, cb) =>
    cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' }))
  );
  const first = await lookup(CachedLookup, 'gone.local', {});
  const second = await lookup(CachedLookup, 'gone.local', {});
  assert.equal(first.err.code, 'ENOTFOUND');
  assert.equal(second.err.code, 'ENOTFOUND');
  assert.equal(calls.length, 1);

  // Expired after ten seconds: asked again.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11_000 });
  await lookup(CachedLookup, 'gone.local', {});
  assert.equal(calls.length, 2);
});

test('answers expire after a minute', async (t) => {
  const { CachedLookup, calls } = load((_n, _o, cb) => cb(null, ADDRESSES));
  await lookup(CachedLookup, 'core', {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 59_000 });
  await lookup(CachedLookup, 'core', {});
  assert.equal(calls.length, 1);
  t.mock.timers.setTime(Date.now() + 2_000);
  await lookup(CachedLookup, 'core', {});
  assert.equal(calls.length, 2);
});

test('the family asked for is part of the key, and dgram-style numeric families work', async () => {
  const { CachedLookup, calls } = load((_n, options, cb) =>
    cb(
      null,
      ADDRESSES.filter((a) => !options.family || a.family === options.family)
    )
  );
  const v6 = await lookup(CachedLookup, 'dual', { family: 6 });
  const v4 = await lookup(CachedLookup, 'dual', 4);
  assert.equal(v6.address, 'fe80::5');
  assert.equal(v4.address, '10.0.0.5');
  assert.equal(calls.length, 2);
});

test('an IP literal goes straight through without being cached', async () => {
  const { CachedLookup, calls } = load((name, _o, cb) => cb(null, name, 4));
  await lookup(CachedLookup, '10.1.2.3', {});
  await lookup(CachedLookup, '10.1.2.3', {});
  assert.equal(calls.length, 2);
});

test('it works as the lookup of a real socket and HTTP request', async () => {
  const { CachedLookup } = loadWithMocks(MODULE, {});
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      http
        .get({ host: 'localhost', port, family: 4, lookup: CachedLookup }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    assert.equal(body, 'ok');
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: 'localhost', port, family: 4, lookup: CachedLookup });
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });
  } finally {
    server.close();
  }
});
