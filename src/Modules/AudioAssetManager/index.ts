// AudioAssetManager
// Owns the catalog of user-imported custom audio files used as alert sounds.
import fs from 'fs';
import path from 'path';

import { CreateLogger } from '../Logger';
import { Manager as AppData } from '../AppData';
import { Manager as UUID } from '../UUID';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';

const Logger = CreateLogger('AudioAssetManager');

// A stored audio asset as recorded in the on-disk manifest.
interface AudioAsset {
  ID: string;
  Label: string;
  FileName: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Duration: number | null;
  Timestamp: number;
}

// The renderer-facing projection of an asset (adds Missing, omits FileName).
interface PublicAudioAsset {
  ID: string;
  Label: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Duration: number | null;
  Timestamp: number;
  Missing: boolean;
}

interface AudioDataURL {
  ID: string;
  Label: string;
  Volume: number;
  DataURL: string;
}

// Result of inspecting a candidate source file before import.
interface AudioInspection {
  Path: unknown;
  OriginalName: string;
  BaseLabel: string;
  Extension: string;
  Size: number;
  DataURL: string | null;
  Error: string | null;
}

interface AudioImportPayload {
  SourcePath?: unknown;
  Label?: unknown;
  Volume?: unknown;
  Duration?: unknown;
}

interface AudioUpdatePayload {
  Label?: unknown;
  Volume?: unknown;
}

interface AudioAssetManagerType {
  SanitizeLabel(Input: unknown): string;
  IsAllowedExtension(NameOrExt: unknown): boolean;
  GetLimits(): {
    MaxFileSizeBytes: number;
    MaxDurationSeconds: number;
    AllowedExtensions: string[];
  };
  ClampVolume(Value: unknown): number;
  Init(): Promise<void>;
  GetAll(): Promise<Result<PublicAudioAsset[]>>;
  Get(ID: string): AudioAsset | null;
  Exists(ID: string): boolean;
  FindMissing(ReferencedIDs: unknown): string[];
  GetDataURL(ID: string): Result<AudioDataURL>;
  InspectCandidate(FilePath: unknown): AudioInspection;
  Import(Payload: AudioImportPayload | null | undefined): Promise<Result<PublicAudioAsset>>;
  Update(ID: string, Payload: AudioUpdatePayload | null | undefined): Promise<Result<PublicAudioAsset>>;
  Delete(ID: string): Promise<Result<{ ID: string }>>;
}

const Manager = {} as AudioAssetManagerType;

// Reasonable, conservative limits.
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15;
const MAX_LABEL_LENGTH = 40;

const ALLOWED_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus']);

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
};

let Initialized = false;
let Assets: AudioAsset[] = [];

function getManifestPath(): string {
  return path.join(AppData.GetAudioDirectory(), 'manifest.json');
}

function ensureDirectory(): string {
  const Dir = AppData.GetAudioDirectory();
  if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
  return Dir;
}

// Strip an arbitrary string down to an alphanumeric, space-free label.
function SanitizeLabel(Input: unknown): string {
  const Cleaned = String(Input == null ? '' : Input)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, MAX_LABEL_LENGTH);
  return Cleaned || 'Audio';
}

Manager.SanitizeLabel = SanitizeLabel;

function NormalizeExtension(NameOrExt: unknown): string {
  const Ext = String(NameOrExt || '')
    .split('.')
    .pop()!
    .toLowerCase()
    .trim();
  return Ext;
}

Manager.IsAllowedExtension = (NameOrExt: unknown) =>
  ALLOWED_EXTENSIONS.has(NormalizeExtension(NameOrExt));

Manager.GetLimits = () => ({
  MaxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  MaxDurationSeconds: MAX_DURATION_SECONDS,
  AllowedExtensions: Array.from(ALLOWED_EXTENSIONS),
});

function ClampVolume(Value: unknown): number {
  let Volume = Number(Value);
  if (!Number.isFinite(Volume)) Volume = 100;
  Volume = Math.round(Volume);
  if (Volume < 0) Volume = 0;
  if (Volume > 200) Volume = 200;
  return Volume;
}

Manager.ClampVolume = ClampVolume;

