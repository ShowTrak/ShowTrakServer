// The commands ShowTrak will send to a FreeKiosk terminal.
//
// This map is the allowlist. The IPC validator resolves a requested command
// against it and rejects anything absent, so the set of things a terminal can be
// told to do is exactly what is declared here — no blocklist to keep current.
//
// That is why /api/js is not here. FreeKiosk will evaluate arbitrary JavaScript
// inside the kiosk WebView; exposing it would put remote code execution one
// click away in a bulk context menu. Its absence is the control, not an
// oversight, so do not add it without a deliberate decision.
//
// Params reuse MonitoringSettingField so a command's parameter form renders
// through the same schema-driven field renderer as everything else.
import type { MonitoringSettingField } from '../MonitoringMethods/types';
import type { FreeKioskDisplayMode } from './metrics';

export type FreeKioskCommandGroup = 'Power' | 'Display' | 'Content' | 'Audio' | 'Maintenance';

export interface FreeKioskCommandDef {
  ID: string;
  Label: string;
  /** Bootstrap Icons name without the `bi-` prefix. */
  Icon: string;
  Method: 'GET' | 'POST';
  Path: string;
  Group: FreeKioskCommandGroup;
  Params?: MonitoringSettingField[];
  /** Needs a confirmation dialog. */
  Destructive?: boolean;
  /** Offered as a bulk action in the multi-select context menu. */
  Bulk?: boolean;
  /** How the view modal draws it. Sliders write the metric named by Metric. */
  Control?: 'button' | 'slider';
  Metric?: string;
  /**
   * Display modes this command does anything in. Absent means all of them.
   *
   * This is not cosmetic. FreeKiosk accepts a WebView command in External App
   * mode, answers `executed: true`, and does nothing — verified against a live
   * device, where POSTing a new URL in app mode left `webview.currentUrl`
   * untouched. Reporting that as a success would be a lie ShowTrak told on the
   * device's behalf, so a command outside its modes is refused rather than sent.
   */
  Modes?: readonly FreeKioskDisplayMode[];
  /**
   * The device is expected to drop the connection while carrying this out.
   *
   * A reboot or a UI restart tears down the HTTP server mid-response, so the
   * socket dies before an answer arrives. That is the command WORKING. Without
   * this flag ShowTrak reports "socket hang up" as a failure on exactly the
   * commands most likely to have succeeded, which trains an operator to ignore
   * the one error message that would matter if it were real.
   */
  ExpectDisconnect?: boolean;
  Note?: string;
}

/** Shared by the two 0–100 sliders, which take the same body either way. */
const LEVEL_PARAM: MonitoringSettingField[] = [
  { Key: 'value', Label: 'Level', Type: 'number', Default: 50, Min: 0, Max: 100, Required: true },
];

