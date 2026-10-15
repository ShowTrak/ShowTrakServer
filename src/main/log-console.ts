// Hidden log console: streams the Logger's live feed to whichever surfaces have
// the console open — the desktop window and/or individual Web UI sockets.
//
// Nothing is streamed to a surface until it opens the console, and a surface
// only receives lines at or above the level it asked for, so a closed console
// (or one watching errors only) costs no IPC and no Web UI bandwidth. While at
// least one viewer is open the Logger is asked to produce lines down to the most
// verbose level any viewer wants; once the last one closes it goes back to
// producing nothing it would not have written anyway.
//
// Lines are batched on a short timer rather than sent one by one: a busy show
// logs in bursts, and one message per line would flood a slow web link.

import { LEVEL_RANK } from '@showtrak/protocol/runtime';
import {
  GetLogFeedBacklog,
  SetLogFeedLevel,
  SubscribeToLogFeed,
  type LogFeedEntry,
} from '../Modules/Logger';

const FLUSH_INTERVAL_MS = 250;
// Lines held between flushes, by count and by characters. Only reached if a
// flush is starved for seconds; the oldest lines go first, which is what a live
// view wants.
const MAX_PENDING = 2000;
const MAX_PENDING_CHARS = 2_000_000;
const DEFAULT_LEVEL = 'info';

export interface LogConsoleSnapshot {
  Level: string;
  Entries: LogFeedEntry[];
}

interface Viewer {
  Level: string;
  Send: (Entries: LogFeedEntry[]) => void;
}

const Viewers = new Map<string, Viewer>();
let Pending: LogFeedEntry[] = [];
let PendingChars = 0;
let Unsubscribe: (() => void) | null = null;
let FlushTimer: ReturnType<typeof setInterval> | null = null;

function NormaliseLevel(Level: unknown): string {
  const Key = String(Level || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, Key) ? Key : DEFAULT_LEVEL;
}

function Rank(Level: string): number {
  return LEVEL_RANK[Level] ?? LEVEL_RANK[DEFAULT_LEVEL] ?? 2;
}

function Wants(Viewer: Viewer, Entry: LogFeedEntry): boolean {
  return Rank(Entry.Level) <= Rank(Viewer.Level);
}

function Flush(): void {
  if (!Pending.length) return;
  const Batch = Pending;
  Pending = [];
  PendingChars = 0;
  for (const [Key, Viewer] of Viewers) {
    const Entries = Batch.filter((Entry) => Wants(Viewer, Entry));
    if (!Entries.length) continue;
    try {
      Viewer.Send(Entries);
    } catch {
      // A surface that can no longer be reached has gone away without closing.
      Viewers.delete(Key);
    }
  }
  if (!Viewers.size) Sync();
}

// Bring the feed subscription, the flush timer and the Logger's feed level in
// line with the current set of viewers.
function Sync(): void {
  if (!Viewers.size) {
    SetLogFeedLevel(null);
    if (Unsubscribe) Unsubscribe();
    Unsubscribe = null;
    if (FlushTimer) clearInterval(FlushTimer);
    FlushTimer = null;
    Pending = [];
    PendingChars = 0;
    return;
  }
  let Most = DEFAULT_LEVEL;
  let MostRank = -1;
  for (const Viewer of Viewers.values()) {
    if (Rank(Viewer.Level) > MostRank) {
      MostRank = Rank(Viewer.Level);
      Most = Viewer.Level;
    }
  }
  SetLogFeedLevel(Most);
  if (!Unsubscribe) {
    Unsubscribe = SubscribeToLogFeed((Entry) => {
      Pending.push(Entry);
      PendingChars += Entry.Message.length;
      while (
        Pending.length > 1 &&
        (Pending.length > MAX_PENDING || PendingChars > MAX_PENDING_CHARS)
      ) {
        PendingChars -= Pending.shift()!.Message.length;
      }
    });
  }
  if (!FlushTimer) {
    FlushTimer = setInterval(Flush, FLUSH_INTERVAL_MS);
    if (typeof FlushTimer.unref === 'function') FlushTimer.unref();
  }
}

/**
 * Open (or re-level) the console for one viewer and return the recent lines at
 * its level. Calling it again with a new level for the same key replaces the
 * level; the returned backlog lets the viewer redraw from scratch. Entries carry
 * a sequence number so a viewer can drop live lines it already has.
 */
export function OpenLogConsole(
  Key: string,
  Level: unknown,
  Send: (Entries: LogFeedEntry[]) => void
): LogConsoleSnapshot {
  const Viewer: Viewer = { Level: NormaliseLevel(Level), Send };
  Viewers.set(Key, Viewer);
  Sync();
  return {
    Level: Viewer.Level,
    Entries: GetLogFeedBacklog().filter((Entry) => Wants(Viewer, Entry)),
  };
}

/** Stop streaming to one viewer. Safe to call for a viewer that is not open. */
export function CloseLogConsole(Key: string): void {
  if (!Viewers.delete(Key)) return;
  Sync();
}
