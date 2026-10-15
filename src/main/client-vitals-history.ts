// CPU and memory history per ShowTrak client (main process), for the line
// charts in the view modal.
//
// A sibling of freekiosk-history.ts, sharing its sample shape so the renderer
// draws both with the same chart code. The difference is the input: a client
// heartbeats every second and usage moves on nearly every one, so flat-run
// compression would save nothing. Readings are instead averaged into one point
// per POINT_INTERVAL_MS, and only the chart's window is kept — the modal draws
// the last hour, and nothing else reads these.
//
// `breach` is recorded at sample time from the alarm the client actually held,
// so the chart's threshold shading shows what was judged then, not what the
// current threshold would say about the past.
import type { FreeKioskMetricSample } from '@showtrak/protocol';
import { PercentReading } from '../Modules/ClientManager/health';

/** One averaged point every this often. Sixty-minute charts get six per minute. */
export const VITALS_POINT_INTERVAL_MS = 10 * 1000;

/** How much history is kept: the view modal's one-hour window, plus a margin. */
export const VITALS_HISTORY_WINDOW_MS = 65 * 60 * 1000;

const MAX_POINTS = Math.ceil(VITALS_HISTORY_WINDOW_MS / VITALS_POINT_INTERVAL_MS) + 10;

interface Accumulator {
  Start: number;
  CpuSum: number;
  CpuCount: number;
  RamSum: number;
  RamCount: number;
  CpuBreach: boolean;
  RamBreach: boolean;
}

interface Entry {
  Cpu: FreeKioskMetricSample[];
  Ram: FreeKioskMetricSample[];
  Pending: Accumulator | null;
  Online: boolean;
}

/** Loose shape of the client this store reads. */
interface ClientLike {
  UUID?: unknown;
  Online?: unknown;
  Vitals?: { CPU?: { UsagePercentage?: unknown }; Ram?: { UsagePercentage?: unknown } } | null;
  ResourceAlarms?: unknown;
}

const Store = new Map<string, Entry>();

function NormalizeUUID(Value: unknown): string | null {
  const Text = typeof Value === 'string' ? Value.trim() : '';
  return Text || null;
}

function AlarmActive(Alarms: unknown, Key: string): boolean {
  return Array.isArray(Alarms) && Alarms.some((Alarm) => Alarm && Alarm.Key === Key);
}

function Trim(Samples: FreeKioskMetricSample[], Now: number): void {
  const Cutoff = Now - VITALS_HISTORY_WINDOW_MS;
  while (Samples.length && Samples[0]!.ts < Cutoff) Samples.shift();
  while (Samples.length > MAX_POINTS) Samples.shift();
}

function Point(Sum: number, Count: number, Breach: boolean, Ts: number): FreeKioskMetricSample {
  return {
    ts: Ts,
    ok: Count > 0,
    n: Count > 0 ? Math.round((Sum / Count) * 10) / 10 : null,
    s: null,
    breach: Count > 0 && Breach,
  };
}

function Flush(Item: Entry, Now: number): void {
  const Acc = Item.Pending;
  Item.Pending = null;
  if (!Acc) return;
  Item.Cpu.push(Point(Acc.CpuSum, Acc.CpuCount, Acc.CpuBreach, Now));
  Item.Ram.push(Point(Acc.RamSum, Acc.RamCount, Acc.RamBreach, Now));
  Trim(Item.Cpu, Now);
  Trim(Item.Ram, Now);
}

/** Fold one client update into its history. Called for every ClientUpdated. */
export function recordClientVitalsSample(Client: ClientLike | null | undefined, Now = Date.now()) {
  const UUID = NormalizeUUID(Client && Client.UUID);
  if (!Client || !UUID) return;
  let Item = Store.get(UUID);

  if (!Client.Online) {
    // One gap point marks the outage, so the line breaks rather than joining
    // the last reading before it to the first one after.
    if (Item && Item.Online) {
      Flush(Item, Now);
      const Gap = { ts: Now, ok: false, n: null, s: null, breach: false };
      Item.Cpu.push({ ...Gap });
      Item.Ram.push({ ...Gap });
      Item.Online = false;
    }
    return;
  }

  const Cpu = PercentReading(Client.Vitals?.CPU?.UsagePercentage);
  const Ram = PercentReading(Client.Vitals?.Ram?.UsagePercentage);
  if (Cpu === null && Ram === null) return;
  if (!Item) {
    Item = { Cpu: [], Ram: [], Pending: null, Online: true };
    Store.set(UUID, Item);
  }
  Item.Online = true;

  const Acc = (Item.Pending ??= {
    Start: Now,
    CpuSum: 0,
    CpuCount: 0,
    RamSum: 0,
    RamCount: 0,
    CpuBreach: false,
    RamBreach: false,
  });
  if (Cpu !== null) {
    Acc.CpuSum += Cpu;
    Acc.CpuCount += 1;
  }
  if (Ram !== null) {
    Acc.RamSum += Ram;
    Acc.RamCount += 1;
  }
  Acc.CpuBreach ||= AlarmActive(Client.ResourceAlarms, 'cpu');
  Acc.RamBreach ||= AlarmActive(Client.ResourceAlarms, 'ram');
  if (Now - Acc.Start >= VITALS_POINT_INTERVAL_MS) Flush(Item, Now);
}

/**
 * Both series for one client, including the point still being averaged, so a
 * chart opened mid-interval already shows the latest reading.
 */
export function getClientVitalsHistory(
  UUID: unknown,
  Now = Date.now()
): { Cpu: FreeKioskMetricSample[]; Ram: FreeKioskMetricSample[] } {
  const Key = NormalizeUUID(UUID);
  const Item = Key ? Store.get(Key) : undefined;
  if (!Item) return { Cpu: [], Ram: [] };
  Trim(Item.Cpu, Now);
  Trim(Item.Ram, Now);
  const Cpu = Item.Cpu.map((Sample) => ({ ...Sample }));
  const Ram = Item.Ram.map((Sample) => ({ ...Sample }));
  const Acc = Item.Pending;
  if (Acc) {
    if (Acc.CpuCount) Cpu.push(Point(Acc.CpuSum, Acc.CpuCount, Acc.CpuBreach, Now));
    if (Acc.RamCount) Ram.push(Point(Acc.RamSum, Acc.RamCount, Acc.RamBreach, Now));
  }
  return { Cpu, Ram };
}

/** Drop expired points, then clients with nothing left. */
export function pruneClientVitalsHistory(Now = Date.now()): void {
  for (const [UUID, Item] of Array.from(Store.entries())) {
    Trim(Item.Cpu, Now);
    Trim(Item.Ram, Now);
    if (!Item.Cpu.length && !Item.Ram.length && !Item.Pending) Store.delete(UUID);
  }
}

/** Forget clients that are no longer in the list. */
export function syncClientVitalsHistory(List: unknown): void {
  const Valid = new Set<string>();
  for (const Client of Array.isArray(List) ? List : []) {
    const UUID = NormalizeUUID(Client && (Client as ClientLike).UUID);
    if (UUID) Valid.add(UUID);
  }
  for (const UUID of Array.from(Store.keys())) {
    if (!Valid.has(UUID)) Store.delete(UUID);
  }
}

export const _internal = { Store, MAX_POINTS };
