// The overall-status history of everything on the page, in one read.
//
// Backs the list view's history column, which draws a one-hour timeline on
// every row. The per-entity readers (GetClientHistory, GetMonitoringCheckHistory,
// ...) would mean one round-trip per row on every refresh (and per CHECK for a
// monitoring target), so this gathers the same series from the same stores in
// a single call.
//
// A ShowTrak client or FreeKiosk terminal expanded in the list also shows one
// row per monitored item, each with its own timeline: a client's system checks,
// applications, USB devices, displays, audio endpoints, network interfaces and
// volumes; a terminal's armed readings. Those series come from the same stores
// the view modal's Status tab reads, but only for the clients and terminals the
// caller names: every one's every item on every refresh would be payload nobody
// is looking at.
//
// Only the samples the timeline can draw are returned. The renderer buckets
// them with the same arithmetic the view modal uses, so a row's graph and the
// modal's Status tab always agree.
import {
  getClientApplicationHistorySamples,
  getClientAudioHistorySamples,
  getClientDisplayHistorySamples,
  getClientNetworkHistorySamples,
  getClientStorageHistorySamples,
  getClientSystemCheckHistorySamples,
  getClientUSBHistorySamples,
  getStatusHistoryOverviewSamples,
} from './monitoring-history';
import { getFreeKioskMetricsSince, getFreeKioskReachabilitySince } from './freekiosk-history';
import type {
  FreeKioskMetricSample,
  HistorySample,
  StatusHistoryOverview,
} from '@showtrak/protocol';

/**
 * How far back the overview reaches. The renderer's timeline window is one
 * hour (MONITOR_HISTORY_WINDOW_MS); the extra minute covers the drift between
 * this read and the moment the renderer buckets it, so the oldest block is
 * never drawn from a partial minute.
 */
export const STATUS_HISTORY_OVERVIEW_WINDOW_MS = 61 * 60 * 1000;

/** The most clients (or terminals) one read will gather items for; more are ignored. */
export const MAX_ITEM_HISTORY_CLIENTS = 500;

/**
 * Each per-item store, and the prefix its series are filed under in
 * `ClientItems` (the renderer's row keys, see lib/client-items.ts). The USB
 * store's own keys already carry `usbname:` for a name-guarded group, so those
 * arrive as `usb:usbname:<name>`.
 */
const ITEM_STORES: ReadonlyArray<{
  Prefix: string;
  Read: (UUID: string) => Array<Record<string, unknown> & { samples?: HistorySample[] }>;
  KeyField: string;
}> = [
  { Prefix: 'system', Read: getClientSystemCheckHistorySamples, KeyField: 'CheckKey' },
  { Prefix: 'app', Read: getClientApplicationHistorySamples, KeyField: 'Key' },
  { Prefix: 'usb', Read: getClientUSBHistorySamples, KeyField: 'Serial' },
  { Prefix: 'display', Read: getClientDisplayHistorySamples, KeyField: 'DisplayID' },
  { Prefix: 'audio', Read: getClientAudioHistorySamples, KeyField: 'EndpointID' },
  { Prefix: 'net', Read: getClientNetworkHistorySamples, KeyField: 'InterfaceName' },
  { Prefix: 'storage', Read: getClientStorageHistorySamples, KeyField: 'MountPoint' },
];

/** UUIDs to gather items for: strings only, deduplicated, capped. */
export function normaliseItemClientList(Value: unknown): string[] {
  if (!Array.isArray(Value)) return [];
  const Out = new Set<string>();
  for (const Entry of Value) {
    if (Out.size >= MAX_ITEM_HISTORY_CLIENTS) break;
    if (typeof Entry !== 'string') continue;
    const UUID = Entry.trim();
    if (UUID.length >= 2 && UUID.length <= 128) Out.add(UUID);
  }
  return [...Out];
}

/** The points from `SinceTs` on. Series are stored oldest first. */
function samplesSince(Samples: HistorySample[], SinceTs: number): HistorySample[] {
  let Low = 0;
  let High = Samples.length;
  while (Low < High) {
    const Mid = (Low + High) >> 1;
    if (Samples[Mid]!.ts < SinceTs) Low = Mid + 1;
    else High = Mid;
  }
  return Low === 0 ? Samples : Samples.slice(Low);
}

/** One client's monitored items, keyed `<kind>:<item key>`. */
function clientItemSamples(UUID: string, SinceTs: number): Record<string, HistorySample[]> {
  const Out: Record<string, HistorySample[]> = {};
  for (const Store of ITEM_STORES) {
    for (const Series of Store.Read(UUID)) {
      const Key = Series && Series[Store.KeyField];
      if (Key == null || Key === '' || !Array.isArray(Series.samples)) continue;
      const Recent = samplesSince(Series.samples, SinceTs);
      if (Recent.length) Out[`${Store.Prefix}:${String(Key)}`] = Recent;
    }
  }
  return Out;
}

/** Which expanded rows to gather items for. Anything else is ignored. */
export interface StatusHistoryOverviewRequest {
  Clients?: unknown;
  Kiosks?: unknown;
}

export function getStatusHistoryOverview(
  Now: number = Date.now(),
  Expanded: unknown = null
): StatusHistoryOverview {
  const SinceTs = Now - STATUS_HISTORY_OVERVIEW_WINDOW_MS;
  const Overview: StatusHistoryOverview = {
    ...getStatusHistoryOverviewSamples(SinceTs),
    Kiosks: getFreeKioskReachabilitySince(SinceTs),
  };
  const Request = (
    Expanded && typeof Expanded === 'object' && !Array.isArray(Expanded) ? Expanded : {}
  ) as StatusHistoryOverviewRequest;
  const ClientUUIDs = normaliseItemClientList(Request.Clients);
  if (ClientUUIDs.length) {
    const ClientItems: Record<string, Record<string, HistorySample[]>> = {};
    for (const UUID of ClientUUIDs) ClientItems[UUID] = clientItemSamples(UUID, SinceTs);
    Overview.ClientItems = ClientItems;
  }
  const KioskUUIDs = normaliseItemClientList(Request.Kiosks);
  if (KioskUUIDs.length) {
    const KioskItems: Record<string, Record<string, FreeKioskMetricSample[]>> = {};
    for (const UUID of KioskUUIDs) KioskItems[UUID] = getFreeKioskMetricsSince(UUID, SinceTs);
    Overview.KioskItems = KioskItems;
  }
  return Overview;
}
