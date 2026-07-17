// Console + file logger with colored tags; writes to daily log file under AppData.
// Provides leveled logging, async (queued) file writes, and daily (midnight)
// file rollover.
import fs from 'fs';
import path from 'path';

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

function Pad(Text: string, Length = 17): string {
  return Text.padEnd(Length, ' ').toUpperCase();
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

// Log level gating
const LevelRank: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const DefaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
const Settings = {
  level: (process.env.LOG_LEVEL || DefaultLevel).toLowerCase(),
  toConsole: (process.env.LOG_TO_CONSOLE || 'true').toLowerCase() !== 'false',
  toFile: (process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false',
};

function isLevelEnabled(level: string): boolean {
  const want = LevelRank[Settings.level] ?? LevelRank[DefaultLevel] ?? 0;
  const have = LevelRank[level] ?? LevelRank.info ?? 0;
  return have <= want;
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

function GetDatestampLabel(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function GetDateTimeStamp(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(
    2,
    '0'
  )} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds()
  ).padStart(2, '0')}`;
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

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || String(arg);
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Remove ANSI color codes for file output
// eslint-disable-next-line no-control-regex -- matching the ANSI escape byte is the point
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  if (typeof s !== 'string') return s;
  return s.replace(ANSI_REGEX, '');
}

// The log level gates emission uniformly: a message below the active level is
// written neither to the console nor to the file. (`silent()` bypasses this on
// purpose — it is always persisted to the file.)
function writeLine(alias: string, type: string, arg: unknown, levelKey: string): void {
  if (!isLevelEnabled(levelKey)) return;
  const msg = serializeArg(arg);
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
    args.forEach((arg) =>
      enqueueWrite(`${GetDateTimeStamp()} ${TagPlain(this.Alias, 'Info')} ${serializeArg(arg)}`)
    );
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
