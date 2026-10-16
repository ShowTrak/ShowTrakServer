// Audit log: the last 24 hours of status changes, edits and actions.
//
// Kept in its own SQLite file in app data (Storage/AuditLog.sqlite), on its own
// connection, deliberately apart from the show database: opening or starting a
// show swaps that file out wholesale, every write to it marks the show unsaved,
// and a saved .ShowTrak would carry the log to whoever it is sent to. None of
// that is right for a record of what happened on this machine.
//
// Writes are queued and flushed in batches (a reconnect storm is one
// transaction, not hundreds), and anything older than AUDIT_LOG_RETENTION_MS is
// purged at start and on a timer, so a server left running for weeks never
// holds more than a day. Nothing is recorded until Start() is called, so a
// module that records edits can be loaded by a test without touching disk.
import path from 'path';
import fs from 'fs';

import type {
  AuditCategory,
  AuditChange,
  AuditEntityType,
  AuditLogEntry,
  AuditLogPage,
  AuditLogQuery,
  AuditSegment,
  AuditSeverity,
} from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { Manager as BroadcastManager } from '../Broadcast';
import {
  AUDIT_LOG_FLUSH_INTERVAL_MS,
  AUDIT_LOG_MAX_ENTRIES,
  AUDIT_LOG_RETENTION_MS,
  AUDIT_LOG_SWEEP_INTERVAL_MS,
} from '../Config/constants';
import { PlainText } from './message';
import { CurrentAuditSource } from './source';

const Logger = CreateLogger('AuditLog');

const sqlite3 = require('sqlite3');

const DATABASE_FILE_NAME = 'AuditLog.sqlite';
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

// The subset of the callback-style sqlite3 connection used here.
interface SqliteConnection {
  exec(sql: string, cb: (err: Error | null) => void): void;
  run(
    sql: string,
    params: unknown,
    cb: (this: { lastID: number; changes: number }, err: Error | null) => void
  ): void;
  all(sql: string, params: unknown, cb: (err: Error | null, rows: unknown[]) => void): void;
  close(cb: (err: Error | null) => void): void;
}

interface AuditRow {
  ID: number;
  Timestamp: number;
  EntityType: string;
  EntityID: string | null;
  EntityName: string | null;
  Category: string;
  Severity: string;
  Summary: string;
  Changes: string | null;
  Details: string | null;
  Source: string | null;
}

// What a caller hands Record(). Only the type, category and summary are needed.
export interface AuditRecordInput {
  EntityType: AuditEntityType;
  EntityID?: string | number | null;
  EntityName?: string | null;
  Category: AuditCategory;
  Severity?: AuditSeverity;
  Summary: AuditSegment[];
  Changes?: AuditChange[];
  Details?: string[];
  // Omitted: an edit or action takes the surface of the request it runs in;
  // a status change has none.
  Source?: string | null;
  Timestamp?: number;
}

