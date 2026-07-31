import path from 'path';
import fs from 'fs';

import { CreateLogger } from '../Logger';
import { DB_PENDING_OPERATION_TIMEOUT_MS } from '../Config/constants';
import { Manager as AppDataManager } from '../AppData';

const Logger = CreateLogger('DB');

// Verbose mode adds long stack traces to every query at a measurable cost;
// opt in via env when debugging instead of paying for it in production.
const sqlite3 =
  process.env.SHOWTRAK_SQLITE_VERBOSE === '1' ? require('sqlite3').verbose() : require('sqlite3');
// Note: On macOS/ARM64, ensure prebuilt sqlite3 is available or rebuild during packaging.

// Minimal shape of the callback-style sqlite3 connection we use. sqlite3 ships
// no bundled types; this covers exactly the surface this module touches.
interface SqliteConnection {
  get(sql: string, params: unknown, cb: (err: Error | null, row: unknown) => void): void;
  all(sql: string, params: unknown, cb: (err: Error | null, rows: unknown[]) => void): void;
  run(sql: string, params: unknown, cb: (this: RunResult, err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
}

// The `this` context sqlite3 binds inside a `run` callback: the row id of the
// last inserted row and the number of rows affected by the statement.
interface RunResult {
  lastID: number;
  changes: number;
}

// Row shape assumed for queries that don't pass an explicit type argument.
// Typed callers (the repositories in ./repositories/*) always supply their own
// row type. This permissive string-map default only backs the handful of
// remaining untyped call sites; `unknown` would be more precise but would force
// changes in call sites owned by other in-flight refactors, so the loose but
// non-`any` default is retained until those callers adopt explicit row types.
type DefaultRow = Record<string, string>;

const DatabasePath = AppDataManager.GetStorageDirectory();
const DatabaseFileName = 'DB.sqlite';

const dbPath = path.join(DatabasePath, DatabaseFileName);

// SQLite header "application_id" magic number used to tag ShowTrak database
// files (.ShowTrak). Spells "SHOT" (ShowTrak) so a file can be positively
// identified as ours before it is swapped in. See sqlite.org/fileformat2.html
const SHOWTRAK_APPLICATION_ID = 0x53484f54;

// The live connection is mutable so a .ShowTrak file can be swapped in at
// runtime (Open) by closing the connection, replacing the file on disk, and
// reconnecting. Consumers always read `DB` at call time via the wrappers below.
let DB: SqliteConnection | null = null;
let schemaInitialized = false;
let schemaInitializationPromise: Promise<void> | null = null;
let readyPromise: Promise<void> | null = null;
let hasUnsavedChanges = false;
let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let pendingOperations = 0;
let pendingDrainResolvers: Array<() => void> = [];

type DBResult<T> = [unknown, T | null];

// A statement runner scoped to an open transaction, handed to WithTransaction's
// callback. Repositories accept it as an optional trailing arg so their writes
// can enlist in a caller-owned transaction instead of autocommitting each one.
type TxRun = (Query: string, Params?: unknown) => Promise<DBResult<RunResult>>;

interface RunOptions {
  // Pass false for writes that must not flip the "unsaved changes" flag
  // (schema bookkeeping, telemetry-driven cache refreshes, snapshot plumbing).
  markDirty?: boolean;
}

// The typed public surface of the DB module. Methods are assigned below in
// definition order; the assertion is safe because every member is populated at
// module scope before the module exports.
interface DBManager {
  InitializeSchema(): Promise<void>;
  Ready(): Promise<void>;
  Get<T = DefaultRow>(Query: string, Params?: unknown): Promise<DBResult<T>>;
  All<T = DefaultRow>(Query: string, Params?: unknown): Promise<DBResult<T[]>>;
  Run(Query: string, Params?: unknown, options?: RunOptions): Promise<DBResult<RunResult>>;
  WithTransaction<T>(fn: (run: TxRun) => Promise<T>, options?: RunOptions): Promise<DBResult<T>>;
  Shutdown(Options?: { TimeoutMs?: number }): Promise<void>;
  RunWithoutDirtyTracking(Query: string, Params?: unknown): Promise<DBResult<RunResult>>;
  HasUnsavedChanges(): Promise<boolean>;
  MarkClean(): void;
  SnapshotTo(TargetPath: string): Promise<DBResult<string>>;
  ReplaceWithFile(SourcePath: string): Promise<DBResult<string>>;
  ResetToEmpty(): Promise<DBResult<string>>;
  HasData(): Promise<boolean>;
}

const Manager = {} as DBManager;

// Consumed by the repository factories in ./repositories/* (they receive the
// DB manager as an argument rather than importing it, so test DB mocks
// injected into managers propagate through them unchanged).
export type { DBManager, DBResult, RunOptions, TxRun };

function ResolvePendingDrainWaiters(): void {
  if (pendingOperations !== 0) return;
  const Waiters = pendingDrainResolvers;
  pendingDrainResolvers = [];
  for (const Resolve of Waiters) {
    try {
      Resolve();
    } catch {
      /* intentional: one drain waiter's callback must not block resolving the rest */
    }
  }
}

function BeginOperation(): boolean {
  if (isShuttingDown || !DB) return false;
  pendingOperations += 1;
  return true;
}

function EndOperation(): void {
  pendingOperations = Math.max(0, pendingOperations - 1);
  ResolvePendingDrainWaiters();
}

function WaitForPendingOperations(TimeoutMs = DB_PENDING_OPERATION_TIMEOUT_MS): Promise<void> {
  if (pendingOperations === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      Logger.warn(
        `Timed out waiting for ${pendingOperations} SQLite operation(s) to finish during shutdown`
      );
      done();
    }, TimeoutMs);
    pendingDrainResolvers.push(done);
  });
}

