// The Client Info modal's left-hand tabs: which exist, which a given client can
// show, and which one ends up active.
//
// Integrated (SDK) clients report none of the hardware/OS inventories, so they
// get only Status and Info. A tab that stops being available while selected
// falls back to the first tab rather than leaving an empty pane.
export type ClientInfoTabKey = 'status' | 'info' | 'usb' | 'video' | 'audio' | 'network' | 'apps';

export interface ClientInfoTab {
  Key: ClientInfoTabKey;
  Title: string;
  /** Shown for integrated (SDK) clients as well as ShowTrak Client installs. */
  Integrated: boolean;
}

export const CLIENT_INFO_TABS: readonly ClientInfoTab[] = [
  { Key: 'status', Title: 'Status', Integrated: true },
  { Key: 'info', Title: 'Info', Integrated: true },
  { Key: 'usb', Title: 'USB Devices', Integrated: false },
  { Key: 'video', Title: 'Video', Integrated: false },
  { Key: 'audio', Title: 'Audio', Integrated: false },
  { Key: 'network', Title: 'Network', Integrated: false },
  { Key: 'apps', Title: 'Applications', Integrated: false },
];

export const DEFAULT_CLIENT_INFO_TAB: ClientInfoTabKey = 'status';

export function AvailableClientInfoTabs(IsIntegrated: boolean): ClientInfoTabKey[] {
  return CLIENT_INFO_TABS.filter((Tab) => !IsIntegrated || Tab.Integrated).map((Tab) => Tab.Key);
}

export function ResolveClientInfoTab(
  Requested: string | null | undefined,
  IsIntegrated: boolean
): ClientInfoTabKey {
  const Available = AvailableClientInfoTabs(IsIntegrated);
  return (Available as string[]).includes(String(Requested))
    ? (Requested as ClientInfoTabKey)
    : DEFAULT_CLIENT_INFO_TAB;
}