type PendingEntry = Omit<AuditLogEntry, 'ID'>;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS AuditLog (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Timestamp INTEGER NOT NULL,
    EntityType TEXT NOT NULL,
    EntityID TEXT,
    EntityName TEXT,
    Category TEXT NOT NULL,
    Severity TEXT NOT NULL,
    Summary TEXT NOT NULL,
    Changes TEXT,
    Details TEXT,
    Source TEXT,
    SearchText TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS AuditLogByEntity ON AuditLog (EntityType, EntityID, ID);
  CREATE INDEX IF NOT EXISTS AuditLogByTimestamp ON AuditLog (Timestamp);
`;

let Started = false;
let StoragePath: string | null = null;
let Connection: SqliteConnection | null = null;
let Opening: Promise<SqliteConnection | null> | null = null;
let Queue: PendingEntry[] = [];
let FlushTimer: ReturnType<typeof setTimeout> | null = null;
let SweepTimer: ReturnType<typeof setInterval> | null = null;
// Every statement runs on one chain, so a flush, a purge and a read never
// interleave on the connection (a read always sees every entry queued before it).
let Chain: Promise<unknown> = Promise.resolve();

function Serial<T>(Fn: () => Promise<T>): Promise<T> {
  const Next = Chain.then(Fn, Fn);
  Chain = Next.catch(() => undefined);
  return Next;
}

function Open(): Promise<SqliteConnection | null> {
  if (Connection) return Promise.resolve(Connection);
  if (Opening) return Opening;
  const FilePath =
    StoragePath || path.join(AppDataManager.GetStorageDirectory(), DATABASE_FILE_NAME);
  Opening = new Promise<SqliteConnection | null>((resolve) => {
    try {
      fs.mkdirSync(path.dirname(FilePath), { recursive: true });
    } catch (Err) {
      Logger.error('Failed to create the audit log directory:', Err);
    }
    const Db: SqliteConnection = new sqlite3.Database(FilePath, (OpenErr: Error | null) => {
      if (OpenErr) {
        Logger.error('Failed to open the audit log database:', OpenErr);
        return resolve(null);
      }
      Db.exec(SCHEMA, (SchemaErr) => {
        if (SchemaErr) {
          Logger.error('Failed to prepare the audit log database:', SchemaErr);
          Db.close(() => resolve(null));
          return;
        }
        Connection = Db;
        resolve(Db);
      });
    });
  }).finally(() => {
    Opening = null;
  });
  return Opening;
}

function Run(Db: SqliteConnection, Sql: string, Params: unknown[] = []) {
  return new Promise<{ lastID: number; changes: number }>((resolve, reject) => {
    Db.run(Sql, Params, function (Err) {
      if (Err) return reject(Err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function All<T>(Db: SqliteConnection, Sql: string, Params: unknown[] = []) {
  return new Promise<T[]>((resolve, reject) => {
    Db.all(Sql, Params, (Err, Rows) => (Err ? reject(Err) : resolve(Rows as T[])));
  });
}

function Normalize(Input: AuditRecordInput): PendingEntry | null {
  if (!Input || !Array.isArray(Input.Summary) || !Input.Summary.length) return null;
  const ID = Input.EntityID;
  return {
    Timestamp: Number.isFinite(Input.Timestamp) ? Number(Input.Timestamp) : Date.now(),
    EntityType: Input.EntityType,
    EntityID: ID === null || ID === undefined || ID === '' ? null : String(ID),
    EntityName: Input.EntityName ? String(Input.EntityName) : null,
    Category: Input.Category,
    Severity: Input.Severity || 'info',
    Summary: Input.Summary,
    Changes: Array.isArray(Input.Changes) ? Input.Changes : [],
    Details: Array.isArray(Input.Details) ? Input.Details.filter(Boolean).map(String) : [],
    Source:
      Input.Source !== undefined
        ? Input.Source
        : Input.Category === 'status'
          ? null
          : CurrentAuditSource(),
  };
}

function SearchTextOf(Entry: PendingEntry): string {
  return [
    Entry.EntityName || '',
    PlainText(Entry.Summary),
    ...Entry.Details,
    ...Entry.Changes.map((Change) => `${Change.Field} ${Change.From ?? ''} ${Change.To ?? ''}`),
    Entry.Source || '',
  ]
    .join('\n')
    .toLowerCase();
}

function ParseJSON<T>(Raw: string | null, Fallback: T): T {
  if (!Raw) return Fallback;
  try {
    return JSON.parse(Raw) as T;
  } catch {
    return Fallback;
  }
}

function FromRow(Row: AuditRow): AuditLogEntry {
  return {
    ID: Number(Row.ID),
    Timestamp: Number(Row.Timestamp),
    EntityType: Row.EntityType as AuditEntityType,
    EntityID: Row.EntityID,
    EntityName: Row.EntityName,
    Category: Row.Category as AuditCategory,
    Severity: Row.Severity as AuditSeverity,
    Summary: ParseJSON<AuditSegment[]>(Row.Summary, []),
    Changes: ParseJSON<AuditChange[]>(Row.Changes, []),
    Details: ParseJSON<string[]>(Row.Details, []),
    Source: Row.Source,
  };
}

function ScheduleFlush(): void {
  if (FlushTimer) return;
  FlushTimer = setTimeout(() => {
    FlushTimer = null;
    void Manager.Flush();
  }, AUDIT_LOG_FLUSH_INTERVAL_MS);
  if (typeof FlushTimer.unref === 'function') FlushTimer.unref();
}

async function WriteBatch(Batch: PendingEntry[]): Promise<AuditLogEntry[]> {
  const Db = await Open();
  if (!Db) return [];
  const Written: AuditLogEntry[] = [];
  try {
    await Run(Db, 'BEGIN IMMEDIATE TRANSACTION');
    for (const Entry of Batch) {
      const { lastID } = await Run(
        Db,
        `INSERT INTO AuditLog
          (Timestamp, EntityType, EntityID, EntityName, Category, Severity, Summary, Changes, Details, Source, SearchText)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Entry.Timestamp,
          Entry.EntityType,
          Entry.EntityID,
          Entry.EntityName,
          Entry.Category,
          Entry.Severity,
          JSON.stringify(Entry.Summary),
          Entry.Changes.length ? JSON.stringify(Entry.Changes) : null,
          Entry.Details.length ? JSON.stringify(Entry.Details) : null,
          Entry.Source,
          SearchTextOf(Entry),
        ]
      );
      Written.push({ ID: lastID, ...Entry });
    }
    await Run(Db, 'COMMIT');
    return Written;
  } catch (Err) {
    Logger.error(`Failed to write ${Batch.length} audit log entr(ies):`, Err);
    await Run(Db, 'ROLLBACK').catch(() => undefined);
    return [];
  }
}

