// ScriptManager
// - Discovers scripts from the scripts directory (one folder per script)
// - Loads Script.json metadata, normalizes it (auto-repairing invalid/missing
//   keys) and calculates checksums for all files
// - Exposes a readonly in-memory catalog plus edit helpers for the Script
//   Manager UI
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';
import { Manager as ChecksumManager } from '../ChecksumManager';
import { Manager as BroadcastManager } from '../Broadcast';
import { Ok, Fail } from '../Utils';
import { SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS } from '../Config/constants';
import type { Result } from '../../types/result';

import {
  PLATFORM_KEYS,
  SCRIPT_COLOURS,
  DEFAULT_CONSOLE_FILTER_MODE,
  NormalizeScriptConfig,
} from './schema';
import type { NormalizedScriptConfig, ConsoleFilterConfig } from './schema';

const Logger = CreateLogger('ScriptManager');

// A per-platform launch/argument map ({ Windows, macOS, Linux }).
type PlatformMap = Record<string, string>;

// One entry in a script folder's file listing.
interface ScriptFileEntry {
  Path: string;
  Type: 'file' | 'directory';
  Checksum?: string | null;
}

// The editable projection of a script surfaced to the Script Manager UI.
interface ScriptEditable {
  id: string;
  name: string;
  description: string;
  colour: number;
  icon: string;
  confirm: boolean;
  timeoutMs: number;
  enabled: boolean;
  platforms: PlatformMap;
  arguments: PlatformMap;
  consoleFilter: ConsoleFilterConfig;
  files: string[];
  valid: boolean;
}

// Structured field edits accepted by SaveFields (from the renderer). Every
// field is validated/normalized at runtime, so inputs are permissive.
interface ScriptEditableInput {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  colour?: unknown;
  icon?: unknown;
  confirm?: unknown;
  timeoutMs?: unknown;
  enabled?: unknown;
  platforms?: unknown;
  arguments?: unknown;
  consoleFilter?: unknown;
}

// A single file inside a sample template (base64-encoded content).
interface TemplateFile {
  path?: unknown;
  content?: unknown;
}

interface ScriptTemplate {
  files: TemplateFile[];
  [key: string]: unknown;
}

// SaveFields succeeds with the final (possibly renamed) ID plus any non-fatal
// normalization warnings.
interface ScriptSaveResult {
  id: string;
  warnings: string[];
}

// CreateFromTemplate keeps a discriminated-object return (not Result<T>)
// because the renderer's auto-retry loop needs to distinguish an ID *conflict*
// from a genuine failure — information a `[string, null]` failure tuple cannot
// carry. See CreateScriptFromTemplateWithGeneratedID in the renderer.
interface ScriptTemplateResult {
  ok: boolean;
  id?: string;
  conflict?: boolean;
  errors?: string[];
}

type ScriptCatalogEntry = Script | InvalidScript;

interface ScriptManagerType {
  GetScripts(Force?: boolean): Promise<ScriptCatalogEntry[]>;
  ReloadScripts(): Promise<ScriptCatalogEntry[]>;
  GetDeploymentFingerprint(): Promise<string>;
  Get(ID: string): Promise<ScriptCatalogEntry | null>;
  GetEditable(ID: string): Promise<Result<ScriptEditable>>;
  SaveFields(ID: string, Fields: ScriptEditableInput): Promise<Result<ScriptSaveResult>>;
  SetOrder(OrderedIDs: unknown): Promise<Result<true>>;
  CreateBlank(): Promise<Result<{ id: string }>>;
  CreateFromTemplate(Sample: unknown, DesiredID: unknown): Promise<ScriptTemplateResult>;
  Delete(ID: string): Promise<Result<true>>;
}

// Catalog cache; populated on first GetScripts() call
let Scripts: ScriptCatalogEntry[] = [];
let ScriptDirectoryWatcher: fs.FSWatcher | null = null;
let ScriptDirectoryWatcherPath: string | null = null;
let ScriptDirectoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
let DeploymentFingerprint = '';

