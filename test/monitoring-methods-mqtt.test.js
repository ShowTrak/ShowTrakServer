const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A stand-in for an mqtt.MqttClient: an EventEmitter with subscribe()/end().
class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    this.options = opts;
    this.ended = false;
    this.subscribedTopic = null;
    this._subError = null;
  }

  subscribe(topic, cb) {
    this.subscribedTopic = topic;
    if (typeof cb === 'function') cb(this._subError || null);
    return this;
  }

  end(force, cb) {
    this.ended = true;
    const done = typeof force === 'function' ? force : cb;
    if (typeof done === 'function') done();
    return this;
  }
}

// Build a mock of the `mqtt` package whose connect() returns a FakeClient and
// then drives a scripted scenario on the next tick (after Run() has attached its
// listeners). `_created` exposes the clients for teardown assertions.
function mqttMock(scenario) {
  const created = [];
  function connect(opts) {
    const client = new FakeClient(opts);
    if (scenario.subError) client._subError = scenario.subError;
    created.push(client);
    setImmediate(() => {
      if (scenario.type === 'refused') {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:1883');
        client.emit('error', err);
        client.emit('close');
        return;
      }
      client.emit('connect', { cmd: 'connack', returnCode: 0 });
      if (scenario.type === 'message' || scenario.type === 'mismatch') {
        const topic = scenario.receivedTopic || client.subscribedTopic || opts.topic || 'test';
        setImmediate(() => client.emit('message', topic, Buffer.from(String(scenario.payload))));
      }
      // scenario.type === 'timeout' emits nothing further; Run's deadline fires.
    });
    return client;
  }
  return { module: { connect }, created };
}

function loadMqtt(mock) {
  return loadWithMocks(methodPath('mqtt-topic.js'), { mqtt: mock.module });
}

test('mqtt method is online when a message is received on the topic', async () => {
  const mock = mqttMock({ type: 'message', receivedTopic: 'stage/heartbeat', payload: 'alive' });
  const mqttMethod = loadMqtt(mock);

  assert.equal(mqttMethod.ID, 'mqtt-topic');
  assert.ok(Array.isArray(mqttMethod.Settings));

  const result = await mqttMethod.Run({
    Address: '127.0.0.1',
    Settings: { Port: 1883, Topic: 'stage/#', Timeout: 2000 },
  });

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.MessageReceived, true);
  assert.equal(result.ReceivedTopic, 'stage/heartbeat');
  assert.equal(result.Payload, 'alive');
  assert.equal(typeof result.LatencyMs, 'number');
  // Client fully torn down after the probe.
  assert.equal(mock.created[0].ended, true);
});

test('mqtt method is degraded when the payload does not contain ExpectedPayload', async () => {
  const mock = mqttMock({ type: 'mismatch', payload: 'OFFLINE' });
  const mqttMethod = loadMqtt(mock);

  const result = await mqttMethod.Run({
    Address: '127.0.0.1',
    Settings: { Port: 1883, Topic: 'stage/status', ExpectedPayload: 'ONLINE', Timeout: 2000 },
  });

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Unexpected payload');
  assert.equal(result.MessageReceived, true);
  assert.equal(mock.created[0].ended, true);
});

test('mqtt method is offline (connected, no message) when nothing arrives before timeout', async () => {
  const mock = mqttMock({ type: 'timeout' });
  const mqttMethod = loadMqtt(mock);

  const result = await mqttMethod.Run({
    Address: '127.0.0.1',
    Settings: { Port: 1883, Topic: 'stage/heartbeat', Timeout: 500 },
  });

  assert.equal(result.Success, false);
  assert.equal(result.Connected, true);
  assert.match(result.Error, /no message/i);
  assert.equal(mock.created[0].ended, true);
});

test('mqtt method is offline (could not connect) when the connection is refused', async () => {
  const mock = mqttMock({ type: 'refused' });
  const mqttMethod = loadMqtt(mock);

  const result = await mqttMethod.Run({
    Address: '127.0.0.1',
    Settings: { Port: 1883, Topic: 'stage/heartbeat', Timeout: 2000 },
  });

  assert.equal(result.Success, false);
  assert.equal(result.Connected, false);
  assert.match(result.Error, /could not connect/i);
  assert.equal(mock.created[0].ended, true);
});

test('mqtt method validates address, port and topic configuration', async () => {
  const mock = mqttMock({ type: 'message', payload: 'x' });
  const mqttMethod = loadMqtt(mock);

  assert.equal((await mqttMethod.Run({})).Success, false);
  assert.equal(
    (await mqttMethod.Run({ Address: '127.0.0.1', Settings: { Port: 70000, Topic: 't' } })).Success,
    false
  );
  assert.equal(
    (await mqttMethod.Run({ Address: '127.0.0.1', Settings: { Port: 1883, Topic: '' } })).Success,
    false
  );
  // No client should have been constructed for invalid configs.
  assert.equal(mock.created.length, 0);
});

test('mqtt internal helpers clamp timeout, truncate payloads and evaluate expectations', () => {
  const mock = mqttMock({ type: 'message', payload: 'x' });
  const mqttMethod = loadMqtt(mock);
  const { ClampTimeout, TruncatePayload, EvaluatePayload } = mqttMethod._internal;

  assert.equal(ClampTimeout(100), 500); // floor
  assert.equal(ClampTimeout(999999), 60000); // ceiling
  assert.equal(ClampTimeout('abc'), 6000); // default
  assert.equal(ClampTimeout(6000), 6000);

  assert.equal(TruncatePayload(Buffer.from('hello')), 'hello');
  const long = 'a'.repeat(300);
  const truncated = TruncatePayload(Buffer.from(long));
  assert.equal(truncated.length, 257); // 256 chars + ellipsis
  assert.ok(truncated.endsWith('…'));

  assert.equal(EvaluatePayload('ONLINE now', 'ONLINE'), null);
  assert.equal(EvaluatePayload('anything', ''), null); // no expectation set
  const mismatch = EvaluatePayload('OFFLINE', 'ONLINE');
  assert.equal(mismatch.Degraded, true);
  assert.equal(mismatch.DegradedReason, 'Unexpected payload');
});
