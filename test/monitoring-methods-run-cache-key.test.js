const test = require('node:test');
const assert = require('node:assert/strict');

const { Manager, getMethodRunCacheKey } = require('../dist/Modules/MonitoringMethods');

// The run-cache memoizes Method.Run(Target) under getMethodRunCacheKey(). For the
// memoization to be sound the key must be a pure function of exactly what Run()
// receives — the RAW target — so a cache hit can only ever replay a probe
// computed from identical inputs. These tests pin that contract.
const ping = Manager.Get('ping');

test('run-cache key distinguishes settings that normalize to the same clamped value', () => {
  // ping.Timeout clamps to Max 30000, so 999999 and 500000 both normalize to
  // 30000. Run() reads the raw Timeout, so the two must NOT share a cache entry.
  const a = getMethodRunCacheKey('ping', ping, {
    Address: 'device.local',
    Settings: { Timeout: 999999 },
  });
  const b = getMethodRunCacheKey('ping', ping, {
    Address: 'device.local',
    Settings: { Timeout: 500000 },
  });
  assert.notEqual(a, b, 'raw-different timeouts that clamp alike must not collide');
});

test('run-cache key distinguishes addresses that differ only in case', () => {
  // Run() forwards the raw address to the probe; a normalized (lowercased) key
  // would have let these collide.
  const a = getMethodRunCacheKey('ping', ping, { Address: 'Device.Local', Settings: {} });
  const b = getMethodRunCacheKey('ping', ping, { Address: 'device.local', Settings: {} });
  assert.notEqual(a, b, 'addresses differing only in case must not collide');
});

test('run-cache key is stable for identical raw targets (dedup preserved)', () => {
  const target = { Address: 'device.local', Settings: { Timeout: 2000 } };
  const a = getMethodRunCacheKey('ping', ping, target);
  const b = getMethodRunCacheKey('ping', ping, {
    Address: 'device.local',
    Settings: { Timeout: 2000 },
  });
  assert.equal(a, b, 'identical raw inputs must share one cache entry');
  // Key ordering must not depend on settings insertion order.
  const c = getMethodRunCacheKey('ping', ping, {
    Settings: { Timeout: 2000 },
    Address: 'device.local',
  });
  assert.equal(a, c, 'key must be independent of object key order');
});

test('run-cache key separates different methods and different addresses', () => {
  const base = { Address: 'device.local', Settings: {} };
  assert.notEqual(
    getMethodRunCacheKey('ping', ping, base),
    getMethodRunCacheKey('tcp-port', Manager.Get('tcp-port'), base),
    'different methods must not share a cache entry'
  );
  assert.notEqual(
    getMethodRunCacheKey('ping', ping, { Address: 'a.local', Settings: {} }),
    getMethodRunCacheKey('ping', ping, { Address: 'b.local', Settings: {} }),
    'different addresses must not share a cache entry'
  );
});
