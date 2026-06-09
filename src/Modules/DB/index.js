const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('DB');

const { Manager: AppDataManager } = require('../AppData');

const sqlite3 = require('sqlite3').verbose();
// Note: On macOS/ARM64, ensure prebuilt sqlite3 is available or rebuild during packaging.
const path = require('path');
const fs = require('fs');

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
let DB = null;
let schemaInitialized = false;
let schemaInitializationPromise = null;
let readyPromise = null;
let hasUnsavedChanges = false;
let suppressDirtyTracking = false;
let isShuttingDown = false;
let shutdownPromise = null;
let pendingOperations = 0;
let pendingDrainResolvers = [];

const Manager = {};

function ResolvePendingDrainWaiters() {
  if (pendingOperations !== 0) return;
  const Waiters = pendingDrainResolvers;
  pendingDrainResolvers = [];
  for (const Resolve of Waiters) {
    try {
      Resolve();
    } catch {}
  }
}

function BeginOperation() {
  if (isShuttingDown || !DB) return false;
  pendingOperations += 1;
  return true;
}

function EndOperation() {
  pendingOperations = Math.max(0, pendingOperations - 1);
  ResolvePendingDrainWaiters();
}

function WaitForPendingOperations(TimeoutMs = 15000) {
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

function CloseLiveConnection() {
  if (!DB) return Promise.resolve();
  const Connection = DB;
  DB = null;
  return new Promise((resolve, reject) => {
    Connection.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function ShouldMarkAsUnsaved(Query) {
  return /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(String(Query || '').trim());
}

// Create tables idempotently using schema.js definitions
Manager.InitializeSchema = async () => {
  if (schemaInitialized) return;
  if (schemaInitializationPromise) return schemaInitializationPromise;

  schemaInitializationPromise = (async () => {
    let Tables = require('./schema.js');
    for (let Table of Tables) {
      Logger.database(`Creating table: ${Table.Name}`);
      let [Err, _Result] = await Manager.Run(Table.SQL);
      if (Err) {
        Logger.databaseError(`Failed to create table ${Table.Name}:`, Err);
      } else {
        Logger.database(`Table ${Table.Name} created successfully.`);
      }
    }
    // Apply additive migrations. SQLite lacks "ADD COLUMN IF NOT EXISTS",
    // so duplicate-column errors are expected on already-migrated installs.
    const Migrations = Array.isArray(Tables.Migrations) ? Tables.Migrations : [];
    for (const SQL of Migrations) {
      const Match =
        /ALTER\s+TABLE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
          SQL
        );
      if (Match) {
        const [, Table, Column] = Match;
        const [PErr, Cols] = await Manager.All(`PRAGMA table_info(\`${Table}\`)`);
        if (PErr) {
          Logger.databaseError(`Migration probe failed for ${Table}`, PErr);
          continue;
        }
        if ((Cols || []).some((c) => c && c.name === Column)) continue;
      }
      const [Err] = await Manager.Run(SQL);
      if (Err) Logger.databaseError(`Migration failed: ${SQL}`, Err);
    }
    // Tag the database header so saved .ShowTrak files are positively
    // identifiable as ShowTrak documents (used when validating Open targets).
    const [TagErr] = await Manager.Run(`PRAGMA application_id = ${SHOWTRAK_APPLICATION_ID}`);
    if (TagErr) Logger.databaseError('Failed to set application_id', TagErr);
    schemaInitialized = true;
  })();

  return schemaInitializationPromise;
};

// Open (or reopen) the SQLite connection and ensure the schema exists before
// the returned promise resolves. Resets the schema-init state so migrations are
// re-applied against whatever file is now on disk (e.g. a just-opened .ShowTrak).
function OpenConnection() {
  isShuttingDown = false;
  shutdownPromise = null;
  schemaInitialized = false;
  schemaInitializationPromise = null;
  hasUnsavedChanges = false;
  readyPromise = new Promise((resolve, reject) => {
    DB = new sqlite3.Database(dbPath, async (err) => {
      if (err) {
        Logger.error('Failed to connect to database:', err);
        return reject(err);
      }
      Logger.success('Connected to SQLite database.');
      try {
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

Manager.Ready = async () => {
  await readyPromise;
};

// Wrapper returning [err, row] for single-row queries
Manager.Get = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    if (!BeginOperation()) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.get(Query, Params, (err, row) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        EndOperation();
        return resolve([err, null]);
      }
      EndOperation();
      resolve([null, row]);
    });
  });
};

// Wrapper returning [err, rows] for multi-row queries
Manager.All = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    if (!BeginOperation()) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.all(Query, Params, (err, rows) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        EndOperation();
        return resolve([err, null]);
      }
      EndOperation();
      resolve([null, rows]);
    });
  });
};

