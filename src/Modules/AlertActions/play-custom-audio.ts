import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AudioAssetManager } from '../AudioAssetManager';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'play-custom-audio';

// Built-in fallback played when the configured asset has been deleted so the
// operator still gets an audible cue (and a visible warning elsewhere).
const FALLBACK_SOUND = 'Notification';

const Settings: AlertActionSettingField[] = [
  {
    Key: 'AssetID',
    Label: 'Audio Asset',
    Type: 'select',
    // Options are populated dynamically by the renderer from the user's
    // imported audio assets (see RenderAlertActionSettingsFields).
    Source: 'audio-assets',
    Options: [],
    Default: '',
    Preview: 'audio-asset',
  },
  {
    // Kept for display/warning purposes when the underlying asset is missing.
    Key: 'AssetLabel',
    Label: 'Audio Asset Label',
    Type: 'string',
    Default: '',
    Hidden: true,
  },
];

function NormalizeSettings(Input: unknown): { AssetID: string; AssetLabel: string } {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  return {
    AssetID: String(Next.AssetID == null ? '' : Next.AssetID).trim(),
    AssetLabel: String(Next.AssetLabel == null ? '' : Next.AssetLabel).trim(),
  };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  const S = NormalizeSettings(SettingsInput);
  if (!S.AssetID) throw new Error('Please choose an audio asset');
  return true;
}

async function Execute(
  Action: AlertActionInput,
  _Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const [Err, Payload] = AudioAssetManager.GetDataURL(S.AssetID);
  if (Err || !Payload) {
    // Asset was deleted: skip the missing file but still cue the operator with
    // a built-in placeholder sound.
    BroadcastManager.emit('PlaySound', FALLBACK_SOUND);
    Logger.warn(`Custom audio asset missing (${S.AssetLabel || S.AssetID}); played fallback sound`);
    return { Success: true, Warning: 'Audio asset missing; played fallback sound' };
  }

  BroadcastManager.emit('PlayCustomAudio', {
    ID: Payload.ID,
    Label: Payload.Label,
    Volume: Payload.Volume,
    DataURL: Payload.DataURL,
  });
  Logger.info(`Play custom audio asset queued (${Payload.Label})`);
  return { Success: true };
}

export const Name = 'Play Custom Audio Asset';
export const Description = 'Plays one of your imported custom audio files on the server.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
