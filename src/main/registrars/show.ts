// IPC registrar: ShowTrak file save/open flows. Returns [err, result] tuples
// consistently. Extracted verbatim from main.ts.

import path from 'path';

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { sendShowFileUpdated } from '../app-window';
import { Manager as BackupManager } from '../../Modules/BackupManager';
import { Manager as FileSelectorManager } from '../../Modules/FileSelectorManager';
import { RecordEdit } from '../../Modules/AuditLog/edits';
import { Line, Value } from '../../Modules/AuditLog/message';
import { AuditStep } from '../../Modules/Shared/audit-names';

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

function register(): void {
  RPC.handle('Show:Save', async () => {
    let CurrentPath = BackupManager.GetCurrentFilePath();
    if (!CurrentPath) {
      // No file opened or saved yet this session — fall back to Save As.
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

  RPC.handle('Show:Open', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenDialog('Open ShowTrak File');
    if (canceled || !filePaths || filePaths.length === 0) {
      Logger.log('Show:Open canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Opening ShowTrak file from:', filePaths[0]);
    const [Err, Result] = await BackupManager.Open(filePaths[0]!); // non-empty checked above
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Opened Show File ', filePaths[0]!);
    return [null, Result];
  });

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

  RPC.handle('Show:New', async () => {
    Logger.log('Creating new ShowTrak show');
    const [Err, Result] = await BackupManager.New();
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    await RecordShowFile('Started a new Show File', null);
    return [null, Result];
  });
}

export { register };