// Best-effort magic-byte sniff so obviously non-audio files are rejected.
function looksLikeAudio(Buf: Buffer | null): boolean {
  if (!Buf || Buf.length < 4) return false;

  const ascii = (start: number, len: number) => Buf.slice(start, start + len).toString('latin1');

  // WAV: "RIFF"...."WAVE"
  if (ascii(0, 4) === 'RIFF' && Buf.length >= 12 && ascii(8, 4) === 'WAVE') return true;
  // Ogg / Opus: "OggS"
  if (ascii(0, 4) === 'OggS') return true;
  // FLAC: "fLaC"
  if (ascii(0, 4) === 'fLaC') return true;
  // MP3 with ID3 tag
  if (ascii(0, 3) === 'ID3') return true;
  // MP4 / M4A / AAC container: bytes 4-7 == "ftyp"
  if (Buf.length >= 8 && ascii(4, 4) === 'ftyp') return true;
  // MPEG/ADTS frame sync: 0xFF followed by 0xEx/0xFx (covers MP3 + raw AAC)
  if (Buf[0] === 0xff && ((Buf[1] ?? 0) & 0xe0) === 0xe0) return true;

  return false;
}

function readMagicHeader(FilePath: string): Buffer | null {
  let fileHandle: number | undefined;
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

function toDataURL(FilePath: string, Extension: string): string {
  const Mime = MIME_BY_EXTENSION[Extension] || 'application/octet-stream';
  const Data = fs.readFileSync(FilePath);
  return `data:${Mime};base64,${Data.toString('base64')}`;
}

function loadManifest(): void {
  const ManifestPath = getManifestPath();
  if (!fs.existsSync(ManifestPath)) {
    Assets = [];
    return;
  }
  try {
    const Raw = fs.readFileSync(ManifestPath, 'utf8');
    const Parsed = JSON.parse(Raw);
    Assets = Array.isArray(Parsed) ? Parsed.filter((A: AudioAsset) => A && A.ID) : [];
  } catch (Err) {
    Logger.error('Failed to read audio manifest, starting empty', Err);
    Assets = [];
  }
}

function persistManifest(): boolean {
  ensureDirectory();
  try {
    fs.writeFileSync(getManifestPath(), JSON.stringify(Assets, null, 2), 'utf8');
    return true;
  } catch (Err) {
    Logger.error('Failed to persist audio manifest', Err);
    return false;
  }
}

function publicShape(Asset: AudioAsset): PublicAudioAsset {
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

function assetFileExists(Asset: AudioAsset | null | undefined): boolean {
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

Manager.Get = (ID: string) => {
  return Assets.find((A) => A.ID === ID) || null;
};

Manager.Exists = (ID: string) => {
  const Asset = Manager.Get(ID);
  return !!(Asset && assetFileExists(Asset));
};

// Returns the list of referenced asset IDs that no longer resolve to a file.
Manager.FindMissing = (ReferencedIDs: unknown) => {
  const Unique = Array.from(new Set(((ReferencedIDs as string[]) || []).filter(Boolean)));
  return Unique.filter((ID) => !Manager.Exists(ID));
};

// Returns a base64 data URL for an asset so the renderer can preview/play it.
Manager.GetDataURL = (ID: string) => {
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

// Validates a candidate source file and returns its metadata + base64 data URL.
Manager.InspectCandidate = (FilePath: unknown) => {
  const OriginalName = path.basename(String(FilePath || ''));
  const Extension = NormalizeExtension(OriginalName);
  const Result: AudioInspection = {
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
    Stat = fs.statSync(String(FilePath));
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

  const Header = readMagicHeader(String(FilePath));
  if (!looksLikeAudio(Header)) {
    Result.Error = 'File does not appear to be a valid audio file';
    return Result;
  }

  try {
    Result.DataURL = toDataURL(String(FilePath), Extension);
  } catch {
    Result.Error = 'File could not be read';
    return Result;
  }

  return Result;
};

// Copies a validated source file into the Audio store and records it in the manifest.
Manager.Import = async (Payload: AudioImportPayload | null | undefined) => {
  if (!Initialized) await Manager.Init();

  const SourcePath = Payload && Payload.SourcePath ? String(Payload.SourcePath) : '';
  if (!SourcePath) return Fail('Source path is required');

  const Inspection = Manager.InspectCandidate(SourcePath);
  if (Inspection.Error) return Fail(Inspection.Error);

  let Duration: number | null = Number(Payload && Payload.Duration);
  if (!Number.isFinite(Duration) || (Duration as number) <= 0) Duration = null;
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

Manager.Update = async (ID: string, Payload: AudioUpdatePayload | null | undefined) => {
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

Manager.Delete = async (ID: string) => {
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

export { Manager };
