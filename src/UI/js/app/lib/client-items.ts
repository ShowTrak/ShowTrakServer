// The monitored items of a ShowTrak client or a FreeKiosk terminal, as rows of
// the list view, each with its live verdict and the key its history is filed
// under:
//
//   - a client: the system checks, applications, USB devices, displays, audio
//     endpoints, network interfaces and volumes an operator has marked Monitored;
//   - a terminal: every reading with a check armed, in a monitored section, that
//     means anything in the terminal's display mode.
//
// The same items, in the same order and with the same live states, as each one's
// view modal Status tab draws (BuildMonitoringHistoryParts in
// ../monitoring-history-modal, RenderFreeKioskModal in ../freekiosk-modal), so
// expanding a row in the list and opening it show the same thing. Pure: the
// markup lives in ../list-view.ts.
import type {
  ClientView,
  FreeKioskMetricCatalog,
  FreeKioskMetricSample,
  FreeKioskTerminalView,
  HistorySample,
  USBDeviceView,
} from '@showtrak/protocol';
import {
  DescribeExpected,
  FreeKioskMetricLiveState,
  IsGroupEnabled,
  MetricAppliesInMode,
  ReadArmedAlarm,
} from './freekiosk-monitoring';
import { FormatMetricValue } from './metric-format';
import { ApplicationIssues } from './applications';
import { AudioTimelineLiveState } from './audio-devices';
import { DisplayKey, DisplayTimelineLiveState } from './displays';
import { NetworkTimelineLiveState, PrimaryAddress, FormatAddress } from './network-interfaces';
import { StorageTimelineLiveState, StorageVolumeTitle } from './storage-volumes';
import { SYSTEM_CHECK_ORDER, SystemCheckCardFor, SystemCheckLiveState } from './system-health';
import { USBTimelineLiveState } from './usb-devices';
import {
  BuildStatusBlocksFromSamples,
  FreeKioskMetricStatusSamples,
  type StatusBlock,
} from './status-blocks';

export type ClientItemState = 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface ClientItem {
  /** `<kind>:<item key>`: the key its series has in the history overview's ClientItems. */
  Key: string;
  Name: string;
  /** What it is: the list's Type column. */
  Kind: string;
  /** Where it is (serial, address, mount point), or ''. */
  Address: string;
  State: ClientItemState;
  /** The live reading or the failing condition: the Details column. */
  Label: string;
}

/** The prefix of a client item row's data-uuid-like key: `item:<UUID>:<Key>`. */
export const CLIENT_ITEM_ROW_PREFIX = 'item:';

/** The history key of one item's row; unique across every client on the page. */
export function ClientItemRowKey(UUID: string, ItemKey: string): string {
  return `${CLIENT_ITEM_ROW_PREFIX}${UUID}:${ItemKey}`;
}

/** The State column's word, in the timeline legend's palette. */
export function ClientItemStateWord(State: ClientItemState): string {
  switch (State) {
    case 'ONLINE':
      return 'Healthy';
    case 'DEGRADED':
      return 'Degraded';
    case 'OFFLINE':
      return 'Failed';
    default:
      return 'Idle';
  }
}

/** The row's state class: the same classes, and so colours, as a tile. Offline is no class. */
export function ClientItemStateClass(State: ClientItemState): string {
  return State === 'OFFLINE' ? '' : State;
}

function USBName(Device: USBDeviceView): string {
  const Manufacturer = Device.ManufacturerName ? String(Device.ManufacturerName).trim() : '';
  const Product = Device.ProductName ? String(Device.ProductName).trim() : '';
  return [Manufacturer, Product].filter(Boolean).join(' ') || 'USB Device';
}

/**
 * Every monitored item of a client, in the Status tab's order: system checks,
 * applications, USB devices (by serial, then name-guarded groups), displays,
 * audio endpoints, network interfaces, volumes.
 */
