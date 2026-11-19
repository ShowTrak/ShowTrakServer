// IPC registrar: ShowTrak file save/open flows. Returns [err, result] tuples
// consistently. Extracted verbatim from main.ts.

import path from 'path';

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { getMainWindow, sendShowFileUpdated } from '../app-window';
import { TakeShowFileRequest } from '../file-associations';
import { ConfirmShowFileReplace, type ReplacePromptDeps } from '../show-file-replace-prompt';
import { Manager as BackupManager } from '../../Modules/BackupManager';
import { Manager as FileSelectorManager } from '../../Modules/FileSelectorManager';
import { Manager as SettingsManager } from '../../Modules/SettingsManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';
import { RecordEdit } from '../../Modules/AuditLog/edits';
import { Line, Value } from '../../Modules/AuditLog/message';
import { AuditStep } from '../../Modules/Shared/audit-names';

const { dialog } = require('electron');

const Logger = CreateLogger('Main');

// The log lives outside the show database, so it outlasts an Open or New and
// says which Show File the entries after it belong to.
function RecordShowFile(Verb: string, FilePath: string | null): Promise<void> {
  return AuditStep(() =>
    RecordEdit({
      EntityType: 'system',
      EntityID: null,
      Summary: Line(Verb, FilePath ? Value(path.basename(FilePath)) : null),
      Details: FilePath ? [FilePath] : [],
    })
  );
}

// Open FilePath, asking before an older version's file is upgraded (the result
// then carries the upgrade for the renderer to put to the operator, answered
// through Show:ResolveUpgrade).
async function OpenShowFile(FilePath: string) {
  Logger.log('Opening ShowTrak file from:', FilePath);
  const [Err, Result] = await BackupManager.RequestOpen(FilePath);
  if (Err || !Result) return [Err, null];
  if (Result.Status === 'Opened') {
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Opened Show File ', FilePath);
  }
  return [null, Result];
}

function SamePath(A: string | null, B: string | null): boolean {
  if (!A || !B) return false;
  const Key = (P: string) =>
    process.platform === 'linux' ? path.resolve(P) : path.resolve(P).toLowerCase();
  return Key(A) === Key(B);
}

