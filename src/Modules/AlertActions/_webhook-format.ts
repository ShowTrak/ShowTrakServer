// Shared formatting helpers for the Discord/Slack/Teams webhook actions.
//
// The embeds intentionally lead with the human-readable details as the title and
// keep the trigger type (and other metadata) de-emphasised. A single-line "text"
// mode is also offered for maximum information density.
import type { AlertActionSettingField, AlertContext } from './types';

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