export function ClientMonitoredItems(Client: ClientView | null | undefined): ClientItem[] {
  if (!Client) return [];
  const Online = !!Client.Online;
  const Items: ClientItem[] = [];

  for (const Key of SYSTEM_CHECK_ORDER) {
    const Card = SystemCheckCardFor(Client, Key);
    if (!Card.Monitored) continue;
    const Live = SystemCheckLiveState(Client, Card);
    Items.push({
      Key: `system:${Key}`,
      Name: Card.Title,
      Kind: 'System Check',
      Address: '',
      State: Live.State,
      Label: Live.Label,
    });
  }

  // Applications: judged only while the client's collector is reporting, as the
  // history recorder does; otherwise there is nothing to say either way.
  const Apps = Client.RunningApplications;
  const AppsReporting = Online && String(Apps?.Status?.State || '').toLowerCase() === 'ok';
  const SeenApps = new Set<string>();
  for (const App of Array.isArray(Apps?.Items) ? Apps.Items : []) {
    if (!App || !App.IsCritical) continue;
    const Name = typeof App.Name === 'string' ? App.Name.trim() : '';
    const Key = (typeof App.Key === 'string' && App.Key.trim()) || Name;
    if (!Key || SeenApps.has(Key)) continue;
    SeenApps.add(Key);
    let State: ClientItemState = 'IDLE';
    let Label = Online ? 'Not Reported' : 'Idle';
    if (AppsReporting) {
      const Issues = ApplicationIssues(App, Client);
      if (App.IsRunning === false) {
        State = 'OFFLINE';
        Label = 'Not Running';
      } else if (Issues.length) {
        State = 'DEGRADED';
        Label = Issues.join('; ');
      } else {
        State = 'ONLINE';
        Label = 'Running';
      }
    }
    Items.push({
      Key: `app:${Key}`,
      Name: Name || Key,
      Kind: 'Application',
      Address: '',
      State,
      Label,
    });
  }

  const USB = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
  const SeenSerials = new Set<string>();
  for (const Device of USB) {
    if (!Device || !Device.IsCritical) continue;
    const Serial = Device.SerialNumber ? String(Device.SerialNumber).trim() : '';
    if (!Serial || SeenSerials.has(Serial)) continue;
    SeenSerials.add(Serial);
    const Live = USBTimelineLiveState([Device], Online);
    Items.push({
      Key: `usb:${Serial}`,
      Name: USBName(Device),
      Kind: 'USB Device',
      Address: Serial,
      State: Live.State,
      Label: Live.Label,
    });
  }
  // Serial-less devices are guarded as a group by name and quantity.
  const SeenNames = new Set<string>();
  for (const Device of USB) {
    if (!Device || !Device.IsCriticalByName) continue;
    const NameKey = Device.NameKey != null ? String(Device.NameKey).trim().toLowerCase() : '';
    if (!NameKey || SeenNames.has(NameKey)) continue;
    SeenNames.add(NameKey);
    const Group = USB.filter(
      (Item) =>
        !!Item &&
        !!Item.IsCriticalByName &&
        String(Item.NameKey ?? '')
          .trim()
          .toLowerCase() === NameKey
    );
    const Live = USBTimelineLiveState(Group, Online);
    const Quantity = Number(Device.Quantity);
    Items.push({
      Key: `usb:usbname:${NameKey}`,
      Name: USBName(Device),
      Kind: 'USB Device',
      Address: Number.isFinite(Quantity) && Quantity > 1 ? `${Quantity} expected` : '',
      State: Live.State,
      Label: Live.Label,
    });
  }

  const SeenDisplays = new Set<string>();
  for (const Display of Array.isArray(Client.DisplayList) ? Client.DisplayList : []) {
    if (!Display || !Display.IsCritical) continue;
    const DisplayID = DisplayKey(Display);
    if (!DisplayID || SeenDisplays.has(DisplayID)) continue;
    SeenDisplays.add(DisplayID);
    const Live = DisplayTimelineLiveState(Display, Online);
    const Label = typeof Display.Label === 'string' ? Display.Label.trim() : '';
    Items.push({
      Key: `display:${DisplayID}`,
      Name: Label || 'Display',
      Kind: 'Display',
      Address: '',
      State: Live.State,
      Label: Live.Label,
    });
  }

  const Endpoints = Array.isArray(Client.AudioDevices?.Endpoints)
    ? Client.AudioDevices.Endpoints
    : [];
  for (const Endpoint of Endpoints) {
    if (!Endpoint || !Endpoint.IsCritical || !Endpoint.EndpointID) continue;
    const Live = AudioTimelineLiveState(Endpoint, Online);
    Items.push({
      Key: `audio:${Endpoint.EndpointID}`,
      Name: Endpoint.Name || 'Audio Device',
      Kind: Endpoint.Direction === 'input' ? 'Audio Input' : 'Audio Output',
      Address: '',
      State: Live.State,
      Label: Live.Label,
    });
  }

  const Interfaces = Array.isArray(Client.NetworkStatus?.Interfaces)
    ? Client.NetworkStatus.Interfaces
    : [];
  for (const Iface of Interfaces) {
    if (!Iface || !Iface.IsCritical || !Iface.Name) continue;
    const Live = NetworkTimelineLiveState(Iface, Online);
    const Address = Iface.IsConnected ? PrimaryAddress(Iface) : null;
    Items.push({
      Key: `net:${Iface.Name}`,
      Name: Iface.Name,
      Kind: 'Network Interface',
      Address: Address ? String(Address.address || FormatAddress(Address)) : '',
      State: Live.State,
      Label: Live.Label,
    });
  }

  const Volumes = Array.isArray(Client.StorageStatus?.Volumes) ? Client.StorageStatus.Volumes : [];
  for (const Volume of Volumes) {
    if (!Volume || !Volume.IsCritical || !Volume.MountPoint) continue;
    const Live = StorageTimelineLiveState(Volume, Online);
    const Title = StorageVolumeTitle(Volume);
    Items.push({
      Key: `storage:${Volume.MountPoint}`,
      Name: Title,
      Kind: 'Volume',
      Address: Title === Volume.MountPoint ? '' : Volume.MountPoint,
      State: Live.State,
      Label: Live.Label,
    });
  }

  return Items;
}