export const Manager = {
  // Begin recording. `FilePath` is for tests; the app uses app data.
  async Start(Options: { FilePath?: string } = {}): Promise<void> {
    if (Started) return;
    Started = true;
    if (Options.FilePath) StoragePath = Options.FilePath;
    await Manager.Purge();
    SweepTimer = setInterval(() => void Manager.Purge(), AUDIT_LOG_SWEEP_INTERVAL_MS);
    if (typeof SweepTimer.unref === 'function') SweepTimer.unref();
  },

  IsStarted(): boolean {
    return Started;
  },

  // Queue one entry. Never throws and never waits: recording must not be able
  // to slow down or break whatever it is recording.
  Record(Input: AuditRecordInput): void {
    if (!Started) return;
    try {
      const Entry = Normalize(Input);
      if (!Entry) return;
      Queue.push(Entry);
      ScheduleFlush();
    } catch (Err) {
      Logger.error('Failed to queue an audit log entry:', Err);
    }
  },

  // Write everything queued so far and announce it.
  Flush(): Promise<void> {
    return Serial(async () => {
      if (!Queue.length) return;
      const Batch = Queue;
      Queue = [];
      const Written = await WriteBatch(Batch);
      if (Written.length) BroadcastManager.emit('AuditLogAppended', Written);
    });
  },

  async Query(Input: AuditLogQuery = {}): Promise<AuditLogPage> {
    if (!Started) return { Entries: [], HasMore: false };
    await Manager.Flush();
    return Serial(async () => {
      const Db = await Open();
      if (!Db) return { Entries: [], HasMore: false };
      const Q = Input || {};
      const Where: string[] = ['Timestamp >= ?'];
      const Params: unknown[] = [Date.now() - AUDIT_LOG_RETENTION_MS];
      if (Q.EntityType) {
        Where.push('EntityType = ?');
        Params.push(Q.EntityType);
      }
      if (Q.EntityID !== undefined && Q.EntityID !== null && Q.EntityID !== '') {
        Where.push('EntityID = ?');
        Params.push(String(Q.EntityID));
      }
      if (Q.Category) {
        Where.push('Category = ?');
        Params.push(Q.Category);
      }
      const Search = typeof Q.Search === 'string' ? Q.Search.trim().toLowerCase() : '';
      if (Search) {
        Where.push("SearchText LIKE ? ESCAPE '\\'");
        Params.push(`%${Search.replace(/[\\%_]/g, (Char) => `\\${Char}`)}%`);
      }
      if (Number.isFinite(Number(Q.BeforeID)) && Q.BeforeID !== null && Q.BeforeID !== undefined) {
        Where.push('ID < ?');
        Params.push(Number(Q.BeforeID));
      }
      const Requested = Math.floor(Number(Q.Limit));
      const Limit = Number.isFinite(Requested)
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, Requested))
        : DEFAULT_PAGE_SIZE;
      try {
        const Rows = await All<AuditRow>(
          Db,
          `SELECT ID, Timestamp, EntityType, EntityID, EntityName, Category, Severity, Summary, Changes, Details, Source
            FROM AuditLog WHERE ${Where.join(' AND ')} ORDER BY ID DESC LIMIT ?`,
          [...Params, Limit + 1]
        );
        return {
          Entries: Rows.slice(0, Limit).map(FromRow),
          HasMore: Rows.length > Limit,
        };
      } catch (Err) {
        Logger.error('Failed to read the audit log:', Err);
        return { Entries: [], HasMore: false };
      }
    });
  },

  // Drop entries older than the retention window, then trim to the hard cap.
  // Returns how many were removed.
  Purge(Now: number = Date.now()): Promise<number> {
    return Serial(async () => {
      const Db = await Open();
      if (!Db) return 0;
      try {
        const Expired = await Run(Db, 'DELETE FROM AuditLog WHERE Timestamp < ?', [
          Now - AUDIT_LOG_RETENTION_MS,
        ]);
        const Overflow = await Run(
          Db,
          'DELETE FROM AuditLog WHERE ID <= (SELECT ID FROM AuditLog ORDER BY ID DESC LIMIT 1 OFFSET ?)',
          [AUDIT_LOG_MAX_ENTRIES]
        );
        const Removed = Expired.changes + Overflow.changes;
        if (Removed > 0) Logger.debug(`Purged ${Removed} audit log entr(ies)`);
        return Removed;
      } catch (Err) {
        Logger.error('Failed to purge the audit log:', Err);
        return 0;
      }
    });
  },

  // Write what is queued and close. Recording stops here.
  async Shutdown(): Promise<void> {
    if (!Started) return;
    if (FlushTimer) clearTimeout(FlushTimer);
    FlushTimer = null;
    if (SweepTimer) clearInterval(SweepTimer);
    SweepTimer = null;
    await Manager.Flush();
    Started = false;
    await Serial(async () => {
      const Db = Connection;
      Connection = null;
      if (!Db) return;
      await new Promise<void>((resolve) => Db.close(() => resolve()));
    });
  },
};
