// IPC registrar: custom audio assets. Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { PushToRenderers } from '../renderer-bus';
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { Manager: AudioAssetManager } = require('../../Modules/AudioAssetManager');
const { Manager: FileSelectorManager } = require('../../Modules/FileSelectorManager');
const { Manager: AppDataManager } = require('../../Modules/AppData');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

function register(): void {
  RPC.handle('Audio:GetAll', async () => {
    const [Err, List] = await AudioAssetManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('Audio:GetData', async (_Event: unknown, ID: unknown) => {
    try {
      ID = IPCValidation.AudioAssetID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Payload] = AudioAssetManager.GetDataURL(ID);
    if (Err) return [Err, null];
    return [null, Payload];
  });

  // Opens the OS file picker and returns inspected candidates (with base64 data
  // URLs) so the renderer can run the duration check before importing.
  RPC.handle('Audio:Select', async () => {
    const { canceled, filePaths } = await FileSelectorManager.OpenAudioDialog('Select Audio Files');
    if (canceled || !filePaths || !filePaths.length) return [null, []];
    const Candidates = filePaths.map((FilePath: string) => AudioAssetManager.InspectCandidate(FilePath));
    return [null, Candidates];
  });

  RPC.handle('Audio:Import', async (_Event: unknown, Payload: unknown) => {
    try {
      Payload = IPCValidation.AudioImportPayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Asset] = await AudioAssetManager.Import(Payload);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Asset];
  });

  RPC.handle('Audio:Update', async (_Event: unknown, ID: unknown, Payload: unknown) => {
    try {
      ID = IPCValidation.AudioAssetID(ID);
      Payload = IPCValidation.AudioUpdatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Asset] = await AudioAssetManager.Update(ID, Payload);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Asset];
  });

  RPC.handle('Audio:Delete', async (_Event: unknown, ID: unknown) => {
    try {
      ID = IPCValidation.AudioAssetID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await AudioAssetManager.Delete(ID);
    if (Err) return [Err, null];
    PushToRenderers('AudioAssetsUpdated');
    return [null, Result];
  });

  RPC.handle('Audio:OpenFolder', async () => {
    return AppDataManager.OpenFolder(AppDataManager.GetAudioDirectory());
  });
}

export { register };
