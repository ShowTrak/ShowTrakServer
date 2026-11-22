// The request timeout every HTTP-based action (webhooks, Telegram, HTTP/S API)
// offers, and how its value is read.
import type { AlertActionSettingField } from './types';

export const TIMEOUT_SETTING_FIELD: AlertActionSettingField = {
  Key: 'Timeout',
  Label: 'Timeout (ms)',
  Type: 'number',
  Default: 5000,
  Min: 250,
  Max: 60000,
};

export function NormalizeTimeout(Value: unknown): number {
  const Timeout = Number(Value);
  return Number.isFinite(Timeout) ? Math.max(250, Math.min(60000, Math.round(Timeout))) : 5000;
}
