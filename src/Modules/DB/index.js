const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('DB');

const { Manager: AppDataManager } = require('../AppData');

const sqlite3 = require('sqlite3').verbose();
// Note: On macOS/ARM64, ensure prebuilt sqlite3 is available or rebuild during packaging.
const path = require('path');

const DatabasePath = AppDataManager.GetStorageDirectory();
const DatabaseFileName = 'DB.sqlite';

const dbPath = path.join(DatabasePath, DatabaseFileName);
let schemaInitialized = false;
let schemaInitializationPromise = null;

const readyState = {
  resolve: null,
  reject: null,
};

const readyPromise = new Promise((resolve, reject) => {
  readyState.resolve = resolve;
  readyState.reject = reject;
});

// Open DB and ensure schema exists before first use
const DB = new sqlite3.Database(dbPath, async (err) => {
  if (err) {
    Logger.error('Failed to connect to database:', err);
    if (readyState.reject) readyState.reject(err);
    return;
  }
  Logger.success('Connected to SQLite database.');
  try {
    await Manager.InitializeSchema();
    if (readyState.resolve) readyState.resolve();
  } catch (schemaError) {
    Logger.databaseError('Schema initialization failed:', schemaError);
    if (readyState.reject) readyState.reject(schemaError);
  }
});

const Manager = {};

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
  schemaInitialized = true;
  })();

  return schemaInitializationPromise;
};

Manager.Ready = async () => {
  await readyPromise;
};

// Wrapper returning [err, row] for single-row queries
Manager.Get = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    DB.get(Query, Params, (err, row) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        return resolve([err, null]);
      }
      resolve([null, row]);
    });
  });
};

// Wrapper returning [err, rows] for multi-row queries
Manager.All = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    DB.all(Query, Params, (err, rows) => {
      if (err) {
        Logger.databaseError('Error fetching data:', err);
        return resolve([err, null]);
      }
      resolve([null, rows]);
    });
  });
};

// Wrapper returning [err, stmt] for INSERT/UPDATE/DELETE/DDL
Manager.Run = async (Query, Params) => {
  return new Promise((resolve, _reject) => {
    DB.run(Query, Params, function (err) {
      if (err) {
        Logger.databaseError('Error running query:', err);
        return resolve([err, null]);
      }
      resolve([null, this]);
    });
  });
};

module.exports = {
  Manager,
};
