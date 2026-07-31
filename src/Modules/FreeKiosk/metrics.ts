// The FreeKiosk metric registry — the single source of truth for everything
// per-value in this feature.
//
// One declaration per readable value drives all of:
//   - the per-metric alarm settings schema (BuildFreeKioskAlarmFields), which is
//     rendered by the SAME schema-driven field renderer the monitoring editor
//     uses, so the "toggle reveals a threshold" behaviour is inherited, not
//     rebuilt;
//   - the rows shown in the terminal's view modal;
//   - which history series are recorded, and how each is charted;
//   - how a threshold is evaluated and worded (see ./alarms).
//
// This module is a LEAF: type-only imports, no I/O, no manager, no DB. That is
// what makes it safe to unit test exhaustively and to hand to the renderer over
// IPC rather than mirroring it (the renderer cannot import from src/Modules —
// its tsconfig rootDir is src/UI).
//
// KEYS MUST BE ID-SAFE. The field renderer locates inputs with
// $('#MON_DYN_' + Key), which only escapes quotes. A key containing a dot would
// parse as an id-plus-class selector and its conditional visibility would
// silently never fire. Keys are therefore [A-Za-z0-9_] only, and the JSON path
// into /api/status is carried separately in Path.
import type { MonitoringSettingField } from '../MonitoringMethods/types';
import type { FreeKioskStatus } from './types';

export type FreeKioskMetricType = 'number' | 'boolean' | 'enum' | 'string';
export type FreeKioskChartKind = 'line' | 'blocks' | 'none';
export type FreeKioskMetricFormat = 'duration' | 'dbm' | 'url' | 'megabytes' | 'raw';

export type FreeKioskMetricSection =
  | 'Battery'
  | 'Screen'
  | 'Content'
  | 'Audio'
  | 'Device'
  | 'Network'
  | 'Rotation'
  | 'Sensors'
  | 'Storage'
  | 'Memory'
  | 'Poll';

// Section render order for the editor accordion and the view modal.
export const FREEKIOSK_SECTIONS: readonly FreeKioskMetricSection[] = Object.freeze([
  'Content',
  'Screen',
  'Battery',
  'Network',
  'Device',
  'Audio',
  'Rotation',
  'Sensors',
  'Storage',
  'Memory',
  'Poll',
] as const);

// ---- Monitoring groups ----------------------------------------------------

/**
 * A section an operator can switch monitoring off for wholesale.
 *
 * Turning a group off hides its alarm toggles and its charts, stops its history
 * being recorded, and force-disables any alarm already armed inside it, so a
 * setting left over from when it was on cannot fire. The readings themselves
 * still show in the view modal: they arrive in the same response either way, and
 * the brief was full visibility of everything the device reports.
 *
 * Note what this does NOT save today. Every metric in the registry comes out of
 * the single GET /api/status the poll already makes — the device returns audio,
 * autoBrightness, battery, device, memory, rotation, screen, sensors, storage,
 * webview and wifi in one body — so no group can currently cost an extra
 * request. `Fixed` and this structure are what a group that DID need its own
 * endpoint (GPS, say) would hang off.
 */
export interface FreeKioskMetricGroup {
  Key: FreeKioskMetricSection;
  Label: string;
  /** Enabled on a newly-created terminal. */
  DefaultOn: boolean;
  /** Cannot be switched off, because ShowTrak itself depends on it. */
  Fixed?: boolean;
  Note?: string;
}

export const FREEKIOSK_METRIC_GROUPS: readonly FreeKioskMetricGroup[] = Object.freeze([
  {
    Key: 'Content',
    Label: 'Content',
    DefaultOn: true,
    Note: 'Whether the terminal is actually showing something, and what. The one group worth keeping on.',
  },
  { Key: 'Screen', Label: 'Screen', DefaultOn: true },
  { Key: 'Battery', Label: 'Battery', DefaultOn: true },
  { Key: 'Network', Label: 'Network', DefaultOn: true },
  {
    Key: 'Device',
    Label: 'Device',
    DefaultOn: false,
    Note: 'Model, Android version, kiosk and Device Owner state, and uptime — which is how a reboot is detected.',
  },
  { Key: 'Audio', Label: 'Audio', DefaultOn: false },
  { Key: 'Rotation', Label: 'URL Rotation', DefaultOn: false },
  {
    Key: 'Sensors',
    Label: 'Sensors',
    DefaultOn: false,
    Note: 'Ambient light and proximity. Many tablets report -1 for sensors they do not have.',
  },
  { Key: 'Storage', Label: 'Storage', DefaultOn: false },
  { Key: 'Memory', Label: 'Memory', DefaultOn: false },
  {
    Key: 'Poll',
    Label: 'ShowTrak Poll',
    DefaultOn: true,
    Fixed: true,
    Note: "Measured by ShowTrak, not read from the device, so it costs nothing. It is also the series behind the terminal's status timeline.",
  },
] as const);

export const FREEKIOSK_METRIC_GROUPS_BY_KEY: ReadonlyMap<string, FreeKioskMetricGroup> = new Map(
  FREEKIOSK_METRIC_GROUPS.map((Group) => [Group.Key, Group])
);

/** Settings key for a group's master switch. Sections are single words, so id-safe. */
export function GroupFieldKey(Section: string): string {
  return `G_${Section}_On`;
}

/**
 * Is this section being monitored?
 *
 * An ABSENT key reads as enabled, never as the group's default. A show file
 * written before groups existed has no `G_*` keys at all, and quietly switching
 * monitoring off on somebody's configured terminals would be the worst possible
 * reading of an upgrade. New terminals get the lean default instead, because
 * BuildDefaultAlarmSettings writes the keys out explicitly.
 */
export function IsMetricGroupEnabled(Settings: unknown, Section: string): boolean {
  const Group = FREEKIOSK_METRIC_GROUPS_BY_KEY.get(Section);
  if (Group && Group.Fixed) return true;
  const Source = (Settings && typeof Settings === 'object' ? Settings : {}) as Record<
    string,
    unknown
  >;
  const Stored = Source[GroupFieldKey(Section)];
  if (Stored === undefined || Stored === null || Stored === '') return true;
  if (typeof Stored === 'boolean') return Stored;
  const Text = String(Stored).trim().toLowerCase();
  return !(Text === 'false' || Text === '0' || Text === 'no');
}

