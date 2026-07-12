import { requestJson } from './_http-shared';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'telegram-bot';

const Settings: AlertActionSettingField[] = [
  { Key: 'BotToken', Label: 'Bot Token', Type: 'string', Default: '' },
  { Key: 'ChatID', Label: 'Chat ID', Type: 'string', Default: '' },
  { Key: 'Timeout', Label: 'Timeout (ms)', Type: 'number', Default: 5000, Min: 250, Max: 60000 },
];

function NormalizeSettings(Input: unknown): { BotToken: string; ChatID: string; Timeout: number } {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const Timeout = Number(Next.Timeout);
  return {
    BotToken: String(Next.BotToken || '').trim(),
    ChatID: String(Next.ChatID || '').trim(),
    Timeout: Number.isFinite(Timeout) ? Math.max(250, Math.min(60000, Math.round(Timeout))) : 5000,
  };
}

// Telegram bot tokens are "<digits>:<token>"; both parts are URL-path-safe so no
// encoding is applied (encoding the colon would break the endpoint).
function ValidateSettings(SettingsInput: unknown): boolean {
  const S = NormalizeSettings(SettingsInput);
  if (!S.BotToken) throw new Error('BotToken is required');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(S.BotToken)) throw new Error('BotToken format is invalid');
  if (!S.ChatID) throw new Error('ChatID is required');
  return true;
}

function escapeHtml(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emojiForSeverity(Severity: unknown): string {
  const S = String(Severity || '').toLowerCase();
  if (S === 'critical' || S === 'error') return '🔴';
  if (S === 'warning') return '🟠';
  if (S === 'success' || S === 'info') return '🟢';
  return '🔵';
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});

  const Lines = [
    `${emojiForSeverity(Context.Severity)} <b>ShowTrak Alert: ${escapeHtml(Context.TriggerType || 'Unknown')}</b>`,
    '',
    `<b>Entity:</b> ${escapeHtml(Context.EntityName || 'Unknown')}`,
    `<b>Type:</b> ${escapeHtml(Context.EntityType || 'Unknown')}`,
    `<b>Severity:</b> ${escapeHtml(Context.Severity || 'info')}`,
    `<b>IP:</b> ${escapeHtml(Context.IP || 'N/A')}`,
    `<b>Group:</b> ${escapeHtml(Context.GroupID == null ? 'No Group' : Context.GroupID)}`,
    `<b>UUID:</b> ${escapeHtml(Context.UUID || 'N/A')}`,
    '',
    escapeHtml(Context.Description || 'No additional details were provided.'),
  ];

  const Response = await requestJson({
    Url: `https://api.telegram.org/bot${S.BotToken}/sendMessage`,
    Method: 'POST',
    Timeout: S.Timeout,
    Body: {
      chat_id: S.ChatID,
      text: Lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `Telegram request failed (${Response.StatusCode})`,
    };
  }

  Logger.info('Telegram bot alert action succeeded');
  return { Success: true, StatusCode: Response.StatusCode };
}

export const Name = 'Telegram Bot';
export const Description = 'Sends a message to a Telegram chat via the Bot API.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
