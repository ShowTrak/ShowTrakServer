// SampleScripts
// - Fetches the public ShowTrak SampleScripts catalog from GitHub
//   (https://github.com/ShowTrak/SampleScripts) and caches it locally.
// - The catalog is fetched on first launch and refreshed in the background by
//   comparing the cached commit SHA against the latest commit on the default
//   branch (so new pushes/releases are picked up automatically).
// - Each sample is a folder containing a Script.json plus its platform script
//   files; the cache stores the file contents (base64) so the Script Manager
//   can create a new script from a template without a network round-trip.
const path = require('path');
const fs = require('fs');

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('SampleScripts');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: BroadcastManager } = require('../Broadcast');

const REPO_OWNER = 'ShowTrak';
const REPO_NAME = 'SampleScripts';
const REPO_BRANCH = 'main';

// Re-check the upstream repository for changes at most this often.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const Manager = {};

let Samples = [];
let CachedSha = null;
let LastRefreshAttempt = 0;
let RefreshInFlight = null;

function GetCacheDirectory() {
  const Dir = AppDataManager.GetSampleScriptsDirectory();
  if (!fs.existsSync(Dir)) {
    fs.mkdirSync(Dir, { recursive: true });
  }
  return Dir;
}

function GetCacheFilePath() {
  return path.join(GetCacheDirectory(), 'catalog.json');
}

// A safe single path segment (used as the on-disk folder name for a sample).
function IsSafeSegment(Value) {
  return (
    typeof Value === 'string' &&
    Value.length > 0 &&
    !Value.includes('..') &&
    !Value.includes('/') &&
    !Value.includes('\\')
  );
}

// A safe relative file path within a sample folder (no traversal/absolute).
function IsSafeRelativePath(Value) {
  if (typeof Value !== 'string' || !Value.trim()) return false;
  const Normalized = Value.replace(/\\/g, '/');
  if (Normalized.startsWith('/')) return false;
  if (path.isAbsolute(Normalized)) return false;
  return !Normalized.split('/').some((Segment) => Segment === '..' || Segment === '');
}

function LoadCacheFromDisk() {
  try {
    const FilePath = GetCacheFilePath();
    if (!fs.existsSync(FilePath)) return false;
    const Parsed = JSON.parse(fs.readFileSync(FilePath, 'utf-8'));
    if (!Parsed || !Array.isArray(Parsed.samples)) return false;
    Samples = Parsed.samples;
    CachedSha = typeof Parsed.sha === 'string' ? Parsed.sha : null;
    Logger.log(`Loaded ${Samples.length} cached sample scripts (sha: ${CachedSha || 'unknown'})`);
    return true;
  } catch (Err) {
    Logger.error('Failed to load sample scripts cache:', Err);
    return false;
  }
}

function WriteCacheToDisk() {
  try {
    const Payload = { sha: CachedSha, fetchedAt: Date.now(), samples: Samples };
    fs.writeFileSync(GetCacheFilePath(), JSON.stringify(Payload, null, 2), 'utf-8');
  } catch (Err) {
    Logger.error('Failed to persist sample scripts cache:', Err);
  }
}

async function FetchJson(Url) {
  const Response = await fetch(Url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ShowTrakServer',
    },
  });
  if (!Response.ok) {
    throw new Error(`${Response.status} ${Response.statusText} for ${Url}`);
  }
  return Response.json();
}

async function FetchLatestSha() {
  const Url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${REPO_BRANCH}`;
  const Data = await FetchJson(Url);
  return Data && typeof Data.sha === 'string' ? Data.sha : null;
}

async function FetchRepoTree() {
  const Url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const Data = await FetchJson(Url);
  if (!Data || !Array.isArray(Data.tree)) return [];
  return Data.tree;
}

async function FetchRawFile(RelativePath) {
  const EncodedPath = RelativePath.split('/').map(encodeURIComponent).join('/');
  const Url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${EncodedPath}`;
  const Response = await fetch(Url, { headers: { 'User-Agent': 'ShowTrakServer' } });
  if (!Response.ok) {
    throw new Error(`${Response.status} ${Response.statusText} for ${Url}`);
  }
  const ArrayBuffer = await Response.arrayBuffer();
  return Buffer.from(ArrayBuffer);
}

