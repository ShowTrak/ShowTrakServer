// Exercises FreeKioskMetricLiveState in src/UI/js/app/freekiosk-modal.ts — the
// colour and text of a monitored reading's status card on the FreeKiosk Status
// tab. It follows the client's critical displays and interfaces: an offline
// terminal's reading is unknown rather than faulty, so it must not paint red.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { FreeKioskMetricLiveState } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'freekiosk-modal.js')
);

test('a healthy reading is Online and shows its value', () => {
  assert.deepEqual(FreeKioskMetricLiveState(true, false, '80%', ''), {
    State: 'ONLINE',
    Label: '80%',
  });
});

test('a breaching reading is Degraded and says what it should have been', () => {
  assert.deepEqual(FreeKioskMetricLiveState(true, true, '14%', 'expected 20% or more'), {
    State: 'DEGRADED',
    Label: '14% · expected 20% or more',
  });
  // Operators with no wording (e.g. an unknown one) still show the value.
  assert.deepEqual(FreeKioskMetricLiveState(true, true, '14%', ''), {
    State: 'DEGRADED',
    Label: '14%',
  });
});

test('an offline terminal makes every reading Idle, breaching or not', () => {
  for (const Breaching of [false, true]) {
    assert.deepEqual(FreeKioskMetricLiveState(false, Breaching, '14%', 'expected 20% or more'), {
      State: 'IDLE',
      Label: 'Idle',
    });
  }
});
