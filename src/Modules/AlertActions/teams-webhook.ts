import {
  AlertTitle,
  NormalizeWebhookSettings,
  OneLineSummary,
  PostWebhook,
  SeverityTone,
  ValidateWebhookSettings,
  WEBHOOK_SETTINGS,
} from './_webhook-format';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'teams-webhook';

const Settings: AlertActionSettingField[] = WEBHOOK_SETTINGS;
const NormalizeSettings = NormalizeWebhookSettings;
const ValidateSettings = ValidateWebhookSettings;

// Adaptive Card text colors: default | good | warning | attention.
const COLOURS: Record<SeverityTone, string> = {
  danger: 'attention',
  warning: 'warning',
  good: 'good',
  neutral: 'default',
};

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  // Adaptive Card delivered via a Power Automate "Workflows" incoming webhook.
  // Even "text" mode must be an Adaptive Card here (Teams workflows do not accept
  // a bare text payload), so it collapses to a single-line TextBlock.
  const Body =
    S.Mode === 'text'
      ? [{ type: 'TextBlock', text: OneLineSummary(Context), wrap: true }]
      : [
          {
            type: 'TextBlock',
            text: AlertTitle(Context),
            weight: 'Bolder',
            size: 'Large',
            color: COLOURS[SeverityTone(Context.Severity)],
            wrap: true,
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Entity', value: String(Context.EntityName || 'Unknown') },
              { title: 'IP', value: String(Context.IP || 'N/A') },
            ],
          },
          {
            type: 'TextBlock',
            text: `Trigger: ${String(Context.TriggerType || 'Unknown')}`,
            wrap: true,
            isSubtle: true,
            spacing: 'Small',
          },
        ];

  const Card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: Body,
  };

  return PostWebhook(
    S,
    {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: Card,
        },
      ],
    },
    Logger,
    'Microsoft Teams'
  );
}

export const Name = 'Microsoft Teams Webhook';
export const Description =
  'Posts an Adaptive Card to a Microsoft Teams (Power Automate Workflows) webhook.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