// Build the sample catalog from the repository tree. Each top-level folder that
// contains a Script.json becomes a sample; all of its files are downloaded and
// stored as base64 content in the cache.
async function BuildSamplesFromTree(Tree) {
  // Group blobs by their top-level folder.
  const FoldersByName = new Map();
  for (const Entry of Tree) {
    if (!Entry || Entry.type !== 'blob' || typeof Entry.path !== 'string') continue;
    const Parts = Entry.path.split('/');
    if (Parts.length < 2) continue; // ignore root-level files (.DS_Store, README, ...)
    const Folder = Parts[0];
    if (!IsSafeSegment(Folder)) continue;
    if (!IsSafeRelativePath(Entry.path)) continue;
    const RelativePath = Parts.slice(1).join('/');
    if (!IsSafeRelativePath(RelativePath)) continue;
    if (!FoldersByName.has(Folder)) FoldersByName.set(Folder, []);
    FoldersByName.get(Folder).push({ fullPath: Entry.path, relativePath: RelativePath });
  }

  const Result = [];
  for (const [Folder, Files] of FoldersByName) {
    const HasConfig = Files.some((f) => f.relativePath === 'Script.json');
    if (!HasConfig) continue;

    let Config = null;
    const DownloadedFiles = [];
    for (const File of Files) {
      let Buffer;
      try {
        Buffer = await FetchRawFile(File.fullPath);
      } catch (Err) {
        Logger.error(`Failed to download ${File.fullPath}:`, Err);
        throw Err;
      }
      DownloadedFiles.push({
        path: File.relativePath,
        content: Buffer.toString('base64'),
      });
      if (File.relativePath === 'Script.json') {
        try {
          Config = JSON.parse(Buffer.toString('utf-8'));
        } catch (Err) {
          Logger.error(`Sample ${Folder} has invalid Script.json, skipping:`, Err);
        }
      }
    }

    if (!Config) continue;

    Result.push({
      id: Folder,
      name: typeof Config.Name === 'string' && Config.Name.trim() ? Config.Name : Folder,
      description: typeof Config.Description === 'string' ? Config.Description : '',
      colour: typeof Config.Colour === 'number' ? Config.Colour : 6,
      confirm: !!Config.Confirmation,
      platforms:
        Config.Platforms && typeof Config.Platforms === 'object' ? Config.Platforms : {},
      files: DownloadedFiles,
    });
  }

  Result.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return Result;
}

// Refresh the catalog from GitHub. Skips the network entirely when the upstream
// commit SHA is unchanged. `Force` bypasses the SHA short-circuit.
async function PerformRefresh(Force) {
  let LatestSha = null;
  try {
    LatestSha = await FetchLatestSha();
  } catch (Err) {
    Logger.warn(`Unable to check sample scripts for updates: ${Err.message}`);
    return { ok: false, error: 'Unable to reach the sample scripts repository' };
  }

  if (!Force && LatestSha && CachedSha && LatestSha === CachedSha && Samples.length > 0) {
    Logger.log('Sample scripts are up to date.');
    return { ok: true, updated: false };
  }

  let Tree;
  try {
    Tree = await FetchRepoTree();
  } catch (Err) {
    Logger.warn(`Unable to download sample scripts catalog: ${Err.message}`);
    return { ok: false, error: 'Unable to download the sample scripts catalog' };
  }

  let NewSamples;
  try {
    NewSamples = await BuildSamplesFromTree(Tree);
  } catch (Err) {
    Logger.warn(`Failed to build sample scripts catalog: ${Err.message}`);
    return { ok: false, error: 'Failed to download one or more sample scripts' };
  }

  Samples = NewSamples;
  CachedSha = LatestSha;
  WriteCacheToDisk();
  Logger.success(`Refreshed sample scripts catalog (${Samples.length} samples).`);
  BroadcastManager.emit('SampleScriptsUpdated');
  return { ok: true, updated: true };
}

function RefreshIfStale() {
  const Now = Date.now();
  if (RefreshInFlight) return RefreshInFlight;
  if (Samples.length > 0 && Now - LastRefreshAttempt < REFRESH_INTERVAL_MS) {
    return Promise.resolve({ ok: true, updated: false });
  }
  LastRefreshAttempt = Now;
  RefreshInFlight = PerformRefresh(false).finally(() => {
    RefreshInFlight = null;
  });
  return RefreshInFlight;
}

// Load the on-disk cache and kick off a background refresh. Safe to call on
// startup; never throws.
Manager.Initialize = async () => {
  LoadCacheFromDisk();
  // Fire-and-forget background refresh so startup is not blocked on the network.
  RefreshIfStale().catch((Err) => Logger.error('Sample scripts refresh failed:', Err));
};

// Force a refresh from GitHub (used by the manual "refresh" button).
Manager.Refresh = async () => {
  LastRefreshAttempt = Date.now();
  return PerformRefresh(true);
};

// Return the catalog metadata for browsing (no file contents). Triggers a
// background staleness check but always returns whatever is cached.
Manager.GetSampleList = async () => {
  if (Samples.length === 0 && !CachedSha) {
    // Nothing cached yet – attempt a refresh and wait for it once.
    try {
      await RefreshIfStale();
    } catch (Err) {
      Logger.error('Sample scripts refresh failed:', Err);
    }
  } else {
    RefreshIfStale().catch((Err) => Logger.error('Sample scripts refresh failed:', Err));
  }
  return Samples.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    colour: s.colour,
    confirm: s.confirm,
    platforms: s.platforms || {},
  }));
};

// Return a single sample including its downloaded file contents (base64).
Manager.GetSample = async (ID) => {
  if (!IsSafeSegment(ID)) return null;
  if (Samples.length === 0) {
    try {
      await RefreshIfStale();
    } catch (Err) {
      Logger.error('Sample scripts refresh failed:', Err);
    }
  }
  return Samples.find((s) => s.id === ID) || null;
};

module.exports = {
  Manager,
};
