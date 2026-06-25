// AudioAssetManager
// Owns the catalog of user-imported custom audio files used as alert sounds.
// Files live in AppData/ShowTrakServer/Audio alongside a manifest.json that
// stores per-asset metadata (label, per-asset playback volume, etc). This is
// app-global on purpose (survives show swaps) so alert rules in any show can
// reference the same assets, mirroring how the built-in alert sounds behave.

const fs = require('fs');
const path = require('path');

const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('AudioAssetManager');

const { Manager: AppData } = require('../AppData');
const { Manager: UUID } = require('../UUID');
const { Ok, Fail } = require('../Utils');

const Manager = {};

// Reasonable, conservative limits. 15 seconds at 24-bit/96kHz stereo WAV is
// ~8.6MB, so 15MB comfortably covers uncompressed clips while preventing huge
// imports. Duration is validated in the renderer (only it can decode audio).
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15;
const MAX_LABEL_LENGTH = 40;

const ALLOWED_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus']);

const MIME_BY_EXTENSION = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
};

let Initialized = false;
let Assets = [];

function getManifestPath() {
  return path.join(AppData.GetAudioDirectory(), 'manifest.json');
}

function ensureDirectory() {
  const Dir = AppData.GetAudioDirectory();
  if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
  return Dir;
}

// Strip an arbitrary string down to an alphanumeric, space-free label. Used for
// both the user-provided label and the default derived from the file name.
function SanitizeLabel(Input) {
  const Cleaned = String(Input == null ? '' : Input)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, MAX_LABEL_LENGTH);
  return Cleaned || 'Audio';
}

Manager.SanitizeLabel = SanitizeLabel;

function NormalizeExtension(NameOrExt) {
  const Ext = String(NameOrExt || '')
    .split('.')
    .pop()
    .toLowerCase()
    .trim();
  return Ext;
}

Manager.IsAllowedExtension = (NameOrExt) => ALLOWED_EXTENSIONS.has(NormalizeExtension(NameOrExt));

Manager.GetLimits = () => ({
  MaxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  MaxDurationSeconds: MAX_DURATION_SECONDS,
  AllowedExtensions: Array.from(ALLOWED_EXTENSIONS),
});

function ClampVolume(Value) {
  let Volume = Number(Value);
  if (!Number.isFinite(Volume)) Volume = 100;
  Volume = Math.round(Volume);
  if (Volume < 0) Volume = 0;
  if (Volume > 200) Volume = 200;
  return Volume;
}

Manager.ClampVolume = ClampVolume;

// Best-effort magic-byte sniff so obviously non-audio files are rejected before
// the renderer even tries to decode them. Permissive by design: the renderer's
// decode step is the authoritative validity check.
function looksLikeAudio(Buffer) {
  if (!Buffer || Buffer.length < 4) return false;

  const ascii = (start, len) => Buffer.slice(start, start + len).toString('latin1');

  // WAV: "RIFF"...."WAVE"
  if (ascii(0, 4) === 'RIFF' && Buffer.length >= 12 && ascii(8, 4) === 'WAVE') return true;
  // Ogg / Opus: "OggS"
  if (ascii(0, 4) === 'OggS') return true;
  // FLAC: "fLaC"
  if (ascii(0, 4) === 'fLaC') return true;
  // MP3 with ID3 tag
  if (ascii(0, 3) === 'ID3') return true;
  // MP4 / M4A / AAC container: bytes 4-7 == "ftyp"
  if (Buffer.length >= 8 && ascii(4, 4) === 'ftyp') return true;
  // MPEG/ADTS frame sync: 0xFF followed by 0xEx/0xFx (covers MP3 + raw AAC)
  if (Buffer[0] === 0xff && (Buffer[1] & 0xe0) === 0xe0) return true;

  return false;
}

function readMagicHeader(FilePath) {
  let fileHandle;
  try {
    fileHandle = fs.openSync(FilePath, 'r');
    const Header = Buffer.alloc(16);
    fs.readSync(fileHandle, Header, 0, 16, 0);
    return Header;
  } catch {
    return null;
  } finally {
    if (fileHandle !== undefined) {
      try {
        fs.closeSync(fileHandle);
      } catch {
        /* ignore */
      }
    }
  }
}

