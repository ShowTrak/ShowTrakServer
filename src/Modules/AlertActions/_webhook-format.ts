// Shared pieces of the Discord/Slack/Teams webhook actions: their settings, the
// alert formatting and the POST itself. Each action only builds its own payload.
//
// The embeds intentionally lead with the human-readable details as the title and
// keep the trigger type (and other metadata) de-emphasised. A single-line "text"
// mode is also offered for maximum information density.
import { requestJson } from './_http-shared';
import { TIMEOUT_SETTING_FIELD, NormalizeTimeout } from './_request-timeout';
import type {
  ActionLogger,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

export type WebhookMode = 'embed' | 'text';

// The Format selector shared by every webhook action. Rendered by the generic,
// schema-driven settings form in the UI.
export const ModeSettingField: AlertActionSettingField = {
  Key: 'Mode',
  Label: 'Format',
  Type: 'select',
  Default: 'embed',
  Options: [
    { Value: 'embed', Label: 'Embed' },
    { Value: 'text', Label: 'Text (single line)' },
  ],
};

export function NormalizeMode(Value: unknown): WebhookMode {
  return String(Value || '').toLowerCase() === 'text' ? 'text' : 'embed';
}

// --- Settings ------------------------------------------------------------------

export const WEBHOOK_SETTINGS: AlertActionSettingField[] = [
  { Key: 'WebhookURL', Label: 'Webhook URL', Type: 'string', Default: '' },
  ModeSettingField,
  TIMEOUT_SETTING_FIELD,
];

// A type rather than an interface, so it stays assignable to the registry's
// Record<string, unknown> settings.
export type WebhookSettings = {
  WebhookURL: string;
  Mode: WebhookMode;
  Timeout: number;
};

export function NormalizeWebhookSettings(Input: unknown): WebhookSettings {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  return {
    WebhookURL: String(Next.WebhookURL || '').trim(),
    Mode: NormalizeMode(Next.Mode),
    Timeout: NormalizeTimeout(Next.Timeout),
  };
}

export function ValidateWebhookSettings(SettingsInput: unknown): boolean {
  const S = NormalizeWebhookSettings(SettingsInput);
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

// POST a payload to the configured webhook. `Service` names it in the log line
// ("Discord webhook alert action succeeded").
export async function PostWebhook(
  S: WebhookSettings,
  Body: unknown,
  Logger: ActionLogger,
  Service: string
): Promise<AlertActionResult> {
  const Response = await requestJson({
    Url: S.WebhookURL,
    Method: 'POST',
    Timeout: S.Timeout,
    Body,
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `Webhook request failed (${Response.StatusCode})`,
    };
  }

  Logger.info(`${Service} webhook alert action succeeded`);
  return { Success: true, StatusCode: Response.StatusCode };
}

// --- Formatting ----------------------------------------------------------------

// How an alert's severity reads, for each action to map onto its own colours
// (or emoji): critical and error are danger, success and info are good.
export type SeverityTone = 'danger' | 'warning' | 'good' | 'neutral';

export function SeverityTone(Severity: unknown): SeverityTone {
  const S = String(Severity || '').toLowerCase();
  if (S === 'critical' || S === 'error') return 'danger';
  if (S === 'warning') return 'warning';
  if (S === 'success' || S === 'info') return 'good';
  return 'neutral';
}

// The primary line of an alert: the details/description, falling back to the
// trigger type when no description is available.
export function AlertTitle(Context: AlertContext): string {
  const Details = String(Context.Description || '').trim();
  if (Details) return Details;
  return `ShowTrak Alert: ${String(Context.TriggerType || 'Unknown')}`;
}

// Local wall-clock time as zero-padded hh:mm:ss.
function ClockTime(): string {
  const Now = new Date();
  const HH = String(Now.getHours()).padStart(2, '0');
  const MM = String(Now.getMinutes()).padStart(2, '0');
  const SS = String(Now.getSeconds()).padStart(2, '0');
  return `${HH}:${MM}:${SS}`;
}

// A compact, single-line summary used by "text" mode.
// Example: "ShowTrak 14:30:05 > TK MBP (10.0.0.5) is offline".
export function OneLineSummary(Context: AlertContext): string {
  const Details = AlertTitle(Context);
  const Entity = String(Context.EntityName || '').trim();
  const IP = String(Context.IP || '').trim();

  let Body = Details;
  if (IP && IP.toUpperCase() !== 'N/A') {
    // Insert the IP in brackets right after the hostname within the details.
    // Falls back to appending it when the hostname isn't part of the sentence.
    Body =
      Entity && Details.includes(Entity)
        ? Details.replace(Entity, `${Entity} (${IP})`)
        : `${Details} (${IP})`;
  }

  return `ShowTrak ${ClockTime()} > ${Body}`;
}
