// The view modal's left-hand tabs: which exist for each kind of entity, and
// which one ends up active.
//
// #SHOWTRAK_CLIENT_INFO is shared by every entity, and each kind gets the rail.
// Integrated (SDK) clients report none of the hardware/OS inventories, so they
// get only Status, Info, Wake on LAN and Actions. Monitoring targets get Status,
// Actions (the controls their check types declare, sent to every check of that
// type on the target) and Settings (name, interval, tags and checks). Dummy
// clients get their status timeline and Settings (ID, title, group, interval
// and tags). FreeKiosk terminals split their metric registry across Content,
// Screen, Battery, Network and Misc, and add Settings.
//
// Every entity is edited from this modal too (in Edit mode). A client's Info,
// Variables, Wake on LAN and Actions tabs, and every other kind's Settings tab,
// switch between read-only and editable as the mode changes (client-info-edit,
// monitor-info-edit, dummy-info-edit and freekiosk-info-edit) — on the Web UI
// too, when its management permissions allow. A client's Actions is desktop
// only: its update and FOG actions are not exposed to the Web UI.
//
// Every kind ends with Logs: its slice of the audit log (status changes, edits
// and actions over the past 24 hours).
//
// A tab that stops being available while selected falls back to the first tab
// rather than leaving an empty pane.
export type ClientInfoTabKey =
  | 'status'
  | 'info'
  | 'variables'
  | 'wol'
  | 'usb'
  | 'storage'
  | 'video'
  | 'audio'
  | 'network'
  | 'apps'
  | 'usage'
  | 'power'
  | 'actions'
  | 'settings'
  | 'controls'
  | 'content'
  | 'screen'
  | 'battery'
  | 'misc'
  | 'logs';

export type ClientInfoKind = 'client' | 'integrated' | 'target' | 'dummy' | 'freekiosk';

export interface ClientInfoTab {
  Key: ClientInfoTabKey;
  Title: string;
  /** Left off the rail in the Web UI. */
  DesktopOnly?: boolean;
}

export type ClientInfoSurface = 'desktop' | 'web';

const STATUS_TAB: ClientInfoTab = { Key: 'status', Title: 'Status' };
const INFO_TAB: ClientInfoTab = { Key: 'info', Title: 'Info' };
const WOL_TAB: ClientInfoTab = { Key: 'wol', Title: 'Wake on LAN' };
const LOGS_TAB: ClientInfoTab = { Key: 'logs', Title: 'Logs' };
const SETTINGS_TAB: ClientInfoTab = { Key: 'settings', Title: 'Settings' };
// A client's Actions (updates, FOG, unadopt) are not exposed to the Web UI.
const CLIENT_ACTIONS_TAB: ClientInfoTab = { Key: 'actions', Title: 'Actions', DesktopOnly: true };

const CLIENT_INFO_TABS_BY_KIND: Readonly<Record<ClientInfoKind, readonly ClientInfoTab[]>> = {
  client: [
    STATUS_TAB,
    INFO_TAB,
    { Key: 'variables', Title: 'Variables' },
    WOL_TAB,
    { Key: 'usb', Title: 'USB Devices' },
    { Key: 'storage', Title: 'Storage Devices' },
    { Key: 'video', Title: 'Video' },
    { Key: 'audio', Title: 'Audio' },
    { Key: 'network', Title: 'Network' },
    { Key: 'apps', Title: 'Applications' },
    { Key: 'usage', Title: 'Usage' },
    { Key: 'power', Title: 'Power & Thermal' },
    CLIENT_ACTIONS_TAB,
    LOGS_TAB,
  ],
  integrated: [STATUS_TAB, INFO_TAB, WOL_TAB, CLIENT_ACTIONS_TAB, LOGS_TAB],
  // Settings is the monitor's editor as well as its view, like a client's Info.
  target: [STATUS_TAB, { Key: 'actions', Title: 'Actions' }, SETTINGS_TAB, LOGS_TAB],
  dummy: [STATUS_TAB, SETTINGS_TAB, LOGS_TAB],
  freekiosk: [
    STATUS_TAB,
    { Key: 'controls', Title: 'Controls' },
    { Key: 'content', Title: 'Content' },
    { Key: 'screen', Title: 'Screen' },
    { Key: 'battery', Title: 'Battery' },
    { Key: 'network', Title: 'Network' },
    { Key: 'misc', Title: 'Misc' },
    SETTINGS_TAB,
    LOGS_TAB,
  ],
};

export const DEFAULT_CLIENT_INFO_TAB: ClientInfoTabKey = 'status';

export function ClientInfoTabsFor(
  Kind: ClientInfoKind,
  Surface: ClientInfoSurface = 'desktop'
): readonly ClientInfoTab[] {
  const Tabs = CLIENT_INFO_TABS_BY_KIND[Kind] ?? CLIENT_INFO_TABS_BY_KIND.dummy;
  return Surface === 'web' ? Tabs.filter((Tab) => !Tab.DesktopOnly) : Tabs;
}

export function AvailableClientInfoTabs(
  Kind: ClientInfoKind,
  Surface: ClientInfoSurface = 'desktop'
): ClientInfoTabKey[] {
  return ClientInfoTabsFor(Kind, Surface).map((Tab) => Tab.Key);
}

export function ResolveClientInfoTab(
  Requested: string | null | undefined,
  Kind: ClientInfoKind,
  Surface: ClientInfoSurface = 'desktop'
): ClientInfoTabKey {
  const Available = AvailableClientInfoTabs(Kind, Surface);
  return (Available as string[]).includes(String(Requested))
    ? (Requested as ClientInfoTabKey)
    : DEFAULT_CLIENT_INFO_TAB;
}

export type FreeKioskMetricTabKey = 'content' | 'screen' | 'battery' | 'network' | 'misc';

/** The FreeKiosk metric tabs, in rail order. */
export const FREEKIOSK_METRIC_TABS: readonly FreeKioskMetricTabKey[] = [
  'content',
  'screen',
  'battery',
  'network',
  'misc',
];

/**
 * Which tab a FreeKiosk registry section is drawn on. The four with a tab of
 * their own map by name; everything else (Device, Audio, Rotation, Sensors,
 * Storage, Memory, Poll, and any section added later) lands on Misc, so a new
 * section is never left without somewhere to appear.
 */
export function FreeKioskSectionTab(Section: string): FreeKioskMetricTabKey {
  switch (Section) {
    case 'Content':
      return 'content';
    case 'Screen':
      return 'screen';
    case 'Battery':
      return 'battery';
    case 'Network':
      return 'network';
    default:
      return 'misc';
  }
}
