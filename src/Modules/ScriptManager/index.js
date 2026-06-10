// ScriptManager
// - Discovers scripts from the scripts directory (one folder per script)
// - Loads Script.json metadata, normalizes it (auto-repairing invalid/missing
//   keys) and calculates checksums for all files
// - Exposes a readonly in-memory catalog plus edit helpers for the Script
//   Manager UI
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

// const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: ChecksumManager } = require('../ChecksumManager');
const { Manager: BroadcastManager } = require('../Broadcast');

const { PLATFORM_KEYS, SCRIPT_COLOURS, NormalizeScriptConfig } = require('./schema');

// Catalog cache; populated on first GetScripts() call
var Scripts = [];

class Script {
  constructor(ID, Config, AllFilesInFolder, CompatiblePlatforms, ValidationErrors) {
    this.ID = ID;
    this.Name = Config.Name;
    this.Description = Config.Description || '';
    // Colour index (integer, 0–7); see SCRIPT_COLOURS in schema.js.
    this.Colour = typeof Config.Colour === 'number' ? Config.Colour : 6;
    this.Weight = Config.Weight || 0;
    this.Confirmation = Config.Confirmation || false;

    // Cross-platform launch map ({ Windows, macOS, Linux }).
    this.Platforms = Config.Platforms || {};
    // Optional per-platform argument string ({ Windows, macOS, Linux }).
    this.Arguments = Config.Arguments || {};
    // Platforms that have a non-empty path pointing at an existing file.
    this.CompatiblePlatforms = CompatiblePlatforms || [];

    this.Files = AllFilesInFolder;

    this.isEnabled = Config.Enabled || false;
    this.isValid = true;
    this.ValidationErrors = ValidationErrors || [];
    // Full normalized config, used by the Script Manager UI.
    this.Config = Config;
  }
}

// Represents a script whose Script.json failed to parse. It is surfaced to the
// Script Manager UI so the author can fix it, but is never runnable.
class InvalidScript {
  constructor(ID, ParseError, RawText) {
    this.ID = ID;
    this.Name = ID;
    this.Description = '';
    this.Colour = 6;
    this.Weight = 0;
    this.Confirmation = false;
    this.Platforms = {};
    this.Arguments = {};
    this.CompatiblePlatforms = [];
    this.Files = [];
    this.isEnabled = false;
    this.isValid = false;
    this.ParseError = ParseError;
    this.RawText = typeof RawText === 'string' ? RawText : '';
    this.ValidationErrors = [];
    this.Config = null;
  }
}

const Manager = {};

// Simple bounded-concurrency runner
async function runWithConcurrency(items, limit, worker) {
  if (!items || items.length === 0) return;
  const size = Math.max(1, Math.min(limit || 8, items.length));
  let index = 0;
  const runners = new Array(size).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// Enumerate files recursively and produce relative paths, adding a checksum later
function RecursiveFileList(dir, baseDir = dir) {
  let results = [];
  var list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results.push({
        Path: path.relative(baseDir, filePath),
        Type: 'directory',
      });
      results = results.concat(RecursiveFileList(filePath, baseDir));
    } else {
      results.push({
        Path: path.relative(baseDir, filePath),
        Type: 'file',
        Checksum: null,
      });
    }
  });
  return results;
}

// Determine which platforms reference an existing file inside the script folder.
function ResolveCompatiblePlatforms(ScriptFolderPath, Platforms) {
  const Compatible = [];
  for (const key of PLATFORM_KEYS) {
    const rel = Platforms[key];
    if (!rel) continue;
    const target = path.join(ScriptFolderPath, rel);
    try {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        Compatible.push(key);
      }
    } catch {
      // Ignore unreadable paths; the platform is simply not compatible.
    }
  }
  return Compatible;
}

