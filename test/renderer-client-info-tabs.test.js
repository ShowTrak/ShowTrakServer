const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/client-info-tabs.ts: which Client Info tabs a client
// gets and which one ends up active. The DOM side (client-info-nav.ts) is a thin
// adapter over this and is not covered here.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  AvailableClientInfoTabs,
  CLIENT_INFO_TABS,
  DEFAULT_CLIENT_INFO_TAB,
  ResolveClientInfoTab,
} = require('../dist-test/UI/js/app/lib/client-info-tabs.js');

test('a ShowTrak Client install gets every tab, Status first', () => {
  assert.deepEqual(AvailableClientInfoTabs(false), [
    'status',
    'info',
    'usb',
    'video',
    'audio',
    'network',
    'apps',
  ]);
  assert.equal(DEFAULT_CLIENT_INFO_TAB, 'status');
  assert.equal(CLIENT_INFO_TABS[0].Key, DEFAULT_CLIENT_INFO_TAB);
});

test('an integrated (SDK) client gets only Status and Info', () => {
  assert.deepEqual(AvailableClientInfoTabs(true), ['status', 'info']);
});

test('an available tab stays selected', () => {
  assert.equal(ResolveClientInfoTab('network', false), 'network');
  assert.equal(ResolveClientInfoTab('info', true), 'info');
});

test('a tab the client cannot show falls back to Status', () => {
  assert.equal(ResolveClientInfoTab('usb', true), 'status');
  assert.equal(ResolveClientInfoTab('nonsense', false), 'status');
  assert.equal(ResolveClientInfoTab(null, false), 'status');
  assert.equal(ResolveClientInfoTab(undefined, true), 'status');
});
