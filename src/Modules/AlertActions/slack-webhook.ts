import { requestJson } from './_http-shared';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'slack-webhook';

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

// Slack attachment color: named keywords or a hex string.
function colorForSeverity(Severity: unknown): string {
  const S = String(Severity || '').toLowerCase();
  if (S === 'critical' || S === 'error') return 'danger';
  if (S === 'warning') return 'warning';
  if (S === 'success' || S === 'info') return 'good';
  return '#3447eb';
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Attachment = {
    color: colorForSeverity(Context.Severity),
    title: `ShowTrak Alert: ${(Context.TriggerType as string) || 'Unknown'}`,
    fields: [
      { title: 'Entity', value: String(Context.EntityName || 'Unknown'), short: true },
      { title: 'Type', value: String(Context.EntityType || 'Unknown'), short: true },
      { title: 'Severity', value: String(Context.Severity || 'info'), short: true },
      { title: 'IP', value: String(Context.IP || 'N/A'), short: true },
      {
        title: 'Group',
        value: Context.GroupID == null ? 'No Group' : String(Context.GroupID),
        short: true,
      },
      { title: 'UUID', value: String(Context.UUID || 'N/A'), short: true },
      {
        title: 'Details',
        value: String(Context.Description || 'No additional details were provided.'),
        short: false,
      },
    ],
    footer: 'ShowTrak Alerts',
    ts: Math.floor(Date.now() / 1000),
  };

  const Response = await requestJson({
    Url: S.WebhookURL,
    Method: 'POST',
    Timeout: S.Timeout,
    Body: {
      text: `ShowTrak Alert: ${String(Context.EntityName || 'Unknown')}`,
      attachments: [Attachment],
    },
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `Webhook request failed (${Response.StatusCode})`,
    };
  }

  Logger.info('Slack webhook alert action succeeded');
  return { Success: true, StatusCode: Response.StatusCode };
}

export const Name = 'Slack Webhook';
export const Description = 'Posts a message to a Slack Incoming Webhook endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
