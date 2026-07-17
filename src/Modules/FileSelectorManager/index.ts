import path from 'path';
import fs from 'fs';
import { Manager as AppDataManager } from '../AppData';
const { dialog } = require('electron') as typeof import('electron');

const SHOWTRAK_FILE_FILTER = {
  name: 'ShowTrak File',
  extensions: ['ShowTrak'],
};

const AUDIO_FILE_FILTER = {
  name: 'Audio Files',
  extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'],
};

// The open/save pickers should reopen where the user last was. Electron's dialog
// no longer restores the last-used directory implicitly (with no defaultPath it
// falls back to the OS Downloads folder), so we persist the last directory per
// picker category ourselves and pass it back in as `defaultPath`.
type DialogCategory = 'show' | 'audio';

function DirectoryStorePath(): string {
  return path.join(AppDataManager.GetStorageDirectory(), 'dialog-directories.json');
}

function LoadLastDirectories(): Partial<Record<DialogCategory, string>> {
  try {
    const Parsed = JSON.parse(fs.readFileSync(DirectoryStorePath(), 'utf8'));
    return Parsed && typeof Parsed === 'object' ? (Parsed as Record<DialogCategory, string>) : {};
  } catch {
    // Missing/corrupt store just means "no remembered directory yet".
    return {};
  }
}

// The remembered directory for a category, or undefined when there is none or it
// no longer exists on disk (so a deleted folder can't send the picker nowhere).
function GetLastDirectory(Category: DialogCategory): string | undefined {
  const Dir = LoadLastDirectories()[Category];
  return Dir && fs.existsSync(Dir) ? Dir : undefined;
}

// Record the directory of a just-picked file. Best-effort: a failure to persist
// must never break the file operation the user actually asked for.
function RememberDirectory(Category: DialogCategory, FilePath: string | undefined): void {
  if (!FilePath) return;
  try {
    const Directories = LoadLastDirectories();
    Directories[Category] = path.dirname(FilePath);
    fs.writeFileSync(DirectoryStorePath(), JSON.stringify(Directories, null, 2), 'utf8');
  } catch {
    /* intentional: persisting the last directory is best-effort */
  }
}

export const Manager = {
  async OpenDialog(Title: string) {
    const Result = await dialog.showOpenDialog({
      title: Title,
      filters: [SHOWTRAK_FILE_FILTER],
      properties: ['openFile'],
      message: Title,
      defaultPath: GetLastDirectory('show'),
    });
    if (!Result.canceled) RememberDirectory('show', Result.filePaths[0]);
    return Result;
  },

  async OpenAudioDialog(Title: string) {
    const Result = await dialog.showOpenDialog({
      title: Title,
      filters: [AUDIO_FILE_FILTER],
      properties: ['openFile', 'multiSelections'],
      message: Title,
      defaultPath: GetLastDirectory('audio'),
    });
    if (!Result.canceled) RememberDirectory('audio', Result.filePaths[0]);
    return Result;
  },

  async SaveDialog(Title: string) {
    const CurrentDatestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 10);
    const DefaultName = `ShowTrak ${CurrentDatestamp}.ShowTrak`;
    const LastDirectory = GetLastDirectory('show');
    const Result = await dialog.showSaveDialog({
      title: Title,
      // Keep the datestamped filename, but seat it in the last-used directory so
      // the picker opens there instead of Downloads.
      defaultPath: LastDirectory ? path.join(LastDirectory, DefaultName) : DefaultName,
      filters: [SHOWTRAK_FILE_FILTER],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (!Result.canceled) RememberDirectory('show', Result.filePath);
    return Result;
  },
};