class Script {
  ID: string;
  Name: string;
  Description: string;
  Colour: number;
  Icon: string;
  Weight: number;
  Confirmation: boolean;
  Timeout: number;
  Platforms: PlatformMap;
  Arguments: PlatformMap;
  ConsoleFilter: ConsoleFilterConfig;
  CompatiblePlatforms: string[];
  Files: ScriptFileEntry[];
  isEnabled: boolean;
  isValid: boolean;
  ValidationErrors: string[];
  Config: NormalizedScriptConfig;

  constructor(
    ID: string,
    Config: NormalizedScriptConfig,
    AllFilesInFolder: ScriptFileEntry[],
    CompatiblePlatforms: string[],
    ValidationErrors: string[]
  ) {
    this.ID = ID;
    this.Name = Config.Name;
    this.Description = Config.Description || '';
    // Colour index (integer, 0–7); see SCRIPT_COLOURS in schema.js.
    this.Colour = typeof Config.Colour === 'number' ? Config.Colour : 6;
    // Bootstrap Icons name (without the "bi-" prefix); see schema.js.
    this.Icon = typeof Config.Icon === 'string' && Config.Icon ? Config.Icon : 'terminal';
    this.Weight = Config.Weight || 0;
    this.Confirmation = Config.Confirmation || false;
    this.Timeout =
      typeof Config.Timeout === 'number' && Number.isInteger(Config.Timeout) && Config.Timeout > 0
        ? Config.Timeout
        : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS;

    // Cross-platform launch map ({ Windows, macOS, Linux }).
    this.Platforms = Config.Platforms || {};
    // Optional per-platform argument string ({ Windows, macOS, Linux }).
    this.Arguments = Config.Arguments || {};
    // Optional console filter ({ Mode, Pattern }) applied client-side to the
    // live console tail. Mode "none" (the default) surfaces every line.
    this.ConsoleFilter =
      Config.ConsoleFilter && typeof Config.ConsoleFilter === 'object'
        ? Config.ConsoleFilter
        : { Mode: DEFAULT_CONSOLE_FILTER_MODE, Pattern: '', Strip: false };
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
  ID: string;
  Name: string;
  Description: string;
  Colour: number;
  Icon: string;
  Weight: number;
  Confirmation: boolean;
  Platforms: PlatformMap;
  Arguments: PlatformMap;
  CompatiblePlatforms: string[];
  Files: ScriptFileEntry[];
  isEnabled: boolean;
  isValid: boolean;
  ParseError: string;
  RawText: string;
  ValidationErrors: string[];
  Config: NormalizedScriptConfig | null;

  constructor(ID: string, ParseError: string, RawText: unknown) {
    this.ID = ID;
    this.Name = ID;
    this.Description = '';
    this.Colour = 6;
    this.Icon = 'terminal';
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

// Methods are assigned incrementally below (some helpers reference Manager.X
// before all are defined), so the surface is declared up front and populated.
const Manager = {} as ScriptManagerType;

// Stable, comparable projections used only to compute the deployment
// fingerprint hash (field order is irrelevant; JSON.stringify uses insertion order).
interface FingerprintFileEntry {
  Path: string;
  Type: string;
  Checksum: string | null;
}

interface FingerprintScriptEntry {
  ID: string;
  Name: string;
  Description: string;
  Colour: number;
  Icon: string;
  Weight: number;
  Confirmation: boolean;
  Timeout: number;
  Enabled: boolean;
  Platforms: PlatformMap;
  Arguments: PlatformMap;
  ConsoleFilter: ConsoleFilterConfig;
  isValid: boolean;
  ParseError: string;
  Files: FingerprintFileEntry[];
}

function NormalizeFileEntryForFingerprint(File: ScriptFileEntry): FingerprintFileEntry | null {
  if (!File || typeof File !== 'object') return null;
  return {
    Path: String(File.Path || ''),
    Type: String(File.Type || ''),
    Checksum: File.Checksum ? String(File.Checksum) : null,
  };
}

function BuildDeploymentFingerprint(ScriptList: ScriptCatalogEntry[]): string {
  const Normalized = (Array.isArray(ScriptList) ? ScriptList : [])
    .map((Script): FingerprintScriptEntry | null => {
      if (!Script || typeof Script !== 'object') return null;
      const Files = (Array.isArray(Script.Files) ? Script.Files : [])
        .map((File) => NormalizeFileEntryForFingerprint(File))
        .filter((Entry): Entry is FingerprintFileEntry => Entry !== null)
        .sort((A, B) => {
          if (A.Path === B.Path) return A.Type.localeCompare(B.Type);
          return A.Path.localeCompare(B.Path);
        });

      return {
        ID: String(Script.ID || ''),
        Name: String(Script.Name || ''),
        Description: String(Script.Description || ''),
        Colour: typeof Script.Colour === 'number' ? Script.Colour : 6,
        Icon: typeof Script.Icon === 'string' && Script.Icon ? Script.Icon : 'terminal',
        Weight: typeof Script.Weight === 'number' ? Script.Weight : 0,
        Confirmation: !!Script.Confirmation,
        Timeout:
          'Timeout' in Script && typeof Script.Timeout === 'number'
            ? Script.Timeout
            : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS,
        Enabled: !!Script.isEnabled,
        Platforms: Script.Platforms || {},
        Arguments: Script.Arguments || {},
        ConsoleFilter:
          'ConsoleFilter' in Script &&
          Script.ConsoleFilter &&
          typeof Script.ConsoleFilter === 'object'
            ? {
                Mode: String(Script.ConsoleFilter.Mode || DEFAULT_CONSOLE_FILTER_MODE),
                Pattern: String(Script.ConsoleFilter.Pattern || ''),
                Strip: Script.ConsoleFilter.Strip === true,
              }
            : { Mode: DEFAULT_CONSOLE_FILTER_MODE, Pattern: '', Strip: false },
        isValid: Script.isValid !== false,
        ParseError: 'ParseError' in Script && Script.ParseError ? String(Script.ParseError) : '',
        Files,
      };
    })
    .filter((Entry): Entry is FingerprintScriptEntry => Entry !== null)
    .sort((A, B) => A.ID.localeCompare(B.ID));

  return crypto.createHash('sha256').update(JSON.stringify(Normalized)).digest('hex');
}

function CloseScriptDirectoryWatcher() {
  if (!ScriptDirectoryWatcher) return;
  try {
    ScriptDirectoryWatcher.close();
  } catch {
    /* intentional: closing an already-closed fs watcher is harmless */
  }
  ScriptDirectoryWatcher = null;
  ScriptDirectoryWatcherPath = null;
}

function ScheduleScriptDirectoryReload() {
  if (ScriptDirectoryReloadTimer) clearTimeout(ScriptDirectoryReloadTimer);
  ScriptDirectoryReloadTimer = setTimeout(async () => {
    ScriptDirectoryReloadTimer = null;
    try {
      await Manager.ReloadScripts();
    } catch (Err) {
      Logger.error('Failed to reload scripts after filesystem change:', Err);
    }
  }, 350);
}

function EnsureScriptDirectoryWatcher(ScriptsDirectory: string) {
  if (!ScriptsDirectory || !fs.existsSync(ScriptsDirectory)) {
    CloseScriptDirectoryWatcher();
    return;
  }
  if (ScriptDirectoryWatcher && ScriptDirectoryWatcherPath === ScriptsDirectory) {
    return;
  }

  CloseScriptDirectoryWatcher();

  const RecursiveWatchSupported = process.platform === 'darwin' || process.platform === 'win32';

  try {
    ScriptDirectoryWatcher = fs.watch(
      ScriptsDirectory,
      { recursive: RecursiveWatchSupported },
      (_EventType: string, FileName: string | Buffer | null) => {
        if (FileName && String(FileName).includes('.DS_Store')) return;
        ScheduleScriptDirectoryReload();
      }
    );
    ScriptDirectoryWatcherPath = ScriptsDirectory;
    Logger.log(
      `Watching scripts directory for changes: ${ScriptsDirectory} (${RecursiveWatchSupported ? 'recursive' : 'non-recursive'})`
    );
  } catch (Err) {
    Logger.warn(`Unable to watch scripts directory (${ScriptsDirectory}): ${(Err as Error).message}`);
  }
}

// Simple bounded-concurrency runner
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<void>
) {
  if (!items || items.length === 0) return;
  const size = Math.max(1, Math.min(limit || 8, items.length));
  let index = 0;
  const runners = new Array(size).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      // i < items.length (checked above) → in-bounds.
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

// Enumerate files recursively and produce relative paths, adding a checksum later
function RecursiveFileList(dir: string, baseDir: string = dir): ScriptFileEntry[] {
  let results: ScriptFileEntry[] = [];
  const list = fs.readdirSync(dir);
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
function ResolveCompatiblePlatforms(ScriptFolderPath: string, Platforms: PlatformMap): string[] {
  const Compatible: string[] = [];
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
async function LoadScriptFolder(ScriptsDirectory: string, ScriptFolder: string) {
  const ScriptFolderPath = path.join(ScriptsDirectory, ScriptFolder);
  const scriptJsonPath = path.join(ScriptFolderPath, 'Script.json');

  let RawText: string;
  try {
    RawText = fs.readFileSync(scriptJsonPath, 'utf-8');
  } catch (err) {
    return new InvalidScript(
      ScriptFolder,
      `Unable to read Script.json: ${(err as Error).message}`,
      ''
    );
  }

  let Parsed: unknown;
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
    return new InvalidScript(ScriptFolder, `Invalid JSON: ${(err as Error).message}`, RawText);
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

function ListScriptFolders(ScriptsDirectory: string): string[] {
  const IsValidScriptFolderName = (FolderName: string) => /^[A-Za-z0-9_-]+$/.test(FolderName);

  return fs.readdirSync(ScriptsDirectory).filter((file) => {
    const fullPath = path.join(ScriptsDirectory, file);
    return fs.statSync(fullPath).isDirectory() && IsValidScriptFolderName(file);
  });
}

Manager.GetScripts = async (Force = false) => {
  if (!Force && Scripts.length > 0) return Scripts; // Return cached catalog
  const TempScripts: ScriptCatalogEntry[] = [];
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  EnsureScriptDirectoryWatcher(ScriptsDirectory);

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
  DeploymentFingerprint = BuildDeploymentFingerprint(Scripts);
  return Scripts;
};

// Reload the catalog from disk and notify listeners (Web UI / connected clients).
Manager.ReloadScripts = async () => {
  await Manager.GetScripts(true);
  BroadcastManager.emit('ScriptsUpdated');
  return Scripts;
};

Manager.GetDeploymentFingerprint = async () => {
  if (Scripts.length === 0) await Manager.GetScripts();
  if (!DeploymentFingerprint) {
    DeploymentFingerprint = BuildDeploymentFingerprint(Scripts);
  }
  return DeploymentFingerprint;
};

// Resolve a script by folder ID; ensure catalog is loaded first
Manager.Get = async (ID: string) => {
  if (Scripts.length === 0) await Manager.GetScripts();
  const Script = Scripts.find((s) => s.ID === ID);
  if (!Script) return null;
  return Script;
};

// A folder ID must be a safe single path segment.
function IsSafeFolderID(ID: unknown): boolean {
  return (
    typeof ID === 'string' &&
    ID.length > 0 &&
    !ID.includes('..') &&
    !ID.includes('/') &&
    !ID.includes('\\')
  );
}

// Validate a user-supplied new script ID.
function ValidateNewID(NewID: unknown): string | null {
  if (typeof NewID !== 'string' || !NewID.trim()) return 'ID is required';
  const Trimmed = NewID.trim();
  if (/\s/.test(Trimmed)) return 'ID cannot contain spaces';
  if (!/^[A-Za-z0-9_-]+$/.test(Trimmed)) {
    return 'ID can only contain letters, numbers, hyphens and underscores';
  }
  return null;
}

// Return the editable fields + the non-config files in a script folder.
// Standard `[Err, Data]` result order.
Manager.GetEditable = async (ID: string): Promise<Result<ScriptEditable>> => {
  if (!IsSafeFolderID(ID)) return Fail('Invalid script ID');
  const Script = await Manager.Get(ID);
  if (!Script) return Fail('Script not found');

  const Files = (Script.Files || [])
    .filter((f) => f.Type === 'file' && f.Path !== 'Script.json')
    .map((f) => f.Path);

  // InvalidScript has no Timeout; fall back to the default for its editor view.
  const Timeout =
    'Timeout' in Script && typeof Script.Timeout === 'number'
      ? Script.Timeout
      : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS;

  return Ok({
    id: Script.ID,
    name: Script.Name || Script.ID,
    description: Script.Description || '',
    colour: typeof Script.Colour === 'number' ? Script.Colour : 6,
    icon: typeof Script.Icon === 'string' && Script.Icon ? Script.Icon : 'terminal',
    confirm: !!Script.Confirmation,
    timeoutMs: Timeout,
    enabled: !!Script.isEnabled,
    platforms: Script.Platforms || {},
    arguments: Script.Arguments || {},
    consoleFilter:
      'ConsoleFilter' in Script &&
      Script.ConsoleFilter &&
      typeof Script.ConsoleFilter === 'object'
        ? {
            Mode: String(Script.ConsoleFilter.Mode || DEFAULT_CONSOLE_FILTER_MODE),
            Pattern: String(Script.ConsoleFilter.Pattern || ''),
            Strip: Script.ConsoleFilter.Strip === true,
          }
        : { Mode: DEFAULT_CONSOLE_FILTER_MODE, Pattern: '', Strip: false },
    files: Files,
    valid: !!Script.isValid,
  });
};

// Persist structured field edits and optionally rename the folder/ID. On
// success the data carries the final (possibly renamed) ID plus any non-fatal
// normalization warnings.
Manager.SaveFields = async (
  ID: string,
  Fields: ScriptEditableInput
): Promise<Result<ScriptSaveResult>> => {
  if (!IsSafeFolderID(ID)) return Fail('Invalid script ID');
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  const ScriptFolderPath = path.join(ScriptsDirectory, ID);
  const scriptJsonPath = path.join(ScriptFolderPath, 'Script.json');

  if (!fs.existsSync(ScriptFolderPath)) {
    return Fail('Script not found');
  }
  if (!Fields || typeof Fields !== 'object') {
    return Fail('Invalid fields');
  }

  // Resolve the desired new ID (defaults to the current one).
  const DesiredID = typeof Fields.id === 'string' ? Fields.id.trim() : ID;
  if (DesiredID !== ID) {
    const IDError = ValidateNewID(DesiredID);
    if (IDError) return Fail(IDError);
    if (fs.existsSync(path.join(ScriptsDirectory, DesiredID))) {
      return Fail(`A script named "${DesiredID}" already exists`);
    }
  }

  // Preserve the existing weight so editing fields never changes ordering.
  const Existing = await Manager.Get(ID);
  const Weight = Existing && typeof Existing.Weight === 'number' ? Existing.Weight : 0;

  const Platforms = (
    Fields.platforms && typeof Fields.platforms === 'object' ? Fields.platforms : {}
  ) as Record<string, unknown>;
  const Arguments = (
    Fields.arguments && typeof Fields.arguments === 'object' ? Fields.arguments : {}
  ) as Record<string, unknown>;
  const RawConfig = {
    Name: Fields.name,
    Description: Fields.description,
    Colour: typeof Fields.colour === 'number' ? Fields.colour : 6,
    Icon: typeof Fields.icon === 'string' ? Fields.icon : 'terminal',
    Weight,
    Confirmation: !!Fields.confirm,
    Timeout: Fields.timeoutMs,
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
    // Normalized (validated against the mode enum) inside NormalizeScriptConfig.
    ConsoleFilter: Fields.consoleFilter,
  };

  const { config, errors } = NormalizeScriptConfig(RawConfig, DesiredID);

  try {
    fs.writeFileSync(scriptJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    return Fail(`Failed to write Script.json: ${(err as Error).message}`);
  }

  let FinalID = ID;
  if (DesiredID !== ID) {
    try {
      fs.renameSync(ScriptFolderPath, path.join(ScriptsDirectory, DesiredID));
      FinalID = DesiredID;
    } catch (err) {
      await Manager.ReloadScripts();
      return Fail(`Failed to rename script folder: ${(err as Error).message}`);
    }
  }

  await Manager.ReloadScripts();
  return Ok({ id: FinalID, warnings: errors });
};

// Persist a new ordering by reassigning Weight in folder order.
Manager.SetOrder = async (OrderedIDs: unknown): Promise<Result<true>> => {
  if (!Array.isArray(OrderedIDs)) return Fail('Invalid order');
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
  return Ok(true);
};

// Compute the next Weight value that places a new script at the bottom of the list.
async function GetBottomWeight(): Promise<number> {
  const Existing = await Manager.GetScripts();
  let Max = 0;
  for (const Script of Existing) {
    const Weight = typeof Script.Weight === 'number' ? Script.Weight : 0;
    if (Weight > Max) Max = Weight;
  }
  return Max + 10;
}

// Find an unused, schema-valid script ID derived from Base.
function GetAvailableID(Base: unknown, ScriptsDirectory: string): string {
  let Root = String(Base || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!Root) Root = 'NewScript';
  let Candidate = Root;
  let Counter = 1;
  while (fs.existsSync(path.join(ScriptsDirectory, Candidate))) {
    Counter += 1;
    Candidate = `${Root}${Counter}`;
  }
  return Candidate;
}

// Create a brand new, blank script.
Manager.CreateBlank = async (): Promise<Result<{ id: string }>> => {
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  if (!fs.existsSync(ScriptsDirectory)) {
    fs.mkdirSync(ScriptsDirectory, { recursive: true });
  }

  const ID = GetAvailableID('NewScript', ScriptsDirectory);
  const ScriptFolderPath = path.join(ScriptsDirectory, ID);

  const Weight = await GetBottomWeight();

  const PlaceholderFiles: Record<string, string> = {
    'windows.bat': '@echo off\r\nREM TODO: Add your Windows commands here\r\n',
    'macos.sh': '#!/bin/bash\n# TODO: Add your macOS commands here\n',
    'linux.sh': '#!/bin/bash\n# TODO: Add your Linux commands here\n',
  };

  const RawConfig = {
    Name: 'New Script',
    Description: 'Describe what this script does.',
    Colour: 6,
    Weight,
    Confirmation: false,
    Timeout: SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS,
    // Not runnable until the author maps platforms and enables it.
    Enabled: false,
    Platforms: { Windows: '', macOS: '', Linux: '' },
    Arguments: { Windows: '', macOS: '', Linux: '' },
  };

  const { config } = NormalizeScriptConfig(RawConfig, ID);

  try {
    fs.mkdirSync(ScriptFolderPath, { recursive: true });
    for (const [FileName, Contents] of Object.entries(PlaceholderFiles)) {
      fs.writeFileSync(path.join(ScriptFolderPath, FileName), Contents, 'utf-8');
    }
    fs.writeFileSync(
      path.join(ScriptFolderPath, 'Script.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    return Fail(`Failed to create script: ${(err as Error).message}`);
  }

  await Manager.ReloadScripts();
  return Ok({ id: ID });
};

// Create a new script from a fetched sample (template). Returns a discriminated
// object (not Result<T>) so the renderer can distinguish an ID `conflict` from
// a genuine failure and auto-retry with a fresh ID.
Manager.CreateFromTemplate = async (
  Sample: unknown,
  DesiredID: unknown
): Promise<ScriptTemplateResult> => {
  if (!Sample || typeof Sample !== 'object' || !Array.isArray((Sample as ScriptTemplate).files)) {
    return { ok: false, errors: ['Invalid template'] };
  }
  const Template = Sample as ScriptTemplate;

  const TargetID = typeof DesiredID === 'string' ? DesiredID.trim() : '';
  const IDError = ValidateNewID(TargetID);
  if (IDError) return { ok: false, errors: [IDError] };

  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  if (!fs.existsSync(ScriptsDirectory)) {
    fs.mkdirSync(ScriptsDirectory, { recursive: true });
  }

  const ScriptFolderPath = path.join(ScriptsDirectory, TargetID);
  if (fs.existsSync(ScriptFolderPath)) {
    return {
      ok: false,
      conflict: true,
      errors: [`A script named "${TargetID}" already exists; choose a different ID.`],
    };
  }

  const Weight = await GetBottomWeight();

  try {
    fs.mkdirSync(ScriptFolderPath, { recursive: true });

    for (const File of Template.files) {
      if (!File || typeof File.path !== 'string') continue;
      if (File.path === 'Script.json') continue; // written separately below
      const RelativePath = File.path.replace(/\\/g, '/');
      // Reject any path that escapes the script folder.
      if (RelativePath.split('/').some((Seg: string) => Seg === '..' || Seg === '')) continue;
      if (path.isAbsolute(RelativePath)) continue;
      const TargetFilePath = path.join(ScriptFolderPath, RelativePath);
      const Resolved = path.resolve(TargetFilePath);
      const Prefix = path.resolve(ScriptFolderPath) + path.sep;
      if (!Resolved.startsWith(Prefix)) continue;
      fs.mkdirSync(path.dirname(TargetFilePath), { recursive: true });
      fs.writeFileSync(TargetFilePath, Buffer.from(String(File.content || ''), 'base64'));
    }
  } catch (err) {
    try {
      fs.rmSync(ScriptFolderPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    return {
      ok: false,
      errors: [`Failed to create script from template: ${(err as Error).message}`],
    };
  }

  // Build the config from the template's Script.json (if present) but always
  // force the new script to the bottom of the list.
  let TemplateConfig: Record<string, unknown> = {};
  const ConfigFile = Template.files.find((f) => f && f.path === 'Script.json');
  if (ConfigFile) {
    try {
      TemplateConfig = JSON.parse(
        Buffer.from(String(ConfigFile.content || ''), 'base64').toString('utf-8')
      );
    } catch {
      TemplateConfig = {};
    }
  }
  TemplateConfig.Weight = Weight;

  const { config } = NormalizeScriptConfig(TemplateConfig, TargetID);
  config.Weight = Weight;

  try {
    fs.writeFileSync(
      path.join(ScriptFolderPath, 'Script.json'),
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    try {
      fs.rmSync(ScriptFolderPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    return { ok: false, errors: [`Failed to write Script.json: ${(err as Error).message}`] };
  }

  await Manager.ReloadScripts();
  return { ok: true, id: TargetID };
};

// Delete a script folder from disk entirely.
Manager.Delete = async (ID: string): Promise<Result<true>> => {
  if (!IsSafeFolderID(ID)) return Fail('Invalid script ID');
  const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
  const ScriptFolderPath = path.join(ScriptsDirectory, ID);
  if (!fs.existsSync(ScriptFolderPath)) return Fail('Script not found');
  try {
    fs.rmSync(ScriptFolderPath, { recursive: true, force: true });
  } catch (err) {
    return Fail(`Failed to delete script folder: ${(err as Error).message}`);
  }
  await Manager.ReloadScripts();
  return Ok(true);
};

export { Manager, SCRIPT_COLOURS };
