import { Manager as BroadcastManager } from '../Broadcast';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'showtrak-alert';

const Settings: AlertActionSettingField[] = [
  { Key: 'Title', Label: 'Custom Title (optional)', Type: 'string', Default: '' },
];

function NormalizeSettings(Input: unknown): Record<string, unknown> {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const Title = String(Next.Title == null ? '' : Next.Title)
    .trim()
    .slice(0, 120);
  return { Title };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  NormalizeSettings(SettingsInput);
  return true;
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  const Description = Context && Context.Description ? Context.Description : '';

  const Payload = {
    Title: S.Title || Description || 'ShowTrak Alert',
    Message: S.Title ? Description : '',
    Severity: (Context && Context.Severity) || 'info',
    TriggerType: (Context && Context.TriggerType) || null,
    UUID: (Context && Context.UUID) || null,
  };

  BroadcastManager.emit('CreateShowTrakAlert', Payload);
  Logger.info('ShowTrak alert action queued');
  return { Success: true };
}

export const Name = 'Create ShowTrak Alert';
export const Description =
  'Raises an alert in the ShowTrak alerts tray with an optional custom title.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