// ---- Display mode ---------------------------------------------------------

/**
 * What the terminal is set up to show.
 *
 * THIS IS DECLARED BY THE OPERATOR, NOT READ FROM THE DEVICE, and it has to be:
 * FreeKiosk's API cannot report it. `GET /api/mode` answers 405 "requires POST",
 * and switching a device from WebView to External App changes nothing whatever
 * in /api/status — verified against a live device by diffing the whole payload
 * across a mode switch, where only uptime and the memory counters moved. No
 * endpoint reports the foreground package either.
 *
 * It exists for one reason: to stop ShowTrak presenting the WebView readings as
 * live on a terminal that is not running the WebView. FreeKiosk retains
 * `webview.currentUrl` from the last page it loaded, so a kiosk locked to an app
 * reports a URL indefinitely — a reading that looks current, is not, and cannot
 * be told apart from a real one by looking at it.
 */
export type FreeKioskDisplayMode = 'webview' | 'external_app' | 'media_player';

export const FREEKIOSK_DISPLAY_MODES: readonly {
  Value: FreeKioskDisplayMode;
  Label: string;
}[] = Object.freeze([
  { Value: 'webview', Label: 'WebView (a URL)' },
  { Value: 'external_app', Label: 'External app' },
  { Value: 'media_player', Label: 'Media player' },
] as const);

/**
 * Pseudo-section for the declaration that describes the device rather than
 * checking it.
 *
 * Deliberately NOT one of FREEKIOSK_SECTIONS. The editor buckets fields by
 * section and then walks the real section list, so this bucket falls out of that
 * loop and is drawn on its own, above the alarms. It states what the terminal
 * displays — not a check, and filing it under a heading that reads "turn on any
 * value to alert when it goes wrong" would misdescribe it.
 */
export const SETUP_SECTION_KEY = 'Setup';

/** Short name for a mode, for error messages and headings. */
export function DisplayModeLabel(Mode: FreeKioskDisplayMode): string {
  if (Mode === 'external_app') return 'External app';
  if (Mode === 'media_player') return 'Media player';
  return 'WebView';
}

/** Settings key holding the declared mode. Id-safe, like every other key here. */
export const DISPLAY_MODE_FIELD_KEY = 'DisplayMode';

/**
 * Assumed when nothing is stored.
 *
 * WebView is what every terminal configured before this field existed was
 * implicitly treated as, so defaulting to it leaves those terminals showing
 * exactly what they showed yesterday. It is also FreeKiosk's own default.
 */
export const DEFAULT_DISPLAY_MODE: FreeKioskDisplayMode = 'webview';

export function GetDisplayMode(Settings: unknown): FreeKioskDisplayMode {
  const Source = (Settings && typeof Settings === 'object' ? Settings : {}) as Record<
    string,
    unknown
  >;
  const Stored = String(Source[DISPLAY_MODE_FIELD_KEY] ?? '').trim();
  return FREEKIOSK_DISPLAY_MODES.some((Mode) => Mode.Value === Stored)
    ? (Stored as FreeKioskDisplayMode)
    : DEFAULT_DISPLAY_MODE;
}

/** Does this reading mean anything in the mode the terminal is declared to be in? */
export function IsMetricInDisplayMode(Settings: unknown, Metric: FreeKioskMetric): boolean {
  if (!Metric.RequiresMode || !Metric.RequiresMode.length) return true;
  return Metric.RequiresMode.includes(GetDisplayMode(Settings));
}

/**
 * The one predicate for "is ShowTrak watching this metric at all".
 *
 * Both gates in one place, because they have to agree everywhere: the alarm
 * engine, the history store and the view modal each ask this question and a
 * metric that is judged but not shown — or shown but not judged — is a bug in
 * whichever of them disagreed.
 */
export function IsMetricActive(Settings: unknown, Metric: FreeKioskMetric): boolean {
  return IsMetricGroupEnabled(Settings, Metric.Section) && IsMetricInDisplayMode(Settings, Metric);
}

/** Whether the metric's group is switched on and its mode applies. */
export function IsMetricMonitored(Settings: unknown, MetricKey: string): boolean {
  const Metric = FREEKIOSK_METRICS_BY_KEY.get(MetricKey);
  if (!Metric) return false;
  return IsMetricActive(Settings, Metric);
}

/**
 * The comparison an alarm arms.
 *
 * An operator always states the ALARM condition, never the healthy one: `below
 * 20` fires under 20, and `is No` fires when the reading is No. Every registry
 * default is therefore written as the state worth waking someone for. Getting
 * this backwards for equality while leaving it forwards for thresholds is the
 * obvious trap, so the editor labels the picker "Alert when".
 *
 * BOOLEANS ARE THE EXCEPTION, and deliberately so. A two-state metric needs no
 * operator, so no picker is drawn — which leaves the value input as the only
 * thing on screen and nothing to tell the reader that it means "alarm when".
 * Every boolean therefore arms `isNot`, whose value input genuinely IS the
 * expected state: "Screen On — expected Yes" alarms when the screen goes off.
 * That is the only reading of a lone Yes/No box anyone arrives at, and it is
 * now the one the engine performs.
 */
export type FreeKioskOperator =
  | 'below'
  | 'above'
  | 'outside'
  | 'inside'
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'changes'
  | 'decreases';

// Operators that judge this poll against the previous one and therefore take no
// threshold value. The alarm schema hides the value inputs for these.
export const EDGE_OPERATORS: readonly FreeKioskOperator[] = Object.freeze([
  'changes',
  'decreases',
] as const);

// Operators that need a second bound.
export const RANGE_OPERATORS: readonly FreeKioskOperator[] = Object.freeze([
  'outside',
  'inside',
] as const);

export const OPERATOR_LABELS: Readonly<Record<FreeKioskOperator, string>> = Object.freeze({
  below: 'Below',
  above: 'Above',
  outside: 'Outside range',
  inside: 'Inside range',
  is: 'Is',
  isNot: 'Is not',
  contains: 'Contains',
  notContains: 'Does not contain',
  changes: 'Changes',
  decreases: 'Goes backwards',
});

