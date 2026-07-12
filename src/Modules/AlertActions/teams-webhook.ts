import { requestJson } from './_http-shared';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'teams-webhook';

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

// Adaptive Card text colors: default | good | warning | attention.
function colorForSeverity(Severity: unknown): string {
  const S = String(Severity || '').toLowerCase();
  if (S === 'critical' || S === 'error') return 'attention';
  if (S === 'warning') return 'warning';
  if (S === 'success' || S === 'info') return 'good';
  return 'default';
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Facts = [
    { title: 'Entity', value: String(Context.EntityName || 'Unknown') },
    { title: 'Type', value: String(Context.EntityType || 'Unknown') },
    { title: 'Severity', value: String(Context.Severity || 'info') },
    { title: 'IP', value: String(Context.IP || 'N/A') },
    { title: 'Group', value: Context.GroupID == null ? 'No Group' : String(Context.GroupID) },
    { title: 'UUID', value: String(Context.UUID || 'N/A') },
  ];

  // Adaptive Card delivered via a Power Automate "Workflows" incoming webhook.
  const Card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: `ShowTrak Alert: ${(Context.TriggerType as string) || 'Unknown'}`,
        weight: 'Bolder',
        size: 'Large',
        color: colorForSeverity(Context.Severity),
        wrap: true,
      },
      { type: 'FactSet', facts: Facts },
      {
        type: 'TextBlock',
        text: String(Context.Description || 'No additional details were provided.'),
        wrap: true,
        isSubtle: true,
      },
    ],
  };

  const Response = await requestJson({
    Url: S.WebhookURL,
    Method: 'POST',
    Timeout: S.Timeout,
    Body: {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: Card,
        },
      ],
    },
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `Webhook request failed (${Response.StatusCode})`,
    };
  }

  Logger.info('Microsoft Teams webhook alert action succeeded');
  return { Success: true, StatusCode: Response.StatusCode };
}

export const Name = 'Microsoft Teams Webhook';
export const Description =
  'Posts an Adaptive Card to a Microsoft Teams (Power Automate Workflows) webhook.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
