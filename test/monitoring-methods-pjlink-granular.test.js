// Pure-evaluator tests for the granular pjlink-* methods. Each method exposes
// its slice logic via _internal, judged here against synthetic snapshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A reachable-projector snapshot; override fields per case.
function snapshot(overrides = {}) {
  return {
    Reachable: true,
    LatencyMs: 5,
    Class: '1',
    Power: 1,
    PowerErr: null,
    Erst: { Fan: 0, Lamp: 0, Temperature: 0, Cover: 0, Filter: 0, Other: 0 },
    ErstErr: null,
    Lamps: [{ Hours: 100, On: true }],
    LampErr: null,
    Input: '31',
    InputErr: null,
    Mute: '30',
    Name: 'Main',
    Manufacturer: 'ACME',
    Model: 'PX-1',
    ...overrides,
  };
}

test('pjlink-power: expected-state matching', () => {
  const { _internal } = require(methodPath('pjlink-power.js'));
  assert.equal(_internal.EvaluatePower(snapshot({ Power: 1 }), 'on'), null);
  assert.match(_internal.EvaluatePower(snapshot({ Power: 0 }), 'on'), /expected On/);
  assert.equal(_internal.EvaluatePower(snapshot({ Power: 3 }), 'on-or-warmup'), null);
  assert.equal(_internal.EvaluatePower(snapshot({ Power: 0 }), 'any'), null);
  assert.match(_internal.EvaluatePower(snapshot({ PowerErr: 'ERR3', Power: null }), 'on'), /busy/i);
  assert.match(_internal.EvaluatePower(snapshot({ PowerErr: 'ERR4', Power: null }), 'on'), /failure/i);
});

test('pjlink-lamp: threshold, laser (ERR1) and unavailable', () => {
  const { _internal } = require(methodPath('pjlink-lamp.js'));
  assert.deepEqual(_internal.EvaluateLamps(snapshot({ Lamps: [{ Hours: 100, On: true }] }), 0), {
    Reasons: [],
    NoLamp: false,
  });
  const over = _internal.EvaluateLamps(snapshot({ Lamps: [{ Hours: 5000, On: true }] }), 4000);
  assert.equal(over.Reasons.length, 1);
  assert.match(over.Reasons[0], /Lamp 1/);
  assert.deepEqual(_internal.EvaluateLamps(snapshot({ Lamps: null, LampErr: 'ERR1' }), 0), {
    Reasons: [],
    NoLamp: true,
  });
  const unavailable = _internal.EvaluateLamps(snapshot({ Lamps: null, LampErr: 'ERR3' }), 0);
  assert.equal(unavailable.NoLamp, false);
  assert.match(unavailable.Reasons[0], /unavailable/i);
});

test('pjlink-errors: errors always degrade, warnings gated', () => {
  const { _internal } = require(methodPath('pjlink-errors.js'));
  assert.deepEqual(_internal.EvaluateErrors(snapshot(), true), []);
  const errSnap = snapshot({ Erst: { Fan: 2, Lamp: 1, Temperature: 0, Cover: 0, Filter: 0, Other: 0 } });
  assert.deepEqual(_internal.EvaluateErrors(errSnap, false), ['Fan error']);
  assert.deepEqual(_internal.EvaluateErrors(errSnap, true), ['Fan error', 'Lamp warning']);
  assert.match(_internal.EvaluateErrors(snapshot({ Erst: null, ErstErr: 'ERR3' }), true)[0], /unavailable/i);
});

test('pjlink-input: power gating and expected-code matching', () => {
  const { _internal } = require(methodPath('pjlink-input.js'));
  assert.equal(_internal.EvaluateInput(snapshot({ Input: '31' }), '31'), null);
  assert.equal(_internal.EvaluateInput(snapshot({ Input: '31' }), ''), null); // report-only
  assert.match(_internal.EvaluateInput(snapshot({ Input: '32' }), '31'), /expected 31/);
  assert.match(_internal.EvaluateInput(snapshot({ Power: 0 }), '31'), /not on/i);
  assert.match(_internal.EvaluateInput(snapshot({ InputErr: 'ERR3' }), '31'), /unavailable/i);
});