function toDataURL(FilePath, Extension) {
  const Mime = MIME_BY_EXTENSION[Extension] || 'application/octet-stream';
  const Data = fs.readFileSync(FilePath);
  return `data:${Mime};base64,${Data.toString('base64')}`;
}

function loadManifest() {
  const ManifestPath = getManifestPath();
  if (!fs.existsSync(ManifestPath)) {
    Assets = [];
    return;
  }
  try {
    const Raw = fs.readFileSync(ManifestPath, 'utf8');
    const Parsed = JSON.parse(Raw);
    Assets = Array.isArray(Parsed) ? Parsed.filter((A) => A && A.ID) : [];
  } catch (Err) {
    Logger.error('Failed to read audio manifest, starting empty', Err);
    Assets = [];
  }
}

function persistManifest() {
  ensureDirectory();
  try {
    fs.writeFileSync(getManifestPath(), JSON.stringify(Assets, null, 2), 'utf8');
    return true;
  } catch (Err) {
    Logger.error('Failed to persist audio manifest', Err);
    return false;
  }
}

function publicShape(Asset) {
  return {
    ID: Asset.ID,
    Label: Asset.Label,
    OriginalName: Asset.OriginalName || '',
    Extension: Asset.Extension,
    Volume: ClampVolume(Asset.Volume),
    Size: Asset.Size || 0,
    Duration: Asset.Duration == null ? null : Asset.Duration,
    Timestamp: Asset.Timestamp || 0,
    Missing: !assetFileExists(Asset),
  };
}

function assetFileExists(Asset) {
  if (!Asset || !Asset.FileName) return false;
  return fs.existsSync(path.join(AppData.GetAudioDirectory(), Asset.FileName));
}

Manager.Init = async () => {
  if (Initialized) return;
  ensureDirectory();
  loadManifest();
  Initialized = true;
};

Manager.GetAll = async () => {
  if (!Initialized) await Manager.Init();
  return Ok(Assets.map(publicShape));
};

Manager.Get = (ID) => {
  return Assets.find((A) => A.ID === ID) || null;
};

Manager.Exists = (ID) => {
  const Asset = Manager.Get(ID);
  return !!(Asset && assetFileExists(Asset));
};

// Returns the list of referenced asset IDs that no longer resolve to a file on
// disk. Used by the boot-time show validation to warn the operator.
Manager.FindMissing = (ReferencedIDs) => {
  const Unique = Array.from(new Set((ReferencedIDs || []).filter(Boolean)));
  return Unique.filter((ID) => !Manager.Exists(ID));
};

// Returns a base64 data URL for an asset so the renderer (loaded from file://
// with webSecurity enabled) can preview/play it via Howler.
Manager.GetDataURL = (ID) => {
  if (!Initialized) return Fail('Audio assets not initialized');
  const Asset = Manager.Get(ID);
  if (!Asset) return Fail('Audio asset not found');
  if (!assetFileExists(Asset)) return Fail('Audio asset file is missing');
  try {
    const FilePath = path.join(AppData.GetAudioDirectory(), Asset.FileName);
    return Ok({
      ID: Asset.ID,
      Label: Asset.Label,
      Volume: ClampVolume(Asset.Volume),
      DataURL: toDataURL(FilePath, Asset.Extension),
    });
  } catch (Err) {
    Logger.error('Failed to read audio asset data', Err);
    return Fail('Failed to read audio asset');
  }
};

