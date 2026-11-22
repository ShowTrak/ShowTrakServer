// Console + file logger with colored tags; writes to a daily log file under
// AppData. Provides leveled logging, async (queued) file writes, and daily
// (midnight) file rollover.
//
// The logger itself is @showtrak/protocol/runtime's CreateAppLogging, shared
// with ShowTrak Timers: level gating and the default level (info in a shipped
// build, debug from a checkout, LOG_LEVEL over both), the coloured console copy,
// and the batched, ordered appends to ShowTrakServer-YYYY-MM-DD.log. ShowTrak
// Client keeps its own sink on purpose: it writes synchronously, so a crashing
// unattended agent keeps the lines explaining why.
//
// What is the Server's own is configured here: its name, its logs folder, and
// the live feed below that its log console reads.
import pc from 'picocolors';

import { CreateAppLogging, IsLevelEnabled, StripAnsi } from '@showtrak/protocol/runtime';
import { Manager as AppDataManager } from '../AppData';

import type { LogConsoleEntry } from '@showtrak/protocol';

let IsInInstallation = false;
try {
  // In install/update phase for Electron apps, avoid file I/O noise. The package
  // exports one boolean (whether this is a Squirrel install run) and no types.
  IsInInstallation = require('electron-squirrel-startup') as boolean;
} catch {
  IsInInstallation = false;
}

// --- Live feed --------------------------------------------------------------
//
// Every emitted line is also kept in a small in-memory ring and handed to any
// feed listener (the hidden log console). The feed has its own level, separate
// from the active level: while a console is watching at 'trace', lines below the
// active level are still produced for the feed, but never written to the
// console or the file. With no console watching, FeedLevel is null and nothing
// below the active level is serialised, so the feed costs nothing extra.

// Each line is the protocol's LogConsoleEntry: the console shows it as it is.
type LogFeedListener = (Entry: LogConsoleEntry) => void;

// The ring is bounded by lines AND characters, whichever is hit first, so a run
// of maximum-length lines cannot hold more than a few MB.
const FEED_RING_SIZE = 1000;
const FEED_RING_MAX_CHARS = 1_000_000;
// A console line is for reading, not archiving: a multi-megabyte JSON dump would
// otherwise be shipped whole to every viewer. The file keeps the full line.
const FEED_MAX_MESSAGE_LENGTH = 20000;

const FeedRing: LogConsoleEntry[] = [];
let FeedRingChars = 0;
const FeedListeners = new Set<LogFeedListener>();
// Seeded from the clock so a restarted server keeps counting upward: a Web UI
// that reconnects across a restart drops lines at or below the last Seq it saw,
// and a counter reset to zero would make it drop everything. Room for 1000 lines
// per millisecond, sustained, before a restart could collide.
let FeedSeq = Date.now() * 1000;
let FeedLevel: string | null = null;

function feedWants(levelKey: string): boolean {
  return FeedLevel !== null && IsLevelEnabled(levelKey, FeedLevel, Logging.DefaultLevel);
}

function pushFeed(alias: string, type: string, levelKey: string, msg: string): void {
  let Message = StripAnsi(msg);
  if (Message.length > FEED_MAX_MESSAGE_LENGTH) {
    const Extra = Message.length - FEED_MAX_MESSAGE_LENGTH;
    Message = `${Message.slice(0, FEED_MAX_MESSAGE_LENGTH)}... (${Extra} more characters in the log file)`;
  }
  const Entry: LogConsoleEntry = {
    Seq: ++FeedSeq,
    Time: Date.now(),
    Level: levelKey,
    Type: type,
    Alias: alias,
    Message,
  };
  FeedRing.push(Entry);
  FeedRingChars += Message.length;
  while (
    FeedRing.length > 1 &&
    (FeedRing.length > FEED_RING_SIZE || FeedRingChars > FEED_RING_MAX_CHARS)
  ) {
    FeedRingChars -= FeedRing.shift()!.Message.length;
  }
  for (const Listener of FeedListeners) {
    try {
      Listener(Entry);
    } catch {
      /* intentional: a broken listener must never break logging */
    }
  }
}

/** Listen to every line the feed produces. Returns an unsubscribe handle. */
export function SubscribeToLogFeed(Listener: LogFeedListener): () => void {
  FeedListeners.add(Listener);
  return () => {
    FeedListeners.delete(Listener);
  };
}

/** The recent lines held in memory, oldest first. */
export function GetLogFeedBacklog(): LogConsoleEntry[] {
  return FeedRing.slice();
}

/**
 * The most verbose level any viewer wants, or null when nobody is watching.
 * Lines down to this level are produced for the feed even when the active level
 * would drop them.
 */
export function SetLogFeedLevel(Level: string | null): void {
  FeedLevel = Level ? String(Level).toLowerCase() : null;
}

// --- The logger -------------------------------------------------------------

const Logging = CreateAppLogging({
  AppName: 'ShowTrakServer',
  LogDirectory: AppDataManager.GetLogsDirectory(),
  Colors: pc,
  SkipFileWrites: IsInInstallation,
  Feed: { Wants: feedWants, Push: pushFeed },
});

export const {
  CreateLogger,
  // Change the level, or turn the console or file copy off or on, at runtime
  // (main/live-settings applies the SYSTEM_LOG_LEVEL setting through it).
  configure,
  // Resolves once every line logged so far has been handed to the OS. For tests
  // and orderly shutdown; logging itself never waits on it.
  flushLogWrites,
} = Logging;
