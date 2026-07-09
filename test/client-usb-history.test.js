const test = require('node:test');
const assert = require('node:assert');

const {
  recordClientUSBHistorySamples,
  syncClientUSBHistoryStore,
  getClientUSBHistorySamples,
} = require('../dist/main/monitoring-history');

function makeClient(overrides = {}) {
  return {
    UUID: 'usbhist',
    Online: true,
    USBDeviceList: [
      {
        SerialNumber: 'AAA111',
        ManufacturerName: 'Focusrite',
        ProductName: 'Scarlett',
        IsCritical: true,
        IsConnected: true,
        Missing: false,
      },
      {
        SerialNumber: 'BBB222',
        ManufacturerName: 'Blackmagic',
        ProductName: 'ATEM',
        IsCritical: true,
        IsConnected: false,
        Missing: true,
      },
      {
        SerialNumber: 'CCC333',
        ManufacturerName: 'Generic',
        ProductName: 'Mouse',
        IsCritical: false,
        IsConnected: true,
        Missing: false,
      },
    ],
    ...overrides,
  };
}

test('records a connected/disconnected sample per critical USB device only', () => {
  recordClientUSBHistorySamples(makeClient({ UUID: 'usbhist-a' }));
  const series = getClientUSBHistorySamples('usbhist-a');
  assert.strictEqual(series.length, 2, 'only critical USB devices are tracked');

  const byKey = new Map(series.map((s) => [s.Serial, s]));
  assert.ok(byKey.has('AAA111') && byKey.has('BBB222'));
  assert.ok(!byKey.has('CCC333'), 'non-critical devices are excluded');

  assert.strictEqual(byKey.get('AAA111').samples.at(-1).online, true);
  assert.strictEqual(byKey.get('BBB222').samples.at(-1).online, false);
  assert.strictEqual(byKey.get('AAA111').Name, 'Focusrite Scarlett');
});

test('uses the pushed sampled-at time when recording history', () => {
  const sampledAt = Date.now() - 1000;
  recordClientUSBHistorySamples(makeClient({ UUID: 'usbhist-ts' }), sampledAt);
  const series = getClientUSBHistorySamples('usbhist-ts');
  assert.strictEqual(series[0].samples.at(-1).ts, sampledAt);
});

test('skips sampling when the client is offline (leaves an idle gap)', () => {
  recordClientUSBHistorySamples(makeClient({ UUID: 'usbhist-b', Online: false }));
  assert.deepStrictEqual(getClientUSBHistorySamples('usbhist-b'), []);
});

test('drops history for devices that are no longer marked critical', () => {
  const client = makeClient({ UUID: 'usbhist-d' });
  recordClientUSBHistorySamples(client);
  assert.strictEqual(getClientUSBHistorySamples('usbhist-d').length, 2);

  client.USBDeviceList = client.USBDeviceList.filter((d) => d.SerialNumber !== 'BBB222');
  recordClientUSBHistorySamples(client);
  const series = getClientUSBHistorySamples('usbhist-d');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].Serial, 'AAA111');
});

test('sync prunes clients that are no longer present', () => {
  syncClientUSBHistoryStore([makeClient({ UUID: 'usbhist-e' })]);
  assert.strictEqual(getClientUSBHistorySamples('usbhist-e').length, 2);

  syncClientUSBHistoryStore([]);
  assert.deepStrictEqual(getClientUSBHistorySamples('usbhist-e'), []);
});