// Load (and normalize) a single script folder. Returns a Script/InvalidScript.
async function LoadScriptFolder(ScriptsDirectory, ScriptFolder) {
  const ScriptFolderPath = path.join(ScriptsDirectory, ScriptFolder);
  const scriptJsonPath = path.join(ScriptFolderPath, 'Script.json');

  let RawText;
  try {
    RawText = fs.readFileSync(scriptJsonPath, 'utf-8');
  } catch (err) {
    return new InvalidScript(ScriptFolder, `Unable to read Script.json: ${err.message}`, '');
  }

  let Parsed;
  try {
    Parsed = JSON.parse(RawText);
  } catch (err) {
    Logger.error(`Failed to parse Script.json for ${ScriptFolder}:`, err);
    BroadcastManager.emit(
      'Notify',
      `Invalid JSON in Script.json for ${ScriptFolder}`,
      'error',
      15000
    );
    return new InvalidScript(ScriptFolder, `Invalid JSON: ${err.message}`, RawText);
  }

  const { config, changed, errors } = NormalizeScriptConfig(Parsed, ScriptFolder);

  // Persist auto-repairs so the on-disk file always matches the schema.
  if (changed) {
    try {
      fs.writeFileSync(scriptJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      Logger.log(`Normalized Script.json for ${ScriptFolder}`);
    } catch (err) {
      Logger.error(`Failed to write normalized Script.json for ${ScriptFolder}:`, err);
    }
  }

  const AllFilesInFolder = RecursiveFileList(ScriptFolderPath);
  const filesNeedingChecksum = AllFilesInFolder.filter((f) => f.Type === 'file');
  // Compute checksums with bounded concurrency to avoid blocking startup
  await runWithConcurrency(filesNeedingChecksum, 8, async (File) => {
    const sum = await ChecksumManager.Checksum(path.join(ScriptFolderPath, File.Path));
    File.Checksum = sum || null;
  });

  const CompatiblePlatforms = ResolveCompatiblePlatforms(ScriptFolderPath, config.Platforms);
  return new Script(ScriptFolder, config, AllFilesInFolder, CompatiblePlatforms, errors);
}

function ListScriptFolders(ScriptsDirectory) {
  return fs.readdirSync(ScriptsDirectory).filter((file) => {
    const fullPath = path.join(ScriptsDirectory, file);
    return (
      fs.statSync(fullPath).isDirectory() &&
      file !== 'node_modules' &&
      file !== '.git' &&
      file !== '.vscode'
    );
  });
}

Manager.GetScripts = async (Force = false) => {
  if (!Force && Scripts.length > 0) return Scripts; // Return cached catalog
  let TempScripts = [];
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();

  Logger.log(`Loading scripts from ${ScriptsDirectory}`);
  if (!fs.existsSync(ScriptsDirectory)) {
    Scripts = [];
    return Scripts;
  }

  const ScriptFolders = ListScriptFolders(ScriptsDirectory);

  for (const ScriptFolder of ScriptFolders) {
    Logger.log(`Loading script from folder: ${ScriptFolder}`);
    const scriptJsonPath = path.join(ScriptsDirectory, ScriptFolder, 'Script.json');
    if (!fs.existsSync(scriptJsonPath)) {
      Logger.error(`Script.json not found in ${ScriptFolder}, skipping...`);
      BroadcastManager.emit('Notify', `Script.json not found in ${ScriptFolder}`, 'error', 15000);
      continue;
    }
    TempScripts.push(await LoadScriptFolder(ScriptsDirectory, ScriptFolder));
  }
  Scripts = TempScripts;
  return Scripts;
};

// Reload the catalog from disk and notify listeners (Web UI / connected clients).
Manager.ReloadScripts = async () => {
  await Manager.GetScripts(true);
  BroadcastManager.emit('ScriptsUpdated');
  return Scripts;
};

// Resolve a script by folder ID; ensure catalog is loaded first
Manager.Get = async (ID) => {
  if (Scripts.length === 0) await Manager.GetScripts();
  const Script = Scripts.find((s) => s.ID === ID);
  if (!Script) return null;
  return Script;
};

// A folder ID must be a safe single path segment.
function IsSafeFolderID(ID) {
  return typeof ID === 'string' && ID.length > 0 && !ID.includes('..') && !ID.includes('/') && !ID.includes('\\');
}

// Validate a user-supplied new script ID. Must be non-empty, contain no spaces
// and only alphanumeric characters (used as the on-disk folder name + OSC ID).
function ValidateNewID(NewID) {
  if (typeof NewID !== 'string' || !NewID.trim()) return 'ID is required';
  const Trimmed = NewID.trim();
  if (/\s/.test(Trimmed)) return 'ID cannot contain spaces';
  if (!/^[A-Za-z0-9]+$/.test(Trimmed)) {
    return 'ID can only contain letters and numbers';
  }
  return null;
}

// Return the editable fields + the non-config files in a script folder. The
// file list powers the per-platform dropdowns and the file overview section.
Manager.GetEditable = async (ID) => {
  if (!IsSafeFolderID(ID)) return [null, 'Invalid script ID'];
  const Script = await Manager.Get(ID);
  if (!Script) return [null, 'Script not found'];

  const Files = (Script.Files || [])
    .filter((f) => f.Type === 'file' && f.Path !== 'Script.json')
    .map((f) => f.Path);

  return [
    {
      id: Script.ID,
      name: Script.Name || Script.ID,
      description: Script.Description || '',
      colour: typeof Script.Colour === 'number' ? Script.Colour : 6,
      confirm: !!Script.Confirmation,
      enabled: !!Script.isEnabled,
      platforms: Script.Platforms || {},
      arguments: Script.Arguments || {},
      files: Files,
      valid: !!Script.isValid,
    },
    null,
  ];
};

// Persist structured field edits and optionally rename the folder/ID. Returns
// { ok, errors, id } where id is the final (possibly renamed) script ID.
Manager.SaveFields = async (ID, Fields) => {
  if (!IsSafeFolderID(ID)) return { ok: false, errors: ['Invalid script ID'] };
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  const ScriptFolderPath = path.join(ScriptsDirectory, ID);
  const scriptJsonPath = path.join(ScriptFolderPath, 'Script.json');

  if (!fs.existsSync(ScriptFolderPath)) {
    return { ok: false, errors: ['Script not found'] };
  }
  if (!Fields || typeof Fields !== 'object') {
    return { ok: false, errors: ['Invalid fields'] };
  }

  // Resolve the desired new ID (defaults to the current one).
  const DesiredID = typeof Fields.id === 'string' ? Fields.id.trim() : ID;
  if (DesiredID !== ID) {
    const IDError = ValidateNewID(DesiredID);
    if (IDError) return { ok: false, errors: [IDError] };
    if (fs.existsSync(path.join(ScriptsDirectory, DesiredID))) {
      return { ok: false, errors: [`A script named "${DesiredID}" already exists`] };
    }
  }

  // Preserve the existing weight so editing fields never changes ordering.
  const Existing = await Manager.Get(ID);
  const Weight =
    Existing && typeof Existing.Weight === 'number' ? Existing.Weight : 0;

  const Platforms = Fields.platforms && typeof Fields.platforms === 'object' ? Fields.platforms : {};
  const Arguments = Fields.arguments && typeof Fields.arguments === 'object' ? Fields.arguments : {};
  const RawConfig = {
    Name: Fields.name,
    Description: Fields.description,
    Colour: typeof Fields.colour === 'number' ? Fields.colour : 6,
    Weight,
    Confirmation: !!Fields.confirm,
    Enabled: !!Fields.enabled,
    Platforms: {
      Windows: Platforms.Windows,
      macOS: Platforms.macOS,
      Linux: Platforms.Linux,
    },
    Arguments: {
      Windows: Arguments.Windows,
      macOS: Arguments.macOS,
      Linux: Arguments.Linux,
    },
  };

  const { config, errors } = NormalizeScriptConfig(RawConfig, DesiredID);

  try {
    fs.writeFileSync(scriptJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    return { ok: false, errors: [`Failed to write Script.json: ${err.message}`] };
  }

  let FinalID = ID;
  if (DesiredID !== ID) {
    try {
      fs.renameSync(ScriptFolderPath, path.join(ScriptsDirectory, DesiredID));
      FinalID = DesiredID;
    } catch (err) {
      await Manager.ReloadScripts();
      return { ok: false, errors: [`Failed to rename script folder: ${err.message}`] };
    }
  }

  await Manager.ReloadScripts();
  return { ok: true, errors, id: FinalID };
};

// Persist a new ordering by reassigning Weight in folder order. Accepts an
// array of script IDs in the desired display order.
Manager.SetOrder = async (OrderedIDs) => {
  if (!Array.isArray(OrderedIDs)) return { ok: false, errors: ['Invalid order'] };
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  let Weight = 10;
  for (const ID of OrderedIDs) {
    if (!IsSafeFolderID(ID)) continue;
    const scriptJsonPath = path.join(ScriptsDirectory, ID, 'Script.json');
    if (!fs.existsSync(scriptJsonPath)) continue;
    try {
      const Parsed = JSON.parse(fs.readFileSync(scriptJsonPath, 'utf-8'));
      const { config } = NormalizeScriptConfig(Parsed, ID);
      config.Weight = Weight;
      fs.writeFileSync(scriptJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      Weight += 10;
    } catch (err) {
      Logger.error(`Failed to reweight ${ID}:`, err);
    }
  }
  await Manager.ReloadScripts();
  return { ok: true };
};

// Delete a script folder from disk entirely.
Manager.Delete = async (ID) => {
  if (!IsSafeFolderID(ID)) return { ok: false, error: 'Invalid script ID' };
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  const ScriptFolderPath = path.join(ScriptsDirectory, ID);
  if (!fs.existsSync(ScriptFolderPath)) return { ok: false, error: 'Script not found' };
  try {
    fs.rmSync(ScriptFolderPath, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `Failed to delete script folder: ${err.message}` };
  }
  await Manager.ReloadScripts();
  return { ok: true };
};

// Export SCRIPT_COLOURS so the desktop renderer can access the palette without
// requiring a separate IPC call.
module.exports = {
  Manager,
  SCRIPT_COLOURS,
};
