// IPC registrar: custom audio assets. Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { PushToRenderers } from '../renderer-bus';
import { Manager as AudioAssetManager } from '../../Modules/AudioAssetManager';
import { Manager as FileSelectorManager } from '../../Modules/FileSelectorManager';
import { Manager as AppDataManager } from '../../Modules/AppData';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  RPC.handle('Audio:GetAll', async () => {
    const [Err, List] = await AudioAssetManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('Audio:GetData', async (_Event: unknown, ID: unknown) => {
    let ValidID;
    try {
      ValidID = IPCValidation.AudioAssetID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Payload] = AudioAssetManager.GetDataURL(ValidID);
    if (Err) return [Err, null];
    return [null, Payload];
  });

  // Opens the OS file picker and returns inspected candidates (with base64 data
  // URLs) so the renderer can run the duration check before importing.
  RPC.handle('Audio:Select', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenAudioDialog('Select Audio Files');
    if (canceled || !filePaths || !filePaths.length) return [null, []];
    const Candidates = filePaths.map((FilePath: string) =>
      AudioAssetManager.InspectCandidate(FilePath)
    );
    return [null, Candidates];
  });

  RPC.handle('Audio:Import', async (_Event: unknown, Payload: unknown) => {
    let ValidPayload;
    try {
      ValidPayload = IPCValidation.AudioImportPayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Asset] = await AudioAssetManager.Import(ValidPayload);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Asset];
  });

  RPC.handle('Audio:Update', async (_Event: unknown, ID: unknown, Payload: unknown) => {
    let ValidID;
    let ValidPayload;
    try {
      ValidID = IPCValidation.AudioAssetID(ID);
      ValidPayload = IPCValidation.AudioUpdatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Asset] = await AudioAssetManager.Update(ValidID, ValidPayload);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Asset];
  });

  RPC.handle('Audio:Delete', async (_Event: unknown, ID: unknown) => {
    let ValidID;
    try {
      ValidID = IPCValidation.AudioAssetID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await AudioAssetManager.Delete(ValidID);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Result];
  });

  RPC.handle('Audio:OpenFolder', async () => {
    return AppDataManager.OpenFolder(AppDataManager.GetAudioDirectory());
  });
}

export { register };