function CloseLiveConnection(): Promise<void> {
  if (!DB) return Promise.resolve();
  const Connection = DB;
  DB = null;
  return new Promise((resolve, reject) => {
    Connection.close((err: Error | null) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function ShouldMarkAsUnsaved(Query: unknown): boolean {
  return /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(Query || '').trim());
}

// Create tables idempotently using schema.js definitions
Manager.InitializeSchema = async (): Promise<void> => {
  if (schemaInitialized) return;
  if (schemaInitializationPromise) return schemaInitializationPromise;

  schemaInitializationPromise = (async () => {
    const Tables = require('./schema') as typeof import('./schema');
    for (const Table of Tables) {
      Logger.database(`Creating table: ${Table.Name}`);
      const [Err] = await Manager.Run(Table.SQL);
      if (Err) {
        Logger.databaseError(`Failed to create table ${Table.Name}:`, Err);
      } else {
        Logger.database(`Table ${Table.Name} created successfully.`);
      }
    }
    // Versioned migrations. Applied versions are recorded in SchemaMigrations;
    // only versions above the recorded maximum run. Installs that predate the
    // version table back-fill naturally: the PRAGMA probe skips ALTERs whose
    // column already exists, and the version is recorded either way.
    const [MigTableErr] = await Manager.Run(
      'CREATE TABLE IF NOT EXISTS `SchemaMigrations` ( \
            Version INTEGER PRIMARY KEY, \
            AppliedAt BIGINT(11) NOT NULL \
      )'
    );
    if (MigTableErr) {
      Logger.databaseError('Failed to create SchemaMigrations table:', MigTableErr);
    }
    const [VersionErr, VersionRow] = await Manager.Get<{ MaxVersion: number | null }>(
      'SELECT MAX(Version) AS MaxVersion FROM SchemaMigrations'
    );
    const AppliedVersion =
      !VersionErr && VersionRow && VersionRow.MaxVersion ? VersionRow.MaxVersion : 0;

    const Migrations = Array.isArray(Tables.Migrations) ? Tables.Migrations : [];
    for (const Migration of Migrations) {
      if (Migration.Version <= AppliedVersion) continue;
      const SQL = Migration.SQL;
      const Match =
        /ALTER\s+TABLE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
          SQL
        );
      let alreadyApplied = false;
      if (Match) {
        const [, Table, Column] = Match;
        const [PErr, Cols] = await Manager.All<{ name: string }>(`PRAGMA table_info(\`${Table}\`)`);
        if (PErr) {
          Logger.databaseError(`Migration probe failed for ${Table}`, PErr);
          continue;
        }
        alreadyApplied = (Cols || []).some((c) => c && c.name === Column);
      }
      if (!alreadyApplied) {
        // markDirty: false — a migration is schema maintenance, never a user
        // edit, so applying one must not leave a freshly opened workspace
        // looking unsaved. Matters for data-carrying migrations (back-fills);
        // pure ALTER/CREATE INDEX statements never marked the DB dirty anyway.
        const [Err] = await Manager.Run(SQL, [], { markDirty: false });
        if (Err) {
          Logger.databaseError(`Migration ${Migration.Version} failed: ${SQL}`, Err);
          continue;
        }
        Logger.database(`Applied migration ${Migration.Version}`);
      }
      const [RecordErr] = await Manager.Run(
        'INSERT OR REPLACE INTO SchemaMigrations (Version, AppliedAt) VALUES (?, ?)',
        [Migration.Version, Date.now()],
        { markDirty: false }
      );
      if (RecordErr) {
        Logger.databaseError(`Failed to record migration ${Migration.Version}:`, RecordErr);
      }
    }
    // Tag the database header so saved .ShowTrak files are positively
    // identifiable as ShowTrak documents (used when validating Open targets).
    const [TagErr] = await Manager.Run(`PRAGMA application_id = ${SHOWTRAK_APPLICATION_ID}`);
    if (TagErr) Logger.databaseError('Failed to set application_id', TagErr);
    schemaInitialized = true;
  })();

  return schemaInitializationPromise;
};

// Connection-level tuning applied on every (re)open, before schema init.
// WAL lets readers and a writer proceed concurrently instead of blocking one
// another; synchronous=NORMAL is the safe, durable companion under WAL (a crash
// can lose only the last transaction, never corrupt the DB); busy_timeout makes
// a contended write wait-and-retry rather than fail fast with SQLITE_BUSY. These
// are per-connection PRAGMAs (WAL persists in the file header) and must be set
// on the raw handle, so they intentionally run outside dirty-change tracking.
async function ConfigureConnection(): Promise<void> {
  const Pragmas = ['journal_mode = WAL', 'synchronous = NORMAL', 'busy_timeout = 5000'];
  for (const Pragma of Pragmas) {
    const [Err] = await Manager.Run(`PRAGMA ${Pragma}`, undefined, { markDirty: false });
    if (Err) Logger.databaseError(`Failed to apply PRAGMA ${Pragma}`, Err);
  }
}

// Open (or reopen) the SQLite connection and ensure the schema exists before
// the returned promise resolves. Resets the schema-init state so migrations are
// re-applied against whatever file is now on disk (e.g. a just-opened .ShowTrak).
function OpenConnection(): Promise<void> {
  isShuttingDown = false;
  shutdownPromise = null;
  schemaInitialized = false;
  schemaInitializationPromise = null;
  hasUnsavedChanges = false;
  readyPromise = new Promise((resolve, reject) => {
    DB = new sqlite3.Database(dbPath, async (err: Error | null) => {
      if (err) {
        Logger.error('Failed to connect to database:', err);
        return reject(err);
      }
      Logger.success('Connected to SQLite database.');
      try {
        await ConfigureConnection();
        await Manager.InitializeSchema();
        resolve();
      } catch (schemaError) {
        Logger.databaseError('Schema initialization failed:', schemaError);
        reject(schemaError);
      }
    });
  });
  return readyPromise;
}

Manager.Ready = async (): Promise<void> => {
  await readyPromise;
};

// Wrapper returning [err, row] for single-row queries. Rows default to `any`
// until callers migrate onto the typed repositories (Phase 3b); repositories
// pass an explicit row type from ./rows.
Manager.Get = async <T = DefaultRow>(Query: string, Params?: unknown): Promise<DBResult<T>> => {
  return new Promise((resolve) => {
    if (!BeginOperation() || !DB) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.get(Query, Params, (err, row) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        EndOperation();
        return resolve([err, null]);
      }
      EndOperation();
      resolve([null, row as T]);
    });
  });
};

