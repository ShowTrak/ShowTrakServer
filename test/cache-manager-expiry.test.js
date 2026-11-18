const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// CacheManager buckets drop expired entries every so often, not only once they
// pass maxEntries. The monitoring run cache sits far below its 2000 cap on a
// typical rig, so it used to keep every check's last full result (response
// bodies included), and every edited check's old key, for the life of the app.

function load() {
  return loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'CacheManager', 'index.js'), {
    '../Logger': { CreateLogger: () => ({ warn: () => {} }) },
  });
}

test('expired entries are swept from a bucket well below its cap', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { Manager } = load();
  const Bucket = Manager.GetBucket('expiry-test', { defaultTtlMs: 1000, maxEntries: 2000 });
  await Bucket.GetOrCreate('old-key', () => ({ Body: 'x'.repeat(1000) }));
  Bucket.Set('other', 1);
  assert.equal(Bucket.Map.size, 2);

  // Long expired, but nothing has been stored since the last sweep window.
  t.mock.timers.setTime(1_010_000);
  Bucket.Set('fresh', 2);
  assert.equal(Bucket.Map.size, 3, 'not swept before the interval');

  t.mock.timers.setTime(1_031_000);
  Bucket.Set('fresher', 3);
  assert.deepEqual([...Bucket.Map.keys()], ['fresher']);
});

test('a probe still in flight is never swept', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { Manager } = load();
  const Bucket = Manager.GetBucket('inflight-test', { defaultTtlMs: 1000 });
  let release;
  const Pending = Bucket.GetOrCreate('slow', () => new Promise((r) => (release = r)));
  t.mock.timers.setTime(1_100_000);
  Bucket.Set('trigger', 1);
  assert.ok(Bucket.Map.has('slow'));
  // A second caller still joins the in-flight probe.
  const Joined = Bucket.GetOrCreate('slow', () => 'second');
  await Promise.resolve();
  release('first');
  assert.equal(await Pending, 'first');
  assert.equal(await Joined, 'first');
});
