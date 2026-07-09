const test = require('node:test');
const assert = require('node:assert');

const {
  recordClientDisplayHistorySamples,
  syncClientDisplayHistoryStore,
  getClientDisplayHistorySamples,
} = require('../dist/main/monitoring-history');

function makeClient(overrides = {}) {
  return {
    UUID: 'disphist',
    Online: true,
    DisplayList: [
      {
        DisplayID: 'edid:DEL:1234:SER9',
        Label: 'Dell U2721',
        IsCritical: true,
        IsConnected: true,
        Missing: false,
        Mismatch: false,
      },
      {
        DisplayID: 'port:linux:DP-2',
        Label: 'Stage Left',
        IsCritical: true,
        IsConnected: true,
        Missing: false,
        Mismatch: true,
      },
      {
        DisplayID: 'attr:::1920x1080@60:e',
        Label: 'Confidence Monitor',
        IsCritical: true,
        IsConnected: false,
        Missing: true,
        Mismatch: false,
      },
      {
        DisplayID: 'edid:AAA:1:NONCRIT',
        Label: 'Operator',
        IsCritical: false,
        IsConnected: true,
        Missing: false,
        Mismatch: false,
      },
    ],
    ...overrides,
  };
}

test('records a connected/mismatch/missing sample per critical display only', () => {
  recordClientDisplayHistorySamples(makeClient({ UUID: 'disphist-a' }));
  const series = getClientDisplayHistorySamples('disphist-a');
  assert.strictEqual(series.length, 3, 'only critical displays are tracked');

  const byKey = new Map(series.map((s) => [s.DisplayID, s]));
  assert.ok(byKey.has('edid:DEL:1234:SER9'));
  assert.ok(byKey.has('port:linux:DP-2'));
  assert.ok(byKey.has('attr:::1920x1080@60:e'));
  assert.ok(!byKey.has('edid:AAA:1:NONCRIT'), 'non-critical displays are excluded');

  // Connected + matching -> online, not degraded.
  const good = byKey.get('edid:DEL:1234:SER9').samples.at(-1);
  assert.strictEqual(good.online, true);
  assert.strictEqual(good.degraded, false);

  // Connected + mismatch -> online but degraded (orange).
  const changed = byKey.get('port:linux:DP-2').samples.at(-1);
  assert.strictEqual(changed.online, true);
  assert.strictEqual(changed.degraded, true);

  // Missing -> offline (red).
  const missing = byKey.get('attr:::1920x1080@60:e').samples.at(-1);
  assert.strictEqual(missing.online, false);

  assert.strictEqual(byKey.get('edid:DEL:1234:SER9').Name, 'Dell U2721');
});

test('uses the pushed sampled-at time when recording display history', () => {
  const sampledAt = Date.now() - 1000;
  recordClientDisplayHistorySamples(makeClient({ UUID: 'disphist-ts' }), sampledAt);
  const series = getClientDisplayHistorySamples('disphist-ts');
  assert.strictEqual(series[0].samples.at(-1).ts, sampledAt);
});

test('skips sampling when the client is offline (leaves an idle gap)', () => {
  recordClientDisplayHistorySamples(makeClient({ UUID: 'disphist-b', Online: false }));
  assert.deepStrictEqual(getClientDisplayHistorySamples('disphist-b'), []);
});

test('drops history for displays that are no longer marked critical', () => {
  const client = makeClient({ UUID: 'disphist-d' });
  recordClientDisplayHistorySamples(client);
  assert.strictEqual(getClientDisplayHistorySamples('disphist-d').length, 3);

  client.DisplayList = client.DisplayList.filter((d) => d.DisplayID !== 'port:linux:DP-2');
  recordClientDisplayHistorySamples(client);
  const series = getClientDisplayHistorySamples('disphist-d');
  assert.strictEqual(series.length, 2);
  assert.ok(!series.some((s) => s.DisplayID === 'port:linux:DP-2'));
});

test('sync prunes clients that are no longer present', () => {
  syncClientDisplayHistoryStore([makeClient({ UUID: 'disphist-e' })]);
  assert.strictEqual(getClientDisplayHistorySamples('disphist-e').length, 3);

  syncClientDisplayHistoryStore([]);
  assert.deepStrictEqual(getClientDisplayHistorySamples('disphist-e'), []);
});
