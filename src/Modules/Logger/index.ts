// Console + file logger with colored tags; writes to daily log file under AppData.
// Provides leveled logging, async (queued) file writes, and daily (midnight)
// file rollover.
//
// Level ranking, default-level derivation and the formatting helpers come from
// @showtrak/protocol/runtime, shared with ShowTrakClient. The SINK below does
// not: this app queues asynchronous appends, while the Client writes
// synchronously so a crashing unattended agent keeps the lines explaining why.
// That difference is deliberate, which is why only the pure half is shared.
import fs from 'fs';
import path from 'path';

import {
  GetDatestampLabel,
  GetDateTimeStamp,
  IsLevelEnabled as IsLevelEnabledFor,
  Pad,
  ResolveDefaultLevel,
  SerializeArg,
  StripAnsi,
} from '@showtrak/protocol/runtime';
import { Manager as AppDataManager } from '../AppData';

const pc = require('picocolors');

const fsp = fs.promises;

let IsInInstallation = false;
try {
  // In install/update phase for Electron apps, avoid file I/O noise.
  IsInInstallation = require('electron-squirrel-startup');
} catch {
  IsInInstallation = false;
}

const LogDirectory = AppDataManager.GetLogsDirectory();
if (!fs.existsSync(LogDirectory)) {
  fs.mkdirSync(LogDirectory, { recursive: true });
}

const Types: Record<string, string> = {
  Info: pc.cyan(Pad('INFO')),
  Warn: pc.magenta(Pad('WARN')),
  Error: pc.red(Pad('ERROR')),
  Trace: pc.magenta(Pad('TRACE')),
  Debug: pc.gray(Pad('DEBUG')),
  Success: pc.green(Pad('SUCCESS')),
  Database: pc.gray(Pad('DATABASE')),
};

// Plain (non-colored) labels for file output
const PlainTypes: Record<string, string> = {
  Info: Pad('INFO'),
  Warn: Pad('WARN'),
  Error: Pad('ERROR'),
  Trace: Pad('TRACE'),
  Debug: Pad('DEBUG'),
  Success: Pad('SUCCESS'),
  Database: Pad('DATABASE'),
};

