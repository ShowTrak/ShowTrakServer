const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/client-info-tabs.ts: which view-modal tabs each kind
// of entity gets, which one ends up active, and where each FreeKiosk registry
// section is drawn. The DOM side (client-info-nav.ts) is a thin adapter over
// this and is not covered here.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  AvailableClientInfoTabs,
  ClientInfoTabsFor,
  DEFAULT_CLIENT_INFO_TAB,
  FREEKIOSK_METRIC_TABS,
  FreeKioskSectionTab,
  ResolveClientInfoTab,
} = require('../dist-test/UI/js/app/lib/client-info-tabs.js');

const KINDS = ['client', 'integrated', 'target', 'dummy', 'freekiosk'];

test('a ShowTrak Client install gets every tab, Status first', () => {
  assert.deepEqual(AvailableClientInfoTabs('client'), [
    'status',
    'info',
    'usb',
    'video',
    'audio',
    'network',
    'apps',
    'usage',
    'power',
  ]);
  assert.equal(DEFAULT_CLIENT_INFO_TAB, 'status');
});

test('an integrated (SDK) client gets only Status and Info', () => {
  assert.deepEqual(AvailableClientInfoTabs('integrated'), ['status', 'info']);
});

test('a monitoring target gets Status and Actions', () => {
  assert.deepEqual(AvailableClientInfoTabs('target'), ['status', 'actions']);
});

test('a dummy client gets only Status', () => {
  assert.deepEqual(AvailableClientInfoTabs('dummy'), ['status']);
});

test('a FreeKiosk terminal gets Status, Controls and its metric tabs', () => {
  assert.deepEqual(AvailableClientInfoTabs('freekiosk'), [
    'status',
    'controls',
    'content',
    'screen',
    'battery',
    'network',
    'misc',
  ]);
  assert.deepEqual(
    ClientInfoTabsFor('freekiosk').map((Tab) => Tab.Title),
    ['Status', 'Controls', 'Content', 'Screen', 'Battery', 'Network', 'Misc']
  );
});

test('every kind starts on Status and lists each tab once', () => {
  for (const Kind of KINDS) {
    const Keys = AvailableClientInfoTabs(Kind);
    assert.equal(Keys[0], DEFAULT_CLIENT_INFO_TAB, Kind);
    assert.equal(new Set(Keys).size, Keys.length, Kind);
  }
});

test('an available tab stays selected', () => {
  assert.equal(ResolveClientInfoTab('network', 'client'), 'network');
  assert.equal(ResolveClientInfoTab('info', 'integrated'), 'info');
  assert.equal(ResolveClientInfoTab('battery', 'freekiosk'), 'battery');
});

test('a tab the entity cannot show falls back to Status', () => {
  assert.equal(ResolveClientInfoTab('usb', 'integrated'), 'status');
  assert.equal(ResolveClientInfoTab('info', 'target'), 'status');
  // Moving from a target to a dummy client must not leave Actions selected.
  assert.equal(ResolveClientInfoTab('actions', 'dummy'), 'status');
  // Switching from a terminal to a client must not leave a FreeKiosk tab active.
  assert.equal(ResolveClientInfoTab('controls', 'client'), 'status');
  assert.equal(ResolveClientInfoTab('apps', 'freekiosk'), 'status');
  assert.equal(ResolveClientInfoTab('nonsense', 'client'), 'status');
  assert.equal(ResolveClientInfoTab(null, 'client'), 'status');
  assert.equal(ResolveClientInfoTab(undefined, 'integrated'), 'status');
});

test('FreeKiosk sections land on their tab, and everything else on Misc', () => {
  assert.equal(FreeKioskSectionTab('Content'), 'content');
  assert.equal(FreeKioskSectionTab('Screen'), 'screen');
  assert.equal(FreeKioskSectionTab('Battery'), 'battery');
  assert.equal(FreeKioskSectionTab('Network'), 'network');
  for (const Section of ['Device', 'Audio', 'Rotation', 'Sensors', 'Storage', 'Memory', 'Poll']) {
    assert.equal(FreeKioskSectionTab(Section), 'misc', Section);
  }
  // A section added to the registry later still has somewhere to appear.
  assert.equal(FreeKioskSectionTab('Something New'), 'misc');
});

test('every registry section maps to a FreeKiosk tab the rail offers', () => {
  const { FREEKIOSK_SECTIONS } = require('../dist/Modules/FreeKiosk/metrics');
  const Rail = AvailableClientInfoTabs('freekiosk');
  for (const Tab of FREEKIOSK_METRIC_TABS) assert.ok(Rail.includes(Tab), Tab);
  for (const Section of FREEKIOSK_SECTIONS) {
    assert.ok(FREEKIOSK_METRIC_TABS.includes(FreeKioskSectionTab(Section)), Section);
  }
});
