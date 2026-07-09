// IPC registrar: ShowTrak file save/open flows. Returns [err, result] tuples
// consistently. Extracted verbatim from main.ts.

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { sendShowFileUpdated } from '../app-window';
const { Manager: BackupManager } = require('../../Modules/BackupManager');
const { Manager: FileSelectorManager } = require('../../Modules/FileSelectorManager');

const Logger = CreateLogger('Main');

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
    Logger.log('Saving ShowTrak file to:', CurrentPath);
    const [Err, Result] = await BackupManager.Save(CurrentPath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
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
    return [null, Result];
  });

  RPC.handle('Show:Open', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenDialog('Open ShowTrak File');
    if (canceled || !filePaths || filePaths.length === 0) {
      Logger.log('Show:Open canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Opening ShowTrak file from:', filePaths[0]);
    const [Err, Result] = await BackupManager.Open(filePaths[0]);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
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
    return [null, Result];
  });
}

export { register };
