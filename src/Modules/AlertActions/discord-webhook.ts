import { requestJson } from './_http-shared';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'discord-webhook';

const Settings: AlertActionSettingField[] = [
  { Key: 'WebhookURL', Label: 'Webhook URL', Type: 'string', Default: '' },
  { Key: 'Timeout', Label: 'Timeout (ms)', Type: 'number', Default: 5000, Min: 250, Max: 60000 },
];

function NormalizeSettings(Input: unknown): { WebhookURL: string; Timeout: number } {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const Timeout = Number(Next.Timeout);
  return {
    WebhookURL: String(Next.WebhookURL || '').trim(),
    Timeout: Number.isFinite(Timeout) ? Math.max(250, Math.min(60000, Math.round(Timeout))) : 5000,
  };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  const S = NormalizeSettings(SettingsInput);
  if (!S.WebhookURL) throw new Error('WebhookURL is required');
  try {
    const Parsed = new URL(S.WebhookURL);
    if (Parsed.protocol !== 'https:' && Parsed.protocol !== 'http:') {
      throw new Error('WebhookURL must use HTTP/S');
    }
  } catch {
    throw new Error('WebhookURL must be a valid URL');
  }
  return true;
}

function colorForSeverity(Severity: unknown): number {
  const S = String(Severity || '').toLowerCase();
  if (S === 'critical' || S === 'error') return 15158332;
  if (S === 'warning') return 16098851;
  if (S === 'success' || S === 'info') return 3066993;
  return 3447003;
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Embed = {
    title: `ShowTrak Alert: ${(Context.TriggerType as string) || 'Unknown'}`,
    color: colorForSeverity(Context.Severity),
    fields: [
      { name: 'Entity', value: String(Context.EntityName || 'Unknown'), inline: true },
      { name: 'Type', value: String(Context.EntityType || 'Unknown'), inline: true },
      { name: 'Severity', value: String(Context.Severity || 'info'), inline: true },
      { name: 'IP', value: String(Context.IP || 'N/A'), inline: true },
      {
        name: 'Group',
        value: Context.GroupID == null ? 'No Group' : String(Context.GroupID),
        inline: true,
      },
      { name: 'UUID', value: String(Context.UUID || 'N/A'), inline: true },
      {
        name: 'Details',
        value: String(Context.Description || 'No additional details were provided.'),
      },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'ShowTrak Alerts',
    },
  };

  const Response = await requestJson({
    Url: S.WebhookURL,
    Method: 'POST',
    Timeout: S.Timeout,
    Body: {
      username: 'ShowTrak Alerts',
      embeds: [Embed],
    },
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `Webhook request failed (${Response.StatusCode})`,
    };
  }

  Logger.info('Discord webhook alert action succeeded');
  return { Success: true, StatusCode: Response.StatusCode };
}

export const Name = 'Discord Webhook';
export const Description = 'Posts an opinionated embed to a Discord webhook endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
