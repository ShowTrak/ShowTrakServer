// Live levels: streams audio meters from monitoring checks to whichever surfaces
// are showing them — the desktop window and/or individual Web UI sockets. Two
// kinds of viewer:
//
//   - a monitor's view: every meter of that monitor's checks with live levels on;
//   - a dashboard: the tile meters of every monitor whose tile widget is 'levels'
//     (its only check has tile levels on), fewer channels at a slower rate.
//
// A check only streams while someone is watching it, and one stream serves both
// kinds of viewer. That matters beyond bandwidth — a stream can hold a device's
// only control connection (the TASCAM MX-8A accepts one), so it must not outlive
// the last viewer.
//
// Frames are batched on short timers: each flush sends a viewer the full set of
// frames it is watching, so a check that stops streaming (its toggle turned off,
// or it was deleted) simply drops out of the next snapshot.

import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as MonitoringMethods, stableStringify } from '../Modules/MonitoringMethods';
import { Manager as MonitoringTargetManager } from '../Modules/MonitoringTargetManager';
import type {
  MonitorLiveLevelsCheck,
  MonitorLiveLevelsSnapshot,
  MonitorTileLevels,
  MonitorTileLevelsSnapshot,
} from '@showtrak/protocol';

const FLUSH_INTERVAL_MS = 100;
// Tiles are small and every open dashboard gets them: every other flush.
const TILE_FLUSH_EVERY = 2;

interface Viewer {
  TargetID: number;
  Send: (Snapshot: MonitorLiveLevelsSnapshot) => void;
}

interface Stream {
  TargetID: number;
  // Which kinds of viewer this stream is serving, as of the last Sync.
  ForView: boolean;
  ForTile: boolean;
  Stop: () => void;
  Last: MonitorLiveLevelsCheck;
}

interface WantedStream {
  TargetID: number;
  CheckID: number;
  Name: string;
  Method: string;
  Check: object;
  ForView: boolean;
  ForTile: boolean;
}

const Viewers = new Map<string, Viewer>();
const TileViewers = new Map<string, (Snapshot: MonitorTileLevelsSnapshot) => void>();
// Keyed by check and everything its method reads, so a settings change starts a
// fresh stream (the old one is stopped) rather than leaving a stale one running.
const Streams = new Map<string, Stream>();
const DirtyTargets = new Set<number>();
let TilesDirty = false;
let FlushCount = 0;
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
    if (Stream.TargetID === TargetID && Stream.ForView) {
      // Tile-only channels (a mix bus picked for the tile) stay off the view.
      Checks.push({ ...Stream.Last, Channels: Stream.Last.Channels.filter((C) => C.View) });
    }
  }
  Checks.sort((A, B) => A.CheckID - B.CheckID);
  return { TargetID, Checks };
}

function TileSnapshot(): MonitorTileLevelsSnapshot {
  const Tiles: MonitorTileLevels[] = [];
  for (const Stream of Streams.values()) {
    if (!Stream.ForTile) continue;
    Tiles.push({
      TargetID: Stream.TargetID,
      CheckID: Stream.Last.CheckID,
      State: Stream.Last.State,
      Message: Stream.Last.Message,
      Channels: Stream.Last.Channels.filter((C) => C.Tile).map((C) => ({
        Label: C.Label,
        Db: C.Db,
      })),
    });
  }
  Tiles.sort((A, B) => A.TargetID - B.TargetID);
  return { Tiles };
}

function Flush(): void {
  let Lost = false;
  if (DirtyTargets.size) {
    const Targets = Array.from(DirtyTargets);
    DirtyTargets.clear();
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
  }
  FlushCount = (FlushCount + 1) % TILE_FLUSH_EVERY;
  if (TilesDirty && FlushCount === 0) {
    TilesDirty = false;
    const Snapshot = TileSnapshot();
    for (const [Key, Send] of TileViewers) {
      try {
        Send(Snapshot);
      } catch {
        TileViewers.delete(Key);
        Lost = true;
      }
    }
  }
  if (Lost) Sync();
}

function OnTargetsChanged(): void {
  Sync();
}

function MarkDirty(Stream: Stream): void {
  if (Stream.ForView) DirtyTargets.add(Stream.TargetID);
  if (Stream.ForTile) TilesDirty = true;
}

// Bring the running streams, the flush timer and the target listeners in line
// with what the current viewers are watching.
function Sync(): void {
  const Wanted = new Map<string, WantedStream>();
  for (const TargetID of new Set(Array.from(Viewers.values(), (V) => V.TargetID))) {
    for (const Live of MonitoringTargetManager.GetLiveLevelChecks(TargetID)) {
      Wanted.set(StreamKey(Live.CheckID, Live.Method, Live.Check), {
        TargetID,
        ...Live,
        ForView: true,
        ForTile: false,
      });
    }
  }
  if (TileViewers.size) {
    for (const Tile of MonitoringTargetManager.GetTileLevelChecks()) {
      const Key = StreamKey(Tile.CheckID, Tile.Method, Tile.Check);
      const Existing = Wanted.get(Key);
      if (Existing) Existing.ForTile = true;
      else Wanted.set(Key, { ...Tile, ForView: false, ForTile: true });
    }
  }

  // Successors start before their predecessors stop, so a stream whose settings
  // changed can hand its device connection straight over (see the method's own
  // sharing, e.g. TASCAM MX-8A's one connection per unit).
  for (const [Key, Live] of Wanted) {
    if (Streams.has(Key)) continue;
    const Stream: Stream = {
      TargetID: Live.TargetID,
      ForView: Live.ForView,
      ForTile: Live.ForTile,
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
    MarkDirty(Stream);
    const Stop = MonitoringMethods.StartLiveLevels(Live.Method, Live.Check, (Frame) => {
      if (Streams.get(Key) !== Stream) return;
      Stream.Last = { CheckID: Live.CheckID, Name: Live.Name, ...Frame };
      MarkDirty(Stream);
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

  for (const [Key, Stream] of Streams) {
    const Want = Wanted.get(Key);
    if (Want) {
      if (Want.ForView !== Stream.ForView || Want.ForTile !== Stream.ForTile) {
        // Mark both before and after, so a viewer it stops serving gets a
        // snapshot without it.
        MarkDirty(Stream);
        Stream.ForView = Want.ForView;
        Stream.ForTile = Want.ForTile;
        MarkDirty(Stream);
      }
      continue;
    }
    Streams.delete(Key);
    MarkDirty(Stream);
    Stream.Stop();
  }
  if (Viewers.size || TileViewers.size) {
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
    TilesDirty = false;
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

/** Start sending one dashboard the tile meters, and return the current ones. */
export function OpenMonitorTileLevels(
  Key: string,
  Send: (Snapshot: MonitorTileLevelsSnapshot) => void
): MonitorTileLevelsSnapshot {
  TileViewers.set(Key, Send);
  Sync();
  return TileSnapshot();
}

/** Stop sending one dashboard the tile meters. Safe to call when not open. */
export function CloseMonitorTileLevels(Key: string): void {
  if (!TileViewers.delete(Key)) return;
  Sync();
}
