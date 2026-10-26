// IPC registrar: ShowTrak file save/open flows. Returns [err, result] tuples
// consistently. Extracted verbatim from main.ts.

import path from 'path';

import { CreateLogger } from '../../Modules/Logger';
import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { sendShowFileUpdated } from '../app-window';
import { Manager as BackupManager } from '../../Modules/BackupManager';
import { Manager as FileSelectorManager } from '../../Modules/FileSelectorManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';
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

  // A file an older version saved is not opened yet: the result carries the
  // upgrade for the renderer to put to the operator, answered through
  // Show:ResolveUpgrade.
  RPC.handle('Show:Open', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenDialog('Open ShowTrak File');
    if (canceled || !filePaths || filePaths.length === 0) {
      Logger.log('Show:Open canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Opening ShowTrak file from:', filePaths[0]);
    const [Err, Result] = await BackupManager.RequestOpen(filePaths[0]!); // non-empty checked above
    if (Err || !Result) return [Err, null];
    if (Result.Status === 'Opened') {
      sendShowFileUpdated(BackupManager.GetCurrentFilePath());
      await RecordShowFile('Opened Show File ', filePaths[0]!);
    }
    return [null, Result];
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