export interface FreeKioskMetric {
  /** Id-safe key. Underscores only — see the header note. */
  Key: string;
  Label: string;
  /** Path into the /api/status `data` object. Empty for derived metrics. */
  Path: readonly string[];
  Type: FreeKioskMetricType;
  Section: FreeKioskMetricSection;
  Chart: FreeKioskChartKind;
  Unit?: string;
  /** Rounding for display and for history dedupe. Defaults to 0. */
  Decimals?: number;
  /** Fixed chart scale and input clamp, where the value has a known domain. */
  Min?: number;
  Max?: number;
  /** Domain for enum metrics. */
  Options?: readonly string[];
  /** Empty means the metric is shown but cannot be alarmed on. */
  Operators: readonly FreeKioskOperator[];
  DefaultOperator?: FreeKioskOperator;
  DefaultValue?: number | boolean | string;
  DefaultValue2?: number;
  /** Armed out of the box. Only content_displaying uses this. */
  DefaultOn?: boolean;
  /** Sentinel the device sends to mean "no reading"; mapped to null. */
  Unavailable?: number;
  Format?: FreeKioskMetricFormat;
  /** Collapses into the editor's Advanced section. */
  Advanced?: boolean;
  /** Computed rather than read from Path. */
  Derived?: boolean;
  /**
   * Display modes this reading means anything in. Absent means all of them.
   *
   * The WebView readings are the case this exists for: FreeKiosk keeps
   * `webview.currentUrl` at whatever was last loaded and never clears it, so on
   * a terminal locked to an external app it reports a page nobody is looking at.
   * See FreeKioskDisplayMode.
   */
  RequiresMode?: readonly FreeKioskDisplayMode[];
  Note?: string;
}

// ---- The registry ---------------------------------------------------------

const NUMERIC_OPS: readonly FreeKioskOperator[] = ['below', 'above', 'outside', 'inside'];