/**
 * One timeline per item of each expanded client, keyed by ClientItemRowKey.
 * Every current item gets one, even with no samples (an all-grey one), and an
 * item whose series is gone (it stopped being monitored) gets none.
 */
export function BuildClientItemHistoryBlocks(
  ClientItems: Record<string, Record<string, HistorySample[]>> | null | undefined,
  Clients: Array<ClientView | null | undefined>,
  Now: number
): Map<string, StatusBlock[]> {
  const Out = new Map<string, StatusBlock[]>();
  if (!ClientItems) return Out;
  for (const Client of Clients) {
    if (!Client || !Client.UUID) continue;
    const Series = ClientItems[Client.UUID];
    if (!Series) continue;
    for (const Item of ClientMonitoredItems(Client)) {
      Out.set(
        ClientItemRowKey(Client.UUID, Item.Key),
        BuildStatusBlocksFromSamples(Series[Item.Key] || [], Now)
      );
    }
  }
  return Out;
}

// --- FreeKiosk terminals ------------------------------------------------------

/** The owner id of a terminal's item rows: its tile's data-uuid. */
export function FreeKioskItemOwnerID(UUID: string): string {
  return `kiosk:${UUID}`;
}

/**
 * Every monitored reading of a terminal, in registry section order and then
 * registry order, as the Status tab lists them. Keyed by metric key, which is
 * how the history store files them. Nothing until the catalogue has loaded.
 */
export function FreeKioskMonitoredItems(
  Terminal: FreeKioskTerminalView | null | undefined,
  Catalogue: FreeKioskMetricCatalog | null | undefined
): ClientItem[] {
  if (!Terminal || !Catalogue || !Array.isArray(Catalogue.Metrics)) return [];
  const Settings = Terminal.Settings || {};
  const GroupLabels = new Map((Catalogue.Groups || []).map((Group) => [Group.Key, Group.Label]));
  const Breaching = new Set((Terminal.Alarms || []).map((Alarm) => Alarm && Alarm.Key));
  const Items: ClientItem[] = [];
  for (const Section of Catalogue.Sections || []) {
    if (!IsGroupEnabled(Catalogue.Groups, Settings, Section)) continue;
    for (const Metric of Catalogue.Metrics) {
      if (Metric.Section !== Section) continue;
      if (!MetricAppliesInMode(Settings, Metric)) continue;
      const Alarm = ReadArmedAlarm(Terminal, Metric);
      if (!Alarm) continue;
      const Value = (Terminal.Metrics || {})[Metric.Key] ?? null;
      const Breach = Breaching.has(Metric.Key);
      const Live = FreeKioskMetricLiveState(
        !!Terminal.Online,
        Breach,
        FormatMetricValue(Metric, Value),
        Breach ? DescribeExpected(Metric, Alarm) : ''
      );
      Items.push({
        Key: Metric.Key,
        Name: Metric.Label,
        Kind: GroupLabels.get(Section) || Section,
        Address: '',
        State: Live.State,
        Label: Live.Label,
      });
    }
  }
  return Items;
}

/**
 * One timeline per monitored reading of each expanded terminal, keyed by
 * ClientItemRowKey under the terminal's owner id. Coloured by the breach flag
 * recorded with each sample, exactly as the Status tab's block timelines are.
 */
export function BuildFreeKioskItemHistoryBlocks(
  KioskItems: Record<string, Record<string, FreeKioskMetricSample[]>> | null | undefined,
  Terminals: Array<FreeKioskTerminalView | null | undefined>,
  Catalogue: FreeKioskMetricCatalog | null | undefined,
  Now: number
): Map<string, StatusBlock[]> {
  const Out = new Map<string, StatusBlock[]>();
  if (!KioskItems) return Out;
  for (const Terminal of Terminals) {
    if (!Terminal || !Terminal.UUID) continue;
    const Series = KioskItems[Terminal.UUID];
    if (!Series) continue;
    const Owner = FreeKioskItemOwnerID(Terminal.UUID);
    for (const Item of FreeKioskMonitoredItems(Terminal, Catalogue)) {
      Out.set(
        ClientItemRowKey(Owner, Item.Key),
        BuildStatusBlocksFromSamples(FreeKioskMetricStatusSamples(Series[Item.Key], Now), Now)
      );
    }
  }
  return Out;
}

/** What an owner's item rows depend on, to tell when they need rebuilding rather than patching. */
export function ClientItemsShapeKey(Items: ClientItem[]): string {
  return Items.map((Item) => Item.Key).join('\u0000');
}