// The replace prompt's view of the app. Dialogs are parented to the main window
// once it is on screen; during start-up it is still hidden, and a sheet on a
// hidden window would never be seen.
const ReplacePromptDeps: ReplacePromptDeps = {
  GetCurrentFilePath: () => BackupManager.GetCurrentFilePath(),
  HasUnsavedChanges: () => BackupManager.HasUnsavedChanges(),
  HasUnsavedWorkingData: () => BackupManager.HasUnsavedWorkingData(),
  IsAutosaveEnabled: async () => {
    try {
      return !!(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED'));
    } catch (Err) {
      Logger.error('Failed to read the autosave setting:', Err);
      return false;
    }
  },
  Save: (FilePath) => BackupManager.Save(FilePath),
  PickSavePath: async () => {
    const { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
    return canceled || !filePath ? null : filePath;
  },
  ShowMessageBox: async (Options) => {
    const Window = getMainWindow();
    const { response } =
      Window && !Window.isDestroyed() && Window.isVisible()
        ? await dialog.showMessageBox(Window, Options)
        : await dialog.showMessageBox(Options);
    return response;
  },
  ShowError: (Title, Message) => dialog.showErrorBox(Title, Message),
  OnSaved: () => sendShowFileUpdated(BackupManager.GetCurrentFilePath()),
};

function register(): void {
  RPC.handle('Show:Save', async () => {
    let CurrentPath = BackupManager.GetCurrentFilePath();
    if (!CurrentPath) {
      // No file opened or saved yet this session; fall back to Save As.
      const { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
      if (canceled || !filePath) {
        Logger.log('Show:Save canceled');
        return ['Cancelled By User', null];
      }
      CurrentPath = filePath;
    }
    if (!CurrentPath) return ['Cancelled By User', null];
    Logger.log('Saving ShowTrak file to:', CurrentPath);
    const [Err, Result] = await BackupManager.Save(CurrentPath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Saved Show File ', CurrentPath);
    return [null, Result];
  });

  RPC.handle('Show:SaveAs', async () => {
    const { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
    if (canceled || !filePath) {
      Logger.log('Show:SaveAs canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Saving ShowTrak file to:', filePath);
    const [Err, Result] = await BackupManager.Save(filePath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Saved Show File as ', filePath);
    return [null, Result];
  });

  // A file an older version saved is not opened yet: the result carries the
  // upgrade for the renderer to put to the operator, answered through
  // Show:ResolveUpgrade.
  RPC.handle('Show:Open', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenDialog('Open ShowTrak File');
    if (canceled || !filePaths || filePaths.length === 0) {
      Logger.log('Show:Open canceled');
      return ['Cancelled By User', null];
    }
    return await OpenShowFile(filePaths[0]!); // non-empty checked above
  });

  // A show file opened from the operating system (double-clicked, or Open
  // With), held by ./file-associations until the renderer is ready for it. The
  // renderer asks once at start-up and again whenever ShowOpenRequested says
  // another has arrived. Nothing waiting, or the file already open, is
  // [null, null].
  RPC.handle('Show:OpenRequested', async () => {
    const Request = TakeShowFileRequest();
    if (!Request) return [null, null];
    if (SamePath(Request.FilePath, BackupManager.GetCurrentFilePath())) return [null, null];
    if (!(await ConfirmShowFileReplace(Request, ReplacePromptDeps))) {
      Logger.log('Show:OpenRequested canceled');
      return ['Cancelled By User', null];
    }
    return await OpenShowFile(Request.FilePath);
  });

  // Boot check: the show file left open last session, if an older version
  // last saved it, comes back as an upgrade to put to the operator.
  RPC.handle('Show:CheckUpgrade', async () => {
    return await BackupManager.CheckCurrentFile();
  });

  // The operator's answer to the pending upgrade: true backs the file up and
  // upgrades it, false leaves it untouched and clears the working data so a
  // new show can be created instead.
  RPC.handle(
    'Show:ResolveUpgrade',
    createTupleHandler<[boolean], unknown>(
      (Accept: unknown) => IPCValidation.Boolean(Accept, 'Accept'),
      async (Accept: boolean) => {
        if (Accept) {
          const [Err, Result] = await BackupManager.AcceptUpgrade();
          if (Err || !Result) return [Err, null];
          sendShowFileUpdated(BackupManager.GetCurrentFilePath());
          await RecordShowFile('Backed up and upgraded Show File ', Result.FilePath);
          return [null, Result];
        }
        const [Err, Result] = await BackupManager.DeclineUpgrade();
        if (Err) return [Err, null];
        sendShowFileUpdated(BackupManager.GetCurrentFilePath());
        return [null, Result];
      }
    )
  );

  RPC.handle('Show:GetCurrentFile', async () => {
    return BackupManager.GetCurrentFilePath();
  });

  RPC.handle('Show:HasUnsavedData', async () => {
    return await BackupManager.HasUnsavedWorkingData();
  });

  RPC.handle('Show:EnsureFileExists', async () => {
    const [Err, Result] = await BackupManager.EnsureCurrentFileExists();
    if (Err) return [Err, null];
    if (Result && Result.Missing) sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });

  // A new show is saved to a location of the operator's choosing before it
  // replaces the working data, so there is never a show without a file.
  RPC.handle('Show:New', async () => {
    const { canceled, filePath } = await FileSelectorManager.SaveDialog('Create New ShowTrak File');
    if (canceled || !filePath) {
      Logger.log('Show:New canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Creating new ShowTrak show at:', filePath);
    const [Err, Result] = await BackupManager.New(filePath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Started a new Show File ', filePath);
    return [null, Result];
  });
}

export { register };