export const FREEKIOSK_METRICS: readonly FreeKioskMetric[] = Object.freeze([
  // ---- Content ------------------------------------------------------------
  {
    Key: 'content_displaying',
    Label: 'Displaying Content',
    Path: [],
    Derived: true,
    Type: 'boolean',
    Section: 'Content',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
    DefaultOn: true,
    Note: 'True when the screen is on and the screensaver is not covering it. Armed by default so a terminal that stops showing anything is reported even though its API is still answering.',
  },
  {
    Key: 'webview_currentUrl',
    Label: 'Current URL',
    Path: ['webview', 'currentUrl'],
    Type: 'string',
    Section: 'Content',
    Chart: 'blocks',
    Format: 'url',
    RequiresMode: ['webview'],
    Operators: ['is', 'isNot', 'contains', 'notContains', 'changes'],
    DefaultOperator: 'contains',
    Note: 'Use "Contains" to pin a host or path without having to match query strings exactly. FreeKiosk keeps the last page it loaded here forever, so this is only shown while the terminal is set to WebView mode.',
  },
  {
    Key: 'webview_loading',
    Label: 'Page Loading',
    Path: ['webview', 'loading'],
    Type: 'boolean',
    Section: 'Content',
    Chart: 'blocks',
    Advanced: true,
    RequiresMode: ['webview'],
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: false,
  },
  {
    Key: 'webview_canGoBack',
    Label: 'Can Go Back',
    Path: ['webview', 'canGoBack'],
    Type: 'boolean',
    Section: 'Content',
    Chart: 'blocks',
    Advanced: true,
    RequiresMode: ['webview'],
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: false,
  },

  // ---- Screen -------------------------------------------------------------
  {
    Key: 'screen_on',
    Label: 'Screen On',
    Path: ['screen', 'on'],
    Type: 'boolean',
    Section: 'Screen',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
    Note: 'The physical panel state. Stays true while the screensaver overlay is up — use Displaying Content to catch that too.',
  },
  {
    Key: 'screen_screensaverActive',
    Label: 'Screensaver Active',
    Path: ['screen', 'screensaverActive'],
    Type: 'boolean',
    Section: 'Screen',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: false,
  },
  {
    Key: 'screen_brightness',
    Label: 'Brightness',
    Path: ['screen', 'brightness'],
    Type: 'number',
    Section: 'Screen',
    Chart: 'line',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: NUMERIC_OPS,
    DefaultOperator: 'below',
    DefaultValue: 10,
  },
  {
    Key: 'autoBrightness_enabled',
    Label: 'Auto Brightness',
    Path: ['autoBrightness', 'enabled'],
    Type: 'boolean',
    Section: 'Screen',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
  },
  {
    Key: 'autoBrightness_currentLightLevel',
    Label: 'Auto Brightness Light Level',
    Path: ['autoBrightness', 'currentLightLevel'],
    Type: 'number',
    Section: 'Screen',
    Chart: 'none',
    Unit: 'lux',
    Decimals: 1,
    Advanced: true,
    Operators: ['below', 'above'],
    DefaultOperator: 'below',
  },
  {
    Key: 'autoBrightness_min',
    Label: 'Auto Brightness Minimum',
    Path: ['autoBrightness', 'min'],
    Type: 'number',
    Section: 'Screen',
    Chart: 'none',
    Unit: '%',
    Min: 0,
    Max: 100,
    Advanced: true,
    Operators: ['is'],
    DefaultOperator: 'is',
  },
  {
    Key: 'autoBrightness_max',
    Label: 'Auto Brightness Maximum',
    Path: ['autoBrightness', 'max'],
    Type: 'number',
    Section: 'Screen',
    Chart: 'none',
    Unit: '%',
    Min: 0,
    Max: 100,
    Advanced: true,
    Operators: ['is'],
    DefaultOperator: 'is',
  },

  // ---- Battery ------------------------------------------------------------
  {
    Key: 'battery_level',
    Label: 'Battery Level',
    Path: ['battery', 'level'],
    Type: 'number',
    Section: 'Battery',
    Chart: 'line',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: NUMERIC_OPS,
    DefaultOperator: 'below',
    DefaultValue: 20,
  },
  {
    Key: 'battery_charging',
    Label: 'Charging',
    Path: ['battery', 'charging'],
    Type: 'boolean',
    Section: 'Battery',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
    Note: 'A permanently-installed terminal should normally always be charging.',
  },
  {
    Key: 'battery_plugged',
    Label: 'Power Source',
    Path: ['battery', 'plugged'],
    Type: 'enum',
    Section: 'Battery',
    Chart: 'blocks',
    Options: ['usb', 'ac', 'wireless', 'none'],
    Operators: ['is', 'isNot', 'changes'],
    DefaultOperator: 'is',
    DefaultValue: 'none',
  },
  {
    Key: 'battery_temperature',
    Label: 'Battery Temperature',
    Path: ['battery', 'temperature'],
    Type: 'number',
    Section: 'Battery',
    Chart: 'line',
    Unit: '°C',
    Decimals: 1,
    Operators: ['above', 'below', 'outside'],
    DefaultOperator: 'above',
    DefaultValue: 45,
  },
  {
    Key: 'battery_voltage',
    Label: 'Battery Voltage',
    Path: ['battery', 'voltage'],
    Type: 'number',
    Section: 'Battery',
    Chart: 'line',
    Unit: 'V',
    Decimals: 2,
    Advanced: true,
    Operators: ['below', 'above', 'outside'],
    DefaultOperator: 'below',
  },
  {
    Key: 'battery_health',
    Label: 'Battery Health',
    Path: ['battery', 'health'],
    Type: 'enum',
    Section: 'Battery',
    Chart: 'blocks',
    Options: ['good', 'overheat', 'dead', 'over_voltage', 'failure', 'cold', 'unknown'],
    Operators: ['is', 'isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: 'good',
  },
  {
    Key: 'battery_technology',
    Label: 'Battery Technology',
    Path: ['battery', 'technology'],
    Type: 'string',
    Section: 'Battery',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },

  // ---- Network ------------------------------------------------------------
  {
    Key: 'wifi_connected',
    Label: 'Wi-Fi Connected',
    Path: ['wifi', 'connected'],
    Type: 'boolean',
    Section: 'Network',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
  },
  {
    Key: 'wifi_ssid',
    Label: 'SSID',
    Path: ['wifi', 'ssid'],
    Type: 'string',
    Section: 'Network',
    Chart: 'blocks',
    Operators: ['is', 'isNot', 'changes'],
    DefaultOperator: 'is',
    Note: 'The device reports placeholder text such as "WiFi (no permission)" when it cannot read the real SSID.',
  },
  {
    Key: 'wifi_signalStrength',
    Label: 'Wi-Fi Signal (RSSI)',
    Path: ['wifi', 'signalStrength'],
    Type: 'number',
    Section: 'Network',
    Chart: 'line',
    Unit: 'dBm',
    Min: -100,
    Max: -30,
    Format: 'dbm',
    Operators: ['below', 'above'],
    DefaultOperator: 'below',
    DefaultValue: -75,
    Note: 'Closer to zero is stronger. -75 dBm is a reasonable floor for reliable use.',
  },
  {
    Key: 'wifi_signalLevel',
    Label: 'Wi-Fi Signal',
    Path: ['wifi', 'signalLevel'],
    Type: 'number',
    Section: 'Network',
    Chart: 'line',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: ['below', 'above'],
    DefaultOperator: 'below',
    DefaultValue: 30,
  },
  {
    Key: 'wifi_linkSpeed',
    Label: 'Link Speed',
    Path: ['wifi', 'linkSpeed'],
    Type: 'number',
    Section: 'Network',
    Chart: 'line',
    Unit: 'Mbps',
    Advanced: true,
    Operators: ['below'],
    DefaultOperator: 'below',
  },
  {
    Key: 'wifi_channel',
    Label: 'Wi-Fi Channel',
    // Derived from wifi.frequency. The device reports megahertz; nobody plans a
    // venue in megahertz, and "is it still on 36?" is the question actually
    // being asked when a tablet starts misbehaving.
    Path: ['wifi', 'frequency'],
    Derived: true,
    Type: 'number',
    Section: 'Network',
    Chart: 'line',
    Advanced: true,
    Operators: ['isNot', 'changes'],
    DefaultOperator: 'changes',
    Note: 'Worked out from the frequency the device reports. "Changes" catches an access point moving the terminal to another channel or band, which is usually what is behind a Wi-Fi problem that fixes itself.',
  },
  {
    Key: 'wifi_frequency',
    Label: 'Wi-Fi Frequency',
    Path: ['wifi', 'frequency'],
    Type: 'number',
    Section: 'Network',
    // The raw reading, shown beside the channel it produces. Deliberately no
    // chart and no alarm: it is the same signal as wifi_channel at a different
    // scale, so a second series would draw the same line twice and a second
    // alarm would be a rival way to say what "Channel changed" already says.
    Chart: 'none',
    Unit: 'MHz',
    Advanced: true,
    Operators: [],
  },
  {
    Key: 'wifi_ipAddress',
    Label: 'Wi-Fi IP Address',
    Path: ['wifi', 'ipAddress'],
    Type: 'string',
    Section: 'Network',
    Chart: 'none',
    Operators: ['is', 'changes'],
    DefaultOperator: 'changes',
  },

  // ---- Device -------------------------------------------------------------
  {
    Key: 'device_kioskMode',
    Label: 'Kiosk Mode',
    Path: ['device', 'kioskMode'],
    Type: 'boolean',
    Section: 'Device',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
  },
  {
    Key: 'device_isDeviceOwner',
    Label: 'Device Owner',
    Path: ['device', 'isDeviceOwner'],
    Type: 'boolean',
    Section: 'Device',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
    Note: 'Reboot and true screen-off need Device Owner. Without it those commands are refused by the device.',
  },
  {
    Key: 'device_uptime',
    Label: 'Uptime',
    Path: ['device', 'uptime'],
    Type: 'number',
    Section: 'Device',
    Chart: 'none',
    Unit: 's',
    Format: 'duration',
    Operators: ['below', 'above', 'decreases'],
    DefaultOperator: 'decreases',
    Note: 'Uptime going backwards means the device restarted. That is the only reliable reboot signal the API offers.',
  },
  {
    Key: 'device_version',
    Label: 'FreeKiosk Version',
    Path: ['device', 'version'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Operators: ['is', 'isNot', 'changes'],
    DefaultOperator: 'is',
  },
  {
    Key: 'device_ip',
    Label: 'Device IP',
    Path: ['device', 'ip'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Operators: ['is', 'changes'],
    DefaultOperator: 'changes',
  },
  {
    Key: 'device_model',
    Label: 'Model',
    Path: ['device', 'model'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Operators: [],
  },
  {
    Key: 'device_manufacturer',
    Label: 'Manufacturer',
    Path: ['device', 'manufacturer'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Operators: [],
  },
  {
    Key: 'device_androidVersion',
    Label: 'Android Version',
    Path: ['device', 'androidVersion'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Operators: [],
  },
  {
    Key: 'device_apiLevel',
    Label: 'Android API Level',
    Path: ['device', 'apiLevel'],
    Type: 'number',
    Section: 'Device',
    Chart: 'none',
    Advanced: true,
    Operators: ['below', 'is'],
    DefaultOperator: 'below',
  },
  {
    Key: 'device_hostname',
    Label: 'Hostname',
    Path: ['device', 'hostname'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },
  {
    Key: 'device_deviceName',
    Label: 'Device Name',
    Path: ['device', 'deviceName'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },
  {
    Key: 'device_product',
    Label: 'Product',
    Path: ['device', 'product'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },
  {
    Key: 'device_processor',
    Label: 'Processor',
    Path: ['device', 'processor'],
    Type: 'string',
    Section: 'Device',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },

  // ---- Audio --------------------------------------------------------------
  {
    Key: 'audio_volume',
    Label: 'Volume',
    Path: ['audio', 'volume'],
    Type: 'number',
    Section: 'Audio',
    Chart: 'line',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: NUMERIC_OPS,
    DefaultOperator: 'below',
    DefaultValue: 1,
    Note: 'Alarm below 1% to catch a terminal that has been muted.',
  },

  // ---- Rotation -----------------------------------------------------------
  {
    Key: 'rotation_enabled',
    Label: 'URL Rotation',
    Path: ['rotation', 'enabled'],
    Type: 'boolean',
    Section: 'Rotation',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: true,
  },
  {
    Key: 'rotation_urlCount',
    Label: 'Rotation URL Count',
    Path: ['rotation', 'urls'],
    Derived: true,
    Type: 'number',
    Section: 'Rotation',
    Chart: 'none',
    Operators: ['is', 'below'],
    DefaultOperator: 'below',
  },
  {
    Key: 'rotation_currentIndex',
    Label: 'Rotation Index',
    Path: ['rotation', 'currentIndex'],
    Type: 'number',
    Section: 'Rotation',
    Chart: 'none',
    Advanced: true,
    Operators: ['is'],
    DefaultOperator: 'is',
  },
  {
    Key: 'rotation_interval',
    Label: 'Rotation Interval',
    Path: ['rotation', 'interval'],
    Type: 'number',
    Section: 'Rotation',
    Chart: 'none',
    Unit: 's',
    Advanced: true,
    Operators: ['is', 'below', 'above'],
    DefaultOperator: 'is',
  },
  {
    Key: 'rotation_urls',
    Label: 'Rotation URLs',
    Path: ['rotation', 'urls'],
    Derived: true,
    Type: 'string',
    Section: 'Rotation',
    Chart: 'none',
    Advanced: true,
    Operators: [],
  },

  // ---- Sensors ------------------------------------------------------------
  {
    Key: 'sensors_light',
    Label: 'Ambient Light',
    Path: ['sensors', 'light'],
    Type: 'number',
    Section: 'Sensors',
    Chart: 'none',
    Unit: 'lux',
    Decimals: 1,
    Unavailable: -1,
    Operators: NUMERIC_OPS,
    DefaultOperator: 'below',
    Note: 'The device reports -1 when it has no light sensor; that is recorded as no reading rather than as zero.',
  },
  {
    Key: 'sensors_proximity',
    Label: 'Proximity',
    Path: ['sensors', 'proximity'],
    Type: 'number',
    Section: 'Sensors',
    Chart: 'none',
    Unit: 'cm',
    Decimals: 1,
    Unavailable: -1,
    Advanced: true,
    Operators: ['below', 'above'],
    DefaultOperator: 'below',
  },

  // ---- Storage ------------------------------------------------------------
  {
    Key: 'storage_usedPercent',
    Label: 'Storage Used',
    Path: ['storage', 'usedPercent'],
    Type: 'number',
    Section: 'Storage',
    Chart: 'none',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: ['above', 'below'],
    DefaultOperator: 'above',
    DefaultValue: 90,
  },
  {
    Key: 'storage_availableMB',
    Label: 'Storage Available',
    Path: ['storage', 'availableMB'],
    Type: 'number',
    Section: 'Storage',
    Chart: 'none',
    Unit: 'MB',
    Format: 'megabytes',
    Operators: ['below'],
    DefaultOperator: 'below',
  },
  {
    Key: 'storage_usedMB',
    Label: 'Storage Used',
    Path: ['storage', 'usedMB'],
    Type: 'number',
    Section: 'Storage',
    Chart: 'none',
    Unit: 'MB',
    Format: 'megabytes',
    Advanced: true,
    Operators: ['above'],
    DefaultOperator: 'above',
  },
  {
    Key: 'storage_totalMB',
    Label: 'Storage Total',
    Path: ['storage', 'totalMB'],
    Type: 'number',
    Section: 'Storage',
    Chart: 'none',
    Unit: 'MB',
    Format: 'megabytes',
    Operators: [],
  },

  // ---- Memory -------------------------------------------------------------
  {
    Key: 'memory_usedPercent',
    Label: 'Memory Used',
    Path: ['memory', 'usedPercent'],
    Type: 'number',
    Section: 'Memory',
    Chart: 'line',
    Unit: '%',
    Min: 0,
    Max: 100,
    Operators: ['above', 'below'],
    DefaultOperator: 'above',
    DefaultValue: 90,
  },
  {
    Key: 'memory_lowMemory',
    Label: 'Low Memory',
    Path: ['memory', 'lowMemory'],
    Type: 'boolean',
    Section: 'Memory',
    Chart: 'blocks',
    Operators: ['isNot'],
    DefaultOperator: 'isNot',
    DefaultValue: false,
  },
  {
    Key: 'memory_availableMB',
    Label: 'Memory Available',
    Path: ['memory', 'availableMB'],
    Type: 'number',
    Section: 'Memory',
    Chart: 'line',
    Unit: 'MB',
    Format: 'megabytes',
    Operators: ['below'],
    DefaultOperator: 'below',
  },
  {
    Key: 'memory_usedMB',
    Label: 'Memory Used',
    Path: ['memory', 'usedMB'],
    Type: 'number',
    Section: 'Memory',
    Chart: 'line',
    Unit: 'MB',
    Format: 'megabytes',
    Advanced: true,
    Operators: ['above'],
    DefaultOperator: 'above',
  },
  {
    Key: 'memory_totalMB',
    Label: 'Memory Total',
    Path: ['memory', 'totalMB'],
    Type: 'number',
    Section: 'Memory',
    Chart: 'none',
    Unit: 'MB',
    Format: 'megabytes',
    Operators: [],
  },

  // ---- Poll ---------------------------------------------------------------
  // Not part of /api/status: ShowTrak supplies these from the poll itself, so
  // they are passed to ExtractMetricValues as overrides.
  {
    Key: 'poll_latencyMs',
    Label: 'Poll Latency',
    Path: [],
    Derived: true,
    Type: 'number',
    Section: 'Poll',
    Chart: 'line',
    Unit: 'ms',
    Operators: ['above'],
    DefaultOperator: 'above',
    DefaultValue: 2000,
  },
  {
    Key: 'control_enabled',
    Label: 'Remote Control Enabled',
    Path: [],
    Derived: true,
    Type: 'boolean',
    Section: 'Poll',
    // Shown, but not alarmable and not charted. It is not read from the device:
    // it only records how the LAST control command went, so it stays unknown
    // until something is sent and cannot change while a terminal is merely being
    // watched. An alarm on it would fire long after the operator had already
    // been told — a refused command reports inline, in the moment, with the
    // device's own wording.
    Chart: 'none',
    Operators: [],
    Note: 'How the last control command went, not a reading from the device — FreeKiosk only reveals its remote-control setting by refusing one. Unknown until something is sent.',
  },
] as const satisfies readonly FreeKioskMetric[]);

export const FREEKIOSK_METRICS_BY_KEY: ReadonlyMap<string, FreeKioskMetric> = new Map(
  FREEKIOSK_METRICS.map((Metric) => [Metric.Key, Metric])
);

// ---- Alarm setting keys ---------------------------------------------------

/** The four settings keys that make up one metric's alarm configuration. */
export function AlarmFieldKeys(MetricKey: string): {
  On: string;
  Op: string;
  V: string;
  V2: string;
} {
  return {
    On: `A_${MetricKey}_On`,
    Op: `A_${MetricKey}_Op`,
    V: `A_${MetricKey}_V`,
    V2: `A_${MetricKey}_V2`,
  };
}

function ValueOperators(Metric: FreeKioskMetric): FreeKioskOperator[] {
  return Metric.Operators.filter((Op) => !EDGE_OPERATORS.includes(Op));
}

function RangeOperators(Metric: FreeKioskMetric): FreeKioskOperator[] {
  return Metric.Operators.filter((Op) => RANGE_OPERATORS.includes(Op));
}

function ValueFieldType(Metric: FreeKioskMetric): string {
  if (Metric.Type === 'number') return 'number';
  if (Metric.Type === 'boolean' || Metric.Type === 'enum') return 'select';
  return 'string';
}

function ValueFieldOptions(
  Metric: FreeKioskMetric
): Array<string | { value: string; label?: string }> | undefined {
  if (Metric.Type === 'boolean') {
    return [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ];
  }
  if (Metric.Type === 'enum' && Metric.Options) return Metric.Options.slice();
  return undefined;
}

function ValueFieldLabel(Metric: FreeKioskMetric): string {
  // A metric whose only value-taking comparison is "is not" is asking for the
  // state it SHOULD be in, whatever its type — every boolean, and the Wi-Fi
  // channel. Keyed on the operators rather than the type so the label can never
  // contradict the comparison the engine will actually make.
  const ValueOps = ValueOperators(Metric);
  if (ValueOps.length && ValueOps.every((Op) => Op === 'isNot')) return 'Expected value';
  if (Metric.Type === 'number') {
    return Metric.Unit ? `Threshold (${Metric.Unit})` : 'Threshold';
  }
  // Everything else has an "Alert when" picker directly above it, which supplies
  // the verb. Calling this one "Expected value" would contradict it whenever the
  // chosen operator is Is, Contains or Does not contain.
  return 'Value';
}

/**
 * Turn the registry into the settings schema the editor renders.
 *
 * Per alarmable metric this emits an enable toggle, an operator picker gated on
 * that toggle, and one or two value inputs gated on both the toggle and the
 * chosen operator — which is the progressive disclosure the feature asks for,
 * expressed entirely as data so the existing field renderer draws it unchanged.
 */
export function BuildFreeKioskAlarmFields(
  Metrics: readonly FreeKioskMetric[] = FREEKIOSK_METRICS
): MonitoringSettingField[] {
  const Fields: MonitoringSettingField[] = [];

  // The group switches come first, so each lands at the head of its own section
  // once the editor buckets the list by MetricSection. Never Advanced: a switch
  // hidden inside a collapsed panel would leave its whole section unexplained.
  const Sections = new Set(Metrics.map((Metric) => Metric.Section));
  for (const Group of FREEKIOSK_METRIC_GROUPS) {
    if (Group.Fixed || !Sections.has(Group.Key)) continue;
    Fields.push({
      Key: GroupFieldKey(Group.Key),
      Label: `Monitor ${Group.Label}`,
      Type: 'boolean',
      Default: Group.DefaultOn,
      Note: Group.Note,
      MetricSection: Group.Key,
      MetricGroup: Group.Key,
    });
  }

  // A declaration, not a control. ShowTrak cannot read the mode from the device
  // and no longer tries to set it, so this exists purely to tell ShowTrak which
  // readings are meaningful and which controls are worth offering.
  if (Metrics.some((Metric) => Metric.RequiresMode?.length)) {
    Fields.push({
      Key: DISPLAY_MODE_FIELD_KEY,
      Label: 'Display mode',
      Type: 'select',
      Default: DEFAULT_DISPLAY_MODE,
      Options: FREEKIOSK_DISPLAY_MODES.map((Mode) => ({ value: Mode.Value, label: Mode.Label })),
      Note: "What this terminal is set up to show. FreeKiosk cannot report this over its API, so ShowTrak has to be told. Setting it here changes nothing on the device — it decides which readings ShowTrak treats as meaningful and which controls it offers. The mode itself is set on the tablet, in FreeKiosk's own settings.",
      MetricSection: SETUP_SECTION_KEY,
    });
  }

  for (const Metric of Metrics) {
    if (!Metric.Operators.length) continue;
    const Keys = AlarmFieldKeys(Metric.Key);
    const ValueOps = ValueOperators(Metric);
    const RangeOps = RangeOperators(Metric);
    // Every field in a section hides with that section's switch. Fixed groups
    // emit no switch, so gating on one would hide them permanently.
    const GroupGate = FREEKIOSK_METRIC_GROUPS_BY_KEY.get(Metric.Section)?.Fixed
      ? null
      : { Key: GroupFieldKey(Metric.Section), Equals: true };
    // A mode-specific metric hides outright in the wrong mode, rather than
    // offering a check whose reading is a leftover. Sits alongside the group
    // gate and is repeated on every field of the metric for the same reason.
    const ModeGate = Metric.RequiresMode?.length
      ? { Key: DISPLAY_MODE_FIELD_KEY, In: Metric.RequiresMode.slice() }
      : null;
    const Gates = [...(GroupGate ? [GroupGate] : []), ...(ModeGate ? [ModeGate] : [])];
    // Collapses a lone condition back to the single-condition form, which the
    // field renderer emits as the original data-visible-when-key/-value pair.
    // Every field that existed before display modes therefore emits the same
    // bytes it did before.
    const Gate = (
      ...Extra: Array<{ Key: string; Equals?: unknown; In?: unknown[] }>
    ): MonitoringSettingField['VisibleWhen'] => {
      const All = [...Gates, ...Extra];
      if (!All.length) return undefined;
      return All.length === 1 ? All[0] : All;
    };

    Fields.push({
      Key: Keys.On,
      Label: Metric.Label,
      Type: 'boolean',
      Default: !!Metric.DefaultOn,
      Advanced: !!Metric.Advanced,
      Note: Metric.Note,
      VisibleWhen: Gate(),
      // Carried so the editor can group fields by section and the tests can
      // tie a field back to its metric without re-parsing the key.
      MetricKey: Metric.Key,
      MetricSection: Metric.Section,
    });

    // A single-operator metric has nothing to choose, so the picker is omitted
    // and the operator is implied by the registry default.
    if (Metric.Operators.length > 1) {
      Fields.push({
        Key: Keys.Op,
        Label: 'Alert when',
        Type: 'select',
        Default: Metric.DefaultOperator || Metric.Operators[0],
        Options: Metric.Operators.map((Op) => ({ value: Op, label: OPERATOR_LABELS[Op] })),
        Advanced: !!Metric.Advanced,
        // The group gate is repeated on every field rather than relied on
        // transitively. Conditions are evaluated against the DOM, and a hidden
        // enable toggle still reports itself as checked — so gating only the
        // toggle would leave its operator and threshold on screen underneath a
        // section that is switched off.
        VisibleWhen: Gate({ Key: Keys.On, Equals: true }),
        MetricKey: Metric.Key,
        MetricSection: Metric.Section,
      });
    }

    if (ValueOps.length) {
      const Visible: Array<{ Key: string; Equals?: unknown; In?: unknown[] }> = [
        { Key: Keys.On, Equals: true },
      ];
      // Only gate on the operator when there is a picker AND at least one
      // operator that would hide the input; otherwise the extra condition is
      // noise that could only ever be true.
      if (Metric.Operators.length > 1 && ValueOps.length !== Metric.Operators.length) {
        Visible.push({ Key: Keys.Op, In: ValueOps.slice() });
      }
      Fields.push({
        Key: Keys.V,
        Label: ValueFieldLabel(Metric),
        Type: ValueFieldType(Metric),
        Default: Metric.DefaultValue ?? (Metric.Type === 'number' ? 0 : ''),
        Min: Metric.Min,
        Max: Metric.Max,
        Options: ValueFieldOptions(Metric),
        Advanced: !!Metric.Advanced,
        VisibleWhen: Gate(...Visible),
        MetricKey: Metric.Key,
        MetricSection: Metric.Section,
      });
    }

    if (RangeOps.length) {
      Fields.push({
        Key: Keys.V2,
        Label: Metric.Unit ? `Upper bound (${Metric.Unit})` : 'Upper bound',
        Type: 'number',
        Default: Metric.DefaultValue2 ?? 0,
        Min: Metric.Min,
        Max: Metric.Max,
        Advanced: !!Metric.Advanced,
        VisibleWhen: Gate({ Key: Keys.On, Equals: true }, { Key: Keys.Op, In: RangeOps.slice() }),
        MetricKey: Metric.Key,
        MetricSection: Metric.Section,
      });
    }
  }

  return Fields;
}

/** The alarm configuration a brand new terminal starts with. */
export function BuildDefaultAlarmSettings(
  Metrics: readonly FreeKioskMetric[] = FREEKIOSK_METRICS
): Record<string, unknown> {
  const Settings: Record<string, unknown> = {};
  for (const Field of BuildFreeKioskAlarmFields(Metrics)) {
    Settings[Field.Key] = Field.Default;
  }
  return Settings;
}

// ---- Reading a status payload --------------------------------------------

function ReadPath(Source: unknown, Path: readonly string[]): unknown {
  let Cursor: unknown = Source;
  for (const Segment of Path) {
    if (Cursor == null || typeof Cursor !== 'object') return undefined;
    Cursor = (Cursor as Record<string, unknown>)[Segment];
  }
  return Cursor;
}

function CoerceNumber(Value: unknown, Metric: FreeKioskMetric): number | null {
  if (Value == null || Value === '') return null;
  const Parsed = Number(Value);
  if (!Number.isFinite(Parsed)) return null;
  // A sensor the device does not have reports its sentinel rather than dropping
  // the key. Recording that as a real reading would draw a -1 line on the chart
  // and could satisfy a "below" alarm on hardware that simply cannot answer.
  if (Metric.Unavailable != null && Parsed === Metric.Unavailable) return null;
  return Parsed;
}

function CoerceBoolean(Value: unknown): boolean | null {
  if (Value == null) return null;
  if (typeof Value === 'boolean') return Value;
  if (typeof Value === 'number') return Value !== 0;
  const Text = String(Value).trim().toLowerCase();
  if (Text === 'true' || Text === '1' || Text === 'yes') return true;
  if (Text === 'false' || Text === '0' || Text === 'no') return false;
  return null;
}

function CoerceString(Value: unknown): string | null {
  if (Value == null) return null;
  if (typeof Value === 'object') return null;
  const Text = String(Value).trim();
  return Text === '' ? null : Text;
}

/**
 * The 802.11 channel a centre frequency in MHz belongs to.
 *
 * Each band numbers its channels from its own base, so this is a set of ranges
 * rather than one formula — and the two exceptions are real: 2.4 GHz channel 14
 * sits 12 MHz above channel 13 instead of 5, and 6 GHz channel 2 sits below the
 * band's own base rather than above it.
 *
 * A frequency in no known band returns null rather than a plausible-looking
 * number: a made-up channel is worse than an em dash, because it would be acted
 * on. Some devices report 0 when disconnected, which lands here.
 */
export function WifiChannelForFrequency(Frequency: unknown): number | null {
  const MHz = Number(Frequency);
  if (!Number.isFinite(MHz) || MHz <= 0) return null;

  // 2.4 GHz
  if (MHz === 2484) return 14;
  if (MHz >= 2412 && MHz <= 2472) return (MHz - 2407) / 5;
  // 4.9 GHz public safety / Japan
  if (MHz >= 4910 && MHz <= 4980) return (MHz - 4000) / 5;
  // 5 GHz
  if (MHz >= 5150 && MHz <= 5895) return (MHz - 5000) / 5;
  // 6 GHz (Wi-Fi 6E)
  if (MHz === 5935) return 2;
  if (MHz >= 5955 && MHz <= 7115) return (MHz - 5950) / 5;
  return null;
}

function ReadDerived(Key: string, Status: FreeKioskStatus): string | number | boolean | null {
  if (Key === 'wifi_channel') {
    return WifiChannelForFrequency(ReadPath(Status, ['wifi', 'frequency']));
  }

  if (Key === 'content_displaying') {
    const On = CoerceBoolean(ReadPath(Status, ['screen', 'on']));
    const Saver = CoerceBoolean(ReadPath(Status, ['screen', 'screensaverActive']));
    // Unknowable rather than false when the device did not report the screen at
    // all — recording a false here would arm the default alarm on no evidence.
    if (On == null) return null;
    return On === true && Saver !== true;
  }

  if (Key === 'rotation_urlCount') {
    const Urls = ReadPath(Status, ['rotation', 'urls']);
    return Array.isArray(Urls) ? Urls.length : null;
  }

  if (Key === 'rotation_urls') {
    const Urls = ReadPath(Status, ['rotation', 'urls']);
    if (!Array.isArray(Urls) || !Urls.length) return null;
    return Urls.map((Entry) => String(Entry)).join(', ');
  }

  return null;
}

/**
 * Flatten a /api/status payload into one reading per registry metric.
 *
 * `Overrides` supplies the metrics ShowTrak measures itself rather than reading
 * from the device (poll latency, whether remote control turned out to be
 * enabled). Every value is a primitive or null — this record is broadcast and
 * serialised into alert history, so it must stay plain data.
 */
export function ExtractMetricValues(
  Status: unknown,
  Overrides: Record<string, string | number | boolean | null> = {}
): Record<string, string | number | boolean | null> {
  const Data = (Status && typeof Status === 'object' ? Status : {}) as FreeKioskStatus;
  const Values: Record<string, string | number | boolean | null> = {};

  for (const Metric of FREEKIOSK_METRICS) {
    if (Object.prototype.hasOwnProperty.call(Overrides, Metric.Key)) {
      Values[Metric.Key] = Overrides[Metric.Key] ?? null;
      continue;
    }

    if (Metric.Derived) {
      const Derived = ReadDerived(Metric.Key, Data);
      Values[Metric.Key] =
        Metric.Type === 'number' && typeof Derived === 'number'
          ? RoundTo(Derived, Metric.Decimals ?? 0)
          : Derived;
      continue;
    }

    const Raw = ReadPath(Data, Metric.Path);
    if (Metric.Type === 'number') {
      const Parsed = CoerceNumber(Raw, Metric);
      Values[Metric.Key] = Parsed == null ? null : RoundTo(Parsed, Metric.Decimals ?? 0);
    } else if (Metric.Type === 'boolean') {
      Values[Metric.Key] = CoerceBoolean(Raw);
    } else {
      Values[Metric.Key] = CoerceString(Raw);
    }
  }

  return Values;
}

export function RoundTo(Value: number, Decimals: number): number {
  if (!Number.isFinite(Value)) return Value;
  const Factor = Math.pow(10, Math.max(0, Decimals));
  return Math.round(Value * Factor) / Factor;
}

// ---- Display ---------------------------------------------------------------

export function FormatDuration(Seconds: number): string {
  const Total = Math.max(0, Math.floor(Seconds));
  const Days = Math.floor(Total / 86400);
  const Hours = Math.floor((Total % 86400) / 3600);
  const Minutes = Math.floor((Total % 3600) / 60);
  if (Days) return `${Days}d ${Hours}h`;
  if (Hours) return `${Hours}h ${Minutes}m`;
  if (Minutes) return `${Minutes}m ${Total % 60}s`;
  return `${Total}s`;
}

/**
 * Render a reading the way an operator reads it. Used to word alarm reasons;
 * the renderer has its own copy for tile and modal display, driven by the same
 * Unit/Decimals/Format hints delivered with the registry.
 */
export function FormatMetricValue(
  Metric: FreeKioskMetric,
  Value: string | number | boolean | null | undefined
): string {
  if (Value == null) return 'no reading';
  if (Metric.Type === 'boolean') return Value ? 'Yes' : 'No';
  if (Metric.Type === 'number') {
    const Numeric = Number(Value);
    if (!Number.isFinite(Numeric)) return 'no reading';
    if (Metric.Format === 'duration') return FormatDuration(Numeric);
    if (Metric.Format === 'megabytes') {
      return Numeric >= 1024 ? `${RoundTo(Numeric / 1024, 1)} GB` : `${RoundTo(Numeric, 0)} MB`;
    }
    const Text = RoundTo(Numeric, Metric.Decimals ?? 0).toString();
    return Metric.Unit ? `${Text}${Metric.Unit === '%' ? '' : ' '}${Metric.Unit}` : Text;
  }
  const Text = String(Value);
  if (Metric.Format === 'url' && Text.length > 60) return `${Text.slice(0, 57)}...`;
  return Text;
}
