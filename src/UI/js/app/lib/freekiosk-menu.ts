// Which FreeKiosk actions the right-click menu offers, per the operator's
// FreeKiosk preferences. The keys mirror FreeKioskMenuSettingKey in
// src/Modules/FreeKiosk/commands.ts (the renderer cannot import across its
// rootDir); test/renderer-freekiosk-menu.test.js holds the two together.

export const FREEKIOSK_MENU_POLL_SETTING_KEY = 'FREEKIOSK_MENU_POLL';

export function FreeKioskMenuSettingKey(CommandID: string): string {
  return `FREEKIOSK_MENU_${CommandID.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

// Only an explicit `false` hides an action. A missing setting (an older server,
// or settings not loaded yet) leaves the menu as it was before these existed.
export function IsFreeKioskMenuActionEnabled(
  SettingsList: readonly { Key: string; Value: unknown }[] | null | undefined,
  Key: string
): boolean {
  if (!Array.isArray(SettingsList)) return true;
  return SettingsList.find((Setting) => Setting && Setting.Key === Key)?.Value !== false;
}
