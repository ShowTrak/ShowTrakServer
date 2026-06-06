const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('BackupManager');

const path = require('path');
const fs = require('fs');

const { Manager: DB } = require('../DB');

const { Manager: AppDataManager } = require('../AppData');

const { Manager: Broadcast } = require('../Broadcast');

const Manager = {};

// Path of the .ShowTrak file currently in use. Persisted to disk (outside the
// swappable show database) so the same file is shown as "open" after a relaunch.
// Loaded once on startup from the app-level state file.
let CurrentFilePath = LoadPersistedFilePath();

Manager.GetCurrentFilePath = () => CurrentFilePath;

// Boot-time integrity check: if a show file was open last session but has since
// been deleted or moved, the working database no longer corresponds to a real
// file. Wipe the working data and clear the pointer so the user is prompted to
// open an existing file or create a new one (instead of silently editing data
// that can no longer be saved back to its origin). Returns { Missing } where
// Missing indicates the previously open file was gone.
Manager.EnsureCurrentFileExists = async () => {
  if (!CurrentFilePath) return [null, { Missing: false }];
  if (fs.existsSync(CurrentFilePath)) return [null, { Missing: false }];

  Logger.warn('Previously open show file is missing, wiping working data:', CurrentFilePath);
  const [Err] = await DB.ResetToEmpty();
  if (Err) {
    Logger.error('Failed to wipe working data after missing show file:', Err);
    return [String(Err && Err.message ? Err.message : Err), null];
  }
  PersistFilePath(null);
  Broadcast.emit('ReinitializeSystem');
  return [null, { Missing: true }];
};

// True when the working database holds data but no show file is associated with
// it (e.g. upgrading from a pre-show-file version). The renderer uses this to
// force a "Save As" before continuing so the legacy data is not lost.
Manager.HasUnsavedWorkingData = async () => {
  if (CurrentFilePath) return false;
  return await DB.HasData();
};

function LoadPersistedFilePath() {
  try {
    const StatePath = AppDataManager.GetStateFilePath();
    if (!fs.existsSync(StatePath)) return null;
    const State = JSON.parse(fs.readFileSync(StatePath, 'utf8'));
    return State && typeof State.CurrentFilePath === 'string' ? State.CurrentFilePath : null;
  } catch (err) {
    Logger.error('Failed to read persisted show file path:', err);
    return null;
  }
}

function PersistFilePath(Value) {
  CurrentFilePath = Value || null;
  try {
    const StatePath = AppDataManager.GetStateFilePath();
    const Dir = path.dirname(StatePath);
    if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
    fs.writeFileSync(StatePath, JSON.stringify({ CurrentFilePath }, null, 2), 'utf8');
  } catch (err) {
    Logger.error('Failed to persist show file path:', err);
  }
}

// "Save As" — write the entire working database out to a portable .ShowTrak
// file. The whole database is dumped as a single snapshot, so there is no
// per-table maintenance and runtime performance is unaffected (the cost is
// taken only when saving).
Manager.Save = async (Path) => {
  Logger.log('Saving ShowTrak file to:', Path);
  const [Err] = await DB.SnapshotTo(Path);
  if (Err) {
    Logger.error('Failed to save ShowTrak file:', Err);
    return [String(Err && Err.message ? Err.message : Err), null];
  }
  PersistFilePath(Path);
  return [null, 'Saved successfully'];
};

// "Open" — replace the working database with the selected .ShowTrak file. The
// DB layer validates the file, swaps it in, and re-applies schema migrations.
// A full re-hydration of in-memory caches/UI is then triggered.
Manager.Open = async (Path) => {
  Logger.log('Opening ShowTrak file from:', Path);
  if (!fs.existsSync(Path)) {
    Logger.error('ShowTrak file does not exist:', Path);
    return ['ShowTrak file does not exist', null];
  }
  const [Err] = await DB.ReplaceWithFile(Path);
  if (Err) {
    Logger.error('Failed to open ShowTrak file:', Err);
    return [String(Err && Err.message ? Err.message : Err), null];
  }
  PersistFilePath(Path);
  Broadcast.emit('ReinitializeSystem');
  return [null, 'Opened successfully'];
};

// "New" — reset the working database to an empty show and clear the current
// file pointer (the new show is untitled until saved).
Manager.New = async () => {
  Logger.log('Creating new ShowTrak show');
  const [Err] = await DB.ResetToEmpty();
  if (Err) {
    Logger.error('Failed to create new show:', Err);
    return [String(Err && Err.message ? Err.message : Err), null];
  }
  PersistFilePath(null);
  Broadcast.emit('ReinitializeSystem');
  return [null, 'New show created'];
};

module.exports = {
  Manager,
};
