const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/settings-tabs.ts: which Preferences tab ends up
// active as the tab set changes, and how numeric values are shown with their
// units. The DOM side (BuildSettingsNav in settings.ts) is a thin adapter over
// this and is not covered here.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  FormatSettingValue,
  ResolveSettingsTab,
} = require('../dist-test/UI/js/app/lib/settings-tabs.js');

const TABS = ['SYSTEM', 'ALERTS', '__REMOTE_ACCESS__', '__PAIRED_DEVICES__'];

test('an available tab stays selected', () => {
  assert.equal(ResolveSettingsTab('ALERTS', TABS), 'ALERTS');
  assert.equal(ResolveSettingsTab('__PAIRED_DEVICES__', TABS), '__PAIRED_DEVICES__');
});

test('a tab that has gone falls back to the first', () => {
  assert.equal(ResolveSettingsTab('__PAIRED_DEVICES__', ['SYSTEM', 'ALERTS']), 'SYSTEM');
  assert.equal(ResolveSettingsTab('nonsense', TABS), 'SYSTEM');
});

test('nothing selected yet picks the first tab', () => {
  assert.equal(ResolveSettingsTab(null, TABS), 'SYSTEM');
  assert.equal(ResolveSettingsTab(undefined, TABS), 'SYSTEM');
  assert.equal(ResolveSettingsTab('', TABS), 'SYSTEM');
});

test('no tabs at all resolves to nothing', () => {
  assert.equal(ResolveSettingsTab('SYSTEM', []), '');
  assert.equal(ResolveSettingsTab(null, []), '');
});

// ---- FormatSettingValue ---------------------------------------------------

test('a numeric setting shows its unit, spaced except for %', () => {
  assert.equal(FormatSettingValue(80, '%'), '80%');
  assert.equal(FormatSettingValue(500, 'ms'), '500 ms');
  assert.equal(FormatSettingValue(5, 's'), '5 s');
  assert.equal(FormatSettingValue(5, 'minutes'), '5 minutes');
});

test('a spelled-out unit reads singular for exactly 1', () => {
  assert.equal(FormatSettingValue(1, 'minutes'), '1 minute');
  assert.equal(FormatSettingValue(1, 'ms'), '1 ms');
  assert.equal(FormatSettingValue(1, 's'), '1 s');
});

test('no unit leaves the bare value', () => {
  assert.equal(FormatSettingValue(3, undefined), '3');
  assert.equal(FormatSettingValue(3, null), '3');
  assert.equal(FormatSettingValue(3, '  '), '3');
});