// Wrapper returning [err, rows] for multi-row queries
Manager.All = async <T = DefaultRow>(Query: string, Params?: unknown): Promise<DBResult<T[]>> => {
  return new Promise((resolve) => {
    if (!BeginOperation() || !DB) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.all(Query, Params, (err, rows) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        EndOperation();
        return resolve([err, null]);
      }
      EndOperation();
      resolve([null, rows as T[]]);
    });
  });
};

// Wrapper returning [err, stmt] for INSERT/UPDATE/DELETE/DDL
Manager.Run = async (
  Query: string,
  Params?: unknown,
  { markDirty = true }: RunOptions = {}
): Promise<DBResult<RunResult>> => {
  return new Promise((resolve) => {
    if (!BeginOperation() || !DB) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.run(Query, Params, function (this: RunResult, err: Error | null) {
      if (err) {
        Logger.databaseError('Error running query:', err);
        EndOperation();
        return resolve([err, null]);
      }
      if (markDirty && ShouldMarkAsUnsaved(Query)) {
        hasUnsavedChanges = true;
      }
      EndOperation();
      resolve([null, this]);
    });
  });
};

// Run a series of statements atomically. `fn` receives a `run` bound to the
// transaction's dirty-tracking options; any throw (or returned [Err, ...]
// surfaced as a throw by the caller) rolls the transaction back.
Manager.WithTransaction = async <T>(
  fn: (run: TxRun) => Promise<T>,
  { markDirty = true }: RunOptions = {}
): Promise<DBResult<T>> => {
  const run: TxRun = (Query, Params) => Manager.Run(Query, Params, { markDirty });
  const [beginErr] = await run('BEGIN IMMEDIATE TRANSACTION');
  if (beginErr) return [beginErr, null];
  try {
    const value = await fn(run);
    const [commitErr] = await run('COMMIT');
    if (commitErr) throw commitErr;
    return [null, value];
  } catch (err) {
    await run('ROLLBACK');
    return [err instanceof Error ? err : new Error(String(err)), null];
  }
};

