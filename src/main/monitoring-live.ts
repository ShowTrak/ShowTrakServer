// Live levels: streams audio meters from monitoring checks to whichever surfaces
// have that monitor's view open — the desktop window and/or individual Web UI
// sockets.
//
// A check only streams while someone is watching it: opening a monitor's view
// starts a stream for each of its checks that has live levels turned on, and the
// last viewer closing stops it. That matters beyond bandwidth — a stream can hold
// a device's only control connection (the TASCAM MX-8A accepts one), so it must
// not outlive the view.
//
// Frames are batched on a short timer: each flush sends a viewer the full set of
// frames for the monitor it is watching, so a check that stops streaming (its
// toggle turned off, or it was deleted) simply drops out of the next snapshot.

import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as MonitoringMethods, stableStringify } from '../Modules/MonitoringMethods';
import { Manager as MonitoringTargetManager } from '../Modules/MonitoringTargetManager';
import type { MonitorLiveLevelsCheck, MonitorLiveLevelsSnapshot } from '@showtrak/protocol';

const FLUSH_INTERVAL_MS = 100;

interface Viewer {
  TargetID: number;
  Send: (Snapshot: MonitorLiveLevelsSnapshot) => void;
}

interface Stream {
  TargetID: number;
  Stop: () => void;
  Last: MonitorLiveLevelsCheck;
}

const Viewers = new Map<string, Viewer>();
// Keyed by check and everything its method reads, so a settings change starts a
// fresh stream (the old one is stopped) rather than leaving a stale one running.
const Streams = new Map<string, Stream>();
const DirtyTargets = new Set<number>();
let FlushTimer: ReturnType<typeof setInterval> | null = null;
let Listening = false;

function StreamKey(
  CheckID: number,
  Method: string,
  Check: { Address?: unknown; Settings?: unknown }
) {
  return `${CheckID}|${stableStringify({ Method, Address: Check.Address, Settings: Check.Settings })}`;
}

function SnapshotFor(TargetID: number): MonitorLiveLevelsSnapshot {
  const Checks: MonitorLiveLevelsCheck[] = [];
  for (const Stream of Streams.values()) {
    if (Stream.TargetID === TargetID) Checks.push(Stream.Last);
  }
  Checks.sort((A, B) => A.CheckID - B.CheckID);
  return { TargetID, Checks };
}

function Flush(): void {
  if (!DirtyTargets.size) return;
  const Targets = Array.from(DirtyTargets);
  DirtyTargets.clear();
  let Lost = false;
  for (const TargetID of Targets) {
    const Snapshot = SnapshotFor(TargetID);
    for (const [Key, Viewer] of Viewers) {
      if (Viewer.TargetID !== TargetID) continue;
      try {
        Viewer.Send(Snapshot);
      } catch {
        // A surface that can no longer be reached has gone away without closing.
        Viewers.delete(Key);
        Lost = true;
      }
    }
  }
  if (Lost) Sync();
}

function OnTargetsChanged(): void {
  Sync();
}

// Bring the running streams, the flush timer and the target listeners in line
// with what the current viewers are watching.
function Sync(): void {
  const Wanted = new Map<
    string,
    { TargetID: number; CheckID: number; Name: string; Method: string; Check: object }
  >();
  for (const TargetID of new Set(Array.from(Viewers.values(), (V) => V.TargetID))) {
    for (const Live of MonitoringTargetManager.GetLiveLevelChecks(TargetID)) {
      Wanted.set(StreamKey(Live.CheckID, Live.Method, Live.Check), { TargetID, ...Live });
    }
  }

  for (const [Key, Stream] of Streams) {
    if (Wanted.has(Key)) continue;
    Streams.delete(Key);
    DirtyTargets.add(Stream.TargetID);
    Stream.Stop();
  }
  for (const [Key, Live] of Wanted) {
    if (Streams.has(Key)) continue;
    const Stream: Stream = {
      TargetID: Live.TargetID,
      Stop: () => undefined,
      Last: {
        CheckID: Live.CheckID,
        Name: Live.Name,
        State: 'connecting',
        Message: null,
        Channels: [],
      },
    };
    Streams.set(Key, Stream);
    DirtyTargets.add(Live.TargetID);
    const Stop = MonitoringMethods.StartLiveLevels(Live.Method, Live.Check, (Frame) => {
      if (Streams.get(Key) !== Stream) return;
      Stream.Last = { CheckID: Live.CheckID, Name: Live.Name, ...Frame };
      DirtyTargets.add(Live.TargetID);
    });
    if (Stop) Stream.Stop = Stop;
    else {
      Stream.Last = {
        ...Stream.Last,
        State: 'unavailable',
        Message: 'Live levels could not start',
      };
    }
  }

  if (Viewers.size) {
    if (!FlushTimer) {
      FlushTimer = setInterval(Flush, FLUSH_INTERVAL_MS);
      if (typeof FlushTimer.unref === 'function') FlushTimer.unref();
    }
    if (!Listening) {
      Listening = true;
      BroadcastManager.on('MonitoringTargetUpdated', OnTargetsChanged);
      BroadcastManager.on('MonitoringTargetListChanged', OnTargetsChanged);
    }
  } else {
    if (FlushTimer) clearInterval(FlushTimer);
    FlushTimer = null;
    DirtyTargets.clear();
    if (Listening) {
      Listening = false;
      BroadcastManager.off('MonitoringTargetUpdated', OnTargetsChanged);
      BroadcastManager.off('MonitoringTargetListChanged', OnTargetsChanged);
    }
  }
}

/**
 * Start watching one monitor's live levels for one viewer, replacing whatever
 * that viewer watched before, and return the current frames for it (empty when
 * none of its checks has live levels turned on).
 */
export function OpenMonitorLiveLevels(
  Key: string,
  TargetID: unknown,
  Send: (Snapshot: MonitorLiveLevelsSnapshot) => void
): MonitorLiveLevelsSnapshot {
  const ID = Number(TargetID);
  if (!Number.isInteger(ID) || ID <= 0) {
    CloseMonitorLiveLevels(Key);
    return { TargetID: ID, Checks: [] };
  }
  Viewers.set(Key, { TargetID: ID, Send });
  Sync();
  return SnapshotFor(ID);
}

/** Stop streaming to one viewer. Safe to call for a viewer that is not open. */
export function CloseMonitorLiveLevels(Key: string): void {
  if (!Viewers.delete(Key)) return;
  Sync();
}
