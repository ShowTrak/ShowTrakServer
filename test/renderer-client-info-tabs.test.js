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

test('a ShowTrak Client install gets every tab, Status first and Logs last', () => {
  assert.deepEqual(AvailableClientInfoTabs('client'), [
    'status',
    'info',
    'variables',
    'wol',
    'usb',
    'storage',
    'video',
    'audio',
    'network',
    'apps',
    'usage',
    'power',
    'actions',
    'logs',
  ]);
  assert.equal(DEFAULT_CLIENT_INFO_TAB, 'status');
});

test('the Web UI leaves client Actions off the rail, and keeps everything else', () => {
  const Desktop = AvailableClientInfoTabs('client');
  const Web = AvailableClientInfoTabs('client', 'web');
  assert.deepEqual(
    Web,
    Desktop.filter((Key) => Key !== 'actions')
  );
  // A monitoring target's Actions are not client editing: the web keeps them.
  assert.deepEqual(AvailableClientInfoTabs('target', 'web'), [
    'status',
    'actions',
    'checks',
    'settings',
    'logs',
  ]);
  // A web operator sent to a client's Actions lands on Status instead.
  assert.equal(ResolveClientInfoTab('actions', 'client', 'web'), 'status');
  assert.equal(ResolveClientInfoTab('actions', 'client'), 'actions');
});

test('an integrated (SDK) client gets only Status, Info, Wake on LAN, Actions and Logs', () => {
  assert.deepEqual(AvailableClientInfoTabs('integrated'), [
    'status',
    'info',
    'wol',
    'actions',
    'logs',
  ]);
  // Its Actions are client editing, which the Web UI does not do.
  assert.deepEqual(AvailableClientInfoTabs('integrated', 'web'), ['status', 'info', 'wol', 'logs']);
});

test('a monitoring target gets Status, Actions, Checks, Settings and Logs', () => {
  assert.deepEqual(AvailableClientInfoTabs('target'), [
    'status',
    'actions',
    'checks',
    'settings',
    'logs',
  ]);
});

test('a dummy client gets Status, Settings and Logs', () => {
  assert.deepEqual(AvailableClientInfoTabs('dummy'), ['status', 'settings', 'logs']);
});

test('every kind ends with the Logs tab', () => {
  for (const Kind of KINDS) {
    const Tabs = ClientInfoTabsFor(Kind);
    assert.deepEqual(Tabs[Tabs.length - 1], { Key: 'logs', Title: 'Logs' }, Kind);
    const WebTabs = ClientInfoTabsFor(Kind, 'web');
    assert.deepEqual(WebTabs[WebTabs.length - 1], { Key: 'logs', Title: 'Logs' }, Kind);
  }
});

test('a FreeKiosk terminal gets Status, Controls, its metric tabs and Settings', () => {
  assert.deepEqual(AvailableClientInfoTabs('freekiosk'), [
    'status',
    'controls',
    'content',
    'screen',
    'battery',
    'network',
    'misc',
    'settings',
    'logs',
  ]);
  assert.deepEqual(
    ClientInfoTabsFor('freekiosk').map((Tab) => Tab.Title),
    ['Status', 'Controls', 'Content', 'Screen', 'Battery', 'Network', 'Misc', 'Settings', 'Logs']
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
  // An SDK client runs no scripts and is still edited in its own editor.
  assert.equal(ResolveClientInfoTab('variables', 'integrated'), 'status');
  assert.equal(ResolveClientInfoTab('info', 'target'), 'status');
  // Moving from a target to a dummy client must not leave Actions selected.
  assert.equal(ResolveClientInfoTab('actions', 'dummy'), 'status');
  assert.equal(ResolveClientInfoTab('settings', 'client'), 'status');
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