Manager.Shutdown = async (Options: { TimeoutMs?: number } = {}): Promise<void> => {
  const TimeoutMs = Number(Options.TimeoutMs) || DB_PENDING_OPERATION_TIMEOUT_MS;
  if (shutdownPromise) return shutdownPromise;

  isShuttingDown = true;
  shutdownPromise = (async () => {
    await WaitForPendingOperations(TimeoutMs);
    try {
      await CloseLiveConnection();
      Logger.log('SQLite connection closed cleanly');
    } catch (err) {
      Logger.databaseError('Failed to close SQLite connection during shutdown:', err);
      throw err;
    }
  })();

  return shutdownPromise;
};

Manager.RunWithoutDirtyTracking = async (
  Query: string,
  Params?: unknown
): Promise<DBResult<RunResult>> => {
  return Manager.Run(Query, Params, { markDirty: false });
};

Manager.HasUnsavedChanges = async (): Promise<boolean> => hasUnsavedChanges;

Manager.MarkClean = (): void => {
  hasUnsavedChanges = false;
};

// Write a consistent, compacted snapshot of the entire database to TargetPath.
// Used by "Save As" to produce a portable .ShowTrak file. VACUUM INTO requires
// the destination to not already exist.
Manager.SnapshotTo = async (TargetPath: string): Promise<DBResult<string>> => {
  // VACUUM INTO requires its destination to not already exist, so we cannot
  // point it directly at an existing TargetPath. Rather than unlink() the
  // existing file first — which fails with EPERM under a dev/unpackaged run,
  // where the process lacks the installed app's entitlement to delete a file
  // the OS tags with another provenance — we VACUUM into a fresh temp file in
  // the same directory and rename() it over the target. rename() replaces the
  // file in place using the write grant the save dialog already provided and
  // never needs a separate delete permission on the existing file. Keeping the
  // temp file in the same directory ensures the rename is atomic (same volume).
  let TempPath: string | null = null;
  try {
    const Dir = path.dirname(TargetPath);
    if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
    TempPath = path.join(Dir, `.${path.basename(TargetPath)}.snapshot-${process.pid}.tmp`);
    if (fs.existsSync(TempPath)) fs.unlinkSync(TempPath);
    // VACUUM INTO does not accept bound parameters on all SQLite builds, so the
    // path is inlined as a quoted string literal with single quotes escaped.
    const Escaped = TempPath.replace(/'/g, "''");
    const [Err] = await Manager.Run(`VACUUM INTO '${Escaped}'`);
    if (Err) return [Err, null];
    fs.renameSync(TempPath, TargetPath);
    TempPath = null;
    return [null, TargetPath];
  } catch (err) {
    Logger.databaseError('Failed to snapshot database:', err);
    return [err, null];
  } finally {
    if (TempPath) {
      try {
        if (fs.existsSync(TempPath)) fs.unlinkSync(TempPath);
      } catch (cleanupErr) {
        Logger.databaseError('Failed to remove temp snapshot file:', cleanupErr);
      }
    }
  }
};

// Validate that SourcePath is a ShowTrak SQLite database before we trust it.
// Opens read-only so a malformed or unrelated file can never corrupt the live
// working database. Accepts the file if the header application_id matches or, as
// a fallback, all of the core tables are present.
function ValidateDatabaseFile(SourcePath: string): Promise<DBResult<boolean>> {
  return new Promise((resolve) => {
    const Probe = new sqlite3.Database(SourcePath, sqlite3.OPEN_READONLY, (err: Error | null) => {
      if (err) {
        return resolve([new Error('Selected file is not a valid ShowTrak file'), null]);
      }
      Probe.get(
        'PRAGMA application_id',
        (idErr: Error | null, idRow: { application_id?: number } | undefined) => {
          const ApplicationId =
            idRow && typeof idRow.application_id === 'number' ? idRow.application_id : null;
          if (!idErr && ApplicationId === SHOWTRAK_APPLICATION_ID) {
            Probe.close(() => {});
            return resolve([null, true]);
          }
          Probe.all(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
            (qErr: Error | null, rows: Array<{ name?: string }> | undefined) => {
              Probe.close(() => {});
              if (qErr) {
                return resolve([new Error('Selected file is not a valid ShowTrak file'), null]);
              }
              const Names = new Set((rows || []).map((r) => r && r.name));
              const Required = ['Groups', 'Clients', 'Settings', 'MonitoringTargets'];
              const Missing = Required.filter((name) => !Names.has(name));
              if (Missing.length) {
                return resolve([
                  new Error(
                    `Selected file is not a valid ShowTrak file (missing: ${Missing.join(', ')})`
                  ),
                  null,
                ]);
              }
              resolve([null, true]);
            }
          );
        }
      );
    });
  });
}

// Replace the live working database with SourcePath: validate it, close the
// current connection, swap the file (clearing any stale sidecar journals), then
// reconnect and re-run schema migrations. Used by "Open".
Manager.ReplaceWithFile = async (SourcePath: string): Promise<DBResult<string>> => {
  const [ValidationErr] = await ValidateDatabaseFile(SourcePath);
  if (ValidationErr) return [ValidationErr, null];

  try {
    await new Promise<void>((resolve, reject) => {
      if (!DB) return resolve();
      DB.close((err: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    Logger.databaseError('Failed to close database before swap:', err);
    // Reconnect to the existing file so the app is not left without a DB.
    await OpenConnection().catch(() => {});
    return [err, null];
  }

  try {
    // Remove stale journal/WAL sidecars so the freshly copied file is read cleanly.
    for (const Suffix of ['-journal', '-wal', '-shm']) {
      const Sidecar = `${dbPath}${Suffix}`;
      if (fs.existsSync(Sidecar)) fs.unlinkSync(Sidecar);
    }
    fs.copyFileSync(SourcePath, dbPath);
  } catch (err) {
    Logger.databaseError('Failed to swap database file:', err);
    await OpenConnection().catch(() => {});
    return [err, null];
  }

  try {
    await OpenConnection();
  } catch (err) {
    return [err, null];
  }
  return [null, dbPath];
};

// Reset the working database to an empty state: close the connection, delete the
// database file and any sidecars, then reconnect (which recreates the schema
// fresh). Used by "New".
Manager.ResetToEmpty = async (): Promise<DBResult<string>> => {
  try {
    await new Promise<void>((resolve, reject) => {
      if (!DB) return resolve();
      DB.close((err: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    Logger.databaseError('Failed to close database before reset:', err);
    await OpenConnection().catch(() => {});
    return [err, null];
  }

  try {
    // Remove the database and any stale journal/WAL sidecars so a clean,
    // empty schema is recreated on reconnect.
    for (const Suffix of ['', '-journal', '-wal', '-shm']) {
      const Target = `${dbPath}${Suffix}`;
      if (fs.existsSync(Target)) fs.unlinkSync(Target);
    }
  } catch (err) {
    Logger.databaseError('Failed to delete database file during reset:', err);
    await OpenConnection().catch(() => {});
    return [err, null];
  }

  try {
    await OpenConnection();
  } catch (err) {
    return [err, null];
  }
  return [null, dbPath];
};

// Returns true if any core table holds rows, i.e. the working database contains
// user data. Used to detect data carried over from a previous boot (e.g. when
// upgrading from a pre-show-file version that wrote straight to the DB).
Manager.HasData = async (): Promise<boolean> => {
  const Tables = [
    'Groups',
    'Clients',
    'MonitoringTargets',
    'FreeKioskTerminals',
    'AlertRules',
    'AlertHistory',
    'Workflows',
    'CriticalUSBDevices',
    'CriticalApplications',
    'Settings',
  ];
  for (const Table of Tables) {
    const [Err, Row] = await Manager.Get(`SELECT 1 FROM \`${Table}\` LIMIT 1`);
    if (Err) continue; // Table may not exist on a fresh/partial schema; skip it.
    if (Row) return true;
  }
  return false;
};

// Establish the initial connection on module load.
OpenConnection();

export { Manager };