export const FREEKIOSK_COMMANDS = Object.freeze([
  // ---- Power --------------------------------------------------------------
  {
    ID: 'wake',
    Label: 'Wake Screen',
    Icon: 'brightness-high',
    Method: 'GET',
    Path: '/api/wake',
    Group: 'Power',
    Bulk: true,
    Control: 'button',
    Note: 'Dismisses the screensaver. Does not turn a physically-off panel back on — use Screen On for that.',
  },
  {
    ID: 'screen.on',
    Label: 'Screen On',
    Icon: 'display',
    Method: 'GET',
    Path: '/api/screen/on',
    Group: 'Power',
    Bulk: true,
    Control: 'button',
  },
  {
    ID: 'screen.off',
    Label: 'Screen Off',
    Icon: 'display-fill',
    Method: 'GET',
    Path: '/api/screen/off',
    Group: 'Power',
    Control: 'button',
    Note: 'Without Device Owner, Device Admin or the accessibility service the device can only dim to 0% — the panel stays on but appears black.',
  },
  {
    ID: 'lock',
    Label: 'Lock Device',
    Icon: 'lock-fill',
    Method: 'GET',
    Path: '/api/lock',
    Group: 'Power',
    Bulk: true,
    Destructive: true,
    Control: 'button',
    Note: 'Needs Device Owner, Device Admin or the accessibility service. Without one the device refuses it and ShowTrak reports the refusal.',
  },
  {
    ID: 'reboot',
    Label: 'Reboot',
    Icon: 'arrow-clockwise',
    Method: 'GET',
    Path: '/api/reboot',
    Group: 'Power',
    Bulk: true,
    Destructive: true,
    Control: 'button',
    ExpectDisconnect: true,
    Note: 'Device Owner only. A device without it answers HTTP 200 and refuses in the body, which ShowTrak surfaces as a failure. A device that DOES reboot drops the connection instead, which is reported as success.',
  },

  // ---- Display ------------------------------------------------------------
  {
    ID: 'brightness',
    Label: 'Brightness',
    Icon: 'brightness-alt-high',
    Method: 'POST',
    Path: '/api/brightness',
    Group: 'Display',
    Control: 'slider',
    Metric: 'screen_brightness',
    Params: LEVEL_PARAM,
    Note: 'Ignored by devices with App Brightness Control switched off, where the system owns brightness.',
  },
  {
    ID: 'screensaver.on',
    Label: 'Enable Screensaver',
    Icon: 'moon-stars',
    Method: 'GET',
    Path: '/api/screensaver/on',
    Group: 'Display',
    Control: 'button',
  },
  {
    ID: 'screensaver.off',
    Label: 'Disable Screensaver',
    Icon: 'sun',
    Method: 'GET',
    Path: '/api/screensaver/off',
    Group: 'Display',
    Control: 'button',
  },

  // ---- Content ------------------------------------------------------------
  {
    ID: 'reload',
    Label: 'Reload Page',
    Icon: 'arrow-repeat',
    Method: 'GET',
    Path: '/api/reload',
    Group: 'Content',
    Bulk: true,
    Control: 'button',
    Modes: ['webview'],
  },

  // ---- Audio --------------------------------------------------------------
  {
    ID: 'volume',
    Label: 'Volume',
    Icon: 'volume-up',
    Method: 'POST',
    Path: '/api/volume',
    Group: 'Audio',
    Control: 'slider',
    Metric: 'audio_volume',
    Params: LEVEL_PARAM,
  },
  {
    ID: 'audio.beep',
    Label: 'Beep',
    Icon: 'bell',
    Method: 'GET',
    Path: '/api/audio/beep',
    Group: 'Audio',
    Control: 'button',
    Note: 'Handy for picking one terminal out of a rack.',
  },

  // ---- Maintenance --------------------------------------------------------
  {
    ID: 'clearCache',
    Label: 'Clear Cache',
    Icon: 'trash',
    Method: 'GET',
    Path: '/api/clearCache',
    Group: 'Maintenance',
    Bulk: true,
    Destructive: true,
    Control: 'button',
    Modes: ['webview'],
    Note: 'Clears the WebView cache, cookies and local storage, then reloads. Signs the page out of anything it was logged into.',
  },
  {
    ID: 'restart-ui',
    Label: 'Restart Kiosk UI',
    Icon: 'arrow-counterclockwise',
    Method: 'GET',
    Path: '/api/restart-ui',
    Group: 'Maintenance',
    Bulk: true,
    Destructive: true,
    Control: 'button',
    ExpectDisconnect: true,
    Note: 'Recreates the FreeKiosk activity without rebooting the device.',
  },
] as const satisfies readonly FreeKioskCommandDef[]);

export const FREEKIOSK_COMMANDS_BY_ID: ReadonlyMap<string, FreeKioskCommandDef> = new Map(
  FREEKIOSK_COMMANDS.map((Command) => [Command.ID, Command])
);

export function GetFreeKioskCommand(ID: unknown): FreeKioskCommandDef | null {
  if (typeof ID !== 'string') return null;
  return FREEKIOSK_COMMANDS_BY_ID.get(ID) || null;
}
