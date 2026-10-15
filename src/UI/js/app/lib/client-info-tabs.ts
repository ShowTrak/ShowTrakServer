// The view modal's left-hand tabs: which exist for each kind of entity, and
// which one ends up active.
//
// #SHOWTRAK_CLIENT_INFO is shared by every entity, and each kind gets the rail.
// Integrated (SDK) clients report none of the hardware/OS inventories, so they
// get only Status and Info. Monitoring targets get Status plus Actions (the
// controls their check types declare, sent to every check of that type on the
// target). Dummy clients have nothing but their status timeline, so they get
// Status alone. FreeKiosk terminals split their metric registry across Content,
// Screen, Battery, Network and Misc.
//
// A tab that stops being available while selected falls back to the first tab
// rather than leaving an empty pane.
export type ClientInfoTabKey =
  | 'status'
  | 'info'
  | 'usb'
  | 'video'
  | 'audio'
  | 'network'
  | 'apps'
  | 'power'
  | 'actions'
  | 'controls'
  | 'content'
  | 'screen'
  | 'battery'
  | 'misc';

export type ClientInfoKind = 'client' | 'integrated' | 'target' | 'dummy' | 'freekiosk';

export interface ClientInfoTab {
  Key: ClientInfoTabKey;
  Title: string;
}

const STATUS_TAB: ClientInfoTab = { Key: 'status', Title: 'Status' };
const INFO_TAB: ClientInfoTab = { Key: 'info', Title: 'Info' };

const CLIENT_INFO_TABS_BY_KIND: Readonly<Record<ClientInfoKind, readonly ClientInfoTab[]>> = {
  client: [
    STATUS_TAB,
    INFO_TAB,
    { Key: 'usb', Title: 'USB Devices' },
    { Key: 'video', Title: 'Video' },
    { Key: 'audio', Title: 'Audio' },
    { Key: 'network', Title: 'Network' },
    { Key: 'apps', Title: 'Applications' },
    { Key: 'power', Title: 'Power & Thermal' },
  ],
  integrated: [STATUS_TAB, INFO_TAB],
  target: [STATUS_TAB, { Key: 'actions', Title: 'Actions' }],
  dummy: [STATUS_TAB],
  freekiosk: [
    STATUS_TAB,
    { Key: 'controls', Title: 'Controls' },
    { Key: 'content', Title: 'Content' },
    { Key: 'screen', Title: 'Screen' },
    { Key: 'battery', Title: 'Battery' },
    { Key: 'network', Title: 'Network' },
    { Key: 'misc', Title: 'Misc' },
  ],
};

export const DEFAULT_CLIENT_INFO_TAB: ClientInfoTabKey = 'status';

export function ClientInfoTabsFor(Kind: ClientInfoKind): readonly ClientInfoTab[] {
  return CLIENT_INFO_TABS_BY_KIND[Kind] ?? CLIENT_INFO_TABS_BY_KIND.dummy;
}

export function AvailableClientInfoTabs(Kind: ClientInfoKind): ClientInfoTabKey[] {
  return ClientInfoTabsFor(Kind).map((Tab) => Tab.Key);
}

export function ResolveClientInfoTab(
  Requested: string | null | undefined,
  Kind: ClientInfoKind
): ClientInfoTabKey {
  const Available = AvailableClientInfoTabs(Kind);
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
