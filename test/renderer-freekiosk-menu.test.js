const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the FreeKiosk preferences that switch individual right-click actions
// on and off: the server-side settings generated from the command map, and the
// renderer's mirror of the key scheme (src/UI/js/app/lib/freekiosk-menu.ts),
// which cannot import the server module and so is held to it here.
//
// Renderer side loaded from dist-test/ (see test/renderer-utils.test.js for why).
const Renderer = require('../dist-test/UI/js/app/lib/freekiosk-menu.js');
const Server = require('../dist/Modules/FreeKiosk/commands');
const { DefaultSettings, Groups } = require('../dist/Modules/SettingsManager/DefaultSettings');

const MenuCommands = Server.FREEKIOSK_COMMANDS.filter(Server.IsFreeKioskMenuCommand);

test('the renderer derives the same keys as the server', () => {
  assert.equal(Renderer.FREEKIOSK_MENU_POLL_SETTING_KEY, Server.FREEKIOSK_MENU_POLL_SETTING_KEY);
  for (const Command of Server.FREEKIOSK_COMMANDS) {
    assert.equal(
      Renderer.FreeKioskMenuSettingKey(Command.ID),
      Server.FreeKioskMenuSettingKey(Command.ID)
    );
  }
});

test('keys are safe to use in an element id selector', () => {
  assert.equal(Server.FreeKioskMenuSettingKey('screen.on'), 'FREEKIOSK_MENU_SCREEN_ON');
  assert.equal(Server.FreeKioskMenuSettingKey('restart-ui'), 'FREEKIOSK_MENU_RESTART_UI');
  for (const Command of MenuCommands) {
    assert.match(Server.FreeKioskMenuSettingKey(Command.ID), /^[A-Z0-9_]+$/);
  }
});

test('menu commands are the bulk ones that need no parameter form', () => {
  assert.ok(MenuCommands.length > 0);
  for (const Command of Server.FREEKIOSK_COMMANDS) {
    const Expected = !!Command.Bulk && !(Command.Params && Command.Params.length);
    assert.equal(Server.IsFreeKioskMenuCommand(Command), Expected, Command.ID);
  }
});

test('every menu action has a FreeKiosk preference that defaults to on', () => {
  assert.ok(Groups.some((Group) => Group.Name === 'FreeKiosk'));
  const Keys = [
    Server.FREEKIOSK_MENU_POLL_SETTING_KEY,
    ...MenuCommands.map((Command) => Server.FreeKioskMenuSettingKey(Command.ID)),
  ];
  for (const Key of Keys) {
    const Setting = DefaultSettings.find((Entry) => Entry.Key === Key);
    assert.ok(Setting, `missing setting for ${Key}`);
    assert.equal(Setting.Group, 'FreeKiosk');
    assert.equal(Setting.Type, 'BOOLEAN');
    // On by default, so upgrading leaves the menu exactly as it was.
    assert.equal(Setting.DefaultValue, true, `${Key} must default to on`);
  }
  // Nothing else in the group, and no key generated twice.
  const GroupKeys = DefaultSettings.filter((Entry) => Entry.Group === 'FreeKiosk').map(
    (Entry) => Entry.Key
  );
  assert.deepEqual(GroupKeys.slice().sort(), Keys.slice().sort());
  assert.equal(new Set(DefaultSettings.map((Entry) => Entry.Key)).size, DefaultSettings.length);
});

test('only an explicit false hides an action', () => {
  const { IsFreeKioskMenuActionEnabled } = Renderer;
  const List = [
    { Key: 'FREEKIOSK_MENU_REBOOT', Value: false },
    { Key: 'FREEKIOSK_MENU_WAKE', Value: true },
  ];
  assert.equal(IsFreeKioskMenuActionEnabled(List, 'FREEKIOSK_MENU_REBOOT'), false);
  assert.equal(IsFreeKioskMenuActionEnabled(List, 'FREEKIOSK_MENU_WAKE'), true);
  // Not yet loaded, or a server that predates the setting.
  assert.equal(IsFreeKioskMenuActionEnabled(List, 'FREEKIOSK_MENU_LOCK'), true);
  assert.equal(IsFreeKioskMenuActionEnabled([], 'FREEKIOSK_MENU_LOCK'), true);
  assert.equal(IsFreeKioskMenuActionEnabled(null, 'FREEKIOSK_MENU_LOCK'), true);
});
