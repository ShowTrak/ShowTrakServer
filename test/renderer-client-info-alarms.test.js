const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Covers src/UI/js/app/lib/client-info-alarms.ts: which view-modal tabs get a
// warning icon for an entity's active alarms.
//
// A client's warning texts are a renderer mirror of the server's *_WARNINGS
// tables, so they are checked against the real tables: a renamed warning would
// otherwise silently fall back to marking Status alone.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  CLIENT_WARNING_TABS,
  ClientAlarmTabs,
  DummyAlarmTabs,
  FreeKioskAlarmTabs,
  MonitorAlarmTabs,
} = require('../dist-test/UI/js/app/lib/client-info-alarms.js');
const { AvailableClientInfoTabs } = require('../dist-test/UI/js/app/lib/client-info-tabs.js');

const ClientManager = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager');
const { USB_WARNINGS } = require(path.join(ClientManager, 'usb.js'));
const { STORAGE_WARNINGS } = require(path.join(ClientManager, 'storage.js'));
const { DISPLAY_WARNINGS } = require(path.join(ClientManager, 'display.js'));
const { AUDIO_WARNINGS } = require(path.join(ClientManager, 'audio.js'));
const { NETWORK_WARNINGS } = require(path.join(ClientManager, 'network.js'));
const { SYSTEM_CHECK_WARNINGS } = require(path.join(ClientManager, 'system-checks.js'));
const { APPLICATION_NOT_RESPONDING_WARNING, APPLICATION_NOT_FOREGROUND_WARNING } = require(
  path.join(ClientManager, 'health.js')
);

const Metrics = require(path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js'));

test('every server warning maps to the tab its condition is set on', () => {
  const Expect = (Table, Tab) => {
    for (const Warning of Object.values(Table)) {
      assert.equal(CLIENT_WARNING_TABS[Warning], Tab, Warning);
    }
  };
  Expect(USB_WARNINGS, 'usb');
  Expect(STORAGE_WARNINGS, 'storage');
  Expect(DISPLAY_WARNINGS, 'video');
  Expect(AUDIO_WARNINGS, 'audio');
  Expect(NETWORK_WARNINGS, 'network');
  Expect([APPLICATION_NOT_RESPONDING_WARNING, APPLICATION_NOT_FOREGROUND_WARNING], 'apps');
  for (const Key of ['cpu', 'ram', 'uptime']) {
    assert.equal(CLIENT_WARNING_TABS[SYSTEM_CHECK_WARNINGS[Key]], 'usage', Key);
  }
  for (const Key of ['power', 'battery', 'charging', 'temperature', 'thermal']) {
    assert.equal(CLIENT_WARNING_TABS[SYSTEM_CHECK_WARNINGS[Key]], 'power', Key);
  }
  assert.equal(Object.keys(SYSTEM_CHECK_WARNINGS).length, 8, 'a new system check needs a tab');
});

test('every mapped tab exists on a client', () => {
  const Tabs = AvailableClientInfoTabs('client');
  for (const Tab of Object.values(CLIENT_WARNING_TABS)) assert.ok(Tabs.includes(Tab), Tab);
});

test('a client marks Status and each warning tab once', () => {
  assert.deepEqual(
    ClientAlarmTabs({
      Degraded: true,
      DegradedWarnings: [
        DISPLAY_WARNINGS.resolution,
        DISPLAY_WARNINGS.rotation,
        SYSTEM_CHECK_WARNINGS.cpu,
      ],
    }),
    ['status', 'video', 'usage']
  );
});

test('an unknown warning (an SDK client reason) marks Status only', () => {
  assert.deepEqual(ClientAlarmTabs({ Degraded: true, DegradedWarnings: ['Projector lamp'] }), [
    'status',
  ]);
});

test('a healthy, starting-up or missing client marks nothing', () => {
  assert.deepEqual(ClientAlarmTabs({ Degraded: false, DegradedWarnings: [] }), []);
  assert.deepEqual(ClientAlarmTabs(null), []);
});

test('a monitor marks Status when a judged check is down or degraded', () => {
  const Ok = { LastChecked: 1, Online: true, Degraded: false };
  assert.deepEqual(MonitorAlarmTabs([Ok]), []);
  assert.deepEqual(MonitorAlarmTabs([Ok, { ...Ok, Online: false }]), ['status']);
  assert.deepEqual(MonitorAlarmTabs([{ ...Ok, Degraded: true }]), ['status']);
  // Never run: no verdict, so no alarm.
  assert.deepEqual(MonitorAlarmTabs([{ LastChecked: null, Online: false }]), []);
  assert.deepEqual(MonitorAlarmTabs(undefined), []);
});

test('a dummy marks Status while degraded', () => {
  assert.deepEqual(DummyAlarmTabs({ Degraded: true }), ['status']);
  assert.deepEqual(DummyAlarmTabs({ Degraded: false }), []);
});

test('a FreeKiosk alarm marks the tab its section card is drawn on', () => {
  const Catalogue = Metrics.FREEKIOSK_METRICS;
  const InSection = (Section) => Catalogue.find((Metric) => Metric.Section === Section).Key;
  assert.deepEqual(
    FreeKioskAlarmTabs([{ Key: InSection('Battery') }, { Key: InSection('Memory') }], Catalogue),
    ['status', 'battery', 'misc']
  );
  assert.deepEqual(FreeKioskAlarmTabs([], Catalogue), []);
  // Catalogue not loaded yet: Status still says something is wrong.
  assert.deepEqual(FreeKioskAlarmTabs([{ Key: InSection('Screen') }], null), ['status']);
});
