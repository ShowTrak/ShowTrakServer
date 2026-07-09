const test = require('node:test');
const assert = require('node:assert');

const {
  recordClientApplicationHistorySamples,
  syncClientApplicationHistoryStore,
  getClientApplicationHistorySamples,
} = require('../dist/main/monitoring-history');

function makeClient(overrides = {}) {
  return {
    UUID: 'client-1',
    Online: true,
    RunningApplications: {
      Status: { State: 'ok' },
      Items: [
        { Name: 'QLab', Key: 'qlab', IsCritical: true, IsRunning: true },
        { Name: 'Vista', Key: 'vista', IsCritical: true, IsRunning: false },
        { Name: 'Chrome', Key: 'chrome', IsCritical: false, IsRunning: true },
      ],
    },
    ...overrides,
  };
}

test('records a running/not-running sample per critical application only', () => {
  const client = makeClient({ UUID: 'apphist-a' });
  recordClientApplicationHistorySamples(client);
  const series = getClientApplicationHistorySamples('apphist-a');
  assert.strictEqual(series.length, 2, 'only critical apps are tracked');

  const byKey = new Map(series.map((s) => [s.Key, s]));
  assert.ok(byKey.has('qlab') && byKey.has('vista'));
  assert.ok(!byKey.has('chrome'), 'non-critical apps are excluded');

  assert.strictEqual(byKey.get('qlab').samples.at(-1).online, true);
  assert.strictEqual(byKey.get('vista').samples.at(-1).online, false);
});

test('uses the pushed sampled-at time when recording history', () => {
  const client = makeClient({ UUID: 'apphist-a-ts' });
  const sampledAt = Date.now() - 1000;
  recordClientApplicationHistorySamples(client, sampledAt);
  const series = getClientApplicationHistorySamples('apphist-a-ts');
  assert.strictEqual(series[0].samples.at(-1).ts, sampledAt);
});

test('skips sampling when the client is offline (leaves an idle gap)', () => {
  const client = makeClient({ UUID: 'apphist-b', Online: false });
  recordClientApplicationHistorySamples(client);
  assert.deepStrictEqual(getClientApplicationHistorySamples('apphist-b'), []);
});

test('skips sampling when application monitoring status is not ok', () => {
  const client = makeClient({ UUID: 'apphist-c' });
  client.RunningApplications.Status = { State: 'permission_denied' };
  recordClientApplicationHistorySamples(client);
  assert.deepStrictEqual(getClientApplicationHistorySamples('apphist-c'), []);
});

test('drops history for applications that are no longer critical', () => {
  const client = makeClient({ UUID: 'apphist-d' });
  recordClientApplicationHistorySamples(client);
  assert.strictEqual(getClientApplicationHistorySamples('apphist-d').length, 2);

  // Vista is no longer marked critical.
  client.RunningApplications.Items = client.RunningApplications.Items.filter(
    (i) => i.Key !== 'vista'
  );
  recordClientApplicationHistorySamples(client);
  const series = getClientApplicationHistorySamples('apphist-d');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].Key, 'qlab');
});

test('sync prunes clients that are no longer present', () => {
  syncClientApplicationHistoryStore([makeClient({ UUID: 'apphist-e' })]);
  assert.strictEqual(getClientApplicationHistorySamples('apphist-e').length, 2);

  syncClientApplicationHistoryStore([]);
  assert.deepStrictEqual(getClientApplicationHistorySamples('apphist-e'), []);
});