// Validates a candidate source file and returns its metadata + base64 data URL
// so the renderer can run the duration check before importing.
Manager.InspectCandidate = (FilePath) => {
  const OriginalName = path.basename(String(FilePath || ''));
  const Extension = NormalizeExtension(OriginalName);
  const Result = {
    Path: FilePath,
    OriginalName,
    BaseLabel: SanitizeLabel(OriginalName.replace(/\.[^.]+$/, '')),
    Extension,
    Size: 0,
    DataURL: null,
    Error: null,
  };

  if (!ALLOWED_EXTENSIONS.has(Extension)) {
    Result.Error = `Unsupported file type: .${Extension || '?'}`;
    return Result;
  }

  let Stat;
  try {
    Stat = fs.statSync(FilePath);
  } catch {
    Result.Error = 'File could not be read';
    return Result;
  }
  if (!Stat.isFile()) {
    Result.Error = 'Not a file';
    return Result;
  }
  Result.Size = Stat.size;
  if (Stat.size > MAX_FILE_SIZE_BYTES) {
    Result.Error = `File is too large (max ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`;
    return Result;
  }
  if (Stat.size === 0) {
    Result.Error = 'File is empty';
    return Result;
  }

  const Header = readMagicHeader(FilePath);
  if (!looksLikeAudio(Header)) {
    Result.Error = 'File does not appear to be a valid audio file';
    return Result;
  }

  try {
    Result.DataURL = toDataURL(FilePath, Extension);
  } catch {
    Result.Error = 'File could not be read';
    return Result;
  }

  return Result;
};

// Copies a validated source file into the Audio store and records it in the
// manifest. Re-validates server-side (size/magic/ext) so the renderer cannot
// smuggle in an invalid or oversized file via a crafted path.
Manager.Import = async (Payload) => {
  if (!Initialized) await Manager.Init();

  const SourcePath = Payload && Payload.SourcePath ? String(Payload.SourcePath) : '';
  if (!SourcePath) return Fail('Source path is required');

  const Inspection = Manager.InspectCandidate(SourcePath);
  if (Inspection.Error) return Fail(Inspection.Error);

  let Duration = Number(Payload && Payload.Duration);
  if (!Number.isFinite(Duration) || Duration <= 0) Duration = null;
  if (Duration != null && Duration > MAX_DURATION_SECONDS + 0.5) {
    return Fail(`Audio must be shorter than ${MAX_DURATION_SECONDS} seconds`);
  }

  const Label = SanitizeLabel(Payload && Payload.Label ? Payload.Label : Inspection.BaseLabel);
  const Volume = ClampVolume(Payload && Payload.Volume);

  const ID = UUID.Generate();
  const FileName = `${ID}.${Inspection.Extension}`;
  const DestinationPath = path.join(ensureDirectory(), FileName);

  try {
    fs.copyFileSync(SourcePath, DestinationPath);
  } catch (Err) {
    Logger.error('Failed to copy audio asset into store', Err);
    return Fail('Failed to save audio file');
  }

  const Asset = {
    ID,
    Label,
    FileName,
    OriginalName: Inspection.OriginalName,
    Extension: Inspection.Extension,
    Volume,
    Size: Inspection.Size,
    Duration,
    Timestamp: Date.now(),
  };

  Assets.push(Asset);
  if (!persistManifest()) {
    // Roll back the copied file if we could not record it.
    Assets = Assets.filter((A) => A.ID !== ID);
    try {
      fs.unlinkSync(DestinationPath);
    } catch {
      /* ignore */
    }
    return Fail('Failed to save audio asset');
  }

  Logger.info(`Imported audio asset ${Label} (${ID})`);
  return Ok(publicShape(Asset));
};

Manager.Update = async (ID, Payload) => {
  if (!Initialized) await Manager.Init();
  const Asset = Manager.Get(ID);
  if (!Asset) return Fail('Audio asset not found');

  if (Payload && Object.prototype.hasOwnProperty.call(Payload, 'Label')) {
    Asset.Label = SanitizeLabel(Payload.Label);
  }
  if (Payload && Object.prototype.hasOwnProperty.call(Payload, 'Volume')) {
    Asset.Volume = ClampVolume(Payload.Volume);
  }

  if (!persistManifest()) return Fail('Failed to update audio asset');
  return Ok(publicShape(Asset));
};

Manager.Delete = async (ID) => {
  if (!Initialized) await Manager.Init();
  const Asset = Manager.Get(ID);
  if (!Asset) return Fail('Audio asset not found');

  try {
    const FilePath = path.join(AppData.GetAudioDirectory(), Asset.FileName);
    if (fs.existsSync(FilePath)) fs.unlinkSync(FilePath);
  } catch (Err) {
    Logger.error('Failed to delete audio asset file', Err);
  }

  Assets = Assets.filter((A) => A.ID !== ID);
  if (!persistManifest()) return Fail('Failed to delete audio asset');
  return Ok({ ID });
};

module.exports = {
  Manager,
};
