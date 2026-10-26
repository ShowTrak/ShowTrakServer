import path from 'path';
import fs from 'fs';

import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { Manager as AppDataManager } from '../AppData';
import { Manager as Broadcast } from '../Broadcast';
import { Config } from '../Config';
import { CompareVersions } from '../Utils';
import { CreateShowFileInfoRepository } from '../DB/repositories/show-file-info';

const Logger = CreateLogger('BackupManager');
const ShowFileInfo = CreateShowFileInfoRepository(DB);

type BackupResult<T> = [string | null, T | null];

// A show file last saved by an older ShowTrak Server, waiting on the operator
// to agree to upgrade it. FileVersion is null for a file saved before versions
// were stamped into show files.
interface ShowFileUpgrade {
  FilePath: string;
  FileName: string;
  FileVersion: string | null;
  CurrentVersion: string;
}

type OpenOutcome =
  { Status: 'Opened'; FilePath: string } | { Status: 'UpgradeRequired'; Upgrade: ShowFileUpgrade };

// The DB layer's error slot is opaque (Error or string); flatten it for the
// renderer-facing [message, null] tuples.
function ErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function LoadPersistedFilePath(): string | null {
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

// Path of the .ShowTrak file currently in use. Persisted to disk (outside the
// swappable show database) so the same file is shown as "open" after a relaunch.
// Loaded once on startup from the app-level state file.
let CurrentFilePath: string | null = LoadPersistedFilePath();

function PersistFilePath(Value: string | null): void {
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

// The older show file the operator is being asked whether to upgrade. Nothing
// writes to it, not even autosave, until they answer.
let PendingUpgrade: ShowFileUpgrade | null = null;

// Files this session may overwrite without looking again: already backed up,
// or found to have been saved by this version. Keyed by SamePathKey.
const SafeToOverwrite = new Set<string>();

function SamePathKey(FilePath: string): string {
  const Resolved = path.resolve(FilePath);
  return process.platform === 'linux' ? Resolved : Resolved.toLowerCase();
}

function IsSamePath(A: string | null, B: string | null): boolean {
  return !!A && !!B && SamePathKey(A) === SamePathKey(B);
}

function BackupTimestamp(At: Date): string {
  const Pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${At.getFullYear()}-${Pad(At.getMonth() + 1)}-${Pad(At.getDate())} ` +
    `${Pad(At.getHours())}-${Pad(At.getMinutes())}-${Pad(At.getSeconds())}`
  );
}

function HoldForUpgrade(FilePath: string, FileVersion: string | null): ShowFileUpgrade {
  PendingUpgrade = {
    FilePath,
    FileName: path.basename(FilePath),
    FileVersion,
    CurrentVersion: Config.Application.Version,
  };
  Logger.log('Show file needs upgrading, awaiting confirmation:', FilePath);
  return PendingUpgrade;
}

const Manager = {
  GetCurrentFilePath(): string | null {
    return CurrentFilePath;
  },

  // Whether the show file at FilePath was last saved by an older ShowTrak
  // Server than this one (or before versions were recorded at all), and so
  // would be upgraded by this version writing to it.
  async InspectFile(
    FilePath: string
  ): Promise<BackupResult<{ NeedsUpgrade: boolean; FileVersion: string | null }>> {
    const [Err, Info] = await DB.ReadFileInfo(FilePath);
    if (Err || !Info) return [ErrorMessage(Err), null];
    const FileVersion = Info.SavedWithVersion;
    const NeedsUpgrade =
      !FileVersion || CompareVersions(FileVersion, Config.Application.Version) < 0;
    return [null, { NeedsUpgrade, FileVersion }];
  },

  // Copy a show file, untouched, into the Backups folder before anything is
  // written to it. The copy is named after the original and the version that
  // last saved it, e.g. "Main Stage (v3.28.0) 2026-10-26 14-03-12.ShowTrak".
  BackupFile(FilePath: string, FileVersion: string | null): BackupResult<string> {
    try {
      const Dir = AppDataManager.GetBackupsDirectory();
      if (!fs.existsSync(Dir)) fs.mkdirSync(Dir, { recursive: true });
      const Ext = path.extname(FilePath) || '.ShowTrak';
      const Base = path.basename(FilePath, path.extname(FilePath));
      const Stem = `${Base} (v${FileVersion || 'unknown'}) ${BackupTimestamp(new Date())}`;
      let Target = path.join(Dir, `${Stem}${Ext}`);
      for (let n = 2; fs.existsSync(Target); n++) Target = path.join(Dir, `${Stem} (${n})${Ext}`);
      fs.copyFileSync(FilePath, Target, fs.constants.COPYFILE_EXCL);
      SafeToOverwrite.add(SamePathKey(FilePath));
      Logger.log('Backed up show file before upgrading it:', FilePath, '->', Target);
      return [null, Target];
    } catch (err) {
      Logger.error('Failed to back up show file:', err);
      return [`Failed to back up the show file: ${ErrorMessage(err)}`, null];
    }
  },

  // "Open" from the UI. A file saved by this version (or a newer one) opens
  // straight away. An older one is left untouched and held as the pending
  // upgrade until the operator answers with AcceptUpgrade or DeclineUpgrade.
  async RequestOpen(FilePath: string): Promise<BackupResult<OpenOutcome>> {
    if (!fs.existsSync(FilePath)) {
      Logger.error('ShowTrak file does not exist:', FilePath);
      return ['ShowTrak file does not exist', null];
    }
    const [InspectErr, Inspection] = await Manager.InspectFile(FilePath);
    if (InspectErr || !Inspection) return [InspectErr, null];
    if (Inspection.NeedsUpgrade) {
      return [
        null,
        { Status: 'UpgradeRequired', Upgrade: HoldForUpgrade(FilePath, Inspection.FileVersion) },
      ];
    }
    const [OpenErr] = await Manager.Open(FilePath);
    if (OpenErr) return [OpenErr, null];
    return [null, { Status: 'Opened', FilePath }];
  },

  // Boot-time check of the show file left open last session. After ShowTrak
  // Server updates it was last saved by an older version, so it is held as the
  // pending upgrade until the operator answers. Returns that upgrade, or null
  // when there is nothing to ask.
  async CheckCurrentFile(): Promise<BackupResult<ShowFileUpgrade | null>> {
    if (PendingUpgrade) return [null, PendingUpgrade];
    const FilePath = CurrentFilePath;
    if (!FilePath || !fs.existsSync(FilePath)) return [null, null];
    if (SafeToOverwrite.has(SamePathKey(FilePath))) return [null, null];
    const [Err, Inspection] = await Manager.InspectFile(FilePath);
    if (Err || !Inspection) return [Err, null];
    if (!Inspection.NeedsUpgrade) {
      SafeToOverwrite.add(SamePathKey(FilePath));
      return [null, null];
    }
    return [null, HoldForUpgrade(FilePath, Inspection.FileVersion)];
  },

  GetPendingUpgrade(): ShowFileUpgrade | null {
    return PendingUpgrade;
  },

  // The operator agreed to upgrade the pending file: back it up, then open it
  // and save it straight back so the file itself is upgraded. When it is the
  // file already open from last session, the working data (which may hold
  // changes not yet saved) is kept as it is and the file is upgraded on its
  // next save.
  async AcceptUpgrade(): Promise<BackupResult<{ FilePath: string; BackupPath: string }>> {
    const Upgrade = PendingUpgrade;
    if (!Upgrade) return ['No show file upgrade is waiting for confirmation', null];
    if (!fs.existsSync(Upgrade.FilePath)) {
      PendingUpgrade = null;
      return ['ShowTrak file does not exist', null];
    }
    const [BackupErr, BackupPath] = Manager.BackupFile(Upgrade.FilePath, Upgrade.FileVersion);
    if (BackupErr || !BackupPath) return [BackupErr, null];
    PendingUpgrade = null;
    if (!IsSamePath(Upgrade.FilePath, CurrentFilePath)) {
      const [OpenErr] = await Manager.Open(Upgrade.FilePath);
      if (OpenErr) return [OpenErr, null];
      const [SaveErr] = await Manager.Save(Upgrade.FilePath);
      if (SaveErr) return [SaveErr, null];
    }
    return [null, { FilePath: Upgrade.FilePath, BackupPath }];
  },

  // The operator declined: the older file is left exactly as it is and the
  // working data is cleared with no show file open, ready for a new show to
  // be created in its place.
  async DeclineUpgrade(): Promise<BackupResult<string>> {
    if (!PendingUpgrade) return ['No show file upgrade is waiting for confirmation', null];
    PendingUpgrade = null;
    const [Err] = await DB.ResetToEmpty();
    if (Err) {
      Logger.error('Failed to clear working data after a declined upgrade:', Err);
      return [ErrorMessage(Err), null];
    }
    if (typeof DB.MarkClean === 'function') DB.MarkClean();
    PersistFilePath(null);
    Broadcast.emit('ReinitializeSystem');
    return [null, 'Upgrade declined'];
  },

  // Boot-time integrity check: if a show file was open last session but has since
  // been deleted or moved, the working database no longer corresponds to a real
  // file. Wipe the working data and clear the pointer so the user is prompted to
  // open an existing file or create a new one (instead of silently editing data
  // that can no longer be saved back to its origin). Returns { Missing } where
  // Missing indicates the previously open file was gone, and FilePath where it
  // was expected.
  async EnsureCurrentFileExists(): Promise<BackupResult<{ Missing: boolean; FilePath?: string }>> {
    if (!CurrentFilePath) return [null, { Missing: false }];
    if (fs.existsSync(CurrentFilePath)) return [null, { Missing: false }];
    const MissingPath = CurrentFilePath;

    Logger.warn('Previously open show file is missing, wiping working data:', MissingPath);
    const [Err] = await DB.ResetToEmpty();
    if (Err) {
      Logger.error('Failed to wipe working data after missing show file:', Err);
      return [ErrorMessage(Err), null];
    }
    if (typeof DB.MarkClean === 'function') DB.MarkClean();
    PersistFilePath(null);
    Broadcast.emit('ReinitializeSystem');
    return [null, { Missing: true, FilePath: MissingPath }];
  },

  // True when the working database holds data but no show file is associated with
  // it (e.g. upgrading from a pre-show-file version). The renderer uses this to
  // force a "Save As" before continuing so the legacy data is not lost.
  async HasUnsavedWorkingData(): Promise<boolean> {
    if (CurrentFilePath) return false;
    return await DB.HasData();
  },

  async HasUnsavedChanges(): Promise<boolean> {
    if (typeof DB.HasUnsavedChanges !== 'function') return false;
    return await DB.HasUnsavedChanges();
  },

  // "Save As" — write the entire working database out to a portable .ShowTrak
  // file. The whole database is dumped as a single snapshot, so there is no
  // per-table maintenance and runtime performance is unaffected (the cost is
  // taken only when saving).
  //
  // Every save stamps the file with this version. A file an older version saved
  // is never overwritten unseen: the pending upgrade, or the file left open
  // last session before its upgrade is confirmed, is refused; any other older
  // show file (one replaced by Save As, say) is backed up first.
  async Save(Path: string): Promise<BackupResult<string>> {
    Logger.log('Saving ShowTrak file to:', Path);
    if (PendingUpgrade && IsSamePath(Path, PendingUpgrade.FilePath)) {
      return ['Confirm the show file upgrade before saving', null];
    }
    const Key = SamePathKey(Path);
    if (!SafeToOverwrite.has(Key) && fs.existsSync(Path)) {
      // A file that is not a show file at all is left to the save dialog.
      const [, Inspection] = await Manager.InspectFile(Path);
      if (Inspection && Inspection.NeedsUpgrade) {
        if (IsSamePath(Path, CurrentFilePath)) {
          Logger.warn('Refusing to save over an older show file before its upgrade is confirmed');
          return ['Confirm the show file upgrade before saving', null];
        }
        const [BackupErr] = Manager.BackupFile(Path, Inspection.FileVersion);
        if (BackupErr) return [BackupErr, null];
      }
    }
    const [StampErr] = await ShowFileInfo.Set('SavedWithVersion', Config.Application.Version);
    if (StampErr) {
      Logger.error('Failed to stamp the show file version:', StampErr);
      return [ErrorMessage(StampErr), null];
    }
    const [Err] = await DB.SnapshotTo(Path);
    if (Err) {
      Logger.error('Failed to save ShowTrak file:', Err);
      return [ErrorMessage(Err), null];
    }
    if (typeof DB.MarkClean === 'function') DB.MarkClean();
    SafeToOverwrite.add(Key);
    PersistFilePath(Path);
    return [null, 'Saved successfully'];
  },

  // "Open" — replace the working database with the selected .ShowTrak file. The
  // DB layer validates the file, swaps it in, and re-applies schema migrations.
  // A full re-hydration of in-memory caches/UI is then triggered. The UI goes
  // through RequestOpen, which asks before an older file is upgraded.
  async Open(Path: string): Promise<BackupResult<string>> {
    Logger.log('Opening ShowTrak file from:', Path);
    if (!fs.existsSync(Path)) {
      Logger.error('ShowTrak file does not exist:', Path);
      return ['ShowTrak file does not exist', null];
    }
    const [Err] = await DB.ReplaceWithFile(Path);
    if (Err) {
      Logger.error('Failed to open ShowTrak file:', Err);
      return [ErrorMessage(Err), null];
    }
    if (typeof DB.MarkClean === 'function') DB.MarkClean();
    PersistFilePath(Path);
    Broadcast.emit('ReinitializeSystem');
    return [null, 'Opened successfully'];
  },

  // "New" — reset the working database to an empty show and save it straight
  // away to Path, so a new show always has a file behind it.
  async New(Path: string): Promise<BackupResult<string>> {
    Logger.log('Creating new ShowTrak show at:', Path);
    const [Err] = await DB.ResetToEmpty();
    if (Err) {
      Logger.error('Failed to create new show:', Err);
      return [ErrorMessage(Err), null];
    }
    if (typeof DB.MarkClean === 'function') DB.MarkClean();
    PersistFilePath(null);
    Broadcast.emit('ReinitializeSystem');
    const [StampErr] = await ShowFileInfo.Set('CreatedWithVersion', Config.Application.Version);
    if (StampErr) Logger.error('Failed to stamp the show file creation version:', StampErr);
    const [SaveErr] = await Manager.Save(Path);
    if (SaveErr) return [SaveErr, null];
    return [null, 'New show created'];
  },
};

export { Manager };
export type { OpenOutcome, ShowFileUpgrade };
