import { Manager as BroadcastManager } from '../Broadcast';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'play-sound';

const SOUND_OPTIONS = [
  { Value: 'Notification', Label: 'Notification' },
  { Value: 'Alert', Label: 'Alert' },
  { Value: 'Warning', Label: 'Warning' },
];

const ALLOWED_SOUNDS = SOUND_OPTIONS.map((Option) => Option.Value);

const Settings: AlertActionSettingField[] = [
  {
    Key: 'Sound',
    Label: 'Sound',
    Type: 'select',
    Options: SOUND_OPTIONS,
    Default: 'Notification',
    Preview: 'sound',
  },
];

function NormalizeSettings(Input: unknown): { Sound: string } {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const Sound = ALLOWED_SOUNDS.includes(Next.Sound as string)
    ? (Next.Sound as string)
    : 'Notification';
  return { Sound };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  NormalizeSettings(SettingsInput);
  return true;
}

async function Execute(
  Action: AlertActionInput,
  _Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  BroadcastManager.emit('PlaySound', S.Sound);
  Logger.info(`Play sound alert action queued (${S.Sound})`);
  return { Success: true };
}

export const Name = 'Play Alert Sound';
export const Description = 'Plays one of the built-in ShowTrak alert sounds on the server.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
