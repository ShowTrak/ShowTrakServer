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

const ID = 'discord-webhook';

const Settings: AlertActionSettingField[] = WEBHOOK_SETTINGS;
const NormalizeSettings = NormalizeWebhookSettings;
const ValidateSettings = ValidateWebhookSettings;

const COLOURS: Record<SeverityTone, number> = {
  danger: 15158332,
  warning: 16098851,
  good: 3066993,
  neutral: 3447003,
};

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Body =
    S.Mode === 'text'
      ? {
          username: 'ShowTrak Alerts',
          content: OneLineSummary(Context),
        }
      : {
          username: 'ShowTrak Alerts',
          embeds: [
            {
              title: AlertTitle(Context),
              color: COLOURS[SeverityTone(Context.Severity)],
              fields: [
                { name: 'Entity', value: String(Context.EntityName || 'Unknown'), inline: true },
                { name: 'IP', value: String(Context.IP || 'N/A'), inline: true },
              ],
              timestamp: new Date().toISOString(),
              footer: {
                text: `ShowTrak Alerts · ${String(Context.TriggerType || 'Unknown')}`,
              },
            },
          ],
        };

  return PostWebhook(S, Body, Logger, 'Discord');
}

export const Name = 'Discord Webhook';
export const Description = 'Posts an opinionated embed to a Discord webhook endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