// --- Log level gating -------------------------------------------------------
//
// Detecting a shipped build: a packaged Electron app has no NODE_ENV, so that
// test alone left every shipped server at 'debug', writing debug chatter to the
// daily log file for the life of the install. The SYSTEM_LOG_LEVEL setting could
// not rescue it either: its default is 'info', and main/live-settings.ts
// deliberately skips applying a still-default setting at boot, so the settings
// UI read "info" while the logger ran at debug.
//
// Electron sets `process.defaultApp` only when the app was launched from a
// checkout (`electron .`), so its absence is the "this is a shipped build"
// signal, the same test `app.isPackaged` performs. It is used here in
// preference to importing `app` because Logger is the lowest module in the tree:
// everything imports it, and giving it an `electron` dependency would mean it
// could no longer be loaded outside an Electron main process (the test suite
// loads it directly). This mirrors ShowTrakClient's Logger, which already
// carried the fix.
//
// LOG_LEVEL overrides both, which is the point: a server misbehaving on site can
// be relaunched with LOG_LEVEL=debug without a rebuild.
const DefaultLevel = ResolveDefaultLevel({
  nodeEnv: process.env.NODE_ENV,
  isPackagedBuild: !process.defaultApp,
});
const Settings = {
  level: (process.env.LOG_LEVEL || DefaultLevel).toLowerCase(),
  toConsole: (process.env.LOG_TO_CONSOLE || 'true').toLowerCase() !== 'false',
  toFile: (process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false',
};

function isLevelEnabled(level: string): boolean {
  return IsLevelEnabledFor(level, Settings.level, DefaultLevel);
}

function Tag(Text: string, Type: string): string {
  return `[${pc.cyan('ShowTrakServer')}] [${pc.cyan(Pad(Text))}] [${
    Object.prototype.hasOwnProperty.call(Types, Type) ? Types[Type] : Types['Info']
  }]`;
}

function TagPlain(Text: string, Type: string): string {
  return `[ShowTrakServer] [${Pad(Text)}] [${
    Object.prototype.hasOwnProperty.call(PlainTypes, Type) ? PlainTypes[Type] : PlainTypes['Info']
  }]`;
}

// Daily rollover: compute today's file on each write and ensure it exists.
function getTodayLogFilePath(): string {
  const fileName = `ShowTrakServer-${GetDatestampLabel()}.log`;
  return path.join(LogDirectory, fileName);
}

async function ensureTodayLogFile(): Promise<string> {
  const filePath = getTodayLogFilePath();
  try {
    await fsp.mkdir(LogDirectory, { recursive: true });
    await fsp.access(filePath).catch(() => fsp.writeFile(filePath, '', 'utf8'));
  } catch {
    void 0;
  }
  return filePath;
}

// Simple write queue to keep ordering and avoid sync I/O.
let writeTail: Promise<unknown> = Promise.resolve();
function enqueueWrite(line: string): void {
  if (IsInInstallation || !Settings.toFile) return;
  writeTail = writeTail
    .then(async () => {
      const filePath = await ensureTodayLogFile();
      await fsp.appendFile(filePath, line + '\n', 'utf8');
    })
    .catch(() => null);
}

// serializeArg / stripAnsi now come from @showtrak/protocol/runtime (aliased at
// the import), both apps formatted log lines identically, and only the sinks
// they feed differ.
const serializeArg = SerializeArg;
const stripAnsi = StripAnsi;

// --- Live feed --------------------------------------------------------------
//
// Every emitted line is also kept in a small in-memory ring and handed to any
// feed listener (the hidden log console). The feed has its own level, separate
// from Settings.level: while a console is watching at 'trace', lines below the
// active level are still produced for the feed, but never written to the
// console or the file. With no console watching, FeedLevel is null and nothing
// below the active level is serialised, so the feed costs nothing extra.

export interface LogFeedEntry {
  Seq: number;
  Time: number;
  Level: string;
  Type: string;
  Alias: string;
  Message: string;
}

type LogFeedListener = (Entry: LogFeedEntry) => void;

// The ring is bounded by lines AND characters, whichever is hit first, so a run
// of maximum-length lines cannot hold more than a few MB.
const FEED_RING_SIZE = 1000;
const FEED_RING_MAX_CHARS = 1_000_000;
// A console line is for reading, not archiving: a multi-megabyte JSON dump would
// otherwise be shipped whole to every viewer. The file keeps the full line.
const FEED_MAX_MESSAGE_LENGTH = 20000;

const FeedRing: LogFeedEntry[] = [];
let FeedRingChars = 0;
const FeedListeners = new Set<LogFeedListener>();
// Seeded from the clock so a restarted server keeps counting upward: a Web UI
// that reconnects across a restart drops lines at or below the last Seq it saw,
// and a counter reset to zero would make it drop everything. Room for 1000 lines
// per millisecond, sustained, before a restart could collide.
let FeedSeq = Date.now() * 1000;
let FeedLevel: string | null = null;

function feedWants(levelKey: string): boolean {
  return FeedLevel !== null && IsLevelEnabledFor(levelKey, FeedLevel, DefaultLevel);
}

function pushFeed(alias: string, type: string, levelKey: string, msg: string): void {
  let Message = stripAnsi(msg);
  if (Message.length > FEED_MAX_MESSAGE_LENGTH) {
    const Extra = Message.length - FEED_MAX_MESSAGE_LENGTH;
    Message = `${Message.slice(0, FEED_MAX_MESSAGE_LENGTH)}... (${Extra} more characters in the log file)`;
  }
  const Entry: LogFeedEntry = {
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
export function GetLogFeedBacklog(): LogFeedEntry[] {
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

// The log level gates emission uniformly: a message below the active level is
// written neither to the console nor to the file. (`silent()` bypasses this on
// purpose; it is always persisted to the file.) A watching log console may
// still receive it through the feed.
function writeLine(alias: string, type: string, arg: unknown, levelKey: string): void {
  const Enabled = isLevelEnabled(levelKey);
  if (!Enabled && !feedWants(levelKey)) return;
  const msg = serializeArg(arg);
  pushFeed(alias, type, levelKey, msg);
  if (!Enabled) return;
  const consoleTag = Tag(alias, type);
  const fileTag = TagPlain(alias, type);
  const line = `${GetDateTimeStamp()} ${fileTag} ${stripAnsi(msg)}`;
  if (Settings.toConsole) console.log(consoleTag, msg);
  enqueueWrite(line);
}

class Logger {
  Alias: string;

  constructor(Alias: string) {
    this.Alias = Alias;
  }
  log(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Info', arg, 'info'));
  }
  // Alias of log(); kept because both names are used across the codebase.
  info(...args: unknown[]): void {
    this.log(...args);
  }
  silent(...args: unknown[]): void {
    args.forEach((arg) => {
      const msg = serializeArg(arg);
      pushFeed(this.Alias, 'Info', 'info', msg);
      enqueueWrite(`${GetDateTimeStamp()} ${TagPlain(this.Alias, 'Info')} ${msg}`);
    });
  }
  warn(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Warn', arg, 'warn'));
  }
  error(...args: unknown[]): void {
    args.forEach((arg) =>
      writeLine(this.Alias, 'Error', arg instanceof Error ? arg : serializeArg(arg), 'error')
    );
  }
  debug(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Debug', arg, 'debug'));
  }
  trace(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Trace', arg, 'trace'));
  }
  success(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Success', arg, 'info'));
  }
  database(...args: unknown[]): void {
    args.forEach((arg) => writeLine(this.Alias, 'Database', arg, 'info'));
  }
  databaseError(...args: unknown[]): void {
    args.forEach((arg) =>
      writeLine(this.Alias, 'Database', arg instanceof Error ? arg : pc.red(arg), 'error')
    );
  }
  child(suffix: string): Logger {
    return new Logger(`${this.Alias}:${suffix}`);
  }
}

export function CreateLogger(Alias: string): Logger {
  return new Logger(Alias);
}

interface LoggerConfigureOptions {
  level?: string;
  toConsole?: boolean;
  toFile?: boolean;
}

export function configure(options: LoggerConfigureOptions = {}): void {
  if (options.level) Settings.level = String(options.level).toLowerCase();
  if (typeof options.toConsole === 'boolean') Settings.toConsole = options.toConsole;
  if (typeof options.toFile === 'boolean') Settings.toFile = options.toFile;
}
