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

const ID = 'slack-webhook';

const Settings: AlertActionSettingField[] = WEBHOOK_SETTINGS;
const NormalizeSettings = NormalizeWebhookSettings;
const ValidateSettings = ValidateWebhookSettings;

// Slack attachment color: named keywords or a hex string.
const COLOURS: Record<SeverityTone, string> = {
  danger: 'danger',
  warning: 'warning',
  good: 'good',
  neutral: '#3447eb',
};

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Body =
    S.Mode === 'text'
      ? { text: OneLineSummary(Context) }
      : {
          attachments: [
            {
              color: COLOURS[SeverityTone(Context.Severity)],
              title: AlertTitle(Context),
              fields: [
                { title: 'Entity', value: String(Context.EntityName || 'Unknown'), short: true },
                { title: 'IP', value: String(Context.IP || 'N/A'), short: true },
              ],
              footer: `ShowTrak Alerts · ${String(Context.TriggerType || 'Unknown')}`,
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        };

  return PostWebhook(S, Body, Logger, 'Slack');
}

export const Name = 'Slack Webhook';
export const Description = 'Posts a message to a Slack Incoming Webhook endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