// Wrapper returning [err, stmt] for INSERT/UPDATE/DELETE/DDL
Manager.Run = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    if (!BeginOperation()) {
      return resolve([new Error('Database is closing'), null]);
    }
    DB.run(Query, Params, function (err) {
      if (err) {
        Logger.databaseError('Error running query:', err);
        EndOperation();
        return resolve([err, null]);
      }
      if (!suppressDirtyTracking && ShouldMarkAsUnsaved(Query)) {
        hasUnsavedChanges = true;
      }
      EndOperation();
      resolve([null, this]);
    });
  });
};

Manager.Shutdown = async (Options = {}) => {
  const TimeoutMs = Number(Options.TimeoutMs) || 15000;
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

Manager.RunWithoutDirtyTracking = async (Query, Params) => {
  const previousSuppressDirtyTracking = suppressDirtyTracking;
  suppressDirtyTracking = true;
  try {
    return await Manager.Run(Query, Params);
  } finally {
    suppressDirtyTracking = previousSuppressDirtyTracking;
  }
};

Manager.HasUnsavedChanges = async () => hasUnsavedChanges;

Manager.MarkClean = () => {
  hasUnsavedChanges = false;
};

// Write a consistent, compacted snapshot of the entire database to TargetPath.
// Used by "Save As" to produce a portable .ShowTrak file. VACUUM INTO requires
// the destination to not already exist.
Manager.SnapshotTo = async (TargetPath) => {
  try {
    suppressDirtyTracking = true;
    const Dir = path.dirname(TargetPath);
    if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
    if (fs.existsSync(TargetPath)) fs.unlinkSync(TargetPath);
    // VACUUM INTO does not accept bound parameters on all SQLite builds, so the
    // path is inlined as a quoted string literal with single quotes escaped.
    const Escaped = String(TargetPath).replace(/'/g, "''");
    const [Err] = await Manager.Run(`VACUUM INTO '${Escaped}'`);
    if (Err) return [Err, null];
    return [null, TargetPath];
  } catch (err) {
    Logger.databaseError('Failed to snapshot database:', err);
    return [err, null];
  } finally {
    suppressDirtyTracking = false;
  }
};

// Validate that SourcePath is a ShowTrak SQLite database before we trust it.
// Opens read-only so a malformed or unrelated file can never corrupt the live
// working database. Accepts the file if the header application_id matches or, as
// a fallback, all of the core tables are present.
function ValidateDatabaseFile(SourcePath) {
  return new Promise((resolve) => {
    const Probe = new sqlite3.Database(SourcePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        return resolve([new Error('Selected file is not a valid ShowTrak file'), null]);
      }
      Probe.get('PRAGMA application_id', (idErr, idRow) => {
        const ApplicationId =
          idRow && typeof idRow.application_id === 'number' ? idRow.application_id : null;
        if (!idErr && ApplicationId === SHOWTRAK_APPLICATION_ID) {
          Probe.close(() => {});
          return resolve([null, true]);
        }
        Probe.all("SELECT name FROM sqlite_master WHERE type = 'table'", (qErr, rows) => {
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
        });
      });
    });
  });
}

// Replace the live working database with SourcePath: validate it, close the
// current connection, swap the file (clearing any stale sidecar journals), then
// reconnect and re-run schema migrations. Used by "Open".
Manager.ReplaceWithFile = async (SourcePath) => {
  const [ValidationErr] = await ValidateDatabaseFile(SourcePath);
  if (ValidationErr) return [ValidationErr, null];

  try {
    await new Promise((resolve, reject) => {
      DB.close((err) => (err ? reject(err) : resolve()));
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
Manager.ResetToEmpty = async () => {
  try {
    await new Promise((resolve, reject) => {
      DB.close((err) => (err ? reject(err) : resolve()));
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
Manager.HasData = async () => {
  const Tables = [
    'Groups',
    'Clients',
    'MonitoringTargets',
    'AlertRules',
    'AlertHistory',
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

module.exports = {
  Manager,
};
